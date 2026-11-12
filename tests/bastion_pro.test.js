import test from 'node:test';
import assert from 'node:assert/strict';
import { BastionProVault } from '../contracts/bastion_pro_vault.js';
import {
  NearAccount,
  NearProtocolRuntime,
  ActionType
} from '../contracts/near_access_key_verifier.js';

// Constant constants for test fixtures
const OWNER_ID = 'acme_corp.testnet';
const AGENT_ID = 'procurement_agent.testnet';
const APPROVED_RECIPIENT = 'aws_cloud_services.testnet';
const ATTACKER_RECIPIENT = 'malicious_hacker.testnet';
const VAULT_ID = 'bastionpro-vault.testnet';

// 1 NEAR = 10^24 yoctoNEAR
const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;
const INITIAL_VAULT_BALANCE = 100n * ONE_NEAR; // 100 NEAR
const MAX_AUTHORIZED_AMOUNT = 10n * ONE_NEAR;  // 10 NEAR

// Timestamps in nanoseconds
const T_BASE = 1_700_000_000_000_000_000n; // arbitrary base timestamp
const T_EXPIRY = T_BASE + 3600_000_000_000n; // +1 hour

test('[SIMULATION] BastionPro Reference Behavioral Suite', async (t) => {
  // Setup fresh vault fixture for each test
  function setupVault() {
    const vault = new BastionProVault({
      owner_id: OWNER_ID,
      initial_balance: INITIAL_VAULT_BALANCE,
      max_consecutive_violations: 3
    });

    // Owner creates valid authorization
    vault.authorize_payment({
      caller_id: OWNER_ID,
      auth_id: 'auth_payment_001',
      approved_recipient: APPROVED_RECIPIENT,
      max_amount: MAX_AUTHORIZED_AMOUNT,
      expires_at_ns: T_EXPIRY,
      nonce: 'nonce_001',
      current_timestamp_ns: T_BASE
    });

    return vault;
  }

  // =========================================================================
  // TEST 1: Valid payment to the approved recipient succeeds
  // =========================================================================
  await t.test('Test 1 [SIMULATION]: Valid payment to approved recipient succeeds and decrements vault balance', () => {
    const vault = setupVault();
    const paymentAmount = 5n * ONE_NEAR;

    const result = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: paymentAmount,
      current_timestamp_ns: T_BASE + 60_000_000_000n // +1 minute
    });

    assert.equal(result.success, true, 'Payment should succeed');
    assert.equal(result.status, 'EXECUTED');
    assert.equal(result.recipient, APPROVED_RECIPIENT);
    assert.equal(result.amount_transferred, paymentAmount.toString());

    // Verify vault balance was decremented exactly by the transferred amount
    const expectedBalance = INITIAL_VAULT_BALANCE - paymentAmount;
    assert.equal(vault.vault_balance, expectedBalance, 'Vault balance must decrease by exact payment amount');

    // Verify authorization marked as used
    const authState = vault.get_authorization('auth_payment_001');
    assert.equal(authState.used, true, 'Authorization must be flagged as used');
  });

  // =========================================================================
  // TEST 2: Payment to an unapproved recipient is denied
  // =========================================================================
  await t.test('Test 2 [SIMULATION]: Payment to unapproved recipient is denied; vault funds completely unchanged', () => {
    const vault = setupVault();
    const initialBalance = vault.vault_balance;

    const result = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: ATTACKER_RECIPIENT, // Malicious redirection
      amount: 5n * ONE_NEAR,
      current_timestamp_ns: T_BASE + 60_000_000_000n
    });

    assert.equal(result.success, false, 'Payment to unauthorized recipient must be blocked');
    assert.equal(result.status, 'DENIED');
    assert.equal(result.error_code, 'ERR_RECIPIENT_NOT_APPROVED');
    assert.equal(result.amount_transferred, '0');

    // CRITICAL: Ensure vault funds are untouched
    assert.equal(vault.vault_balance, initialBalance, 'Vault balance must remain completely unchanged');

    // Verify authorization was NOT consumed by the failed attempt
    const authState = vault.get_authorization('auth_payment_001');
    assert.equal(authState.used, false, 'Authorization must remain valid for the legitimate recipient');

    // Verify denial was recorded in audit log
    const audit = vault.get_audit_log();
    const denialLog = audit.find(e => e.event === 'PAYMENT_DENIED');
    assert.ok(denialLog, 'Denial incident must be registered in audit log');
    assert.equal(denialLog.error_code, 'ERR_RECIPIENT_NOT_APPROVED');
  });

  // =========================================================================
  // TEST 3: Payment above the authorised limit is denied
  // =========================================================================
  await t.test('Test 3 [SIMULATION]: Payment above authorized limit is denied; vault funds completely unchanged', () => {
    const vault = setupVault();
    const initialBalance = vault.vault_balance;
    const overLimitAmount = 15n * ONE_NEAR; // Limit is 10 NEAR

    const result = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: overLimitAmount,
      current_timestamp_ns: T_BASE + 60_000_000_000n
    });

    assert.equal(result.success, false, 'Excessive payment amount must be blocked');
    assert.equal(result.status, 'DENIED');
    assert.equal(result.error_code, 'ERR_AMOUNT_EXCEEDED');
    assert.equal(result.amount_transferred, '0');

    // Verify balance untouched
    assert.equal(vault.vault_balance, initialBalance, 'Vault balance must remain completely unchanged');

    // Verify authorization not consumed
    const authState = vault.get_authorization('auth_payment_001');
    assert.equal(authState.used, false);
  });

  // =========================================================================
  // TEST 4: Expired authorisation is denied
  // =========================================================================
  await t.test('Test 4 [SIMULATION]: Expired authorization is denied; vault funds completely unchanged', () => {
    const vault = setupVault();
    const initialBalance = vault.vault_balance;

    // Time is 10 seconds past expiry
    const timePastExpiry = T_EXPIRY + 10_000_000_000n;

    const result = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: 5n * ONE_NEAR,
      current_timestamp_ns: timePastExpiry
    });

    assert.equal(result.success, false, 'Expired authorization must be blocked');
    assert.equal(result.status, 'DENIED');
    assert.equal(result.error_code, 'ERR_AUTH_EXPIRED');
    assert.equal(result.amount_transferred, '0');
    assert.equal(vault.vault_balance, initialBalance, 'Vault balance must remain completely unchanged');
  });

  // =========================================================================
  // TEST 5: Reusing an authorisation is denied (Replay Attack Prevention)
  // =========================================================================
  await t.test('Test 5 [SIMULATION]: Replay attack is blocked; reusing an authorization is denied', () => {
    const vault = setupVault();

    // 1st Attempt: Legitimate payment of 4 NEAR
    const firstAttempt = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: 4n * ONE_NEAR,
      current_timestamp_ns: T_BASE + 60_000_000_000n
    });
    assert.equal(firstAttempt.success, true);
    const balanceAfterFirst = vault.vault_balance;

    // 2nd Attempt: Replay attempt using the SAME authorization
    const replayAttempt = vault.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: 4n * ONE_NEAR,
      current_timestamp_ns: T_BASE + 120_000_000_000n
    });

    assert.equal(replayAttempt.success, false, 'Replaying authorization must be blocked');
    assert.equal(replayAttempt.status, 'DENIED');
    assert.equal(replayAttempt.error_code, 'ERR_AUTH_ALREADY_USED');
    assert.equal(replayAttempt.amount_transferred, '0');

    // Balance must NOT have decremented a second time
    assert.equal(vault.vault_balance, balanceAfterFirst, 'Balance must not change on replay attempt');
  });

  // =========================================================================
  // TEST 6: Unauthorised caller cannot change payment rules or withdraw funds
  // =========================================================================
  await t.test('Test 6 [SIMULATION]: Non-owner caller cannot authorize rules, withdraw, or freeze', () => {
    const vault = setupVault();
    const initialBalance = vault.vault_balance;

    // Hacker attempts to authorize a rule for themselves
    assert.throws(
      () => {
        vault.authorize_payment({
          caller_id: ATTACKER_RECIPIENT,
          auth_id: 'hacker_auth',
          approved_recipient: ATTACKER_RECIPIENT,
          max_amount: 50n * ONE_NEAR,
          expires_at_ns: T_EXPIRY,
          current_timestamp_ns: T_BASE
        });
      },
      /ERR_UNAUTHORIZED/,
      'Non-owner must not be able to create payment authorizations'
    );

    // Hacker attempts to withdraw vault funds
    assert.throws(
      () => {
        vault.withdraw_funds({
          caller_id: ATTACKER_RECIPIENT,
          recipient: ATTACKER_RECIPIENT,
          amount: 50n * ONE_NEAR
        });
      },
      /ERR_UNAUTHORIZED/,
      'Non-owner must not be able to withdraw funds'
    );

    // Hacker attempts to trigger emergency freeze
    assert.throws(
      () => {
        vault.emergency_freeze({ caller_id: ATTACKER_RECIPIENT });
      },
      /ERR_UNAUTHORIZED/,
      'Non-owner must not be able to trigger freeze'
    );

    // Verify balance is completely untouched
    assert.equal(vault.vault_balance, initialBalance);
  });

  // =========================================================================
  // TEST 7: Restricted NEAR FunctionCall access key boundary verification
  // =========================================================================
  await t.test('Test 7 [SPEC SIMULATION]: Restricted NEAR FunctionCall access key cannot directly transfer or escape scope', () => {
    // Set up NEAR ledger accounts
    const ledger = new Map();

    const agentPubKey = 'ed25519:6E2nDwhk...AgentKey';
    const ownerPubKey = 'ed25519:9X7sLmQp...OwnerKey';

    const agentAccount = new NearAccount(AGENT_ID, 5n * ONE_NEAR);
    const ownerAccount = new NearAccount(OWNER_ID, 100n * ONE_NEAR);
    const vaultAccount = new NearAccount(VAULT_ID, INITIAL_VAULT_BALANCE);

    ledger.set(AGENT_ID, agentAccount);
    ledger.set(OWNER_ID, ownerAccount);
    ledger.set(VAULT_ID, vaultAccount);

    // Owner has FULL ACCESS key
    ownerAccount.add_full_access_key(ownerPubKey, 0n);

    // Agent holds ONLY a restricted FunctionCall key:
    // Scoped strictly to VAULT_ID and method_names: ["request_payment"]
    agentAccount.add_function_call_key(agentPubKey, {
      receiver_id: VAULT_ID,
      method_names: ['request_payment'],
      allowance: 1n * ONE_NEAR, // 1 NEAR gas allowance
      nonce: 0n
    });

    // ------------------------------------------------------------------------
    // SUB-TEST 7A: Compromised agent attempts direct native NEAR Transfer to hacker
    // ------------------------------------------------------------------------
    const directTransferTx = {
      signer_id: AGENT_ID,
      public_key: agentPubKey,
      nonce: 1n,
      receiver_id: ATTACKER_RECIPIENT,
      actions: [
        {
          type: ActionType.TRANSFER,
          deposit: (5n * ONE_NEAR).toString()
        }
      ]
    };

    const directTransferValidation = NearProtocolRuntime.validate_transaction(directTransferTx, ledger);
    assert.equal(
      directTransferValidation.valid,
      false,
      'Protocol consensus MUST reject direct Transfer signed by FunctionCall key'
    );
    assert.equal(
      directTransferValidation.error_code,
      'InvalidAccessKeyError::RequiresFullAccessPermission'
    );

    // ------------------------------------------------------------------------
    // SUB-TEST 7B: Compromised agent attempts to call an unauthorized smart contract
    // ------------------------------------------------------------------------
    const rogueContractTx = {
      signer_id: AGENT_ID,
      public_key: agentPubKey,
      nonce: 2n,
      receiver_id: 'malicious_dex.testnet', // Not the vault!
      actions: [
        {
          type: ActionType.FUNCTION_CALL,
          method_name: 'swap_all_tokens',
          args: Buffer.from('{}').toString('base64'),
          gas: 30_000_000_000_000n,
          deposit: 0n
        }
      ]
    };

    const rogueContractValidation = NearProtocolRuntime.validate_transaction(rogueContractTx, ledger);
    assert.equal(
      rogueContractValidation.valid,
      false,
      'Protocol consensus MUST reject calls to receiver_id outside key scope'
    );
    assert.equal(
      rogueContractValidation.error_code,
      'InvalidAccessKeyError::ReceiverMismatch'
    );

    // ------------------------------------------------------------------------
    // SUB-TEST 7C: Compromised agent attempts to call an unauthorized method on the vault
    // ------------------------------------------------------------------------
    const unauthorizedMethodTx = {
      signer_id: AGENT_ID,
      public_key: agentPubKey,
      nonce: 3n,
      receiver_id: VAULT_ID,
      actions: [
        {
          type: ActionType.FUNCTION_CALL,
          method_name: 'withdraw_funds', // Method not whitelisted for agent key!
          args: Buffer.from('{}').toString('base64'),
          gas: 30_000_000_000_000n,
          deposit: 0n
        }
      ]
    };

    const unauthorizedMethodValidation = NearProtocolRuntime.validate_transaction(unauthorizedMethodTx, ledger);
    assert.equal(
      unauthorizedMethodValidation.valid,
      false,
      'Protocol consensus MUST reject method names not explicitly whitelisted on the key'
    );
    assert.equal(
      unauthorizedMethodValidation.error_code,
      'InvalidAccessKeyError::MethodNameNotAllowed'
    );

    // ------------------------------------------------------------------------
    // SUB-TEST 7D: Agent calls the legitimate whitelisted method on the vault
    // ------------------------------------------------------------------------
    const legitimateTx = {
      signer_id: AGENT_ID,
      public_key: agentPubKey,
      nonce: 4n,
      receiver_id: VAULT_ID,
      actions: [
        {
          type: ActionType.FUNCTION_CALL,
          method_name: 'request_payment', // Whitelisted!
          args: Buffer.from('{"auth_id":"auth_payment_001"}').toString('base64'),
          gas: 30_000_000_000_000n,
          deposit: 0n
        }
      ]
    };

    const legitimateValidation = NearProtocolRuntime.validate_transaction(legitimateTx, ledger);
    assert.equal(
      legitimateValidation.valid,
      true,
      'Protocol consensus permits strictly configured FunctionCall method invocations'
    );
    assert.equal(legitimateValidation.error, null);
  });

  // =========================================================================
  // TEST 8: State Rollback & Atomic Revert Verification
  // =========================================================================
  await t.test('Test 8 [SIMULATION]: Reverting transactions rollback behavior vs state-persisted denial audit logging', () => {
    const vault = setupVault();
    const initialBalance = vault.vault_balance;

    // Case 8A: Strict revert mode (simulating panic in NEAR transaction)
    assert.throws(
      () => {
        vault.request_payment({
          caller_id: AGENT_ID,
          auth_id: 'auth_payment_001',
          recipient: ATTACKER_RECIPIENT,
          amount: 5n * ONE_NEAR,
          current_timestamp_ns: T_BASE + 60_000_000_000n,
          revert_on_denial: true // Throws Error / Panics
        });
      },
      /\[NEAR_PANIC\] ERR_RECIPIENT_NOT_APPROVED/,
      'Strict mode must panic on unauthorized payment'
    );

    // In a panic, zero funds leave vault
    assert.equal(vault.vault_balance, initialBalance, 'Funds are 100% safe in panic mode');

    // Case 8B: Consecutive violation auto-freeze mechanism
    // 3 consecutive violations trigger auto-freeze
    const v2 = setupVault();
    assert.equal(v2.is_frozen, false);

    // Violation 1
    v2.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: ATTACKER_RECIPIENT,
      amount: 1n * ONE_NEAR,
      current_timestamp_ns: T_BASE
    });
    assert.equal(v2.is_frozen, false);
    assert.equal(v2.consecutive_violations_count, 1);

    // Violation 2
    v2.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: ATTACKER_RECIPIENT,
      amount: 1n * ONE_NEAR,
      current_timestamp_ns: T_BASE
    });
    assert.equal(v2.is_frozen, false);
    assert.equal(v2.consecutive_violations_count, 2);

    // Violation 3: Trips the circuit breaker!
    v2.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: ATTACKER_RECIPIENT,
      amount: 1n * ONE_NEAR,
      current_timestamp_ns: T_BASE
    });
    assert.equal(v2.is_frozen, true, 'Vault must auto-freeze after 3 consecutive security violations');

    // Even a valid payment is now refused because vault is frozen
    const attemptWhileFrozen = v2.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: 1n * ONE_NEAR,
      current_timestamp_ns: T_BASE
    });
    assert.equal(attemptWhileFrozen.success, false);
    assert.equal(attemptWhileFrozen.error_code, 'ERR_VAULT_FROZEN');

    // Owner unfreezes vault
    v2.unfreeze({ caller_id: OWNER_ID });
    assert.equal(v2.is_frozen, false);
    assert.equal(v2.consecutive_violations_count, 0);

    // Legitimate payment now executes successfully
    const attemptAfterUnfreeze = v2.request_payment({
      caller_id: AGENT_ID,
      auth_id: 'auth_payment_001',
      recipient: APPROVED_RECIPIENT,
      amount: 1n * ONE_NEAR,
      current_timestamp_ns: T_BASE
    });
    assert.equal(attemptAfterUnfreeze.success, true);
    assert.equal(v2.vault_balance, INITIAL_VAULT_BALANCE - 1n * ONE_NEAR);
  });
});

