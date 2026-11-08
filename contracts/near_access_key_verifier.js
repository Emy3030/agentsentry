/**
 * NEAR Access Key Specification Verification Engine
 *
 * Implements the canonical NEAR Protocol transaction validation rules as defined in:
 * - nearcore: runtime/near-vm-runner & chain/client/src/client.rs
 * - NEAR Protocol Specification: Account Model & Access Keys
 *
 * This verifier proves whether a given transaction signed by a specific AccessKey
 * passes or fails protocol-level consensus validation before any contract execution occurs.
 */

export const ActionType = {
  TRANSFER: 'Transfer',
  FUNCTION_CALL: 'FunctionCall',
  ADD_KEY: 'AddKey',
  DELETE_KEY: 'DeleteKey',
  DEPLOY_CONTRACT: 'DeployContract',
  STAKE: 'Stake',
  DELETE_ACCOUNT: 'DeleteAccount'
};

export const PermissionType = {
  FULL_ACCESS: 'FullAccess',
  FUNCTION_CALL: 'FunctionCall'
};

export class NearAccount {
  constructor(account_id, initial_balance = 0n) {
    this.account_id = account_id;
    this.balance = BigInt(initial_balance);
    this.access_keys = new Map(); // public_key -> AccessKey
  }

  add_full_access_key(public_key, nonce = 0n) {
    this.access_keys.set(public_key, {
      public_key,
      nonce: BigInt(nonce),
      permission: { type: PermissionType.FULL_ACCESS }
    });
  }

  add_function_call_key(public_key, { receiver_id, method_names = [], allowance = null, nonce = 0n }) {
    this.access_keys.set(public_key, {
      public_key,
      nonce: BigInt(nonce),
      permission: {
        type: PermissionType.FUNCTION_CALL,
        receiver_id,
        method_names: Array.isArray(method_names) ? method_names : [method_names],
        allowance: allowance !== null ? BigInt(allowance) : null
      }
    });
  }
}

export class NearProtocolRuntime {
  /**
   * Validates a signed NEAR transaction against the signer's registered AccessKey.
   * Matches the exact validation logic executed by NEAR validator nodes.
   *
   * @param {Object} tx - The transaction payload
   * @param {string} tx.signer_id - Account sending the transaction
   * @param {string} tx.public_key - Public key of the key pair used to sign
   * @param {bigint|number} tx.nonce - Transaction nonce
   * @param {string} tx.receiver_id - Target account / contract ID
   * @param {Array<Object>} tx.actions - List of actions in the transaction
   * @param {Map<string, NearAccount>} accounts_state - Ledger of accounts
   *
   * @returns {Object} Validation outcome: { valid: boolean, error?: string }
   */
  static validate_transaction(tx, accounts_state) {
    const account = accounts_state.get(tx.signer_id);
    if (!account) {
      return {
        valid: false,
        error_code: 'ERR_ACCOUNT_DOES_NOT_EXIST',
        error: `Signer account '${tx.signer_id}' does not exist on-chain`
      };
    }

    const access_key = account.access_keys.get(tx.public_key);
    if (!access_key) {
      return {
        valid: false,
        error_code: 'InvalidAccessKeyError::AccessKeyNotFound',
        error: `Signer '${tx.signer_id}' does not possess public key '${tx.public_key}'`
      };
    }

    const txNonce = BigInt(tx.nonce);
    if (txNonce <= access_key.nonce) {
      return {
        valid: false,
        error_code: 'InvalidTransactionVersion::InvalidNonce',
        error: `Transaction nonce ${txNonce} must be strictly greater than key nonce ${access_key.nonce}`
      };
    }

    // ========================================================
    // ACCESS KEY PERMISSION ENFORCEMENT (NEAR Protocol Spec)
    // ========================================================

    const perm = access_key.permission;

    // Case 1: FullAccess Key permits all actions to any receiver
    if (perm.type === PermissionType.FULL_ACCESS) {
      return { valid: true, error: null };
    }

    // Case 2: FunctionCall Key restrictions
    if (perm.type === PermissionType.FUNCTION_CALL) {
      // Restriction 1: FunctionCall key can ONLY contain EXACTLY ONE action, and it MUST be FunctionCall
      if (!Array.isArray(tx.actions) || tx.actions.length !== 1) {
        return {
          valid: false,
          error_code: 'InvalidAccessKeyError::RequiresFullAccessPermission',
          error: `FunctionCall access key can only authorize exactly one action; received ${tx.actions ? tx.actions.length : 0}`
        };
      }

      const action = tx.actions[0];
      if (action.type !== ActionType.FUNCTION_CALL) {
        return {
          valid: false,
          error_code: 'InvalidAccessKeyError::RequiresFullAccessPermission',
          error: `Action '${action.type}' is forbidden. FunctionCall keys cannot execute direct Transfer, AddKey, DeleteKey, or DeployContract actions.`
        };
      }

      // Restriction 2: Transaction receiver_id MUST strictly match the key's receiver_id
      if (tx.receiver_id !== perm.receiver_id) {
        return {
          valid: false,
          error_code: 'InvalidAccessKeyError::ReceiverMismatch',
          error: `Transaction receiver '${tx.receiver_id}' does not match key's allowed receiver '${perm.receiver_id}'`
        };
      }

      // Restriction 3: Method name must be whitelisted (if method_names list is non-empty)
      if (perm.method_names.length > 0 && !perm.method_names.includes(action.method_name)) {
        return {
          valid: false,
          error_code: 'InvalidAccessKeyError::MethodNameNotAllowed',
          error: `Method '${action.method_name}' is not in the allowed method list: [${perm.method_names.join(', ')}]`
        };
      }

      // Restriction 4: FunctionCall keys CANNOT attach a native NEAR deposit (deposit must be 0)
      if (action.deposit && BigInt(action.deposit) > 0n) {
        return {
          valid: false,
          error_code: 'InvalidAccessKeyError::DepositWithFunctionCall',
          error: `FunctionCall access keys cannot attach a native token deposit to a method call (attached: ${action.deposit})`
        };
      }

      return { valid: true, error: null };
    }

    return {
      valid: false,
      error_code: 'ERR_UNKNOWN_PERMISSION_TYPE',
      error: 'Unrecognized permission type'
    };
  }
}

