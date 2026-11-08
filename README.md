# AgentSentry

AgentSentry contains a NEAR payment vault contract and a standalone Rust payment-rule validator.

## Project layout

- `src/lib.rs` is the NEAR contract (`agent-sentry-vault`).
- `crates/agent-sentry-validator` contains the pure Rust validator.
- `contracts/` contains JavaScript reference/simulation code. It is not the deployed contract implementation.
- `tests/agent_sentry.test.js` tests that JavaScript simulation; it does not execute the NEAR contract.

## Secure contract initialization

`new` accepts `owner_id` only when the immediate caller (`predecessor_account_id`) is that same account. The intended owner must submit contract deployment and the `new` call in one signed NEAR transaction, with `owner_id` set to the signer/caller account. NEAR SDK 5.30.0's `#[init]` guard rejects initialization after contract state exists.

Do not deploy the contract in one transaction and leave it uninitialized for a later call. An uninitialized deployed contract has no on-chain record of its intended owner, so the contract cannot distinguish that owner from an earlier caller that supplies itself as `owner_id`. If deployment and initialization were separated, redeploy and initialize atomically before funding or exposing the contract.

## Denial and transfer monitoring

The contract retains the 100 most recent authorized-initiator denial records in a rotating log. Authorization IDs are limited to 128 bytes so each retained record has a bounded size. `get_vault_state.total_denials_logged` counts persistent records from the owner-selected initiator and reports fixed per-error counters and the oldest retained sequence number; `get_denial_log` uses absolute sequence numbers. When full, the ring replaces the oldest detail record. Its details remain available in the corresponding on-chain denial event, and the counters and eviction metadata remain in contract state. Events for non-initiator callers set `persisted` to false and omit the supplied authorization ID from the event payload.

Payment transfers are asynchronous. Freezing prevents new payment dispatches but does not cancel a transfer already scheduled. If a transfer callback fails, the pending authorization and its reserved balance remain locked. There is intentionally no owner method to release that reservation or retry the payment: after a failed callback the contract cannot prove whether the original transfer succeeded, so guessing could permit a duplicate payment.

A callback that does not receive exactly one transfer result returns without changing settlement state. Callback execution failures such as out-of-gas are different: the callback transaction rolls back, leaving the transfer pending and its reservation intact. No contract-level recovery is provided because the original transfer outcome is not available to a later method call.

## Local checks

```sh
cargo test --locked --features integration-tests
cargo test --locked -p agent-sentry-validator --lib
cargo build --locked --release --target wasm32-unknown-unknown
npm test
```

The integration tests use NEAR SDK test utilities. The GitHub Actions workflow runs them on Ubuntu and also builds the WASM contract. No deployment is performed by these checks.
