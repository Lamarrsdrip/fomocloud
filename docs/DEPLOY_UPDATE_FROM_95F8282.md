# Upgrade from current main (`95f8282`)

This ZIP is intended to replace/update the source tree from current GitHub `main`.

Before touching the VPS database, make a MongoDB backup. The schema is substantially expanded for multi-user accounts, auth sessions, settings, social relationships, P&L snapshots, worker health and source-sell context.

Recommended Mac validation:

```bash
pnpm install
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
```

Back up the current VPS Mongo database before changing schema/data. Then run the additive v0.5 backfill against a staging copy first:

```bash
pnpm db:generate
pnpm db:migrate:v05
pnpm db:push
```

`db:migrate:v05` is idempotent and does not delete historical documents. It backfills newly-required fields on the pre-v0.5 Mongo collections, including marking legacy positions as `SIMULATION` (the prior deployment was simulation-only) and generating deterministic `legacy:<ObjectId>` order idempotency keys. Do not skip the backup.

Then build the Hostinger static frontend with the VPS HTTPS API:

```bash
NEXT_PUBLIC_API_URL=https://fomocloud-api.173-212-249-202.sslip.io \
  pnpm --filter @fomocloud/web build
```

Upload the *contents* of `apps/web/out/` to Hostinger `public_html`.

For VPS deployment, update code first, install dependencies, generate Prisma client, apply the reviewed schema with `db push`, build/typecheck, then restart only the FomoCloud services. Do not overwrite shared Caddy configuration or disturb unrelated MT5/ClipForge services.

New persistent workers included by this version:

- `fomocloud-market-worker`
- `fomocloud-balance-worker`
- `fomocloud-analytics-worker`
- `fomocloud-notification-worker`

Use `deployment/windows/install-services.example.ps1` as the service template rather than running workers in open terminal windows.

Keep:

```env
EXECUTION_MODE=simulation
LIVE_EXECUTION_ENABLED=false
```

until the real delegated/session signer and controlled live-chain tests are complete.
