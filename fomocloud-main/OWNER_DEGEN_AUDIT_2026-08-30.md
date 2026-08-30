# MemeCloud owner/degen audit — 2026-08-30

## Scope actually inspected

This pass recursively inventoried the uploaded source tree and reviewed the production-critical paths end-to-end rather than treating the screenshots as isolated UI bugs.

- `apps/`: 82 files / ~5,815 TS/TSX/JS/Prisma/ops LOC
- `packages/`: 67 files / ~4,695 code LOC
- `services/`: 70 files / ~4,219 code LOC
- `deployment/`: 3 files / 42 ops LOC
- plus root configuration/docs and the existing `FORENSIC_AUDIT_FINAL.md`

High-risk traces reviewed directly: public/auth API, Brain feed/token routes, Smart Money API, notification settings/delivery, wallet UI/balances/send/history/security, portfolio accounting presentation, discovery worker, wallet-first discovery, smart-wallet scoring/promotion, Brain decision scoring, watched-wallet notification path, market normalization/snapshots, strategy entry/risk/exit semantics, social/X enrichment, Windows NSSM deployment/reboot behavior.

## Fixed in this pass

### 1. Discovery is no longer a generic token firehose

- Main Hunt feed now requires a real qualified Brain state **and** quality-capital evidence: weighted smart-wallet convergence, whale participation, or material tracked smart-money flow.
- Raw/fresh tokens stay in the explicitly separate New Token Radar until they earn the main-feed evidence bar.
- `New token found` phone alerts are now alpha alerts: young token + usable liquidity + organic buyers + quality smart/whale capital + meaningful money. A raw new mint cannot notify everybody merely because it exists.
- Old/dead tokens receive an explicit age penalty and only re-awaken if fresh quality capital plus accelerating flow returns.
- Unknown launch age is represented as unknown (`-1` internally), not fabricated as exactly 24 hours old. Unknown age can never receive the new-token alpha bonus.

### 2. Professional-degen Brain scoring

The old score path over-rewarded raw inflow/buyer activity and kept smart-wallet convergence mostly explanatory. It now separates and weights:

- Momentum
- Smart Money
- Execution Quality
- Risk
- Evidence Completeness

Quality smart-money convergence now changes the actual decision score. PROVEN wallets carry materially more authority than PAPER wallets; repeat-early DISCOVERED/ANALYZING wallets can contribute only a weak pre-proof insider-cluster hint after repeated early entries, never the authority of PROVEN skill.

`MONEY_RUSH` now requires multi-channel evidence rather than a naked score threshold: quality capital, strong organic flow, acceleration, sufficient execution quality and no severe structure risk.

### 3. Rug/dead-token evidence is stronger and missing evidence stays missing

- Missing holder profile fields no longer collapse to a verified 0% bundled/creator risk.
- Missing creator holding no longer normalizes to zero.
- Brain risk now consumes bundled supply, creator-linked supply, LP risk, freeze/mint/token-extension evidence where producers have verified it.
- Extreme bundled supply, creator holding, LP structure and authority risks become visible warnings and meaningfully reduce qualification without turning ordinary meme volatility into a traditional-finance hard block.
- Hard blocks remain reserved for objective execution impossibility/catastrophic conditions.

### 4. Smart-wallet scoring rebuilt around skill, not wealth

Wallet scoring now explicitly uses:

- realized profitability rather than letting an unrealized moonbag manufacture skill
- repeat forward outcomes/hit rate and downside
- 7D current form
- 30D durability
- activity recency
- distinct-token diversity
- early-entry edge when available
- average copy chase
- unknown-vs-verified risk evidence
- unrealized-profit reliance penalty

Whale size is separate from skill. Recent chain observations now persist the actual whale tier / observed wallet balance into candidate evidence so the user-facing whale view is not guessed from an admin label.

OPEN/PARTIAL paper positions remain excluded from PROVEN proof; only mature/closed outcomes or valid bounded forward samples can promote a wallet.

### 5. Alpha-insider / early-cluster detection

Wallet-first discovery remains independent of token-first Birdeye discovery. Repeat early participation across multiple independently qualifying tokens creates a wallet candidate. During a new token's 10-minute flow window, those repeat-early candidates can form a weak pre-proof convergence clue, while PAPER/PROVEN traders dominate the real Smart Money weight. This allows MemeCloud to notice coordinated early capital before a move without falsely calling every new address smart money.

### 6. X/social quota now follows alpha instead of trash

