// =============================================================================
// BastionPro Payment Validator — Pure Rule Engine
// =============================================================================
// This module contains ONLY deterministic, pure-Rust validation logic.
// It has NO dependencies on near-sdk host functions (env::*).
// This makes it unit-testable on any host platform without the near-sdk
// `unit-testing` feature or a C toolchain.
// =============================================================================

/// The reason a payment was denied or the result of validation.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ValidationResult {
    /// Payment is approved. Proceed with transfer.
    Approved,
    /// Payment was denied. Carry the error code and human reason.
    Denied { code: &'static str, reason: &'static str },
}

impl ValidationResult {
    pub fn is_approved(&self) -> bool {
        matches!(self, ValidationResult::Approved)
    }

    pub fn error_code(&self) -> Option<&'static str> {
        match self {
            ValidationResult::Denied { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// Snapshot of an authorization rule used for validation (no SDK types).
pub struct AuthSnapshot {
    pub approved_recipient: String,
    pub max_amount_yocto: u128,
    pub expires_at_ns: u64,
    pub used: bool,
    pub revoked: bool,
}

/// Run all BastionPro payment validation checks deterministically.
/// Parameters use primitive types only — no NEAR SDK types.
///
/// Checks in order:
///   1. Vault freeze
///   2. Auth existence (caller supplies `Option<AuthSnapshot>`)
///   3. Revocation
///   4. Single-use replay
///   5. Expiry
///   6. Recipient match
///   7. Spending ceiling
///   8. Vault solvency
pub fn validate_payment(
    is_frozen: bool,
    auth: Option<&AuthSnapshot>,
    requested_recipient: &str,
    requested_amount_yocto: u128,
    current_time_ns: u64,
    vault_balance_yocto: u128,
) -> ValidationResult {
    // 1. Vault freeze
    if is_frozen {
        return ValidationResult::Denied {
            code: "ERR_VAULT_FROZEN",
            reason: "Vault is currently frozen due to an emergency or security violation",
        };
    }

    // 2. Auth existence
    let auth = match auth {
        Some(a) => a,
        None => {
            return ValidationResult::Denied {
                code: "ERR_AUTH_NOT_FOUND",
                reason: "No authorization found for the given auth_id",
            };
        }
    };

    // 3. Revocation
    if auth.revoked {
        return ValidationResult::Denied {
            code: "ERR_AUTH_REVOKED",
            reason: "Authorization has been revoked by the vault owner",
        };
    }

    // 4. Single-use replay
    if auth.used {
        return ValidationResult::Denied {
            code: "ERR_AUTH_ALREADY_USED",
            reason: "Authorization has already been executed",
        };
    }

    if requested_amount_yocto == 0 {
        return ValidationResult::Denied {
            code: "ERR_INVALID_AMOUNT",
            reason: "Requested payment amount must be positive",
        };
    }

    // 5. Expiry
    if current_time_ns > auth.expires_at_ns {
        return ValidationResult::Denied {
            code: "ERR_AUTH_EXPIRED",
            reason: "Authorization has expired",
        };
    }

    // 6. Recipient match
    if requested_recipient != auth.approved_recipient {
        return ValidationResult::Denied {
            code: "ERR_RECIPIENT_NOT_APPROVED",
            reason: "Recipient does not match the approved recipient in authorization",
        };
    }

    // 7. Spending ceiling
    if requested_amount_yocto > auth.max_amount_yocto {
        return ValidationResult::Denied {
            code: "ERR_AMOUNT_EXCEEDED",
            reason: "Requested payment exceeds authorized ceiling",
        };
    }

    // 8. Vault solvency
    if vault_balance_yocto < requested_amount_yocto {
        return ValidationResult::Denied {
            code: "ERR_INSUFFICIENT_VAULT_BALANCE",
            reason: "Vault balance is insufficient to cover payment",
        };
    }

    ValidationResult::Approved
}

/// Computes whether consecutive violations have crossed the auto-freeze threshold.
/// Pure function — no side effects.
pub fn should_auto_freeze(consecutive_violations: u32, max_violations: u32) -> bool {
    consecutive_violations >= max_violations
}

// =============================================================================
// UNIT TESTS — pure Rust, no NEAR host functions, no C toolchain required
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    const YOCTO_10: u128 = 10_000_000_000_000_000_000_000_000; // 10 NEAR
    const YOCTO_5: u128  =  5_000_000_000_000_000_000_000_000; //  5 NEAR
    const YOCTO_15: u128 = 15_000_000_000_000_000_000_000_000; // 15 NEAR
    const YOCTO_4: u128  =  4_000_000_000_000_000_000_000_000; //  4 NEAR
    const VAULT_BAL: u128 = 100_000_000_000_000_000_000_000_000; // 100 NEAR

    const T_BASE: u64 = 1_700_000_000_000_000_000;
    const T_EXPIRY: u64 = T_BASE + 3_600_000_000_000; // +1 hour
    const T_NOW: u64 = T_BASE + 60_000_000_000;       // +1 min (valid)
    const T_PAST: u64 = T_BASE + 7_200_000_000_000;   // +2 hours (expired)

    fn good_auth() -> AuthSnapshot {
        AuthSnapshot {
            approved_recipient: "aws_cloud.near".to_string(),
            max_amount_yocto: YOCTO_10,
            expires_at_ns: T_EXPIRY,
            used: false,
            revoked: false,
        }
    }

    // ------------------------------------------------------------------
    // 1. HAPPY PATH
    // ------------------------------------------------------------------

    #[test]
    fn test_valid_payment_approved() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result, ValidationResult::Approved);
    }

