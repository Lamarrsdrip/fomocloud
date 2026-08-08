# v0.5 multi-user platform upgrade

Baseline inspected on GitHub: `Lamarrsdrip/fomocloud` `main`, including split-deployment commit `95f828290167ff5343fbad81b45c11e4b71ffc9d`.

## Product conversion

- Public page is now a real landing page; it contains no hardcoded user balance, P&L, fake trade history or fabricated trader returns.
- `Start Trading` routes to signup; existing users can sign in.
- Email/password auth, wallet-signature auth, replay-safe DB wallet challenges, email verification/reset and revocable refresh sessions.
- Private onboarding and private multi-user dashboard.
- Per-user Trading Cash, live-only P&L, chain allocations, positions, order history, decisions, activity, notifications and settings.
- User data is always selected from the authenticated user ID rather than accepting a client-supplied owner ID.
- Optional privacy-light community profiles are opt-in, off by default.
- Optional X OAuth2 PKCE linking.

## Trader/copy model

- Admin-managed platform traders live in MongoDB instead of frontend constants.
- Featured / Recommended / Default onboarding controls.
- Every user independently chooses Follow / Watch / Auto Copy.
- Per-trader amount, wallet-chase limit, scale-in and re-entry settings.
- Users can save an X favorite before its public wallet is known; it cannot Watch/Auto Copy until a genuine source wallet is mapped.
- Users can add their own public trader wallets. The same source wallet is globally deduplicated so it is monitored once and fanned out to followers.
- One source signal creates independent `CopyDecision` records for each user.

## Chase and meme policy

- Critical invariant: chase is `source-wallet execution -> current executable entry`, never 24h token performance.
- Executor contains no `dailyMovePct` decision dependency.
- User max chase is capped at 55% in the current fast-copy layer.
- Over-chase becomes `WAIT_PULLBACK`, not a permanent reject.
- Adaptive meme strategy keeps +100/+150/+200 new-token harvests and uncapped runner behavior.
- Fixed an actual runner bug: trailing protection now uses the real drawdown-from-peak percentage instead of subtracting P&L percentage points. The +5000% hyper-runner test now holds as intended.

## Source sells

- Solana listener records transaction-visible source token balance before/after a SELL and calculates a source sold percentage when verifiable.
- Simulation can mirror that verified sold fraction using a fresh genuine market price.
- If sold percentage or price is not verifiable, the system waits rather than inventing an exit.
- Live source exits remain gated by the reviewed delegated signer requirement.

## Data/workers

- Solana source-wallet listener watches each verified source wallet once.
- Market worker uses real Jupiter executable quotes + on-chain token supply for price/market-cap marks.
- Balance worker reconciles genuine Solana USDC balances from linked user wallets.
- Analytics worker records LIVE-only account-value/P&L snapshots.
- Notification worker handles personal Web Push plus selected transactional email and queued broadcasts.
- Worker heartbeat package powers real Admin health rather than static green labels.
- MongoDB + Redis development compose now matches the production database family and initializes a single-node replica set.

## Admin/security

- Integrated `/admin/` is role protected; no browser `x-admin-token` shortcut.
- Users, platform traders, signals, orders, config, broadcasts and genuine worker health are wired to backend APIs.
- Secret integration config uses AES-256-GCM and returns only redacted configured state.
- VAPID generation/test, SMTP test and queued push/email broadcasts.
- Production refuses a placeholder JWT secret or placeholder envelope encryption key.
- Wallet unlinking is blocked while a trading permission reference is active.
- Refresh sessions can be listed/revoked.
- Admin provider writes/test sends are restricted to `ADMIN` rather than support accounts.


## Final hardening added in this artifact

- Authoritative chase now uses each user's **actual-size Jupiter executable quote** in both simulation and the future live path. Cached market marks are not treated as the final entry.
- Source wallets that buy with WSOL/USDT can now be normalized to USD using a genuine detection-time Jupiter conversion; the method is recorded on the signal. This prevents common SOL-funded meme buys from being discarded just because they were not paid in USDC.
- Added a configurable hard executable price-impact ceiling (default 35%) to Admin risk settings.
- Executor exposure checks now use **remaining cost basis after partial exits**, so harvested positions do not keep consuming their original full exposure forever.
- Exit worker is guarded against overlapping 3-second ticks, reducing duplicate TP race risk.
- Solana listener retries transaction fetch briefly after a confirmed log and no longer spends subscriptions on orphaned custom wallets with zero followers.
- Solana USDC balance reconciliation now uses JSON-RPC batching with bounded fallback concurrency and a slower 60-second reconciliation cycle for better scale.
- Dashboard “Today P&L” now uses a genuine pre-midnight P&L snapshot when available instead of treating the account's entire unrealized P&L as today's move.
- Email-created accounts must verify their email before enabling Auto Copy; wallet-created accounts remain usable without requiring email.
- Admin Users now has a real per-user detail view for Trading Cash, live P&L, positions, wallets, Auto Copy and followed traders.
- Admin can add/remove verified source wallets and detects a source wallet already mapped to another tracked trader.
- Public community follow API now refuses users who have not opted into a public profile.
- Added clearer client errors for session replay, private community profiles, duplicate source-wallet mapping, missing source price and excessive executable price impact.
- Personal notification delivery is now retry-idempotent at the database layer: Activity IDs become BullMQ job IDs and durable `Notification.deliveryKey` values, so a worker retry cannot create duplicate notification rows.
- Broadcast delivery now distinguishes recipients who were skipped because they opted out or had no requested destination, instead of silently counting them as neither sent nor failed.

## Multi-chain truthfulness

The schema/router remain multi-chain. In this release the genuinely implemented source-listener + balance + executable-price path is Solana. Base/Ethereum/BNB/Arbitrum/Avalanche remain adapter-ready until their source listeners and balance/execution paths are genuinely implemented. The UI/API no longer presents an adapter-ready chain as a working Auto Copy source.

## Validation completed in this workspace

- 37 TypeScript/TSX source files transpiled successfully for syntax: **PASS**.
- 44 JSON files parsed successfully (including every `package.json`): **PASS**.
- Secret-pattern source scan: **PASS**.
- Static chase invariant (`dailyMovePct` absent from executor): **PASS**.
- Strategy runtime tests: **4/4 PASS**, including +5000% hyper runner HOLD.

Full dependency install, Prisma generation, workspace typecheck and Next production build could not be executed in the artifact container because package-registry network access is unavailable. Run the commands in `docs/TESTING_V0_5.md` on the Mac/VPS before pushing/deploying.
