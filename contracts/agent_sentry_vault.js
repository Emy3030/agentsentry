/**
 * [SIMULATION / REFERENCE MODEL] AgentSentry Vault Contract Logic
 *
 * NOTE: This JavaScript file is a behavioral simulation and specification model.
 * It is NOT a compiled NEAR WebAssembly smart contract.
 * For the genuine NEAR smart contract, see `src/lib.rs` (Rust NEAR SDK).
 *
 * Implements NEAR Protocol execution semantics:
 * - Deterministic policy enforcement (No AI in the decision path).
 * - Enforces owner-approved recipient, spending limit, expiry timestamp, and single-use nonce.
 * - Guarantees zero fund leakage upon any policy denial.
 * - Supports dual denial modes:
 *     1. State-Preserving Denial: records incident in the audit log and returns DENIED.
 *     2. Atomic Revert Denial: panics immediately, ensuring transaction abort and RPC failure log.
 * - Owner controls authorizations, freezing, unfreezing, and treasury withdrawals.
 */

export class AgentSentryVault {
  /**
   * Initializes the vault.
   * @param {Object} params
   * @param {string} params.owner_id - The authorized owner NEAR account ID.
   * @param {bigint|string|number} [params.initial_balance=0n] - Initial vault balance in yoctoNEAR.
   * @param {number} [params.max_consecutive_violations=3] - Threshold to auto-freeze vault.
   */
  constructor({ owner_id, initial_balance = 0n, max_consecutive_violations = 3 } = {}) {
    if (!owner_id || typeof owner_id !== 'string') {
      throw new Error('ERR_INVALID_OWNER: owner_id must be a non-empty string');
    }

    this.owner_id = owner_id;
    this.vault_balance = BigInt(initial_balance);
    this.is_frozen = false;
    this.max_consecutive_violations = max_consecutive_violations;
    this.consecutive_violations_count = 0;

    // Authorizations map: auth_id -> Authorization object
    this.authorizations = new Map();

    // Verifiable audit log of events
    this.audit_log = [];
  }

  // ==========================================
  // VIEW METHODS
  // ==========================================

  get_vault_state() {
    return {
      owner_id: this.owner_id,
      vault_balance: this.vault_balance.toString(),
      is_frozen: this.is_frozen,
      consecutive_violations_count: this.consecutive_violations_count,
      total_authorizations: this.authorizations.size,
      audit_log_length: this.audit_log.length
    };
  }

  get_authorization(auth_id) {
    const auth = this.authorizations.get(auth_id);
    if (!auth) return null;
    return {
      auth_id: auth.auth_id,
      approved_recipient: auth.approved_recipient,
      max_amount: auth.max_amount.toString(),
      expires_at_ns: auth.expires_at_ns.toString(),
      nonce: auth.nonce,
      used: auth.used,
      revoked: auth.revoked,
      created_at_ns: auth.created_at_ns.toString()
    };
  }

  get_audit_log() {
    return [...this.audit_log];
  }

  // ==========================================
  // OWNER GOVERNANCE METHODS
  // ==========================================

  /**
   * Authorizes a prospective payment rule. Only the vault owner can invoke this.
   */
  authorize_payment({
    caller_id,
    auth_id,
    approved_recipient,
    max_amount,
    expires_at_ns,
    nonce,
    current_timestamp_ns = 0n
  }) {
    this._assert_owner(caller_id);

    if (this.is_frozen) {
      throw new Error('ERR_VAULT_FROZEN: Cannot authorize rules while vault is frozen');
    }
    if (!auth_id || typeof auth_id !== 'string') {
      throw new Error('ERR_INVALID_AUTH_ID: auth_id is required');
    }
    if (this.authorizations.has(auth_id)) {
      throw new Error(`ERR_AUTH_ID_EXISTS: Authorization '${auth_id}' is already registered`);
    }
    if (!approved_recipient || typeof approved_recipient !== 'string') {
      throw new Error('ERR_INVALID_RECIPIENT: approved_recipient is required');
    }

    const parsedMax = BigInt(max_amount);
    if (parsedMax <= 0n) {
      throw new Error('ERR_INVALID_MAX_AMOUNT: max_amount must be greater than zero');
    }

    const parsedExpiry = BigInt(expires_at_ns);
    const parsedCurrentTime = BigInt(current_timestamp_ns);
    if (parsedExpiry <= parsedCurrentTime) {
      throw new Error('ERR_INVALID_EXPIRY: expiry timestamp must be in the future');
    }

    const auth = {
      auth_id,
      approved_recipient,
      max_amount: parsedMax,
      expires_at_ns: parsedExpiry,
      nonce: nonce || auth_id,
      used: false,
      revoked: false,
      created_at_ns: parsedCurrentTime
    };

    this.authorizations.set(auth_id, auth);

    this._log_event('AUTHORIZATION_CREATED', {
      auth_id,
      approved_recipient,
      max_amount: parsedMax.toString(),
      expires_at_ns: parsedExpiry.toString(),
      nonce: auth.nonce
    });

    return { success: true, auth_id };
  }

