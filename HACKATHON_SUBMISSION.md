# AgentSentry — NEAR Payment Security for AI Agents

## Product

AgentSentry is an MVP for an owner-controlled payment boundary around AI-driven agents. The design lets an agent request a payment while the NEAR contract checks the request against a scoped authorization. The frontend's attack scenario is an illustrative, local simulation; it does not prove a live contract rejection.

## Why NEAR

NEAR account FunctionCall access keys can be restricted to a receiver contract and permitted methods, so an agent can be given scoped call authority without the owner's unrestricted account key. NEAR promises also support asynchronous settlement: the contract reserves the amount, dispatches a native transfer, and processes the result through a private callback. Owners must configure access keys themselves; wallet integration is not included here.

## Architecture and policy

- The Rust contract in `src/lib.rs` is the intended on-chain authority.
- The owner creates an authorization binding one initiator to an approved recipient, amount ceiling, expiry, and single-use rule.
- A request that passes validation reserves the balance and returns `PENDING`; the callback later marks it executed or failed.
- Recipient mismatch and other eligible denials return `DENIED` without scheduling a transfer. Persistent denial details are bounded to 100 records.
- The React, TypeScript, and Vite app provides five demo pages and a read-only adapter interface. Only vault state can be read from a configured contract account. Authorization forms, transaction activity, denial details, and the threat simulation remain demo/local data. No signed owner calls are implemented.

## Local setup

Prerequisites: Node.js supported by Vite (20.19+ or 22.12+), stable Rust/Cargo, and the `wasm32-unknown-unknown` target.

```sh
npm --prefix web ci
npm run dev
```

To opt into public vault-state reads, copy `web/.env.example` to `web/.env.local` and set `VITE_NEAR_CONTRACT_ACCOUNT_ID` to a verified, deployed, initialized contract account. Do not put private keys or wallet credentials in frontend environment variables. Without that setting, the app makes no RPC call and shows clearly labeled fixtures.

## Verification commands

```sh
npm test
cargo test --locked -p agent-sentry-validator --lib
cargo test --locked --features integration-tests
npm run build
cargo build --locked --release --target wasm32-unknown-unknown
```

The JavaScript tests exercise a reference simulation, not the Rust contract. The integration-test feature runs tests against the actual NEAR contract. The Ubuntu workflow is configured for contract tests, validator tests, and the WASM build; a configured workflow is not a passing CI result.

## Known limitations and release status

- No testnet account or contract deployment has been verified. No live payment or malicious-recipient rejection has been demonstrated. No transaction hashes, screenshots, hosted demo, or demo recording are claimed.
- Deployment and `new` initialization must be submitted atomically by the intended owner. An uninitialized deployed contract cannot identify its intended owner.
- If the transfer callback itself fails, its state rolls back and the reservation can remain locked indefinitely. There is no recovery action because the contract cannot later prove the original transfer outcome.
- Authorization storage is a non-enumerable `LookupMap`; the API cannot list every authorization or provide complete historical payment activity.
- The optional authorization nonce is stored as metadata; replay protection comes from the unique authorization ID and its used/pending state.

See [README.md](README.md) for full security behavior, setup, and current local verification results.
