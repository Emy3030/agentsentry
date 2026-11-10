# AgentSentry: Verifiable AI Agent Payment Firewall on NEAR

> **Core Promise:** "AI agents can request payments. AgentSentry's NEAR smart contract independently enforces the owner's payment rules."

AgentSentry provides a deterministic on-chain security boundary and execution firewall between autonomous AI agents and financial payment vaults. While AI agents analyze context and propose payments, all transfers are strictly evaluated and governed by an immutable NEAR smart contract before any funds can move.

---

## Why NEAR Protocol is Essential for AgentSentry

AgentSentry relies on fundamental architectural features of NEAR Protocol that cannot be replicated on traditional EVM chains:

1. **Scoped `FunctionCall` Access Keys:**
   NEAR allows account owners to issue restricted access keys limited strictly to calling `request_payment` on the AgentSentry contract with a gas allowance. The AI agent never receives custody of the master private keys and cannot sign native transfers (`Transfer` action) or withdraw vault funds directly.
2. **Named Account ID Model:**
   NEAR's human-readable account identifiers (e.g., `procurement-agent.near`, `aws-billing.near`, `acme-corp.near`) allow payment policies to map directly to authenticated business identities rather than opaque cryptographic hashes.
3. **Asynchronous Execution & Fail-Closed Callbacks:**
   NEAR's native cross-contract call and promise pipelining enables two-phase reservation and settlement (`transfer` + private `on_transfer_complete` callback), guaranteeing that pending amounts are isolated and funds cannot be double-spent while asynchronous receipts resolve.
4. **Predictable Low Gas & Sub-Second Finality:**
   Enables high-frequency micro-authorizations and responsive AI agent workflows without risk of transaction delay, mempool front-running, or prohibitive transaction fees.

---

## Core Architecture & Security Invariants

```
                                      +------------------------------------+
                                      |     Human Owner (Full Access)      |
                                      +------------------------------------+
                                            |                       |
                                            | authorize_payment     | emergency_freeze
                                            v                       v
+------------------------+  FunctionCall   +------------------------------------+
|  Autonomous AI Agent   | --------------> |     AgentSentry Vault Contract     |
| (Prompt-Injected / OK) | request_payment |         (NEAR Protocol)            |
+------------------------+                 +------------------------------------+
                                            |               |
                                     Checks | Pass          | Fails: Zero funds transferred
                                            v               v
                                   +----------------+  +--------------------------------+
                                   | Schedule NEAR  |  | On-Chain Denial Audit Log      |
                                   | Transfer       |  | & Auto-Freeze Circuit Breaker  |
                                   +----------------+  +--------------------------------+
                                            |
                                            v
                                   +----------------+
                                   | Approved Vendor|
                                   +----------------+
```

### Security Invariants

* **1. Owner-Only Initialization Guard:**
  The `new` method verifies that `env::predecessor_account_id() == owner_id`. The contract must be deployed and initialized in a single atomic transaction by the intended owner, preventing front-running takeovers.
* **2. Recipient Allowlisting & Amount Ceilings:**
  Transfers are permitted exclusively to the designated `approved_recipient` up to the authorized `max_amount`. Any mismatch or excess is rejected with zero funds leaving the vault.
* **3. Expiry & Single-Use Replay Prevention:**
  Authorizations expire deterministically at `expires_at_ns`. Each authorization is flagged as `used` immediately upon payment request, preventing replay attacks.
* **4. Two-Phase Reservation & Fail-Closed Callbacks:**
  When a valid payment request is processed, the contract reserves the balance upfront (`reserved_balance_yocto`) before dispatching the asynchronous transfer promise. A private callback (`on_transfer_complete`) finalizes the settlement. If a callback fails or reverts, the contract remains fail-closed; funds remain safely reserved to prevent double-spending.
* **5. Bounded On-Chain Storage & DoS Protection:**
  The contract stores the 100 most recent authorized-initiator denials in a rotating ring buffer (`Vector<DenialRecord>`) alongside fixed-size aggregate counters (`DenialCounters`). Unrelated callers cannot bloat contract storage or consume gas allotments; unauthorized attempts emit indexed NEP-style JSON events without persistent storage writes.
