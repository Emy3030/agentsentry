pub use agent_sentry_validator as validator;

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

const DENIAL_LOG_CAPACITY: u64 = 100;
const MAX_AUTH_ID_BYTES: usize = 128;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Authorization {
    pub auth_id: String,
    pub authorized_initiator: AccountId,
    pub approved_recipient: AccountId,
    pub max_amount: NearToken,
    pub expires_at_ns: u64,
    pub nonce: String,
    pub used: bool,
    pub pending_transfer_id: Option<u64>,
    pub revoked: bool,
    pub created_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingTransfer {
    pub amount_yocto: u128,
    pub recipient: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DenialRecord {
    pub error_code: String,
    pub reason: String,
    pub caller_id: AccountId,
    pub auth_id: String,
    pub attempted_recipient: AccountId,
    pub attempted_amount: U128,
    pub timestamp_ns: U64,
    pub vault_auto_frozen: bool,
}

/// Fixed-size aggregate counters ensure denial details can rotate without
/// losing the overall security signal.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct DenialCounters {
    pub invalid_amount: u64,
    pub vault_frozen: u64,
    pub auth_not_found: u64,
    pub auth_revoked: u64,
    pub auth_already_used: u64,
    pub auth_expired: u64,
    pub recipient_not_approved: u64,
    pub amount_exceeded: u64,
    pub insufficient_vault_balance: u64,
    pub other: u64,
}

impl DenialCounters {
    fn increment(&mut self, error_code: &str) {
        let counter = match error_code {
            "ERR_INVALID_AMOUNT" => &mut self.invalid_amount,
            "ERR_VAULT_FROZEN" => &mut self.vault_frozen,
            "ERR_AUTH_NOT_FOUND" => &mut self.auth_not_found,
            "ERR_AUTH_REVOKED" => &mut self.auth_revoked,
            "ERR_AUTH_ALREADY_USED" => &mut self.auth_already_used,
            "ERR_AUTH_EXPIRED" => &mut self.auth_expired,
            "ERR_RECIPIENT_NOT_APPROVED" => &mut self.recipient_not_approved,
            "ERR_AMOUNT_EXCEEDED" => &mut self.amount_exceeded,
            "ERR_INSUFFICIENT_VAULT_BALANCE" => &mut self.insufficient_vault_balance,
            _ => &mut self.other,
        };
        *counter = counter.checked_add(1).expect("ERR_DENIAL_COUNTER_OVERFLOW");
    }
}

#[near(serializers = [json])]
pub struct PaymentResult {
    pub success: bool,
    pub status: String,
    pub auth_id: String,
    pub recipient: AccountId,
    pub amount_transferred: U128,
    pub remaining_vault_balance: U128,
    pub error_code: Option<String>,
    pub reason: Option<String>,
}

#[near(serializers = [json])]
pub struct VaultStateView {
    pub owner_id: AccountId,
    pub vault_balance: U128,
    pub reserved_balance: U128,
    pub is_frozen: bool,
    pub consecutive_violations: u32,
    pub max_consecutive_violations: u32,
    pub total_denials_logged: u64,
    pub denial_records_evicted: u64,
    pub oldest_denial_index: u64,
    pub denial_counts: DenialCounters,
}

#[near(serializers = [json])]
pub struct AuthorizationView {
    pub auth_id: String,
    pub authorized_initiator: AccountId,
    pub approved_recipient: AccountId,
    pub max_amount: U128,
    pub expires_at_ns: U64,
    pub nonce: String,
    pub used: bool,
    pub pending_transfer_id: Option<u64>,
    pub revoked: bool,
    pub created_at_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentSentryVault {
    pub owner_id: AccountId,
    pub is_frozen: bool,
    pub consecutive_violations: u32,
    pub max_consecutive_violations: u32,
    pub next_transfer_id: u64,
    pub reserved_balance_yocto: u128,
    pub authorizations: LookupMap<String, Authorization>,
    pub pending_transfers: LookupMap<u64, PendingTransfer>,
    /// Recent denial details, stored as a ring capped at DENIAL_LOG_CAPACITY.
    pub denial_log: Vector<DenialRecord>,
    /// Absolute sequence count for all persisted authorized-initiator denials.
    pub total_denials_logged: u64,
    /// Fixed-size aggregates retained after individual details rotate out.
    pub denial_counts: DenialCounters,
}

#[near]
impl AgentSentryVault {
    /// Initializes the vault for the account that directly calls `new`.
    /// Deployment and initialization must be submitted atomically by the
    /// intended owner so nobody else can initialize an empty contract first.
    #[init]
    pub fn new(owner_id: AccountId, max_consecutive_violations: Option<u32>) -> Self {
        require!(!env::state_exists(), "ERR_ALREADY_INITIALIZED");
        require!(
            env::predecessor_account_id() == owner_id,
            "ERR_UNAUTHORIZED_INITIALIZER"
        );
        Self {
            owner_id,
            is_frozen: false,
            consecutive_violations: 0,
            max_consecutive_violations: max_consecutive_violations.unwrap_or(3),
            next_transfer_id: 0,
            reserved_balance_yocto: 0,
            authorizations: LookupMap::new(b"a"),
            pending_transfers: LookupMap::new(b"p"),
            denial_log: Vector::new(b"d"),
            total_denials_logged: 0,
            denial_counts: DenialCounters::default(),
        }
    }

    // ==========================================
    // OWNER GOVERNANCE METHODS
    // ==========================================

    /// Creates a payment authorization rule. Only the owner can call this.
    pub fn authorize_payment(
        &mut self,
        auth_id: String,
        authorized_initiator: AccountId,
        approved_recipient: AccountId,
        max_amount: U128,
        expires_at_ns: U64,
        nonce: Option<String>,
    ) {
        self.assert_owner();
        require!(!self.is_frozen, "ERR_VAULT_FROZEN: Cannot create rules while frozen");
        require!(auth_id.len() <= MAX_AUTH_ID_BYTES, "ERR_AUTH_ID_TOO_LONG");
        require!(self.authorizations.get(&auth_id).is_none(), "ERR_AUTH_ID_EXISTS");
        require!(max_amount.0 > 0, "ERR_INVALID_MAX_AMOUNT: Must be positive");

        let current_time = env::block_timestamp();
        require!(
            expires_at_ns.0 > current_time,
            "ERR_INVALID_EXPIRY: Expiry must be in the future"
        );

        let chosen_nonce = nonce.unwrap_or_else(|| auth_id.clone());
        let auth = Authorization {
            auth_id: auth_id.clone(),
            authorized_initiator: authorized_initiator.clone(),
            approved_recipient: approved_recipient.clone(),
            max_amount: NearToken::from_yoctonear(max_amount.0),
            expires_at_ns: expires_at_ns.0,
            nonce: chosen_nonce,
            used: false,
            pending_transfer_id: None,
            revoked: false,
            created_at_ns: current_time,
        };

        self.authorizations.insert(&auth_id, &auth);

        log_contract_event(
            "authorization_created",
            serde_json::json!({
                "auth_id": auth_id,
                "initiator": authorized_initiator,
                "recipient": approved_recipient,
                "max_amount": max_amount.0.to_string(),
            }),
        );
    }

    /// Revokes an authorization. Only owner.
    pub fn revoke_authorization(&mut self, auth_id: String) {
        self.assert_owner();
        let mut auth = self.authorizations.get(&auth_id).expect("ERR_AUTH_NOT_FOUND");
        require!(!auth.used && auth.pending_transfer_id.is_none(), "ERR_AUTH_ALREADY_USED");
        auth.revoked = true;
        self.authorizations.insert(&auth_id, &auth);

        log_contract_event(
            "authorization_revoked",
            serde_json::json!({ "auth_id": auth_id }),
        );
    }

    /// Emergency freeze: Halts all payment dispatches immediately. Only owner.
    pub fn emergency_freeze(&mut self) {
        self.assert_owner();
        self.is_frozen = true;
        log_contract_event("vault_frozen", serde_json::json!({}));
    }

    /// Unfreeze: Restores normal operation after security review. Only owner.
    pub fn unfreeze(&mut self) {
        self.assert_owner();
        self.is_frozen = false;
        self.consecutive_violations = 0;
        log_contract_event("vault_unfrozen", serde_json::json!({}));
    }

    /// Owner withdraws funds directly from the vault balance.
    pub fn withdraw_funds(&mut self, recipient: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        let token_amount = NearToken::from_yoctonear(amount.0);
        require!(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(self.reserved_balance_yocto)
                >= amount.0,
            "ERR_INSUFFICIENT_BALANCE"
        );
        Promise::new(recipient).transfer(token_amount)
    }

    // ==========================================
    // AGENT PAYMENT EXECUTION ENGINE
    // ==========================================

    /// Requests a payment against an approved authorization.
    /// Can be invoked by an autonomous agent with a scoped FunctionCall key.
    ///
    /// Implements deterministic validation:
    /// - If any check fails, zero funds are transferred.
    /// - The denial is recorded in the on-chain audit log.
    /// - Consecutive violations trigger an auto-freeze circuit breaker.
    pub fn request_payment(
        &mut self,
        auth_id: String,
        recipient: AccountId,
        amount: U128,
    ) -> PaymentResult {
        let caller = env::predecessor_account_id();
        let current_time = env::block_timestamp();
        let requested_amount = NearToken::from_yoctonear(amount.0);
        let vault_balance = env::account_balance();

        // Zero-value transfers are not useful and would otherwise consume a
        // single-use authorization without paying the approved recipient.
        if amount.0 == 0 {
            return self.record_denial_and_exit(
                "ERR_INVALID_AMOUNT",
                "Requested payment amount must be positive",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 1. Vault Freeze Check
        if self.is_frozen {
            return self.record_denial_and_exit(
                "ERR_VAULT_FROZEN",
                "Vault is currently frozen due to an emergency or security violation",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 2. Authorization Existence Check
        let mut auth = match self.authorizations.get(&auth_id) {
            Some(a) => a,
            None => {
                return self.record_denial_and_exit(
                    "ERR_AUTH_NOT_FOUND",
                    "No authorization found for the given auth_id",
                    caller,
                    auth_id,
                    recipient,
                    amount,
                );
            }
        };

        // The owner binds each authorization to one initiator. An invalid
        // caller can be audited but cannot execute or consume the payment.
        if caller != auth.authorized_initiator {
            return self.record_denial_and_exit(
                "ERR_UNAUTHORIZED_INITIATOR",
                "Caller is not authorized to initiate this payment",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 3. Revocation Check
        if auth.revoked {
            return self.record_denial_and_exit(
                "ERR_AUTH_REVOKED",
                "Authorization has been revoked by the vault owner",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 4. Replay Check (Single-use nonce)
        if auth.used {
            return self.record_denial_and_exit(
                "ERR_AUTH_ALREADY_USED",
                "Authorization has already been executed",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 5. Expiry Check
        if current_time > auth.expires_at_ns {
            return self.record_denial_and_exit(
                "ERR_AUTH_EXPIRED",
                "Authorization has expired",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 6. Recipient Check
        if recipient != auth.approved_recipient {
            return self.record_denial_and_exit(
                "ERR_RECIPIENT_NOT_APPROVED",
                "Recipient does not match the approved recipient in authorization",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 7. Spending Limit Check
        if requested_amount.as_yoctonear() > auth.max_amount.as_yoctonear() {
            return self.record_denial_and_exit(
                "ERR_AMOUNT_EXCEEDED",
                "Requested payment exceeds authorized ceiling",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // 8. Vault Solvency Check
        let available_balance = vault_balance
            .as_yoctonear()
            .saturating_sub(self.reserved_balance_yocto);
        if available_balance < requested_amount.as_yoctonear() {
            return self.record_denial_and_exit(
                "ERR_INSUFFICIENT_VAULT_BALANCE",
                "Vault balance is insufficient to cover payment",
                caller,
                auth_id,
                recipient,
                amount,
            );
        }

        // ==========================================
        // ALL CHECKS PASSED: RESERVE AND SCHEDULE TRANSFER
        // ==========================================

        let transfer_id = self.next_transfer_id;
        self.next_transfer_id = self
            .next_transfer_id
            .checked_add(1)
            .expect("ERR_TRANSFER_ID_EXHAUSTED");
        self.reserved_balance_yocto = self
            .reserved_balance_yocto
            .checked_add(amount.0)
            .expect("ERR_RESERVED_BALANCE_OVERFLOW");
        self.pending_transfers.insert(
            &transfer_id,
            &PendingTransfer {
                amount_yocto: amount.0,
                recipient: recipient.clone(),
            },
        );
        auth.used = true;
        auth.pending_transfer_id = Some(transfer_id);
        self.authorizations.insert(&auth_id, &auth);

        // Reserve the amount before scheduling. The private callback settles
        // the reservation and is guarded by both the auth id and unique id.
        let callback_args = serde_json::to_vec(&(auth_id.clone(), transfer_id))
            .expect("ERR_CALLBACK_ARGS_SERIALIZATION");
        let _ = Promise::new(recipient.clone())
            .transfer(requested_amount)
            .then(Promise::new(env::current_account_id()).function_call(
                "on_transfer_complete",
                callback_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            ));

        let remaining = available_balance.saturating_sub(requested_amount.as_yoctonear());

        log_contract_event(
            "payment_initiated",
            serde_json::json!({
                "auth_id": auth_id,
                "transfer_id": transfer_id,
                "recipient": recipient,
                "amount": amount.0.to_string(),
            }),
        );

        PaymentResult {
            success: true,
            status: "PENDING".to_string(),
            auth_id,
            recipient,
            amount_transferred: amount,
            remaining_vault_balance: U128(remaining),
            error_code: None,
            reason: None,
        }
    }

    /// Settles a scheduled native transfer. A failed payment releases its
    /// reservation and makes the authorization retryable. Repeated or stale
    /// callbacks do not change state. If this callback itself fails, NEAR
    /// rolls back its state changes; the pending authorization and reservation
    /// remain fail-closed because no later contract call can prove the original
    /// transfer outcome.
    #[private]
    pub fn on_transfer_complete(&mut self, auth_id: String, transfer_id: u64) -> bool {
        if env::promise_results_count() != 1 {
            return false;
        }
        let mut auth = match self.authorizations.get(&auth_id) {
            Some(auth) if auth.pending_transfer_id == Some(transfer_id) => auth,
            _ => return false,
        };

        let pending = match self.pending_transfers.get(&transfer_id) {
            Some(pending) => pending,
            None => return false,
        };
        self.reserved_balance_yocto = self
            .reserved_balance_yocto
            .checked_sub(pending.amount_yocto)
            .expect("ERR_RESERVED_BALANCE_INVARIANT");

        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                auth.pending_transfer_id = None;
                self.authorizations.insert(&auth_id, &auth);
                self.pending_transfers.remove(&transfer_id);
                self.consecutive_violations = 0;
                log_contract_event(
                    "payment_executed",
                    serde_json::json!({
                        "auth_id": auth_id,
                        "transfer_id": transfer_id,
                        "recipient": pending.recipient,
                        "amount": pending.amount_yocto.to_string(),
                    }),
                );
            }
            Err(_) => {
                auth.used = false;
                auth.pending_transfer_id = None;
                self.authorizations.insert(&auth_id, &auth);
                self.pending_transfers.remove(&transfer_id);
                log_contract_event(
                    "payment_transfer_failed",
                    serde_json::json!({
                        "error": "ERR_TRANSFER_FAILED",
                        "auth_id": auth_id,
                        "transfer_id": transfer_id,
                        "recipient": pending.recipient,
                        "amount": pending.amount_yocto.to_string(),
                    }),
                );
            }
        }
        true
    }

    // ==========================================
    // VIEW METHODS
    // ==========================================

    pub fn get_vault_state(&self) -> VaultStateView {
        VaultStateView {
            owner_id: self.owner_id.clone(),
            vault_balance: U128(env::account_balance().as_yoctonear()),
            reserved_balance: U128(self.reserved_balance_yocto),
            is_frozen: self.is_frozen,
            consecutive_violations: self.consecutive_violations,
            max_consecutive_violations: self.max_consecutive_violations,
            total_denials_logged: self.total_denials_logged,
            denial_records_evicted: self
                .total_denials_logged
                .saturating_sub(self.denial_log.len()),
            oldest_denial_index: self
                .total_denials_logged
                .saturating_sub(self.denial_log.len()),
            denial_counts: self.denial_counts.clone(),
        }
    }

    pub fn get_authorization(&self, auth_id: String) -> Option<AuthorizationView> {
        self.authorizations.get(&auth_id).map(|a| AuthorizationView {
            auth_id: a.auth_id,
            authorized_initiator: a.authorized_initiator,
            approved_recipient: a.approved_recipient,
            max_amount: U128(a.max_amount.as_yoctonear()),
            expires_at_ns: U64(a.expires_at_ns),
            nonce: a.nonce,
            used: a.used,
            pending_transfer_id: a.pending_transfer_id,
            revoked: a.revoked,
            created_at_ns: U64(a.created_at_ns),
        })
    }

    pub fn get_denial_log(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<DenialRecord> {
        let oldest_retained = self
            .total_denials_logged
            .saturating_sub(self.denial_log.len());
        // Indices are absolute record sequence numbers. A cursor older than
        // the retained window starts at the oldest available record; callers
        // can detect the gap through get_vault_state().oldest_denial_index.
        let start = from_index.unwrap_or(oldest_retained).max(oldest_retained);
        let end = std::cmp::min(
            start.saturating_add(limit.unwrap_or(50)),
            self.total_denials_logged,
        );
        (start..end)
            .map(|sequence| {
                self.denial_log
                    .get(sequence % DENIAL_LOG_CAPACITY)
                    .expect("ERR_DENIAL_LOG_SLOT_MISSING")
            })
            .collect()
    }

    // ==========================================
    // INTERNAL HELPERS
    // ==========================================

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_UNAUTHORIZED: Predecessor is not the vault owner"
        );
    }

    fn record_denial_and_exit(
        &mut self,
        error_code: &str,
        reason: &str,
        caller_id: AccountId,
        auth_id: String,
        attempted_recipient: AccountId,
        attempted_amount: U128,
    ) -> PaymentResult {
        // Persist denials only for the owner-selected initiator. This keeps
        // arbitrary callers from growing contract storage with random auth IDs.
        let is_authorized_initiator = self
            .authorizations
            .get(&auth_id)
            .is_some_and(|auth| auth.authorized_initiator == caller_id);
        let mut denial_sequence = None;
        if is_authorized_initiator {
            self.consecutive_violations = self.consecutive_violations.saturating_add(1);
            if self.consecutive_violations >= self.max_consecutive_violations {
                self.is_frozen = true;
            }

            self.denial_counts.increment(error_code);
            let next_total = self
                .total_denials_logged
                .checked_add(1)
                .expect("ERR_DENIAL_TOTAL_OVERFLOW");

            let record = DenialRecord {
                error_code: error_code.to_string(),
                reason: reason.to_string(),
                caller_id: caller_id.clone(),
                auth_id: auth_id.clone(),
                attempted_recipient: attempted_recipient.clone(),
                attempted_amount,
                timestamp_ns: U64(env::block_timestamp()),
                vault_auto_frozen: self.is_frozen,
            };

            if self.denial_log.len() < DENIAL_LOG_CAPACITY {
                self.denial_log.push(&record);
            } else {
                let slot = self.total_denials_logged % DENIAL_LOG_CAPACITY;
                self.denial_log.replace(slot, &record);
            }
            denial_sequence = Some(self.total_denials_logged);
            self.total_denials_logged = next_total;
        }

        log_contract_event(
            "payment_denied",
            serde_json::json!({
                "error": error_code,
                "reason": reason,
                "caller_id": caller_id,
                "auth_id": is_authorized_initiator.then_some(auth_id.as_str()),
                "attempted_recipient": attempted_recipient,
                "attempted_amount": attempted_amount.0.to_string(),
                "timestamp_ns": env::block_timestamp().to_string(),
                "persisted": is_authorized_initiator,
                "denial_sequence": denial_sequence,
                "denial_records_evicted": self.total_denials_logged.saturating_sub(self.denial_log.len()),
            }),
        );

        PaymentResult {
            success: false,
            status: "DENIED".to_string(),
            auth_id,
            recipient: attempted_recipient,
            amount_transferred: U128(0),
            remaining_vault_balance: U128(
                env::account_balance()
                    .as_yoctonear()
                    .saturating_sub(self.reserved_balance_yocto),
            ),
            error_code: Some(error_code.to_string()),
            reason: Some(reason.to_string()),
        }
    }
}

/// Emits a NEP-style event with JSON-serialized fields so arbitrary string
/// values cannot corrupt the event JSON.
fn log_contract_event(event: &str, fields: serde_json::Value) {
    let mut payload = fields
        .as_object()
        .expect("ERR_EVENT_FIELDS_NOT_OBJECT")
        .clone();
    for reserved_field in ["standard", "version", "event"] {
        assert!(
            !payload.contains_key(reserved_field),
            "ERR_EVENT_RESERVED_FIELD"
        );
    }
    payload.insert("standard".to_string(), serde_json::json!("agentsentry"));
    payload.insert("version".to_string(), serde_json::json!("1.0.0"));
    payload.insert("event".to_string(), serde_json::json!(event));

    let serialized = serde_json::to_string(&serde_json::Value::Object(payload))
        .expect("ERR_EVENT_SERIALIZATION");
    env::log_str(&format!("EVENT_JSON:{serialized}"));
}

// =========================================================================
// INTEGRATION TESTS — require `--features integration-tests`
// Uses VMContextBuilder / testing_env! from near-sdk unit-testing feature.
// Needs a full C toolchain (gcc/as) on Windows due to near-crypto's build deps.
// Run with: cargo test --features integration-tests
// =========================================================================

#[cfg(all(test, feature = "integration-tests"))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{
        get_created_receipts, get_logs, testing_env_with_promise_results, VMContextBuilder,
    };
    use near_sdk::testing_env;
    use near_sdk::PromiseResult as MockPromiseResult;
    fn owner() -> AccountId {
        "acme_corp.near".parse().unwrap()
    }
    fn agent() -> AccountId {
        "procurement_agent.near".parse().unwrap()
    }
    fn approved_recipient() -> AccountId {
        "aws_cloud.near".parse().unwrap()
    }
    fn attacker() -> AccountId {
        "attacker.near".parse().unwrap()
    }
    fn vault_account() -> AccountId {
        "agent_sentry_vault.near".parse().unwrap()
    }

    #[test]
    fn test_intended_owner_can_initialize_vault() {
        use near_sdk::state::ContractState;

        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(vault_account())
            .predecessor_account_id(owner());
        testing_env!(builder.build());

        let vault = AgentSentryVault::new(owner(), Some(3));
        assert_eq!(vault.owner_id, owner());
        assert!(!vault.state_write());
        assert!(env::state_exists());
    }

    #[test]
    fn test_unauthorized_initializer_cannot_establish_or_replace_owner() {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(vault_account())
            .predecessor_account_id(attacker());
        testing_env!(builder.build());

        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            AgentSentryVault::new(owner(), Some(3))
        }));
        assert!(rejected.is_err());
        assert!(!env::state_exists());

        builder.predecessor_account_id(owner());
        testing_env!(builder.build());
        let vault = AgentSentryVault::new(owner(), Some(3));
        assert_eq!(vault.owner_id, owner());
    }

    #[test]
    fn test_repeated_initialization_is_rejected_and_owner_is_unchanged() {
        use near_sdk::state::ContractState;

        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(vault_account())
            .predecessor_account_id(owner());
        testing_env!(builder.build());

        let vault = AgentSentryVault::new(owner(), Some(3));
        assert_eq!(vault.owner_id, owner());
        assert!(!vault.state_write());

        builder.predecessor_account_id(attacker());
        testing_env!(builder.build());
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            AgentSentryVault::new(attacker(), Some(3))
        }));
        assert!(rejected.is_err());

        let stored_vault =
            AgentSentryVault::state_read().expect("initialized state remains present");
        assert_eq!(stored_vault.owner_id, owner());
    }

    fn setup_context() -> (VMContextBuilder, AgentSentryVault) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("agent_sentry_vault.near".parse().unwrap())
            .predecessor_account_id(owner())
            .account_balance(NearToken::from_near(100))
            .block_timestamp(1_700_000_000_000_000_000); // T_BASE

        testing_env!(builder.build());
        let mut vault = AgentSentryVault::new(owner(), Some(3));

        // Authorize payment for AWS
        vault.authorize_payment(
            "auth_001".to_string(),
            agent(),
            approved_recipient(),
            U128(10_000_000_000_000_000_000_000_000), // 10 NEAR
            U64(1_700_000_000_000_000_000 + 3600_000_000_000), // +1 hour
            Some("nonce_001".to_string()),
        );

        (builder, vault)
    }

    fn latest_event(event_name: &str) -> serde_json::Value {
        get_logs()
            .iter()
            .rev()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .filter_map(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            .find(|event| {
                event.get("event").and_then(serde_json::Value::as_str) == Some(event_name)
            })
            .unwrap_or_else(|| panic!("EVENT_JSON for {event_name} was not emitted"))
    }

    fn assert_event_logs_are_valid_json() {
        for line in get_logs().iter().filter(|line| line.starts_with("EVENT_JSON:")) {
            let json = line.strip_prefix("EVENT_JSON:").unwrap();
            serde_json::from_str::<serde_json::Value>(json)
                .unwrap_or_else(|error| panic!("invalid event JSON: {error}"));
        }
    }

    #[test]
    fn test_authorization_events_escape_special_ids_and_preserve_values() {
        let (_builder, mut vault) = setup_context();
        let auth_ids = [
            "auth_ordinary".to_string(),
            r#"auth_"quoted""#.to_string(),
            r"auth\backslash".to_string(),
            "auth\nnew\rline\ttab\u{0000}\u{001f}".to_string(),
            "auth/slash <>& café\u{2028}".to_string(),
        ];

        for auth_id in auth_ids {
            vault.authorize_payment(
                auth_id.clone(),
                agent(),
                approved_recipient(),
                U128(1_000),
                U64(1_700_000_000_000_000_000 + 3600_000_000_000),
                None,
            );
            let created = latest_event("authorization_created");
            assert_eq!(created["auth_id"].as_str(), Some(auth_id.as_str()));
            assert_eq!(created["initiator"].as_str(), Some("procurement_agent.near"));
            assert_eq!(created["recipient"].as_str(), Some("aws_cloud.near"));
            assert_eq!(created["max_amount"].as_str(), Some("1000"));

            vault.revoke_authorization(auth_id.clone());
            let revoked = latest_event("authorization_revoked");
            assert_eq!(revoked["auth_id"].as_str(), Some(auth_id.as_str()));
        }

        assert_event_logs_are_valid_json();
    }

    #[test]
    fn test_payment_events_escape_special_ids_and_preserve_values() {
        let (mut builder, mut vault) = setup_context();
        let success_id = "payment_\"quoted\"\\path\ncontrol\u{0001}<>& café".to_string();
        vault.authorize_payment(
            success_id.clone(),
            agent(),
            approved_recipient(),
            U128(1_000),
            U64(1_700_000_000_000_000_000 + 3600_000_000_000),
            None,
        );

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        let requested = vault.request_payment(success_id.clone(), approved_recipient(), U128(500));
        assert!(requested.success);
        let initiated = latest_event("payment_initiated");
        assert_eq!(initiated["auth_id"].as_str(), Some(success_id.as_str()));
        assert_eq!(initiated["amount"].as_str(), Some("500"));

        let transfer_id = vault
            .get_authorization(success_id.clone())
            .unwrap()
            .pending_transfer_id
            .unwrap();
        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Successful(vec![]));
        assert!(vault.on_transfer_complete(success_id.clone(), transfer_id));
        let executed = latest_event("payment_executed");
        assert_eq!(executed["auth_id"].as_str(), Some(success_id.as_str()));
        assert_eq!(executed["amount"].as_str(), Some("500"));

        let failed_id = "failed_\"quote\\slash\n\u{0002}".to_string();
        builder.predecessor_account_id(owner());
        testing_env!(builder.build());
        vault.authorize_payment(
            failed_id.clone(),
            agent(),
            approved_recipient(),
            U128(1_000),
            U64(1_700_000_000_000_000_000 + 3600_000_000_000),
            None,
        );
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        assert!(vault.request_payment(failed_id.clone(), approved_recipient(), U128(500)).success);
        let failed_transfer_id = vault
            .get_authorization(failed_id.clone())
            .unwrap()
            .pending_transfer_id
            .unwrap();
        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Failed);
        assert!(vault.on_transfer_complete(failed_id.clone(), failed_transfer_id));
        let failed = latest_event("payment_transfer_failed");
        assert_eq!(failed["auth_id"].as_str(), Some(failed_id.as_str()));
        assert_eq!(failed["error"].as_str(), Some("ERR_TRANSFER_FAILED"));

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        let denied = vault.request_payment(failed_id, attacker(), U128(500));
        assert_eq!(denied.error_code.as_deref(), Some("ERR_RECIPIENT_NOT_APPROVED"));
        let denied_event = latest_event("payment_denied");
        assert_eq!(denied_event["error"].as_str(), Some("ERR_RECIPIENT_NOT_APPROVED"));
        assert_eq!(
            denied_event["reason"].as_str(),
            Some("Recipient does not match the approved recipient in authorization")
        );

        builder.predecessor_account_id(owner());
        testing_env!(builder.build());
        vault.emergency_freeze();
        assert_eq!(latest_event("vault_frozen")["event"].as_str(), Some("vault_frozen"));
        vault.unfreeze();
        assert_eq!(latest_event("vault_unfrozen")["event"].as_str(), Some("vault_unfrozen"));

        assert_event_logs_are_valid_json();
    }

    #[test]
    #[should_panic(expected = "ERR_EVENT_RESERVED_FIELD")]
    fn test_event_serializer_rejects_reserved_metadata_overrides() {
        log_contract_event("expected_event", serde_json::json!({ "event": "caller_event" }));
    }

    #[test]
    fn test_valid_payment_succeeds() {
        let (mut builder, mut vault) = setup_context();

        // Switch predecessor to agent
        builder.predecessor_account_id(agent());
        builder.block_timestamp(1_700_000_000_000_000_000 + 60_000_000_000); // +1 min
        testing_env!(builder.build());

        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000), // 5 NEAR
        );

        assert!(res.success, "Valid payment must succeed");
        assert_eq!(res.status, "PENDING");
        assert_eq!(res.amount_transferred.0, 5_000_000_000_000_000_000_000_000);

        let auth_view = vault.get_authorization("auth_001".to_string()).unwrap();
        assert!(auth_view.used, "Authorization must be marked used");
        let transfer_id = auth_view.pending_transfer_id.unwrap();
        assert_eq!(vault.reserved_balance_yocto, 5_000_000_000_000_000_000_000_000);

        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Successful(vec![]));
        assert!(vault.on_transfer_complete("auth_001".to_string(), transfer_id));
        assert!(vault.get_authorization("auth_001".to_string()).unwrap().used);
        assert_eq!(vault.get_authorization("auth_001".to_string()).unwrap().pending_transfer_id, None);
        assert_eq!(vault.reserved_balance_yocto, 0);
        assert!(!vault.on_transfer_complete("auth_001".to_string(), transfer_id));
        assert!(get_logs().iter().any(|line| line.contains("payment_executed")));
    }

    #[test]
    fn test_unapproved_recipient_denied() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        let res = vault.request_payment(
            "auth_001".to_string(),
            attacker(), // Attacker redirection
            U128(5_000_000_000_000_000_000_000_000),
        );

        assert!(!res.success, "Unapproved recipient must be blocked");
        assert_eq!(res.status, "DENIED");
        assert_eq!(res.error_code.unwrap(), "ERR_RECIPIENT_NOT_APPROVED");
        assert_eq!(res.amount_transferred.0, 0, "Zero funds must leave vault");
        assert!(get_created_receipts().is_empty(), "Denial must not schedule a transfer");

        // Auth remains unused
        let auth_view = vault.get_authorization("auth_001".to_string()).unwrap();
        assert!(!auth_view.used, "Auth must remain valid for approved recipient");

        // Incident logged
        assert_eq!(vault.get_denial_log(None, None).len(), 1);
        assert!(get_logs().iter().any(|line| line.contains("payment_denied")));

        let unknown = vault.request_payment(
            "unknown_auth".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000),
        );
        assert_eq!(unknown.error_code.as_deref(), Some("ERR_AUTH_NOT_FOUND"));
        assert_eq!(vault.get_denial_log(None, None).len(), 1);
        assert_eq!(vault.consecutive_violations, 1);
    }

    #[test]
    fn test_denial_log_is_bounded_and_retains_aggregate_monitoring() {
        let (mut builder, mut vault) = setup_context();
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        let total_attempts = DENIAL_LOG_CAPACITY + 7;
        for amount in 1..=total_attempts {
            vault.request_payment(
                "auth_001".to_string(),
                attacker(),
                U128(amount as u128),
            );
        }

        let state = vault.get_vault_state();
        assert!(state.is_frozen, "auto-freeze must still trip at the threshold");
        assert_eq!(state.consecutive_violations, total_attempts as u32);
        assert_eq!(state.total_denials_logged, total_attempts);
        assert_eq!(state.denial_records_evicted, 7);
        assert_eq!(state.oldest_denial_index, 7);
        assert_eq!(state.denial_counts.recipient_not_approved, 3);
        assert_eq!(state.denial_counts.vault_frozen, total_attempts - 3);

        let retained = vault.get_denial_log(Some(0), Some(DENIAL_LOG_CAPACITY));
        assert_eq!(retained.len(), DENIAL_LOG_CAPACITY as usize);
        assert_eq!(retained[0].attempted_amount.0, 8);
        assert_eq!(retained[DENIAL_LOG_CAPACITY as usize - 1].attempted_amount.0, total_attempts as u128);

        let latest_denial = latest_event("payment_denied");
        assert_eq!(latest_denial["denial_sequence"].as_u64(), Some(total_attempts - 1));
        assert_eq!(latest_denial["denial_records_evicted"].as_u64(), Some(7));
    }

    #[test]
    #[should_panic(expected = "ERR_AUTH_ID_TOO_LONG")]
    fn test_authorization_id_length_is_capped_for_denial_storage() {
        let (_builder, mut vault) = setup_context();
        vault.authorize_payment(
            "x".repeat(MAX_AUTH_ID_BYTES + 1),
            agent(),
            approved_recipient(),
            U128(1_000),
            U64(1_700_000_000_000_000_000 + 3600_000_000_000),
            None,
        );
    }

    #[test]
    fn test_unauthorized_initiator_is_denied_and_does_not_freeze_vault() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(attacker());
        testing_env!(builder.build());
        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000),
        );

        assert!(!res.success);
        assert_eq!(res.status, "DENIED");
        assert_eq!(res.error_code.as_deref(), Some("ERR_UNAUTHORIZED_INITIATOR"));
        assert!(!vault.get_authorization("auth_001".to_string()).unwrap().used);
        assert_eq!(vault.reserved_balance_yocto, 0);
        assert_eq!(vault.consecutive_violations, 0);
        assert!(vault.get_denial_log(None, None).is_empty());
        assert!(get_created_receipts().is_empty(), "Unauthorized caller must not schedule a transfer");
        assert!(get_logs().iter().any(|line| line.contains("payment_denied")));
    }

    #[test]
    fn test_failed_transfer_releases_authorization_and_duplicate_callback_is_ignored() {
        let (mut builder, mut vault) = setup_context();
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000),
        );
        assert!(res.success);
        let transfer_id = vault
            .get_authorization("auth_001".to_string())
            .unwrap()
            .pending_transfer_id
            .unwrap();
        assert_eq!(vault.reserved_balance_yocto, 5_000_000_000_000_000_000_000_000);

        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Failed);
        assert!(vault.on_transfer_complete("auth_001".to_string(), transfer_id));

        let auth = vault.get_authorization("auth_001".to_string()).unwrap();
        assert!(!auth.used);
        assert_eq!(auth.pending_transfer_id, None);
        assert_eq!(vault.reserved_balance_yocto, 0);
        assert!(vault.get_denial_log(None, None).is_empty());
        assert!(get_logs().iter().any(|line| line.contains("payment_transfer_failed")));

        // The authorization is retryable after failure. A stale callback for
        // the previous attempt must not release the new attempt's reserve.
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        let retry = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000),
        );
        assert!(retry.success);
        let retry_id = vault
            .get_authorization("auth_001".to_string())
            .unwrap()
            .pending_transfer_id
            .unwrap();
        assert_ne!(retry_id, transfer_id);
        assert_eq!(vault.reserved_balance_yocto, 5_000_000_000_000_000_000_000_000);

        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Failed);
        assert!(!vault.on_transfer_complete("auth_001".to_string(), transfer_id));
        assert_eq!(vault.reserved_balance_yocto, 5_000_000_000_000_000_000_000_000);
        assert_eq!(
            vault.get_authorization("auth_001".to_string()).unwrap().pending_transfer_id,
            Some(retry_id)
        );
    }

    #[test]
    fn test_callback_without_transfer_result_leaves_reservation_fail_closed() {
        let (mut builder, mut vault) = setup_context();
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        assert!(vault
            .request_payment(
                "auth_001".to_string(),
                approved_recipient(),
                U128(5_000_000_000_000_000_000_000_000),
            )
            .success);

        let transfer_id = vault
            .get_authorization("auth_001".to_string())
            .unwrap()
            .pending_transfer_id
            .unwrap();
        let reserved = vault.reserved_balance_yocto;

        // A callback without exactly one promise result cannot settle. In the
        // real runtime the private callback receives one result; this also
        // verifies the guard never releases funds on missing evidence.
        builder.predecessor_account_id(vault_account());
        testing_env!(builder.build());
        assert!(!vault.on_transfer_complete("auth_001".to_string(), transfer_id));
        let auth = vault.get_authorization("auth_001".to_string()).unwrap();
        assert!(auth.used);
        assert_eq!(auth.pending_transfer_id, Some(transfer_id));
        assert_eq!(vault.reserved_balance_yocto, reserved);
        assert!(vault.pending_transfers.get(&transfer_id).is_some());
    }

    #[test]
    fn test_freeze_does_not_cancel_pending_transfer_and_callback_settles_it() {
        let (mut builder, mut vault) = setup_context();
        builder.predecessor_account_id(agent());
        testing_env!(builder.build());
        assert!(vault
            .request_payment(
                "auth_001".to_string(),
                approved_recipient(),
                U128(5_000_000_000_000_000_000_000_000),
            )
            .success);
        let transfer_id = vault
            .get_authorization("auth_001".to_string())
            .unwrap()
            .pending_transfer_id
            .unwrap();

        builder.predecessor_account_id(owner());
        testing_env!(builder.build());
        vault.emergency_freeze();
        assert!(vault.is_frozen);
        assert_eq!(vault.reserved_balance_yocto, 5_000_000_000_000_000_000_000_000);

        builder.predecessor_account_id(vault_account());
        testing_env_with_promise_results(builder.build(), MockPromiseResult::Successful(vec![]));
        assert!(vault.on_transfer_complete("auth_001".to_string(), transfer_id));

        assert!(vault.is_frozen, "settlement must not unfreeze the vault");
        assert_eq!(vault.reserved_balance_yocto, 0);
        let auth = vault.get_authorization("auth_001".to_string()).unwrap();
        assert!(auth.used);
        assert_eq!(auth.pending_transfer_id, None);
        assert!(vault.pending_transfers.get(&transfer_id).is_none());
    }

    #[test]
    fn test_amount_exceeded_denied() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(15_000_000_000_000_000_000_000_000), // 15 NEAR > 10 NEAR ceiling
        );

        assert!(!res.success, "Over-limit payment must be blocked");
        assert_eq!(res.error_code.unwrap(), "ERR_AMOUNT_EXCEEDED");
        assert_eq!(res.amount_transferred.0, 0);
    }

    #[test]
    fn test_zero_amount_denied_without_consuming_authorization() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        let res = vault.request_payment("auth_001".to_string(), approved_recipient(), U128(0));

        assert!(!res.success);
        assert_eq!(res.error_code.unwrap(), "ERR_INVALID_AMOUNT");
        assert_eq!(res.amount_transferred.0, 0);
        assert!(!vault.get_authorization("auth_001".to_string()).unwrap().used);
        assert_eq!(vault.get_denial_log(None, None).len(), 1);
    }

    #[test]
    fn test_expired_authorization_denied() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        // Set timestamp past expiry (+2 hours)
        builder.block_timestamp(1_700_000_000_000_000_000 + 7200_000_000_000);
        testing_env!(builder.build());

        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(5_000_000_000_000_000_000_000_000),
        );

        assert!(!res.success, "Expired authorization must be blocked");
        assert_eq!(res.error_code.unwrap(), "ERR_AUTH_EXPIRED");
        assert_eq!(res.amount_transferred.0, 0);
    }

    #[test]
    fn test_reused_authorization_denied() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        // First attempt succeeds
        let res1 = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(4_000_000_000_000_000_000_000_000),
        );
        assert!(res1.success);

        // Replay attempt fails
        let res2 = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(4_000_000_000_000_000_000_000_000),
        );
        assert!(!res2.success, "Replaying authorization must be blocked");
        assert_eq!(res2.error_code.unwrap(), "ERR_AUTH_ALREADY_USED");
        assert_eq!(res2.amount_transferred.0, 0);
    }

    #[test]
    #[should_panic(expected = "ERR_UNAUTHORIZED")]
    fn test_unauthorized_caller_cannot_change_rules() {
        let (mut builder, mut vault) = setup_context();

        // Attacker calls authorize_payment
        builder.predecessor_account_id(attacker());
        testing_env!(builder.build());

        vault.authorize_payment(
            "hacker_auth".to_string(),
            attacker(),
            attacker(),
            U128(50_000_000_000_000_000_000_000_000),
            U64(1_700_000_000_000_000_000 + 3600_000_000_000),
            None,
        );
    }

    #[test]
    fn test_consecutive_violations_auto_freeze() {
        let (mut builder, mut vault) = setup_context();

        builder.predecessor_account_id(agent());
        testing_env!(builder.build());

        assert!(!vault.is_frozen);

        // 3 consecutive attacks
        for _ in 0..3 {
            vault.request_payment(
                "auth_001".to_string(),
                attacker(),
                U128(1_000_000_000_000_000_000_000_000),
            );
        }

        assert!(vault.is_frozen, "Vault must auto-freeze after 3 violations");

        // Next attempt fails with ERR_VAULT_FROZEN even if recipient is valid
        let res = vault.request_payment(
            "auth_001".to_string(),
            approved_recipient(),
            U128(1_000_000_000_000_000_000_000_000),
        );
        assert_eq!(res.error_code.unwrap(), "ERR_VAULT_FROZEN");

        // Owner unfreezes
        builder.predecessor_account_id(owner());
        testing_env!(builder.build());
        vault.unfreeze();
        assert!(!vault.is_frozen);
    }
}