  /**
   * Revokes an existing authorization. Only owner.
   */
  revoke_authorization({ caller_id, auth_id }) {
    this._assert_owner(caller_id);

    const auth = this.authorizations.get(auth_id);
    if (!auth) {
      throw new Error(`ERR_AUTH_NOT_FOUND: Authorization '${auth_id}' does not exist`);
    }
    if (auth.used) {
      throw new Error(`ERR_AUTH_ALREADY_USED: Cannot revoke authorization '${auth_id}' because it has already been used`);
    }

    auth.revoked = true;
    this._log_event('AUTHORIZATION_REVOKED', { auth_id });
    return { success: true, auth_id };
  }

  /**
   * Emergency Freeze: Halts all payment dispatches immediately.
   */
  emergency_freeze({ caller_id }) {
    this._assert_owner(caller_id);
    this.is_frozen = true;
    this._log_event('VAULT_FROZEN', { initiated_by: caller_id });
    return { success: true, is_frozen: true };
  }

  /**
   * Unfreezes vault after security review.
   */
  unfreeze({ caller_id }) {
    this._assert_owner(caller_id);
    this.is_frozen = false;
    this.consecutive_violations_count = 0;
    this._log_event('VAULT_UNFROZEN', { initiated_by: caller_id });
    return { success: true, is_frozen: false };
  }

  /**
   * Deposits funds into the vault balance.
   */
  deposit({ amount }) {
    const parsedAmount = BigInt(amount);
    if (parsedAmount <= 0n) {
      throw new Error('ERR_INVALID_DEPOSIT: amount must be positive');
    }
    this.vault_balance += parsedAmount;
    this._log_event('FUNDS_DEPOSITED', {
      amount: parsedAmount.toString(),
      new_balance: this.vault_balance.toString()
    });
    return { success: true, vault_balance: this.vault_balance.toString() };
  }

  /**
   * Owner withdraws funds from the vault.
   */
  withdraw_funds({ caller_id, recipient, amount }) {
    this._assert_owner(caller_id);
    const parsedAmount = BigInt(amount);
    if (parsedAmount <= 0n) {
      throw new Error('ERR_INVALID_WITHDRAWAL: amount must be positive');
    }
    if (this.vault_balance < parsedAmount) {
      throw new Error('ERR_INSUFFICIENT_VAULT_BALANCE: insufficient funds');
    }

    this.vault_balance -= parsedAmount;
    this._log_event('FUNDS_WITHDRAWN', {
      recipient,
      amount: parsedAmount.toString(),
      remaining_balance: this.vault_balance.toString()
    });

    return {
      success: true,
      amount_withdrawn: parsedAmount.toString(),
      remaining_balance: this.vault_balance.toString()
    };
  }

  // ==========================================
  // PAYMENT EXECUTION & VERIFICATION ENGINE
  // ==========================================

