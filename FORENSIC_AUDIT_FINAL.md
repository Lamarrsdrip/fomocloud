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
| M-30 | Financial precision audit (no float drift in canonical money) | PENDING AUDIT | Fork A running | |
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

## Still open (not yet fixed, real remaining work)
| ID | Item | Size | Notes |
|---|---|---|---|
| M-30 | Float→Decimal/integer-micro-USD migration for canonical USD fields | LARGE, RISKY | Not an active bug at current trade sizes but architecturally exactly what's flagged; needs careful schema migration + every read/write site updated |
| M-1 | Explicit system architecture map + wallet/deposit/execution graph doc | MEDIUM | Descriptive artifact, not yet written as a standalone doc (this file covers it piecemeal) |
| M-4/M-6/PC-F | Explicit persisted stage-funnel enum (RAW_DISCOVERED..MONEY_RUSH) | MEDIUM | classifyLifecycle() computes a real progression on read; not persisted as named stages |
| M-11/PC-C | Admin Smart Money Desk (Found Today/Active Now/Watchlist/Paper/Proven/Paused/Rejected UI) | LARGE | Frontend build |
| M-12/PC-D | Persistent, continuously-monitoring admin watchlist | MEDIUM-LARGE | Backend + frontend |
| M-33 through M-43, M-45 through M-48, C-12 through C-23 | Remaining UX/product redesign (Home Pulse, full Wallet redesign, Smart Money nav, Auto Trade UX, empty states, Admin Health 2.0, status-language translation, mobile QA, design system) | VERY LARGE | Token Detail (M-44) partially done (Verdict breakdown, reasons); Discover (M-42) partially done (New Token Radar separation); rest not started |
| M-49/M-50/C-26 | API + frontend monolith refactor | LARGE | Not started |
| M-51/M-52/M-53/C-25 | Test-script audit, chaos testing, process-crash testing | LARGE | Not started |
| M-54/M-55/M-57/PC-L | Live observation-window funnel tests | BLOCKED | Requires the VPS, currently down |
| M-59 | Real-money live execution verification | BLOCKED | Requires owner-approved funded test |
| M-60/C-22 | Full mobile/viewport UX QA | LARGE | Not started |
| M-65/C-27 | Repeat 7-pass audit after fixes | ONGOING | This is pass 1; more passes needed once larger items land |

## Blockers (genuine external only)
| ID | Blocker | Reason |
|---|---|---|
| M-59 | Real-money live execution verification | Requires owner-approved funded test — will not run without explicit fresh approval |
| M-54/55/57/PC-L | Live observation-window funnel tests | Requires the production VPS (173.212.249.202), which is currently unreachable (resource exhaustion incident, restart pending owner action) |

## Next steps
1. Collect reports from forks A-E, update every PENDING AUDIT row above with real status + evidence.
2. Begin fixing confirmed real-money-safety gaps first (financial precision, execution duplication, IDOR).
3. Proceed in order: safety → architecture → intelligence/discovery → wallet → notifications → UX → refactors → chaos testing → final QA passes.
4. Update this file after every batch of fixes with commit hashes.