The social worker no longer spends scarce X recent-search quota on the newest 40 arbitrary `discoveryToken` rows. It prioritizes qualified Brain opportunities plus a small high-flow/whale fresh-radar lane. Social velocity/community activity therefore enriches tokens that already show money/evidence rather than wasting requests on dead noise.

### 7. Platform watchlist trades notify every enabled user

The Brain watchlist loop now reads actual BUY **and SELL** flow from owner/admin-watched wallets. Every active user whose single master notification switch is ON receives a durable push job, independent of:

- their own wallet
- Auto Trade state
- whether the browser is open

Delivery keys are transaction/wallet/mint/user specific, so replay/restart does not intentionally duplicate the same notification.

### 8. One notification switch

The Account UI no longer exposes a wall of per-type notification toggles. `MemeCloud alerts` is one master switch. The notification worker now treats that master `pushEnabled` flag as the user authority for all useful push classes; legacy granular fields cannot silently suppress alpha while the master switch says ON.

### 9. Account cleanup

Removed duplicated wallet/trading clutter from Account. Account is now profile, email/X, notifications, security/sessions, owner Admin entry, sign-out/account close. Wallet belongs to Portfolio.

### 10. One-wallet / one-balance product UI

Portfolio now presents:

- one `Total Balance`
- `Available`
- `In trades`
- one MemeCloud wallet
- performance/history below, rather than six competing balance/P&L cards

Underlying realized/unrealized/ledger truth is **not** deleted; it remains authoritative accounting and position detail. Only the normal user presentation is simplified.

The wallet sheet now opens to a wallet home with `Add money`, `Send`, `History`, and `Wallet settings`, rather than five technical tabs as the first interaction.

### 11. No normal `Unknown` wallet state

Wallet balance UI now distinguishes:

- `Updating…` while reading the chain
- real verified amounts when available
- `Temporarily unavailable` + Retry on provider failure

It never converts a failed balance read into fake `$0`, and it no longer presents `USDC Unknown / SOL Unknown / Synced Unknown` as a normal wallet experience.

### 12. Smart Money UX made useful/copyable

Smart Wallet list/detail now shows useful evidence instead of address + opaque score:

- stage / current activity
- 7D and 30D realized P&L
- win rate
- current form
- skill score
- observed trades
- distinct tokens
- volume
- forward hit rate
- average copy chase
- evidence completeness
- observed whale size/tier
- why MemeCloud discovered the wallet
- current/recent tokens with amount, market cap and liquidity when known

PROVEN + linked trader wallets can be Auto Copied. Watching is available through the existing trader/follow authority. Unproven candidates cannot be falsely made live-copyable just because they appeared on the list.

### 13. Reboot/deployment regression fixed in deployment script

A real live outage occurred because legacy `fomocloud-api` auto-started after reboot and owned port 4000 while `memecloud-api` also reported Running. The Windows install script now disables only legacy FomoCloud **application** services during completed MemeCloud migration (never Mongo/Redis, XAU, ClipForge, etc.) and verifies that port 4000 is actually owned by the current MemeCloud root after installation.

## Tests executed in this sandbox

Because the uploaded ZIP contains source but no installed monorepo dependencies and this environment cannot download pnpm packages, a full `pnpm build/typecheck/test` cannot be truthfully claimed here. Pure TypeScript modules were compiled with the available global TypeScript compiler and executed with Node's test runner.

Passed locally in this audit:

- Brain/lifecycle/convergence/scoring: **31/31**
- Discovery/strategy combined regression suite in the main run: **10/10 relevant tests** (the complete combined Brain+Discovery+Strategy run was **41/41** before the final extra provider/age tests)
- Provider normalization + Strategy/age/runner tests: **13/13**
- Notification decision/master-switch tests: **4/4**

Important new regressions covered include old-token junk, quality-capital authority, Money Rush, unrealized moonbag vs realized skill, current-form/activity weighting, unknown risk, unknown token age, 5,000% runner handling, drawdown-from-price semantics, and watched-wallet/master notification behavior.

## Deployment gate

Do **not** call this LIVE VERIFIED from this ZIP alone. Before real-money LIVE mode, the owner/Codex/Claude deployment pass should run from a machine with dependencies installed:

1. `corepack enable && pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. Prisma/index safety checks + backup
6. deploy current frontend/backend release
7. verify only current MemeCloud app services own their ports/processes
8. observation-only live funnel test
9. watched-wallet BUY/SELL push on a real phone
10. controlled owner-approved tiny live execution/reconciliation test before enabling general live trading

This file deliberately distinguishes source implementation/test evidence from live verification. It should be handed to Codex/Claude with the existing `FORENSIC_AUDIT_FINAL.md` for the final independent pass.
