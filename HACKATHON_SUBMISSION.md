# AgentSentry: AI Agent Financial Security Guard

## How It Works

AgentSentry is designed as an on-chain boundary between an AI-driven payment agent and an owner's NEAR vault. The contract checks each payment request against owner-configured authorization rules.

1. **Owner permissions:** The owner creates an authorization that binds an approved initiator to a recipient, amount limit, expiry, and single-use payment.
2. **Agent request:** The approved initiator submits a payment request with an authorization ID, recipient, and amount.
3. **Contract enforcement:** The contract checks the request against the authorization. A recipient mismatch returns a denied result and does not schedule a transfer. Denial records are persisted for the authorization's approved initiator; unrelated callers cannot grow the persistent denial log.
4. **Asynchronous settlement:** An accepted request reserves the amount while the native NEAR transfer and its callback settle. A request being accepted or pending does not mean the payment has executed.

## Core Security Features

- **Single-use authorization:** Prevents reuse while a payment is pending or after it has executed. A failed transfer can make the authorization retryable after its callback confirms failure.
- **Bounded denial history:** The contract retains up to 100 persisted denial records in a ring buffer and tracks aggregate denial counts.
- **Automatic freeze:** Consecutive persisted denials from an authorization's approved initiator can freeze the vault at the configured threshold. Arbitrary callers do not increment this counter.
- **Reserved-balance accounting:** Pending transfer amounts are tracked separately from available funds.
- **Fail-closed callback behavior:** If the settlement callback itself fails, the pending reservation remains in place because a later call cannot safely prove the original transfer outcome.

The frontend threat simulation is illustrative and does not submit a blockchain transaction. Contract behavior should be described as on-chain enforcement only when the contract is deployed and the interaction is verified on the selected network.
