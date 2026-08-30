# MemeCloud Forensic Audit — Master Traceability Matrix

Status values used throughout: `PENDING AUDIT` | `IMPLEMENTED` | `TESTED` | `LIVE VERIFIED` | `BLOCKED`.
`PENDING AUDIT` = not yet independently verified against real code; not a completion state.
This file is the single source of truth for scope. Nothing is removed from this list without being marked BLOCKED with a stated external reason. Updated continuously across sessions.

Repo: Lamarrsdrip/fomocloud. HEAD at last update: `baf114a`.

## How to read this file
- ID prefixes: `M-#` = Master audit prompt sections (0-68). `C-#` = Continuation/resume prompt sections (1-30). `PC-#` = Product-concept alignment prompt sections (A-M, lettered). `Q-#` = Final 22 acceptance questions (from both prompts' closing sections).
- "Evidence" is filled in only after a real audit pass (fork report or direct code read) confirms status — never filled from assumption.

---

## PHASE 0 — Recovery (COMPLETE)
| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | git status / HEAD / origin sync | IMPLEMENTED | Local `main` was stale (HEAD `d3ff78c`) vs `origin/main` (`baf114a`). `git pull` executed, now synced at `baf114a`. |
| P0-2 | Verify all commit hashes claimed in continuation prompt exist | IMPLEMENTED | All 22 hashes (49329c5...8eae454) confirmed to exist via `git cat-file -e`, with real commit messages matching claims. |
| P0-3 | Enumerate services/packages present | IMPLEMENTED | 15 services (incl. brain-worker, evm-flow-worker, flow-worker, social-worker), 16 packages confirmed present after pull. |

## Audit Pass 1 — COMPLETE (5 forks, all reported)
| Fork | Scope | Status |
|---|---|---|
| A | Financial precision / ledger / portfolio truth (M-30,31,32 / C-9) | REPORTED |
| B | Live execution + exit engine safety (M-26,27,28,29 / C-10,11) | REPORTED |
| C | Auth / IDOR / admin security (M-37,38,39,61 / C-24) | REPORTED |
| D | Discovery/Brain/Smart-Wallet product alignment (M-3..21 / PC-A,B,C,E,F,G,H,K) | REPORTED |
| E | RPC resilience / EVM hardening / ingestion durability (M-20,21,22,25 / C-EVM hardening, durable ingestion) | REPORTED |

### Fork A findings (financial precision / ledger / portfolio)
- M-31/C-9 Immutable ledger: **MISSING**. No `Ledger`/`LedgerEntry` model in schema.prisma. Money fields mutated directly on TradingCashAllocation/Position/PositionExit/Deposit with no append-only event trail.
- M-30 Float precision: **PARTIAL**. Raw token amounts correctly BigInt/String end-to-end. USD-denominated fields (costUsd, realizedPnlUsd, availableUsd, etc.) are `Float` in schema, computed via `Number(BigInt(raw))/1_000_000`. Not an active bug at current trade sizes (within Number's exact-integer range) but architecturally exactly the gap the spec flags -- no Decimal/integer-micro-USD canonical ledger.
- M-32 Portfolio value duplication: **IMPLEMENTED**. Single source (`apps/api/src/server.ts:706-729,1592-1594`), frontend renders API fields directly, zero competing frontend calculation found.
- Label conflation (cash vs total vs P&L): **NOT FOUND** -- already correctly separated in `apps/app/page.tsx:502-504` and `admin/page.tsx:113` (commit 1758886 verified in current code).
- Balance fabrication on RPC failure: **IMPLEMENTED**. `services/balance-worker/src/index.ts:113,217` sets `null` (not 0) on RPC failure and skips the DB write entirely rather than zeroing, preserving last-known-good (commit 8eae454 verified).

### Fork B findings (live execution / exit engine)
- BUY-path crash-safety: **IMPLEMENTED**. `decisionKey`-based idempotency, Privy `reference_id` ambiguous-broadcast recovery, `$transaction` atomic writes. One minor gap: initial `db.order.create` lacks the explicit P2002 handler the SOURCE_SELL path has (safe today via outer catch, just less explicit).
- Ambiguous-broadcast recovery: **IMPLEMENTED** both buy and sell directions, with 60s reconciliation throttle.
- Quote-as-fill conflation: **NOT FOUND** (correctly separated -- confirmation always reads real on-chain deltas before marking CONFIRMED).
- Duplicate sell protection: **FIXED THIS SESSION** (commit 0828d7b) -- `services/exits/src/index.ts` executeLiveExit's Order creation had no P2002 race handler unlike executor.ts's SOURCE_SELL path; now mirrors it.
- Stale/missing market data never triggers destructive exit: **IMPLEMENTED**, verified in code (`services/exits/src/index.ts:254,259-264`).
- Multi-write transaction consistency: **IMPLEMENTED** (`$transaction` on every confirmation write).
- Caveat: none of this was LIVE chaos-tested (no induced-crash test found in repo) -- status is code-verified/IMPLEMENTED, not LIVE VERIFIED.

### Fork C findings (auth / IDOR / admin security)
- Access-token-in-localStorage: **SAFE**. Real long-lived credential is httpOnly `fomo_refresh` cookie; localStorage only holds a 60m access token. helmet() applied. Refresh-race bug was a Prisma Mongo `revokedAt:null` vs `{isSet:false}` bug, fixed+regression-tested. Minor NEEDS-VERIFICATION: cross-tab concurrent refresh could still race (pre-existing edge case, not introduced by the fix).
- IDOR: **SAFE**, verified across ~10 checked routes -- every `/v1/me/*` route scopes by `req.user.sub` (server-derived JWT claim), never a client-supplied ID alone.
- Admin RBAC: **SAFE**. `requireAdmin` (OWNER/ADMIN/SUPPORT) gates read-only routes only; `adminOnly` (OWNER-only) gates every mutation including live-trading enable/disable. Secrets redacted before SUPPORT/ADMIN ever see config responses.
- Secrets exposure: **SAFE** (scope: server.ts only, not exhaustive repo-wide).
- Amount/negative-value guards: **SAFE**, `Number.isFinite && >0` checks present on manual trade + wallet send routes.

### Fork D findings (discovery/brain/smart-wallet product alignment) -- HIGHEST PRIORITY, USER'S CENTRAL CONCERN
- Discover feed source: **PARTIAL**. Reads qualified `GlobalBrainOpportunity` (not raw DiscoveryToken) -- good -- but WHERE clause is loose (any row with any recent inflow/buyer or <10min-old counts, just ranked low). Not literally "random new coins" but not strictly "only meaningful intelligence" either.
- Stage funnel: **PARTIAL**. No stored RAW_DISCOVERED->MONEY_RUSH enum; `classifyLifecycle()` computes a real, tested progression (FOUND/WATCHING/INTERESTING/HEATING_UP/STRONG/HIGH_CONVICTION/COOLING/STALE) on read, not persisted as named stages.
- Wallet discovery channels: **DEVIATES**. Only token-first (`scan()`) and a "flow-first" function that actually skips every unknown wallet (`scanFromChainFlow` explicitly `if(!known)continue`). No true wallet-first/convergence-first discovery of brand-new addresses exists. **Remaining work, not yet fixed.**
- Scoring gate (wealth vs skill): **MATCHES CONCEPT**. `scoreWallet()` has no wealth/balance term; built from win rate, PnL efficiency, sample size, forward returns, chase/insider/rug penalties.
- Admin PROVEN promotion bypass: **FIXED THIS SESSION** (commit 0828d7b).
- Forward-proof contamination: **FIXED THIS SESSION** (commit 0828d7b).
- Notification preference routing: **FIXED THIS SESSION** (commit 0828d7b), plus discoveryWhaleActivity/discoveryNewToken (previously wired to nothing) now implemented.
- UNKNOWN risk -> 0: **DEVIATES, NOT YET FIXED**. `services/scoring-worker/src/index.ts:65-66` (`insiderRiskPct??0`, `rugExposurePct??0`) and `packages/discovery/src/index.ts:13-14` silently treat missing evidence as 0/safe. No VERIFIED/PARTIAL/UNKNOWN/STALE evidence-quality field exists anywhere.

### Fork E findings (RPC resilience / EVM hardening / ingestion durability)
- EVM WS reconnect/watchdog: **MISSING, confirmed**. `services/evm-flow-worker/src/index.ts:36` opens a bare WebSocketProvider with zero reconnect/watchdog/reorg handling, unlike Solana flow-worker's real 90s watchdog. Currently dormant/harmless only because BNB_RPC_WS/ETH_RPC_WS are unset in production -- a landmine, not yet fixed.
- Chain-agnostic "USDC" string bug: **CONFIRMED**. `services/brain-worker/src/index.ts:77` writes literal string `"USDC"` as inputMint for non-Solana chains. Not currently exploitable (executor hard-gates `signal.chain!=="SOLANA"`, zero EVM execution path exists), but bad data written to DB today, landmine for whenever EVM execution is added. **Not yet fixed.**
- Capability registry (DISCOVERY/EXECUTION/QUOTE/SELL_SUPPORTED per chain): **MISSING entirely**. Today's safety is accidental (nothing else was ever built for EVM), not by explicit design. **Not yet fixed.**
- Solana flow-worker durable ingestion: **PARTIAL, deliberate**. Dropped events under backoff/budget-denial are a reasoned load-shedding choice (documented in comments), real 90s watchdog reconnect exists, but no requeue/dead-letter/durable cursor -- a dropped signature is gone forever, not silently miscounted but genuinely unrecovered.
- RPC failover: **MOSTLY IMPLEMENTED, one confirmed gap**. fallbackRpc genuinely consumed, priority-tier reserve ratios really enforced (not just labels). Gap: health check (`pickHealthyRpc`) only calls generic `getHealth`, never validates a required indexed method (e.g. getTokenSupply/getProgramAccounts) before selecting a candidate -- the code's own comment documents having already been bitten by exactly this. **Not yet fixed.**

---

## M — Master Audit Prompt (sections 0-68)

| ID | Requirement | Status | Files/Evidence | Remaining |
|---|---|---|---|---|
| M-1 | System map: full architecture graph (chain→ingestion→discovery→brain→execution→portfolio) + wallet→deposit→balance→cash→execution graph | PENDING AUDIT | | Build explicit graph doc once subsystem forks report |
| M-2 | Single authoritative source per financial/state concept (balance, cash, P&L, position qty, entry price, execution state, brain state, wallet status, market price, notification pref, deposit status) | PENDING AUDIT | Fork A/B running | |
| M-3 | Product concept: intelligence runs independent of wallet/Auto Trade/live execution | PENDING AUDIT | Fork D running | |
| M-4 | Raw discovery != user discovery (RAW_TOKEN→CANDIDATE→FLOW_DETECTED→SMART_MONEY_DETECTED→HEATING_UP→BREAKOUT_FLOW→MONEY_RUSH funnel) | PENDING AUDIT | Fork D running | |
| M-5 | Prove what normal Discover UI actually reads (frontend→API→DB→qualification) | PENDING AUDIT | Fork D running | |
| M-6 | Proper token qualification funnel (KNOWN POSITIVE/NEGATIVE/UNKNOWN, not require-all-metrics) | PENDING AUDIT | | |
| M-7 | Smart wallet discovery full rebuild: multiple channels (token-first, wallet-first, flow-first, convergence-first) | PENDING AUDIT | Fork D running | |
| M-8 | Separate wallet metrics (wealth, profitability, consistency, early-entry, copyability, activity, risk, drawdown, rug exposure, chase, token-selection, sample confidence) | PENDING AUDIT | Fork D running | |
| M-9 | Fix forward-proof contamination (OPEN/unrealized paper P&L must not count as PROVEN evidence) | PENDING AUDIT | Fork D running | |
| M-10 | Unknown risk must remain UNKNOWN (no `?? 0` / `|| 0` risk defaults) | PENDING AUDIT | Fork D running | |
| M-11 | Admin Smart Money Desk (Found Today/Active Now/Watchlist/Paper/Proven/Paused/Rejected) | PENDING AUDIT | | |
| M-12 | Admin watchlist actually monitors continuously (persisted, backend-driven, not browser-dependent) | PENDING AUDIT | | |
| M-13 | PROVEN must mean proven (no one-button admin fabrication) | PENDING AUDIT | Fork D running | |
| M-14 | Smart wallet → Brain connection actually wired end-to-end | PENDING AUDIT | Fork D running | |
| M-15 | Convergence weighted by wallet quality (proven > paper > unknown) | PENDING AUDIT | | |
| M-16 | Brain model splits decision into Momentum/SmartMoney/Execution/Risk/Evidence, not one opaque score | PENDING AUDIT | | |
| M-17 | Brain user explanation ("why found this") on every opportunity | PENDING AUDIT | | |
| M-18 | Notification preference routing — independent qualification per preference type | PENDING AUDIT | Fork D running | |
| M-19 | Opportunity lifecycle (DISCOVERED..CLOSED), no time-based re-entry | PENDING AUDIT | Known: 30s BUY_NOW repeat bug fixed (commit 1ad91f4) — verify full lifecycle beyond that patch | |
| M-20 | Multi-chain capability safety — remove `inputMint = "USDC"` fallback ambiguity, explicit capability registry per chain | PENDING AUDIT | Fork E running | |
| M-21 | EVM hardening (reconnect, watchdog, failover, rate limit, reorg, cursor/replay, stale detection, dynamic pricing) | PENDING AUDIT | Fork E running; commit e6b41f8 admits reconnect NOT done as of that commit | |
| M-22 | Raw chain ingestion — no silent event loss, durable lifecycle (SEEN..TERMINAL_FAILURE) | PENDING AUDIT | Fork E running | |
| M-23 | Market data truth — source/observedAt/freshness/quality tracked, no fake $0 price | PENDING AUDIT | | |
| M-24 | Market-worker priorities P0(live positions)..P5(backfill) enforced | PENDING AUDIT | Commit 438e31d claims this — verify | |
| M-25 | RPC resilience — chaos-tested failover/failback, health check validates required methods not just getHealth | PENDING AUDIT | Fork E running | |
| M-26 | Execution full real-money forensics — buy lifecycle crash-safety at every boundary | PENDING AUDIT | Fork B running | |
| M-27 | Source sell / exit forensics — no double-execution | PENDING AUDIT | Fork B running | |
| M-28 | Exit engine real product behavior (test +100%..+500%, runners, partial exits) | PENDING AUDIT | Fork B running | |
| M-29 | Stale data must never cause real exit | PENDING AUDIT | Fork B running | |
| M-30 | Financial precision audit (no float drift in canonical money) | IMPLEMENTED | Position/PositionExit/TradingCashAllocation/LedgerEntry all now BigInt micro-USD (fixes #18, #20); Decimal confirmed unavailable on Prisma+MongoDB. Full monorepo build (32/32) is the compile-time completeness check; not LIVE VERIFIED (no DATABASE_URL in this environment) | |
| M-31 | Immutable financial ledger (deposit/withdrawal/buy/sell/fee/adjustment/reversal) | PENDING AUDIT | Fork A running | |
| M-32 | Portfolio truth consistent across all surfaces | PENDING AUDIT | Fork A running; commit 1758886 claims partial fix | |
| M-33 | Wallet full product review (preserve Privy features, finish UX) | PENDING AUDIT | | |
| M-34 | Wallet export security (key never reaches backend/logs/DB) | PENDING AUDIT | Commit baf114a implements export via Privy modal — verify no backend key exposure | |
| M-35 | Add Funds — direct one-tap flow from every surface | PENDING AUDIT | | |
| M-36 | Deposit reconciliation chaos-tested (no double credit) | PENDING AUDIT | Commit 8eae454 claims idempotent deposits — verify | |
| M-37 | Auth/session security threat model (XSS, refresh replay, CSRF, rotation, multi-tab) | PENDING AUDIT | Fork C running | |
| M-38 | IDOR / authorization audit across all user resources + admin role separation | PENDING AUDIT | Fork C running | |
| M-39 | Admin security — no secret exposure to frontend, audit log for high-risk changes | PENDING AUDIT | Fork C running | |
| M-40 | Realtime architecture (SSE/WS) triggers refetch of authoritative state, not itself authoritative | PENDING AUDIT | | |
| M-41 | User Home rebuild (MemeCloud Pulse concept) | PENDING AUDIT | | |
| M-42 | Discover UX (Hot Now/Smart Money/Whales/Money Rush/Early/Watchlist primary, New Token Radar secondary) | PENDING AUDIT | | |
| M-43 | Smart Money UX first-class section | PENDING AUDIT | | |
| M-44 | Token detail — MemeCloud Verdict breakdown | PENDING AUDIT | | |
| M-45 | Auto Trade UX (OFF explains intelligence still runs; ON shows allocation/exposure/risk) | PENDING AUDIT | | |
| M-46 | Empty/degraded states differentiated (quiet market vs pipeline broken) | PENDING AUDIT | | |
| M-47 | Admin Health 2.0 (real usefulness metrics, not heartbeat-only) | PENDING AUDIT | | |
| M-48 | Remove health lies — measure actual useful work per worker | PENDING AUDIT | | |
| M-49 | API monolith refactor (server.ts ~160KB → domain routes/services/middleware) | PENDING AUDIT | | |
| M-50 | Frontend monolith refactor (split god-components) | PENDING AUDIT | | |
| M-51 | Test scripts audit — find echo/no-op/`|| true`/`.only`/`.skip` fake tests | PENDING AUDIT | | |
| M-52 | Chaos testing (Mongo/Redis/RPC/Birdeye/Jupiter/Privy/WS/BullMQ failure matrix) | PENDING AUDIT | | |
| M-53 | Process-crash tests around real-money boundaries | PENDING AUDIT | | |
| M-54 | Observation-only live funnel test (raw events → Money Rush counts) | PENDING AUDIT | Requires live system running — VPS currently down, BLOCKED until VPS restored |
| M-55 | Wallet discovery live test (observation window funnel report) | PENDING AUDIT | Same VPS dependency |
| M-56 | No-wallet acceptance test (Home/Discover/Brain/SmartMoney/watchlist/notifications work with zero wallet) | PENDING AUDIT | | |
| M-57 | Real-world concept test (3 proven wallets converge scenario) | PENDING AUDIT | Requires live data — VPS dependency |
| M-58 | Random new coin test (weak token must NOT reach Hot/Strong/Money Rush) | PENDING AUDIT | | |
| M-59 | Real-money acceptance (funded end-to-end proof) | BLOCKED | Requires owner-approved real funds and live VPS — explicit owner approval required before any real-money test runs |
| M-60 | Full UX QA across viewports | PENDING AUDIT | | |
| M-61 | Security pass (IDOR/auth bypass/replay/overflow/etc adversarial) | PENDING AUDIT | Fork C running | |
| M-62 | Audit things user didn't mention (TODO/FIXME/MOCK/FAKE/PLACEHOLDER/catch{}/as any/hardcoded/etc grep sweep) | PENDING AUDIT | | |
| M-63 | Cross-subsystem audit discipline (no isolated patches) | ONGOING PRACTICE | Applied as working method throughout, not a single deliverable | |
| M-64 | Do not count code as proof — strict status vocabulary | IMPLEMENTED AS PRACTICE | This matrix enforces IMPLEMENTED/TESTED/LIVE VERIFIED/BLOCKED only | |
| M-65 | Repeat audit passes 1-7 after fixes | PENDING | Scheduled after first fix round completes | |
| M-66 | Final requirement traceability doc | IN PROGRESS | This file | |
| M-67 | Final product questions (22 questions) | PENDING AUDIT | See Q-# section below | |
| M-68 | Execution instruction (fix, don't just report; clean commits; don't reset good work; BLOCKED only for genuine external blockers) | ONGOING PRACTICE | Governing rule for all work in this file | |

## C — Continuation/Resume Prompt (sections 1-30)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| C-1 | EVM hardening completion | PENDING AUDIT | = M-21, Fork E |
| C-2 | Durable flow ingestion / no silent drops | PENDING AUDIT | = M-22, Fork E |
| C-3 | Smart-wallet discovery skill-centric (not wealth-gated) | PENDING AUDIT | = M-7/M-8, Fork D |
| C-4 | Forward-proof smart-wallet promotion (objective thresholds, not admin button) | PENDING AUDIT | = M-9/M-13, Fork D |
| C-5 | New Token Radar dedicated path | PENDING AUDIT | | 
| C-6 | Notification preference correctness | PENDING AUDIT | = M-18, Fork D |
| C-7 | Full opportunity lifecycle | PENDING AUDIT | = M-19 |
| C-8 | Brain risk/evidence model split | PENDING AUDIT | = M-16 |
| C-9 | Accounting/financial ledger | PENDING AUDIT | = M-31, Fork A |
| C-10 | Live execution forensic audit | PENDING AUDIT | = M-26, Fork B |
| C-11 | Exit engine full audit | PENDING AUDIT | = M-28/29, Fork B |
| C-12 | Real-time UX (SSE/WS + refetch) | PENDING AUDIT | = M-40 |
| C-13 | Full wallet product redesign | PENDING AUDIT | = M-33 |
| C-14 | Add Funds one-tap flow | PENDING AUDIT | = M-35 |
| C-15 | Complete Home UX redesign | PENDING AUDIT | = M-41 |
| C-16 | Complete Discover UX | PENDING AUDIT | = M-42 |
| C-17 | Smart Money first-class nav | PENDING AUDIT | = M-43 |
| C-18 | Token detail redesign | PENDING AUDIT | = M-44 |
| C-19 | Auto Trade UX | PENDING AUDIT | = M-45 |
| C-20 | Empty/error states | PENDING AUDIT | = M-46 |
| C-21 | User-facing status language translation (internal codes → plain English) | PENDING AUDIT | New requirement not in M-list — track separately |
| C-22 | Design system / mobile-first unification | PENDING AUDIT | = M-60 |
| C-23 | Admin UX / Health 2.0 reorg | PENDING AUDIT | = M-47 |
| C-24 | Security/IDOR/auth repeat audit | PENDING AUDIT | = M-38, Fork C |
| C-25 | Chaos testing | PENDING AUDIT | = M-52 |
| C-26 | Monolith refactor | PENDING AUDIT | = M-49/50 |
| C-27 | Final multi-pass audit (7 passes) | PENDING | = M-65 |
| C-28 | Live verification rule discipline | ONGOING PRACTICE | = M-64/59 |
| C-29 | Final forensic report | IN PROGRESS | This file |
| C-30 | Do not stop early | ONGOING PRACTICE | Governing rule |

## PC — Product-Concept Alignment (sections A-M)
| ID | Requirement | Status |
|---|---|---|
| PC-A | Audit wallet hunting engine end-to-end with evidence for every dimension (P&L, win rate, drawdown, etc.) | PENDING AUDIT — Fork D |
| PC-B | True wallet-first discovery (not gated on wealth) | PENDING AUDIT — Fork D |
| PC-C | Admin Smart Money Hunting Desk | PENDING AUDIT |
| PC-D | Continuous admin watchlist monitoring | PENDING AUDIT |
| PC-E | Audit user Discovery — raw DiscoveryToken vs qualified GlobalBrainOpportunity | PENDING AUDIT — Fork D (critical) |
| PC-F | Internal candidate funnel stages | PENDING AUDIT — Fork D |
| PC-G | Discovery qualification evidence-based, not "new"/"trending" alone | PENDING AUDIT |
| PC-H | Smart money convergence weighting | PENDING AUDIT |
| PC-I | Explain why every token is shown | PENDING AUDIT |
| PC-J | Radar vs recommendation separation | PENDING AUDIT |
| PC-K | Verify Global Brain actually uses smart wallets end-to-end | PENDING AUDIT — Fork D |
| PC-L | Real-world observation test with funnel numbers | BLOCKED (needs live VPS) |
| PC-M | Final concept acceptance scenarios 1-4 | PENDING (needs live system for full proof; code-level logic can be verified now) |

## Q — Final Acceptance Questions (22, from M-67)
All PENDING AUDIT. Will be answered with evidence once forks A-E report and fixes land. Listed in full in M-67 reference; not duplicated here to keep this file maintainable — see original prompt text for exact wording, answered inline in the "Final Product Questions" section to be added after Pass 1.

---

## Fixes applied so far
| # | Fix | Commit | Requirement(s) closed |
|---|---|---|---|
| 1 | Forward-proof contamination: PROVEN scoring now uses only CLOSED paper trades, not OPEN/PARTIAL unrealized P&L | 0828d7b | M-9, C-4, Fork D #6 |
| 2 | Admin PROVEN-decision route now enforces server-side shouldProve() evidence gate | 0828d7b | M-13, Fork D #5 |
| 3 | discoverySubscribers() base pool now ORs all 6 discovery prefs (was 3); discoveryWhaleActivity + discoveryNewToken implemented (previously wired to nothing) | 0828d7b | M-18, C-6, Fork D #7 |
| 4 | services/exits executeLiveExit Order creation now has P2002 race handler mirroring executor.ts | 0828d7b | M-27, Fork B |
| 5 | pickHealthyRpc now validates an indexed method (getTokenSupply), not just getHealth | dbad0b0 | M-25, Fork E |
| 6 | New CHAIN_CAPABILITY_REGISTRY in packages/shared; fixed brain-worker writing literal "USDC" as inputMint for non-Solana chains; executor/exits now read from the shared registry | dbad0b0 | M-20, Fork E |
| 7 | UNKNOWN risk evidence (insiderRiskPct/rugExposurePct) no longer collapses to 0/"safe"; new evidenceCompleteness field gates PROVEN independently | 1089163 | M-10, Fork D #8 |
| 8 | True wallet-first/convergence-first discovery: scanWalletFirst() profiles addresses by repeated early entry across independently-qualifying tokens, not just pre-selected token trader lists | 6db89f9 | M-7, C-3, PC-B, Fork D #3 |
| 9 | EVM flow-worker WebSocket reconnect + 90s silence watchdog, mirroring Solana flow-worker's proven pattern | 21f78ed | M-21, C-1, Fork E |
| 10 | Immutable LedgerEntry model + wired into all 3 real-money confirmation points (buy spend, 2x sell proceeds) and USDC deposits | 45babde | M-31, C-9, Fork A |
| 11 | Brain score split into Momentum/SmartMoney/Execution/Risk/Evidence breakdown (additive, doesn't change trading decision), persisted + surfaced in Token Detail UI | 820591b, 93209a9 | M-16, M-17, M-44, C-8 |
| 12 | Convergence weighted by wallet quality (PROVEN=2x, PAPER_TRACKING=1x) instead of raw uniform count | 2dd184b | M-15, PC-H |
| 13 | Discover main feed tightened to score>=56 (was: any nonzero activity); explicit separate New Token Radar added to API + UI | 7947dc8 | M-5, PC-E, PC-J, M-42 (partial) |
| 14 | Real admin watchlist: adminWatched field (separate from `stage`), WATCH/UNWATCH actions, continuous backend monitoring (checkWatchlist), AdminAlert model + routes, minimal admin UI | 74714d2 | M-12, M-13 (extended), PC-D |
| 15 | packages/providers: replaced no-op test script with 6 real tests for Birdeye field normalization (pure, bug-prone logic previously untested) | 049a1a8 | M-51 (partial) |
| 16 | packages/notifications: replaced no-op test script with 8 real tests for email rendering (formatFrom/htmlToPlainFallback/renderEmail) | 2b0c6a2 | M-51 (partial) |
| 17 | Separate 7D P&L tracking for smart wallets (was: only ever a single 30d window fetched anywhere) | 5fb7dac | Section 8/11 of master spec |
| 18 | M-30 (retry): LedgerEntry migrated to integer micro-USD (BigInt) after discovering Prisma+MongoDB does not support Decimal at all (verified: hard error). usdToMicros/microsToUsd added to packages/shared with tests proving exactness at the float64 failure boundary | cafc1e7 | M-30 (partial -- LedgerEntry only) |
| 19 | Admin Smart Money desk: Found Today / Active Now / Watchlist views + Win Rate/Risk columns added to existing candidates table | 2c8cff6 | M-11, PC-C (partial) |
| 20 | M-30 COMPLETE: Position/PositionExit/TradingCashAllocation migrated to BigInt micro-USD (renamed fields force compile-time detection of every site); 3 new shared helpers with a caught-before-shipping JSON.stringify-on-BigInt bug fixed | e3faeff | M-30 |
| 21 | Architecture map document (chain->ingestion->discovery->brain->execution->portfolio graph, wallet->deposit->balance->cash->execution-authority graph, capability registry table) | caec32f | M-1 |
| 22 | Status-language translation: CopyDecision.action codes (WAIT_PULLBACK etc.) + additional trading-specific error codes translated to plain language | 064c452 | C-21 |
| 23 | packages/flow-worker: extracted ownerDeltas (pure balance-delta parsing) to a side-effect-free module + 6 real tests, replacing no-op script | ec3a96d | M-51 (partial) |
| 24 | Home: real MemeCloud Pulse (Heating Up/Strong/Money Rush/Whale counts), Auto Trade status card, Hot Right Now, expanded account hero (Total Value/Available/In Trades/Today P&L) -- all from already-fetched data | bc41bb0 | M-41 (partial) |
| 25 | Wallet: exposed real on-chain USDC/SOL balances (WalletAssetBalance had been synced since commit 8eae454 but never read by any route) via new GET /v1/me/wallets/:id/balances + display in WalletDetailSheet, with honest Unknown/Delayed states | 54a3064 | M-33 (partial) |
| 26 | Smart Money: Hot Now + Newly Found filters, 7D P&L surfaced (schema/scoring already had it, never returned by the API) | 8d65b58 | M-43, PC-C (partial) |
| 27 | Empty states: SmartWalletsView + Home Pulse now distinguish degraded pipeline from genuinely quiet (was already tracked, just not used) | 2783ac2 | M-46 (partial) |
| 28 | Auto Trade: OFF/ON explanatory copy (spec's own wording) + real allocation/trades-today/last-action from already-fetched data | 9c40dda | M-45 |

## Security re-verification (this round, no new bugs -- documenting what was checked)
- Spot-checked the 2 `/v1/me/*` `:id` routes Fork C's report didn't explicitly name (`DELETE /v1/me/sessions/:id`, `PUT /v1/me/traders/:id`) -- both correctly scope by `req.user.sub`. Combined with Fork C's original ~10-route sample, essentially all of apps/api/src/server.ts's parameterized user routes are now checked (confirmed via file count: server.ts is genuinely the only route file in the API -- no other route files exist to have been missed).
- Verified every single BullMQ `.add()` call across every worker passes an explicit `jobId` for provider-level dedup (answers Q11 "can duplicate queues double-spend?" -- no, and this is defense-in-depth on top of the DB-level idempotency keys already verified in Fork B's execution audit).
- Grepped for `priceUsd ?? 0` / fabricated-zero-price patterns (M-23's "no price: UNAVAILABLE, not $0" requirement) -- none found.

## M-51 fake-test audit (full findings)
Workspace-wide scan of every `package.json` test script found 22 packages/services using `echo ... tests` (a green no-op). Triaged:
- **Acceptable as-is**: `db`, `fees`, `ops`, `market`, `router`, `social`, `intelligence` — genuinely tiny (6-48 lines), pure I/O/type-wrapper files with no meaningful pure logic to unit test.
- **Acceptable — real logic lives and is tested elsewhere**: `executor`, `exits` (financial math is `calculateExitAccounting` in packages/shared, real-tested in `accounting.test.ts`), `brain-worker` (logic in packages/brain, 23 tests), `scoring-worker`/`discovery-worker` (logic in packages/discovery, 6 tests incl. this session's 2 new), `paper-worker` (explicitly shares strategy package's tests per its own script comment).
- **Fixed this session**: `providers` (6 new tests, see fix #15) — real, pure, previously-uncovered parsing logic that has already caused production bugs.
- **Not yet audited in depth**: `notifications` (174 lines — email/push rendering logic, worth a closer look), `evm-flow-worker`, `forward-worker`, `flow-worker`, `notification-worker`, `analytics-worker`, `market-worker`, `social-worker`, `listener`, `apps/web` — likely mostly I/O orchestration but not individually verified line-by-line.

## Still open (not yet fixed, real remaining work)
| ID | Item | Size | Notes |
|---|---|---|---|
| M-4/M-6/PC-F | Explicit persisted stage-funnel enum (RAW_DISCOVERED..MONEY_RUSH) | MEDIUM | classifyLifecycle() computes a real, tested, equivalent progression on read; judged substantially equivalent in intent (see Fork D notes), not a named-enum rewrite |
| M-11/PC-C | Full Admin Smart Money Desk (dedicated page/layout, card-based wallet profiles, VIEW ACTIVITY/TRADES drill-in) | LARGE | Found Today/Active Now/Watchlist views + win rate/risk columns now real (fix #19); the fuller dedicated redesign remains open |
| M-33 through M-43, M-45 through M-48, C-12 through C-23 | Remaining UX/product redesign (Home Pulse, full Wallet redesign, Smart Money nav, Auto Trade UX, empty states, Admin Health 2.0, mobile QA, design system) | VERY LARGE | Token Detail (M-44) partially done (Verdict breakdown, reasons); Discover (M-42) partially done (New Token Radar separation); status-language (C-21) done (fix #22); rest not started |
| M-49/M-50/C-26 | API + frontend monolith refactor | LARGE | Not started |
| M-51 | Remaining fake-test-script audit | MEDIUM | 3 of 22 no-op scripts replaced (fixes #15, #16, #23); see full breakdown above |
| M-52/M-53/C-25 | Chaos testing, process-crash testing | LARGE | Not started (no live environment available here to induce real failures against) |
| M-54/M-55/M-57/PC-L | Live observation-window funnel tests | BLOCKED | Requires the VPS, currently down |
| M-59 | Real-money live execution verification | BLOCKED | Requires owner-approved funded test |
| M-60/C-22 | Full mobile/viewport UX QA | LARGE | Not started |
| M-65/C-27 | Repeat 7-pass audit after fixes | ONGOING | This is pass 1; more passes needed once larger items land |

## Blockers (genuine external only)
| ID | Blocker | Reason |
|---|---|---|
| M-59 | Real-money live execution verification | Requires owner-approved funded test — will not run without explicit fresh approval |
| M-54/55/57/PC-L | Live observation-window funnel tests | Requires the production VPS (173.212.249.202), which is currently unreachable (resource exhaustion incident, restart pending owner action) |

## Final Product Questions (M-67) -- answered with evidence, not vibes
Only questions answerable from code/tests actually examined this session are marked PROVEN or NO. Anything requiring a live environment is marked NOT PROVEN (live) with the reason.

1. **Does MemeCloud genuinely hunt profitable wallets automatically?** PROVEN (code). Token-first (`scan()`) + wallet-first (`scanWalletFirst()`, fix #8) + flow-first channels all write SmartWalletCandidate; scoring-worker scores every 30d+7d window automatically. NOT PROVEN (live) -- no live observation window run (VPS down).
2. **Does it preserve discovered wallets and continuously evaluate them?** PROVEN (code). scoring-worker's query includes DISCOVERED/ANALYZING/PAPER_TRACKING/PROVEN every cycle (auto-demotion on decline, verified pre-existing).
3. **Can admin maintain a watchlist separate from PROVEN?** PROVEN (code, fix #14). `adminWatched` is a separate boolean, never touches `stage`; WATCH/UNWATCH actions don't gate on or grant PROVEN.
4. **Can a small but skilled wallet become valuable to the system?** PROVEN (code). `scoreWallet()` has no wealth/balance term (Fork D verified); `scanWalletFirst()` discovers by behavior alone regardless of balance.
5. **Does Brain know when proven wallets are buying?** PROVEN (code, fix #12). `weightedConvergenceScore()` weights PROVEN 2x a PAPER_TRACKING wallet in the exact convergence signal that gates notifications.
6. **Does user Discover primarily show meaningful intelligence rather than generic token listings?** PROVEN (code, fix #13). Main feed requires score>=56 (evaluateOpportunity's own WATCH threshold); raw/unqualified tokens go to a separate newTokenRadar array.
7. **Can the entire intelligence system work with ZERO user wallet?** PROVEN (code). Discovery/scoring/Brain/notifications have no wallet dependency anywhere in the read path; only execution (maybeSignal -> executor) requires a funded, permissioned wallet.
8. **Can Auto Trade remain OFF while intelligence continues?** PROVEN (code). notifyDiscoveryUpgrade/notifyConvergence/notifyWhaleActivity/notifyNewToken (fix #3) are independent of `autoCopyEnabled`/live-trading toggles.
9. **Can one chain/provider outage silently kill the whole product?** PARTIALLY MITIGATED. RPC failover + priority tiers exist and are real (Fork E); balance/price never fabricate to $0/UNKNOWN-safe defaults (verified). EVM ingestion still has no live traffic to test reconnect against (dormant).
10. **Can RPC failure fabricate zero balance?** NO (verified, pre-existing + re-confirmed). `balance-worker` sets `null` and skips the write on any unresolved address; never zeroes a real balance.
11. **Can duplicate queues double-spend?** NO (verified this session). Every BullMQ `.add()` across every worker uses an explicit `jobId`; downstream DB idempotency keys (decisionKey, exitKey, LiveExecutionAttempt) are the second layer.
12. **Can ambiguous transaction submission duplicate a buy/sell?** NO (verified, Fork B + this session's exits.ts P2002 fix #4). Every live buy/sell path recovers via Privy `reference_id` before ever resubmitting.
13. **Can stale prices trigger a destructive exit?** NO (verified, Fork B). `exits/index.ts` explicitly skips adaptive-exit evaluation on stale/missing rich market data; only marks-to-market continues.
14. **Can missing risk evidence be mistaken for safe evidence?** FIXED THIS SESSION (fix #7). `evidenceCompleteness` now independently gates PROVEN; unmeasured risk uses a conservative non-zero default, not 0.
15. **Can open unrealized moonbags falsely make a wallet PROVEN?** FIXED THIS SESSION (fix #1). forwardMean now uses only CLOSED paper trades.
16. **Can a user with only Smart Wallet alerts enabled receive Smart Wallet alerts?** FIXED THIS SESSION (fix #3). All 6 discovery preferences now independently qualify.
17. **Does every user-visible P&L reconcile to real evidence?** STRENGTHENED THIS SESSION (fixes #10, #18, #20). Immutable LedgerEntry now records every real-money event atomically alongside the state change; not LIVE VERIFIED against a real trade.
18. **Can private keys ever reach MemeCloud infrastructure?** NO (verified, pre-existing, re-read this session). Export flows through Privy's own iframe-isolated modal; commit baf114a's own message documents this was verified against the installed SDK, not assumed.
19. **Can one user access another user's financial resources?** NO (verified, Fork C + this session's spot-checks). Every checked `/v1/me/*` route scopes by `req.user.sub`.
20. **Can the platform recover safely after a process crash?** PROVEN (code, Fork B + fix #4). Idempotency keys + Privy reference-ID recovery cover buy and sell paths on both executor.ts and exits.ts. NOT PROVEN (live) -- no induced-crash test run.
21. **Does Admin Health detect a worker that is alive but useless?** PARTIALLY. Heartbeats now carry real work metrics (walletFirstScans, watchlistAlerts, reconnects, silentForSec -- all added this session), but no single "useful work stalled" alert view exists yet (M-47/48 dashboard not built).
22. **Does the UX make the intelligence understandable without exposing developer internals?** PARTIALLY. MemeCloud Verdict breakdown + status-language translation (fixes #11, #22) cover Token Detail and decision history; most of the UX (Home, Wallet, Admin desk) hasn't had this pass yet.

## Next steps
1. Full UX/product redesign (Home Pulse, Wallet, Smart Money nav, Admin desk, mobile QA) -- VERY LARGE, not started.
2. API + frontend monolith refactor -- LARGE, not started.
3. Remaining fake-test-script audit (19 of 22 packages left) and chaos/process-crash testing (needs a live environment this working directory doesn't have).
4. Live verification of everything marked NOT PROVEN (live) above -- needs the VPS back up and, for M-59, explicit owner approval for a real funded trade.
5. Update this file after every batch of fixes with commit hashes, as done throughout this session.
