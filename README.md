# BastionPro: AI Agent Payment Security on NEAR

BastionPro is an MVP exploring an owner-controlled payment boundary for AI-driven agents. The Rust NEAR contract checks payment requests against on-chain authorization rules. The frontend includes an illustrative threat simulation and a read-only vault-state adapter; it does not submit wallet transactions.

> **Status:** The contract has not been verified as deployed. The frontend simulation is local and does not call the Rust contract. Do not interpret the demo as evidence of a live on-chain payment or rejection.

## Why NEAR

NEAR provides two capabilities used in BastionPro's design: account-level FunctionCall access keys can limit an agent key to a contract receiver and allowed methods, and asynchronous promises let the contract reserve funds before dispatching a native transfer and settle the result in a private callback. Owners must configure any access-key restrictions themselves; this repository does not create keys or connect a wallet. Callback failure remains fail-closed and may lock the reservation indefinitely.

## Pre-signing policy and on-chain enforcement

The owner approves a scoped authorization before an agent payment call is signed: the rule binds the approved initiator, recipient, amount ceiling, expiry, and single-use authorization ID. During transaction execution, the NEAR contract independently checks the signed request before scheduling any native transfer. This is pre-transfer enforcement; the current frontend does not intercept or validate a wallet signature before it is created. A rejected request cannot cause the contract to transfer funds, though a signed call can still incur transaction costs.

## How the contract is designed to work

1. The owner creates a single-use authorization binding an approved initiator to a recipient, maximum amount, and expiry.
2. The authorized initiator requests a payment from the contract.
3. The contract checks the authorization and either returns a `DENIED` result without scheduling a transfer, or reserves the amount and schedules an asynchronous native NEAR transfer.
4. A private callback settles the reservation after the transfer promise resolves. `PENDING` means unresolved; it does not mean the payment succeeded.

NEAR FunctionCall access keys can be scoped to contract methods, but this repository does not create or manage those keys. The AI agent must not receive the owner's unrestricted account credentials.

## Security behavior and limitations

- **Owner initialization:** `new` requires the immediate caller to equal `owner_id` and rejects existing state. Deployment and initialization must be atomic in a transaction submitted by the intended owner. If deployment is left uninitialized, the contract cannot know who the intended owner is; an earlier caller could initialize it with itself as owner.
- **Payment rules:** The contract checks the approved initiator, recipient, positive amount, maximum, expiry, revocation, single-use state, freeze state, and available balance before dispatching a transfer.
- **Expiry boundary:** An authorization is valid when the current timestamp equals `expires_at_ns`; it expires only when current time is greater.
- **Replay protection:** Each authorization ID is unique and marked used while pending and after execution. The optional `nonce` is stored as metadata; it is not independently checked for uniqueness.
- **Denial monitoring:** Up to 100 denial records for the authorization's approved initiator are retained in a rotating log. Aggregate counters remain available. Arbitrary callers can produce a denial event but do not grow persistent denial storage or increment the persisted violation counter.
- **Automatic freeze:** Consecutive persisted denials from an approved initiator can freeze the vault at the configured threshold. The owner can unfreeze it.
- **Asynchronous settlement:** Freezing prevents new payment dispatches but does not cancel a transfer already scheduled. A confirmed transfer failure releases its reservation and makes the authorization retryable. If the callback transaction itself fails, the pending authorization and reservation remain locked indefinitely. There is no safe owner recovery method because a later call cannot prove whether the original transfer succeeded.
- **Owner withdrawal:** The owner can withdraw available funds. Reserved funds are excluded from the withdrawable balance.

## Repository layout

- `src/lib.rs` — NEAR Rust contract and feature-gated integration tests.
- `crates/bastion-pro-validator/` — dependency-free Rust payment-rule validator and unit tests.
- `contracts/` — JavaScript reference/simulation code, not the deployed contract.
- `tests/bastion_pro.test.js` — JavaScript simulation tests, not NEAR contract tests.
- `web/` — React, TypeScript, and Vite frontend.
- `.github/workflows/contract-tests.yml` — Ubuntu workflow configured for contract tests, validator tests, and WASM build.

The contract exposes public views `get_vault_state`, `get_authorization`, and `get_denial_log`. `u64` values in view responses use NEAR SDK `U64` wrappers and serialize as decimal strings for JavaScript precision. Denial-log cursors are also decimal strings. Authorizations are stored in a non-enumerable `LookupMap`; the contract does not expose a complete authorization list or complete payment history.

## Prerequisites and setup

- Node.js matching the installed Vite engine requirement (`^20.19.0` or `>=22.12.0`).
- Stable Rust and Cargo. Add the WASM target if needed:

  ```sh
  rustup target add wasm32-unknown-unknown
  ```

Install the frontend dependencies from the `web/` lockfile:

```sh
npm --prefix web ci
```

For read-only contract state, copy `web/.env.example` to `web/.env.local` and set `VITE_NEAR_CONTRACT_ACCOUNT_ID` only to an account where the contract has actually been deployed and initialized. `VITE_NEAR_RPC_URL` defaults to NEAR testnet. The account ID and RPC URL are public frontend configuration; never put private keys or wallet credentials in Vite variables. With no account ID configured, the app makes no contract read and labels its values as demo fixtures.

## Local verification commands

Run the JavaScript reference simulation and standalone Rust validator:

```sh
npm test
cargo test --locked -p bastionpro-validator --lib
```

The JavaScript tests exercise the simulation only. To run the actual NEAR contract integration tests, use a Linux environment or a Windows C/GNU toolchain that supplies the required `dlltool.exe`:

```sh
cargo test --locked --features integration-tests
```

Build and run the frontend:

```sh
npm run build
npm run dev
```

The build script performs `tsc --noEmit` followed by the Vite production build. Build the NEAR WASM contract with:

```sh
cargo build --locked --release --target wasm32-unknown-unknown
```

The default artifact path is `target/wasm32-unknown-unknown/release/bastionpro_vault.wasm`.

## Current verification status

Last local verification: **2026-11-12**.

- **JavaScript simulation:** 9/9 tests passed using `npm.cmd test`.
- **Rust validator:** 20/20 tests passed with `cargo test --locked -p bastionpro-validator --lib`.
- **NEAR contract integration tests:** Blocked. `cargo test --locked --features integration-tests` stopped because `dlltool.exe` is unavailable. The Ubuntu GitHub Actions workflow is configured, but has not been triggered or verified.
- **Workspace Rust tests:** `cargo test --locked --workspace` is also blocked while compiling native dependencies because `dlltool.exe` is unavailable.
- **Frontend:** `npm.cmd run build` passed, including `tsc --noEmit` and the Vite production build.
- **WASM:** `cargo build --locked --release --target wasm32-unknown-unknown` passed from the current renamed source. Artifact: `target/wasm32-unknown-unknown/release/bastionpro_vault.wasm`, **321,754 bytes**, SHA-256 `782410965C56B96C44A60EBC6F75A833C0FB37879E5217665E1C66EF67DF322C`.
- **Network:** No account, contract deployment, wallet connection, RPC read, signed call, or testnet/mainnet transaction has been verified. The frontend ships with no contract account ID; configure one only after verifying a deployed and initialized contract.

## License

MIT. See [LICENSE](LICENSE).
