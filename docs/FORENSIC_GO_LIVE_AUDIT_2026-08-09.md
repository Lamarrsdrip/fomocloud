# MemeCloud forensic trading-engine and go-live audit

Audit date: 2026-08-09  
Decision: **NO-GO for real-money unattended execution**  
Safe operating mode: **SIMULATION only**

This report distinguishes code that exists from code that has been exercised and from code that is safe for real funds. A quote adapter is not an execution adapter, a connected wallet is not delegated signing authority, and a pure strategy test is not proof that the production worker uses that strategy.

## Executive findings

1. Solana source-wallet monitoring is implemented for independently verified public wallets, with WebSocket detection, bounded restart replay, transaction persistence, signal idempotency and BullMQ fan-out.
2. The decoder now rejects ambiguous transfers/token-to-token movement, handles USDC, USDT, WSOL and native SOL paths, and derives partial/full source-sell percentages.
3. A reproducible public-mainnet smoke test decoded current Jupiter BUY and SELL transactions. A separate live sample decoded a 19.88% partial USDC sell.
4. The production executor obtains a genuine user-size Jupiter quote and computes chase from source execution to that executable quote. It does not use 24-hour token movement.
5. Simulation order, position, TP-floor, source-sell mirror, P&L and notification paths exist. Position accounting now uses one fee-aware implementation shared by both simulation exit paths.
6. Rich meme intelligence and adaptive exit strategy exist as pure packages and tests but are **not wired into the production executor/exits workers**.
7. Live signing is deliberately absent. The worker stops at `WAIT_SIGNER`; no live order, submission, confirmation, live position or live sell is created.
8. Solana is the only implemented source listener and Jupiter is the only working quote/build primitive. EVM chains have no source listener or execution implementation.
9. Two legacy “verified wallets” were discovered to be the Solana System Program and Token Program IDs used by an earlier controlled test. They were immediately unverified and all three affected follows were paused. They were not real traders and must never be restored. Runtime executable-program rejection now prevents recurrence.
10. After that correction, production has **zero independently verified genuine trader wallets**. Genuine trader discovery/provenance is therefore a launch blocker for actual copy monitoring, not something to conceal with demo data.

## Verification performed

### PWA

- Web TypeScript check passed.
- Static production build passed all 21 routes.
- Desktop Chrome displayed the premium install card only after a real `beforeinstallprompt` event.
- The Install action invoked the browser install flow.
- iPhone Safari emulation displayed instructions and no fake Install button.
- Service worker registration fetched `/login/`, `/app/`, auth routes and all 192/512/maskable/Apple icons.
- Manifest uses `start_url: /login/`, so an installed Home Screen launch opens Login directly; it also uses `display: standalone` and valid PNG icon sizes.
- Installed state and dismissals are remembered; iPadOS touch-device detection is included.

### Listener and public chain

- Decoder unit suite: 6 tests passed.
- Replay unit suite: 4 tests passed.
- Public-chain smoke: `pnpm --filter @fomocloud/listener smoke:public-chain` passed against Solana mainnet and found both a Jupiter BUY and SELL.
- Observed real BUY inputs included native SOL and USDC.
- Observed real SELL outputs included native SOL and USDC.
- Real partial-sell sample: transaction `5iffpkJgYFiGBJsBzk66G28ceRB2qfAG1nEnm3EKmTqsUjmX7UHJBjeo9gid3fCSQRkrDDoh1ZpjdPyYpiowJ7Cd` decoded a 19.88% token sale to USDC.
- Replay behavior is fail-closed: a missing cursor or gap beyond the configured bound yields `REPLAY_GAP` and monitoring stops pending review.

### Chase, strategy and accounting

- Shared risk/accounting suite: 14 tests passed.
- Strategy suite: 12 tests passed.
- Chase boundaries covered: 30%, 40%, 50%, 55%, and beyond 55%.
- A token’s +5000% daily move is not passed into copy eligibility.
- Runner HOLD covered at +500%, +1000%, +2000%, +5000%, and +10000% under healthy hyper evidence.
- Fresh TP ladder covered at +100%, +150%, +200%.
- Established TP ladder covered at +50%, +100%.
- Hyper sells less at partials; cooling sells more.
- Fee-aware partial/final accounting, cost basis, realized P&L, unrealized P&L, runner amount, full close and oversell rejection are covered.