    #[test]
    fn test_exact_max_amount_approved() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_10, // exactly at ceiling
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result, ValidationResult::Approved);
    }

    // ------------------------------------------------------------------
    // 2. VAULT FREEZE — must block even valid payment
    // ------------------------------------------------------------------

    #[test]
    fn test_frozen_vault_blocks_valid_payment() {
        let auth = good_auth();
        let result = validate_payment(
            true, // frozen
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_VAULT_FROZEN"));
        assert!(!result.is_approved());
    }

    // ------------------------------------------------------------------
    // 3. AUTH NOT FOUND
    // ------------------------------------------------------------------

    #[test]
    fn test_missing_auth_denied() {
        let result = validate_payment(
            false,
            None, // no auth found
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AUTH_NOT_FOUND"));
    }

    // ------------------------------------------------------------------
    // 4. REVOKED AUTH
    // ------------------------------------------------------------------

    #[test]
    fn test_revoked_auth_denied() {
        let mut auth = good_auth();
        auth.revoked = true;
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AUTH_REVOKED"));
    }

    // ------------------------------------------------------------------
    // 5. REPLAY PREVENTION — single-use nonce
    // ------------------------------------------------------------------

    #[test]
    fn test_already_used_auth_denied() {
        let mut auth = good_auth();
        auth.used = true;
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AUTH_ALREADY_USED"));
    }

    // ------------------------------------------------------------------
    // 6. EXPIRY
    // ------------------------------------------------------------------

    #[test]
    fn test_expired_auth_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_PAST, // past expiry
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AUTH_EXPIRED"));
    }

    #[test]
    fn test_exact_expiry_timestamp_still_valid() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_EXPIRY, // exactly at expiry — NOT expired (> not >=)
            VAULT_BAL,
        );
        assert_eq!(result, ValidationResult::Approved);
    }

    #[test]
    fn test_one_nanosecond_past_expiry_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_EXPIRY + 1,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AUTH_EXPIRED"));
    }

    // ------------------------------------------------------------------
    // 7. WRONG RECIPIENT — redirection attack
    // ------------------------------------------------------------------

    #[test]
    fn test_wrong_recipient_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "attacker.near", // not approved_recipient
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_RECIPIENT_NOT_APPROVED"));
        // Critically: zero funds transferred (no transfer in pure logic)
    }

    // ------------------------------------------------------------------
    // 8. SPENDING CEILING
    // ------------------------------------------------------------------

    #[test]
    fn test_amount_exceeds_ceiling_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_15, // 15 NEAR > 10 NEAR ceiling
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AMOUNT_EXCEEDED"));
    }

    #[test]
    fn test_amount_exceeds_ceiling_by_one_yocto_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_10 + 1, // 1 yoctoNEAR over ceiling
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_AMOUNT_EXCEEDED"));
    }

    // ------------------------------------------------------------------
    // 9. VAULT INSOLVENCY
    // ------------------------------------------------------------------

    #[test]
    fn test_insufficient_vault_balance_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_NOW,
            YOCTO_4, // only 4 NEAR in vault, need 5
        );
        assert_eq!(result.error_code(), Some("ERR_INSUFFICIENT_VAULT_BALANCE"));
    }

    // ------------------------------------------------------------------
    // 10. CHECK ORDERING — freeze takes priority over all others
    // ------------------------------------------------------------------

    #[test]
    fn test_freeze_overrides_missing_auth() {
        let result = validate_payment(
            true,
            None, // no auth AND frozen
            "any.near",
            YOCTO_5,
            T_NOW,
            VAULT_BAL,
        );
        // Should report FROZEN, not NOT_FOUND
        assert_eq!(result.error_code(), Some("ERR_VAULT_FROZEN"));
    }

    #[test]
    fn test_freeze_overrides_expired_auth() {
        let auth = good_auth();
        let result = validate_payment(
            true, // frozen
            Some(&auth),
            "aws_cloud.near",
            YOCTO_5,
            T_PAST, // also expired
            VAULT_BAL,
        );
        // Should report FROZEN first
        assert_eq!(result.error_code(), Some("ERR_VAULT_FROZEN"));
    }

    // ------------------------------------------------------------------
    // 11. AUTO-FREEZE THRESHOLD LOGIC
    // ------------------------------------------------------------------

    #[test]
    fn test_auto_freeze_at_threshold() {
        assert!(should_auto_freeze(3, 3));  // exactly at threshold
    }

    #[test]
    fn test_auto_freeze_above_threshold() {
        assert!(should_auto_freeze(4, 3));  // above threshold
    }

    #[test]
    fn test_no_auto_freeze_below_threshold() {
        assert!(!should_auto_freeze(2, 3)); // not yet
    }

    #[test]
    fn test_no_auto_freeze_at_zero() {
        assert!(!should_auto_freeze(0, 3));
    }

    // ------------------------------------------------------------------
    // 12. ZERO-AMOUNT GUARD
    // ------------------------------------------------------------------

    #[test]
    fn test_zero_amount_denied() {
        let auth = good_auth();
        let result = validate_payment(
            false,
            Some(&auth),
            "aws_cloud.near",
            0,
            T_NOW,
            VAULT_BAL,
        );
        assert_eq!(result.error_code(), Some("ERR_INVALID_AMOUNT"));
    }
}