  /**
   * Requests a payment against an approved authorization.
   * Can be called by an agent possessing a FunctionCall access key.
   *
   * @param {Object} params
   * @param {string} params.caller_id - Account invoking the function.
   * @param {string} params.auth_id - Unique authorization identifier.
   * @param {string} params.recipient - Destination account for payment.
   * @param {bigint|string|number} params.amount - Payment amount in yoctoNEAR.
   * @param {bigint|string|number} params.current_timestamp_ns - Block timestamp.
   * @param {boolean} [params.revert_on_denial=false] - If true, throws Error (panics) on failure.
   *
   * @returns {Object} Result of validation and transfer.
   */
  request_payment({
    caller_id,
    auth_id,
    recipient,
    amount,
    current_timestamp_ns,
    revert_on_denial = false
  }) {
    const parsedAmount = BigInt(amount);
    const parsedTime = BigInt(current_timestamp_ns);

    // Rule 1: Vault must not be frozen
    if (this.is_frozen) {
      return this._handle_denial(
        'ERR_VAULT_FROZEN',
        'Vault is currently frozen due to an emergency or security incident',
        { caller_id, auth_id, recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 2: Authorization must exist
    const auth = this.authorizations.get(auth_id);
    if (!auth) {
      return this._handle_denial(
        'ERR_AUTH_NOT_FOUND',
        `No authorization found for ID '${auth_id}'`,
        { caller_id, auth_id, recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 3: Authorization must not be revoked
    if (auth.revoked) {
      return this._handle_denial(
        'ERR_AUTH_REVOKED',
        `Authorization '${auth_id}' has been revoked by vault owner`,
        { caller_id, auth_id, recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 4: Nonce / Single-use check: must not be already used
    if (auth.used) {
      return this._handle_denial(
        'ERR_AUTH_ALREADY_USED',
        `Authorization '${auth_id}' (nonce: ${auth.nonce}) has already been executed`,
        { caller_id, auth_id, recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 5: Expiration check
    if (parsedTime > auth.expires_at_ns) {
      return this._handle_denial(
        'ERR_AUTH_EXPIRED',
        `Authorization '${auth_id}' expired at ${auth.expires_at_ns}ns (current: ${parsedTime}ns)`,
        { caller_id, auth_id, recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 6: Recipient check: Must match the approved recipient
    if (recipient !== auth.approved_recipient) {
      return this._handle_denial(
        'ERR_RECIPIENT_NOT_APPROVED',
        `Target recipient '${recipient}' does not match approved recipient '${auth.approved_recipient}'`,
        { caller_id, auth_id, recipient, approved_recipient: auth.approved_recipient, amount: parsedAmount },
        revert_on_denial
      );
    }

    // Rule 7: Spending limit check: Amount must not exceed authorized maximum
    if (parsedAmount > auth.max_amount) {
      return this._handle_denial(
        'ERR_AMOUNT_EXCEEDED',
        `Requested amount ${parsedAmount} exceeds authorized limit ${auth.max_amount}`,
        { caller_id, auth_id, recipient, amount: parsedAmount, max_allowed: auth.max_amount },
        revert_on_denial
      );
    }

    // Rule 8: Vault Solvency Check
    if (this.vault_balance < parsedAmount) {
      return this._handle_denial(
        'ERR_INSUFFICIENT_VAULT_BALANCE',
        `Vault balance (${this.vault_balance}) is less than requested payment (${parsedAmount})`,
        { caller_id, auth_id, recipient, amount: parsedAmount, vault_balance: this.vault_balance },
        revert_on_denial
      );
    }

    // ==========================================
    // ALL RULES PASSED: ATOMIC STATE UPDATE & TRANSFER
    // ==========================================

    auth.used = true;
    this.vault_balance -= parsedAmount;
    this.consecutive_violations_count = 0; // Reset violation counter on valid action

    this._log_event('PAYMENT_EXECUTED', {
      auth_id,
      caller_id,
      recipient,
      amount: parsedAmount.toString(),
      remaining_vault_balance: this.vault_balance.toString(),
      timestamp_ns: parsedTime.toString()
    });

    return {
      success: true,
      status: 'EXECUTED',
      auth_id,
      recipient,
      amount_transferred: parsedAmount.toString(),
      remaining_vault_balance: this.vault_balance.toString()
    };
  }

  // ==========================================
  // INTERNAL HELPERS
  // ==========================================

  _assert_owner(caller_id) {
    if (caller_id !== this.owner_id) {
      throw new Error(`ERR_UNAUTHORIZED: Caller '${caller_id}' is not the vault owner ('${this.owner_id}')`);
    }
  }

  _handle_denial(error_code, reason, context, revert_on_denial) {
    // 1. Vault funds are untouched (guaranteed)
    // 2. Track violation count
    this.consecutive_violations_count += 1;

    // 3. Auto-freeze if threshold exceeded
    if (this.consecutive_violations_count >= this.max_consecutive_violations) {
      this.is_frozen = true;
    }

    // 4. Record tamper-evident denial event in contract audit log
    const denial_record = {
      event: 'PAYMENT_DENIED',
      error_code,
      reason,
      context: {
        ...context,
        amount: context.amount ? context.amount.toString() : '0',
        max_allowed: context.max_allowed ? context.max_allowed.toString() : undefined,
        vault_balance: context.vault_balance ? context.vault_balance.toString() : undefined
      },
      consecutive_violations: this.consecutive_violations_count,
      vault_auto_frozen: this.is_frozen
    };

    this.audit_log.push(denial_record);

    // 5. If revert_on_denial is requested (simulating NEAR transaction panic), throw Error
    if (revert_on_denial) {
      throw new Error(`[NEAR_PANIC] ${error_code}: ${reason}`);
    }

    // 6. Otherwise return observable structured DENIED response
    return {
      success: false,
      status: 'DENIED',
      error_code,
      reason,
      amount_transferred: '0',
      remaining_vault_balance: this.vault_balance.toString(),
      vault_auto_frozen: this.is_frozen
    };
  }

  _log_event(event, data) {
    this.audit_log.push({
      event,
      data,
      timestamp: Date.now()
    });
  }
}