## End-to-end pipeline status

| Stage | Implemented | Tested | Production truth | Live-ready |
|---|---:|---:|---|---:|
| Source trader identity | Partial | Manual only | Admin records Fomo/X identity and public evidence | No |
| Source wallet provenance | Yes | Type/build | User submissions start unverified; admin evidence required | Partial |
| Solana listener | Yes | Unit + public-chain smoke | Verified wallets only; WebSocket + bounded replay | Yes for signal observation |
| EVM/other listeners | No | No | No source logs/decoder | No |
| Solana decoder | Yes | Unit + real public swaps | Conservative quote-to-token classification | Partial protocol coverage |
| Normalized signal | Yes | Controlled simulation | DB unique key + queue job identity | Yes for supported decode |
| Market snapshot | Minimal | Live Jupiter quote observed | Executable price and estimated market cap only | No for rich intelligence |
| Meme intelligence | Package only | Pure unit tests | Not called by executor/exits workers | No |
| User follow resolution | Yes | Controlled multi-user test | One signal fans out by follow mode | Simulation-ready |
| User copy settings | Yes | Unit + controlled test | Global/follow limits, chains, add/re-entry flags | Simulation-ready |
| User-specific decision | Yes | Unit + controlled test | Cash/exposure/chase/impact checks | Simulation-ready |
| Execution quote | Solana only | Real Jupiter quote | Actual requested user size | Quote-ready |
| Build transaction | Primitive only | Not end-to-end here | `JupiterExecution.buildSwap` exists | Not production-wired |
| Sign/authorization | No provider | Fail-closed observed | `DisabledSignerProvider`; worker emits `WAIT_SIGNER` | **No** |
| Submit | Primitive only | No controlled live test | `submitSigned` exists but worker never calls it | **No** |
| Chain confirmation | Primitive only | No controlled live test | `waitConfirmed` exists but worker never calls it | **No** |
| Position creation | Simulation | Tested indirectly | Created from genuine quote, not confirmed fill | **No for LIVE** |
| TP/runner | Simulation floors + pure strategy | Unit | Worker does not use rich adaptive strategy | **No for LIVE** |
| Exit | Simulation only | Unit/accounting | No signer, live sell, retry state machine or reconciliation | **No** |
| P&L/reconciliation | Simulation/account marks | Unit | No chain-derived live fill reconciliation | **No for LIVE** |
| Notifications | In-app/push/email paths | Partial live | SMTP depends on provider configuration | Partial |

## Source-signal audit

| Case | Result | Evidence/limitation |
|---|---|---|
| BUY | Pass | Unit fixtures and real Jupiter mainnet swaps |
| SELL | Pass | Unit fixtures and real Jupiter mainnet swaps |
| Swap vs transfer | Pass for covered cases | Transfer with balance movement but no swap legs is rejected |
| Multi-hop | Pass for net quote/token route | Unit net-balance fixture; not every Solana router is decoded |
| Token decimals | Pass | Raw amounts and token-balance decimals used |
| Native SOL input/output | Pass | Fee-adjusted lamport delta plus Jupiter program evidence |
| USDC | Pass | Exact transaction ratio produces source USD price |
| USDT | Decode pass | Accepted as quote; no fake exact USD source price |
| Partial sell | Pass | Unit 25%; real public sample 19.88% |
| Full sell | Pass | Unit and real public 100% samples |
| Additional buys | Implemented policy | Executor checks open position and user setting; no production E2E source test |
| Re-entry | Implemented policy | Executor checks prior closed position and user setting; no production E2E source test |
| Failed transaction | Pass | Failed transaction fixture ignored |
| Duplicate event | Pass by design | Unique source transaction, signal key, decision key and queue job IDs |
| Reconnect/replay | Pass in unit suite | Bounded cursor replay oldest-first; unknown gap stops monitoring |
| Every Solana DEX/router | No | Jupiter V6/native evidence and balance classification covered; broader protocol corpus required |

## Chase audit

Authoritative formula:

`followed wallet execution price -> this user’s current actual-size executable quote`

The stored `dailyMovePct` is not passed to `decideCopy` and does not participate in the production executable-quote chase check.

