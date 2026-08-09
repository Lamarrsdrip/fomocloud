# MemeCloud v0.5 — Multi-user social copy-trading platform

MemeCloud is now structured as a **real multi-user application**, not a shared trading dashboard.

- `apps/web` — public landing page, signup/login, onboarding, private user app, integrated role-protected admin
- `apps/api` — account/auth APIs, private user data, trader registry, settings, admin, push/email/broadcast APIs
- `services/listener` — watches each verified public source wallet once and produces normalized source signals
- `services/executor` — fans one source signal out into independent per-user copy/watch/skip decisions
- `services/market-worker` — builds a VPS-side Solana executable-price cache from genuine Jupiter quotes + on-chain supply
- `services/balance-worker` — reconciles each user's genuine Solana USDC Trading Cash from linked wallets
- `services/analytics-worker` — records LIVE-only account-value/P&L history for dashboard charts
- `services/exits` — genuine price marking for open positions; live exits fail closed until the full execution/signing path exists
- `services/notification-worker` — user Web Push plus queued email/push broadcasts
- MongoDB — users, traders, signals, decisions, orders, positions, settings, audit history
- Redis/BullMQ — hot data, queues and worker coordination

## Product flow

```text
Public landing page
        ↓
Start Trading
        ↓
Email/password OR wallet login
        ↓
Private onboarding
        ↓
Private user dashboard
        ├── Trading Cash / balances
        ├── personal P&L
        ├── positions / history / activity
        ├── platform traders
        ├── custom public trader wallets
        ├── Follow / Watch / Auto Copy
        ├── per-trader settings
        ├── community following + optional X account
        └── push / account / trading settings
```

Every user has independent data. A source wallet is monitored once, then one normalized signal is fanned out to followers. Each user gets their own decision based on their own Auto Copy state, cash, chain settings, exposure and per-trader rules.

For Solana source sells, the listener also records the transaction-visible before/after source token balance and derives a verified sold percentage when possible. Simulation positions can mirror that verified fraction; if the fraction or fresh market price cannot be established, the system waits instead of inventing an exit. Live mirror exits remain signer-gated.

## Critical chase rule

**Chase is never the token's 24-hour move.**

```text
followed wallet execution → current executable entry = wallet chase
```

A token can already be +5,000% in 24 hours and still have only a +35% wallet chase after the followed trader's buy. `dailyMovePct` is informational only and is deliberately absent from `decideCopy()`.

Fresh-meme policy remains adaptive: roughly 30–40% normally, 40–50% under strong acceleration and up to ~55% under exceptional hyper momentum, subject to user limits and real market evidence.

## Profit policy

Strategy package preserves:

- fresh/new: +100%, +150%, +200% partial harvest ladder + runner
- established: +50%, +100% + runner
- hyper momentum harvests less
- cooling momentum harvests more
- no arbitrary final-profit cap; a runner may remain open at +500%, +1,000%, +5,000% or more while evidence supports it

The current deployed/test execution mode must remain **simulation** until a reviewed delegated/session signer is wired and controlled live-chain testing passes.


## Copy price / chase integrity

The executor treats the followed wallet's source execution as the anchor and compares it with the **actual executable quote for that individual user's requested amount**. The token's 24-hour percentage move is never the chase value. For Solana source buys paid in WSOL/USDT, the source quote asset is normalized to USDC at detection time through a genuine Jupiter quote and the method is recorded for auditability.

The current Solana simulation route uses genuine Jupiter executable quotes but does not move funds. The same actual-size quote checks are required before any future LIVE route can reach the delegated signer boundary.

## Authentication

Supported architecture:

- email + password (bcrypt)
- email verification/reset tokens
- short-lived JWT access token
- opaque refresh session stored server-side
- replay-safe wallet challenges stored in MongoDB
- Solana wallet sign-in/linking
- optional X OAuth2 PKCE account linking
- role-based Admin/Support access

A user login or a connected wallet **does not grant unattended signing permission**.

## User privacy / isolation

Authenticated APIs derive the user from the verified access token. User-owned queries never accept a frontend-provided `userId` as the authority. Custom trader source-wallet monitoring can be shared for efficiency, while each user keeps their own private label/settings.

Community following intentionally exposes only lightweight public profile information; balances, watchlists, exact portfolios and trading permissions are not public.

## Admin

Admin is integrated at `/admin/` and requires an authenticated `ADMIN`/`SUPPORT` role. It provides real data for:

- user management
- platform traders + verified source wallets
- Featured / Recommended / Default onboarding traders
- signals and per-user orders
- encrypted integration configuration
- VAPID key generation + push test
- SMTP test
- queued push/email broadcasts
- worker/database/Redis system health

Secrets stored through Admin use AES-256-GCM envelope encryption via `ENVELOPE_ENCRYPTION_KEY`. The Admin API returns configured/not-configured state, not saved plaintext.

## Split deployment

Production test topology:

```text
Hostinger static PWA
  https://your-frontend.example
            │ HTTPS
            ▼
Windows VPS API / workers
  https://api.example
            │
     MongoDB + Redis
```

The current design deliberately keeps backend workers on a 24/7 server instead of converting everything into a Hostinger Node app.

See `docs/DEPLOY_SPLIT.md`.

## Local setup

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm --filter @memecloud/db prisma generate
pnpm --filter @memecloud/db prisma db push
pnpm dev
```

The development Mongo Compose service initializes a single-node replica set, which Prisma Mongo transactions require.

## Hostinger frontend build

```bash
NEXT_PUBLIC_API_URL=https://your-api.example pnpm --filter @memecloud/web build
```

Upload the contents of `apps/web/out/` to Hostinger `public_html`.

## Backend workers

Persistent VPS processes:

- API
- Solana listener
- executor
- exits/position marker
- market worker
- balance reconciliation worker
- analytics/P&L snapshot worker
- notification/broadcast worker

Example Windows service setup is in `deployment/windows/install-services.example.ps1`.

## Data truth rules

Do not fabricate financial/account/provider states.

- a quote is not a confirmed live trade
- submitted is not confirmed
- simulation positions are labeled `SIMULATION` and excluded from live account P&L
- no verified source wallet → do not pretend a trader can be copied
- no market quote → do not invent a fill
- no SMTP/push provider → show `NOT CONFIGURED`
- no data history → show `Tracking` / `Insufficient history`, not fake return percentages

## What is still intentionally not live-money ready

The repository does **not** contain a fallback that stores user seed phrases or primary private keys. Live Auto Copy remains blocked until a real scoped delegated/session signing provider, per-chain execution adapters, security review and controlled low-value tests are complete.

Read `docs/LIVE_READINESS.md` before changing `LIVE_EXECUTION_ENABLED`.