* **6. Circuit Breaker Auto-Freeze:**
  Consecutive denials from an authorized initiator increment a violation counter. Exceeding `max_consecutive_violations` triggers an automatic vault freeze, halting all dispatches until the human owner unfreezes the vault.

---

## Project Structure

```
near/
├── src/lib.rs                           # Main NEAR smart contract (AgentSentryVault)
├── Cargo.toml                           # Workspace root configuration
├── crates/
│   └── agent-sentry-validator/          # Standalone, zero-dependency pure Rust rule engine
│       ├── Cargo.toml
│       └── src/lib.rs                   # 20 exhaustive unit tests
├── web/                                 # Frontend Threat Simulator & Vault Monitor
│   ├── src/                             # React 19 + TypeScript + Vite application
│   └── package.json
├── contracts/                           # Reference JavaScript behavioral model & specs
│   ├── agent_sentry_vault.js            # [SIMULATION] contract model
│   └── near_access_key_verifier.js      # [SPEC] NEAR FunctionCall key verification
├── tests/
│   └── agent_sentry.test.js             # [SIMULATION] 9-test reference suite
├── package.json                         # Root test & build orchestration
└── HACKATHON_SUBMISSION.md              # Submission overview & technical disclosure
```

---

## Local Installation & Verification Commands

### Prerequisites
* **Node.js**: v18.x or v20+ (`node --version`)
* **Rust**: 1.95+ with the `wasm32-unknown-unknown` target:
  ```sh
  rustup target add wasm32-unknown-unknown
  ```

### 1. Install Dependencies
```sh
npm install
npm --prefix web install
```

### 2. Run Test Suites
```sh
# Run JavaScript reference simulation tests (9/9 pass)
npm test

# Run Rust validator unit tests (20/20 pass)
cargo test -p agent-sentry-validator --lib
```

### 3. Build & Run Frontend Threat Simulator
```sh
# Production typecheck and build (zero errors)
npm run build

# Start local interactive development dashboard
npm run dev
# Or directly inside the web folder:
# cd web && npm run dev
```

### 4. Build Smart Contract WASM
```sh
cargo build --release --target wasm32-unknown-unknown
```
The compiled release binary is located at:
`target/wasm32-unknown-unknown/release/agent_sentry_vault.wasm`

---

## Honest Status & Verification Disclosure

* **Rust Rule Validator Engine (`agent-sentry-validator`):**
  100% verified. All 20 unit tests execute locally and pass in under 0.02s, testing valid executions, ceiling breaches, expired authorizations, replay attacks, vault freezes, auto-freeze triggers, and solvency limits.
* **JavaScript Reference Simulation (`tests/agent_sentry.test.js`):**
  100% verified. 9 tests pass using Node.js's built-in test runner, verifying behavioral parity, access key scopes, and transaction rollback properties.
* **Frontend Web Application (`web/`):**
  100% verified. Built with React 19, TypeScript, and Vite. Passes `tsc --noEmit` and bundles cleanly. Offers an interactive simulation arena demonstrating adversarial attacks (prompt injection, recipient spoofing, limit escalation) against the AgentSentry security boundary.
* **Compiled WASM Contract:**
  The NEAR smart contract in `src/lib.rs` compiles cleanly to `wasm32-unknown-unknown` with zero errors and zero warnings (binary size ~315 KB).
* **Live Network Status:**
  In accordance with hackathon instructions, no live testnet or mainnet transactions have been broadcast and no funds have been spent in this local verification phase. The contract is packaged and ready for atomic deployment via `near-cli-rs`.
* **Platform Note on Integration Tests:**
  The `integration-tests` feature in `src/lib.rs` uses NEAR SDK 5.30's `VMContextBuilder` and runs in CI (Linux). On Windows host machines, `near-crypto`'s transitive C build dependencies require a GNU binutils assembler (`as.exe`); the decoupled `agent-sentry-validator` sub-crate guarantees that all security logic can be tested deterministically without requiring platform-specific C toolchains.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