| Scenario | Expected | Result |
|---|---|---|
| Daily move +5000%, source $1.00, executable $1.35 | 35% chase, not blocked by daily move | Pass |
| 30% at 30% cap | Allow | Pass |
| 40% at 40% cap | Allow | Pass |
| 50% at 50% cap | Allow | Pass |
| 55% at 55% hyper cap | Allow | Pass |
| Beyond personal/platform cap | `WAIT_PULLBACK`/price moved too far | Pass |

## Meme-intelligence truth table

| Input | Current real production source | Used by production decision? |
|---|---|---:|
| Executable price | Jupiter user-size quote | Yes |
| Price impact | Jupiter quote | Yes |
| Token decimals/supply | Solana RPC | Yes |
| Market cap | Supply × executable quote estimate | Display/market cache |
| Liquidity | No complete provider | Only if a real stored value exists; commonly absent |
| Volume acceleration | None | No |
| Buy/sell volume | None | No |
| Unique buyers/sellers | None | No |
| Holder growth | None | No |
| Smart-wallet flow | None | No |
| Creator/deployer activity | None | No |
| Holder concentration | None | No |
| Bundled/sniper data | None | No |
| Social momentum | None | No |
| Source holding/selling | Transaction balance delta for sell percentage | Source-sell simulation only |

No placeholder intelligence is used by the production executor. The consequence is not “neutral intelligence”; the honest consequence is that the adaptive intelligence package is not active.

## Hard-block and runner audit

The pure strategy reserves hard blocks for objective severe failures: no sell route, dangerous token restrictions, extreme liquidity, unusable impact, liquidity collapse and creator dumping. Concentration, social quality and less-severe concerns modify risk/size rather than automatically blocking.

This policy is covered by unit tests, but it is **not yet the production worker’s exit policy** because the required real market snapshot does not exist and `@fomocloud/intelligence` is not imported by the executor/exits services.

## Exit and failure audit

| Exit case | Pure strategy | Production worker |
|---|---|---|
| Normal pullback | Tested: full exit after trail | Not wired |
| Hyper pullback | Tested: reduce, preserve runner | Not wired |
| Liquidity collapse | Tested: full exit | No real liquidity feed/live sell |
| Source full exit | Tested with momentum condition | Simulation mirror exists; LIVE waits signer |
| Creator dump | Tested: full exit | No creator feed/live sell |
| Volume/buyer-flow breakdown | Tested: full exit | No flow feed/live sell |
| Partial/multiple TP | Tested and simulation worker active | No live sell |
| Failed sell/no route | Fail-closed concept only | No live exit state machine |
| Retry without double sell | Not implemented for LIVE | **Critical blocker** |
| Confirmed balance reconciliation | Not implemented for LIVE | **Critical blocker** |

## Execution-adapter matrix

| Chain/venue | Quote | Build | Sign | Submit | Confirm | Sell | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| Solana / Jupiter | Working | Primitive exists | Missing provider | Primitive exists, unused | Primitive exists, unused | Not wired | Quote-ready, **not live-ready** |
| Base | No implementation | No | No | No | No | No | Not ready |
| Ethereum | No implementation | No | No | No | No | No | Not ready |
| BNB | No implementation | No | No | No | No | No | Not ready |
| Arbitrum | No implementation | No | No | No | No | No | Not ready |
| Avalanche | No implementation | No | No | No | No | No | Not ready |
| Sui/Hyperliquid/Monad | No listener/execution | No | No | No | No | No | Not ready/not modelled consistently |

## Required signer architecture

Never request or store a seed phrase or a user’s primary-wallet private key.

Recommended evaluation path:

1. Use user-owned wallets with scoped server access from a reviewed wallet-infrastructure provider, or dedicated user trading sub-wallets with deliberately limited balances.
2. Solana policy must allow only reviewed Jupiter program instructions and required token/system instructions, with explicit spend ceilings, allowed quote assets, expiry, pause and revocation.
3. EVM should use a reviewed smart account/session-key model with contract/function allowlists, token/value limits, rate limits, timestamps and paymaster controls.
4. Store only provider permission/signer references; protect backend authorization keys in a KMS/HSM or provider-supported enclave/quorum arrangement.
5. Enforce each limit twice: MemeCloud decision layer and wallet/provider policy layer.
6. Prevent arbitrary transfers/withdrawals, arbitrary contract/program calls, policy mutation and private-key export by the automation signer.
7. Add an immutable authorization audit trail and reconciliation alarm.

