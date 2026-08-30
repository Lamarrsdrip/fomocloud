# Authoritative execution state

`readExecutionState()` in `packages/config` is the only model allowed to answer whether a new
Solana entry can construct, sign, and submit a real transaction. API responses, Owner Control,
manual BUY, and the automated executor all consume it.

## Inputs and ownership

| Input | Source | Meaning |
| --- | --- | --- |
| Requested mode | MongoDB `AppConfig(key=liveTrading)` | Owner request; hot-reloaded |
| VPS safety gate | executor process `EXECUTION_MODE` | Deploy-time maximum capability |
| Emergency pause | MongoDB `AppConfig(key=risk).emergencyNewEntriesPaused` | Immediate new-entry kill switch |
| RPC verification/operation | Market-data `AppConfig.testResults` | Matching credential proof plus current operational result |
| Scanner progress | `WorkerHeartbeat(solana-flow-scanner)` plus latest real `ChainFlowObservation` | Process and progress health |
| Router | Execution `AppConfig.testResults.jupiter` | Matching, currently operational Jupiter route |
| Signer | executor runtime configuration plus signer `AppConfig.testResults.privy` | Loaded and currently verified signer |
| Wallet authorization | active, unexpired Solana `Wallet.tradingEnabled + permissionRef` rows | At least one delegated wallet |
| Workers | fresh heartbeats for executor, exits, market worker, listener, and flow scanner | Required process health |

`LIVE_EXECUTION_ENABLED` is retired and ignored. It is not a fallback gate or source of truth.

## State and branch contract

- `requestedMode` is the owner's DB request.
- `environmentMode` is the executor's own VPS safety gate, preferably read from its heartbeat.
- `actualRuntimeMode` is `LIVE` only when every live gate is satisfied; otherwise it is
  `SIMULATION`.
- `nextQualifiedSignalAction` is the executable contract: `SIMULATION`, `LIVE_TRANSACTION`, or
  `BLOCKED`.
- `blockers[]` contains stable codes, source categories, and operator-facing messages.

The Admin enable endpoint refuses while `readyForLive=false`. If a previously-live dependency later
degrades, the state changes to `LIVE_BLOCKED` and new transaction construction is refused.

## Transaction paths

| Path | New-entry state model? | Real-money behavior |
| --- | --- | --- |
| Automated BUY | Yes, immediately before `buildSwap()` | Live only on `LIVE_TRANSACTION`; simulation on `SIMULATION`; no order construction on `BLOCKED` |
| Manual BUY | Yes, before signer/wallet resolution | Same global state plus the requesting user's active wallet authorization |
| Source-sell mirror | Existing position mode | A stored LIVE position remains eligible for a real protective sell |
| Stop-loss/take-profit exits | Existing position mode | A stored LIVE position remains eligible for a real protective sell |
| User-initiated Send | Separate explicit manual transfer authorization | Not presented as auto-trading state |

Protective exits intentionally do not obey the new-entry switch: turning off new entries must not
trap funds already in a real position. Owner Control shows the count of such positions separately.

## No-funding verification

`packages/config/src/executionState.test.ts` exercises the exact state function imported by the
executor. The production-safety fixture (`EXECUTION_MODE=simulation`, RPC degraded) must select
`SIMULATION`, set `newEntriesLive=false`, and never select `LIVE_TRANSACTION`. Tests must never call
Jupiter build, Privy sign, or Solana submission APIs.