Minimum policy fields still required in MemeCloud’s schema/API:

- Per-trade maximum.
- Per-day and total exposure maximum.
- Allowed chains, assets, venues/programs/contracts and instruction/function selectors.
- Maximum slippage/price impact.
- Valid-from and expiry timestamps.
- User revoke and immediate platform pause.
- Nonce/pending-order state and transaction replacement policy.

## Genuine fomo.family discovery architecture

Official fomo.family surfaces expose social feeds, profiles, following and leaderboards to users. This audit found no published official developer/partner API, webhook, SDK or documented endpoint for exporting trader profiles, following graphs, public wallets or trade streams. That is an inference from the current official website, blog and terms—not proof that a private partner API can never exist.

`docs.fomo.com` documents an unrelated website social-proof/marketing-notification product (Events, Templates and marketing KPIs). It must not be connected to MemeCloud trader discovery.

Safe architecture now implemented:

1. Admin records Fomo username/profile URL, X handle and category.
2. A public source wallet can be submitted with evidence but starts unverified.
3. Admin verification requires a method and evidence URL/note.
4. Only independently verified wallets are eligible for listener subscriptions.
5. Verification/unverification is audited; unverifying pauses Watch/Auto Copy follows.
6. Listener baselines a newly verified wallet instead of copying old history.
7. Runtime rejects executable Solana programs as source wallets.
8. If fomo.family later offers a documented partner API, implement it as a provider adapter with contractual permission, provenance snapshots and rate-limit handling. Do not scrape or reverse-engineer private endpoints.

## Go-live checklist

### P0: required before any real-money transaction

- [ ] Select and security-review a delegated signer/wallet provider.
- [ ] Implement owner-controlled consent, expiry, revoke and pause.
- [ ] Enforce per-trade, daily, aggregate, chain, asset and venue policy outside the browser.
- [ ] Implement signer adapter in executor and exits workers.
- [ ] Build, sign, submit and confirm Solana BUY from the production worker.
- [ ] Build, sign, submit and confirm partial/full Solana SELL.
- [ ] Persist pending transaction state before submission.
- [ ] Add retry/replacement logic that cannot double-submit or double-sell.
- [ ] Reconcile actual input/output, fees and balances from confirmed chain transactions.
- [ ] Create LIVE positions only from confirmed actual fills.
- [ ] Exercise RPC disconnect, quote expiry, failed preflight, failed chain transaction and worker restart.
- [ ] Add a complete genuine exit snapshot or intentionally ship a simpler documented live exit policy.
- [ ] Add no-route/liquidity-collapse emergency behavior with a tested alternate route/alert path.
- [ ] Obtain legal/compliance review for automated copy trading, custody model, fees, sanctions/AML and supported jurisdictions.
- [ ] Complete independent application/infrastructure security review.

### P1: required for the promised intelligence product

- [ ] Integrate genuine liquidity and DEX trade-flow data.
- [ ] Integrate holder/concentration/creator/deployer evidence.
- [ ] Integrate bundled/sniper evidence where legitimately available.
- [ ] Integrate genuine social data or remove social scoring from product claims.
- [ ] Wire `@fomocloud/intelligence` into production decisions with freshness/provenance checks.
- [ ] Wire adaptive TP/runner strategy into production exits.
- [ ] Add broader Solana protocol fixture corpus and EVM listener/execution adapters.
- [ ] Establish a verified trader registry with independent evidence and ongoing monitoring health.

### Controlled owner test only after all P0 signer/execution items pass

1. Create a dedicated tiny-value owner test wallet/sub-wallet.
2. Set strict provider policy and MemeCloud policy limits.
3. Execute one tiny BUY; verify quote, signature, tx, confirmation, actual fill, fees and position.
4. Execute one partial SELL; verify remaining raw balance and cost basis.
5. Execute one full SELL; verify close and final realized P&L.
6. Repeat failed quote, failed transaction, RPC disconnect and worker restart scenarios.
7. Keep public `LIVE_EXECUTION_ENABLED=false` until a reviewed owner report is signed off.

## Final verdict

MemeCloud’s simulation path and Solana source-decoding foundation are materially improved and testable. The system is **not ready for unattended real-money auto-trading** because delegated signing, production submission/confirmation wiring, live exits, idempotent failed-exit recovery and chain-derived reconciliation are missing. Keep execution in simulation mode.
