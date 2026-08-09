# Hostinger production deployment

The production split is **Hostinger static frontend + Windows VPS backend**. Hostinger serves the exported PWA only. The VPS runs the API, MongoDB, Redis, and persistent workers.

## Current verified release

- Date: 2026-08-09
- Git branch: `main`
- Frontend source commit: `4b2ef6e`
- Frontend: `https://wheat-viper-505237.hostingersite.com`
- API: `https://fomocloud-api.173-212-249-202.sslip.io`
- Deployment method: validated static export synchronized to a staging directory, then atomically renamed into place.
- Deployed `index.html` SHA-256: `0c03aabf03622d6046b86d871bee4655eb22d75d9b4b042dcbec03144d5ebac4`
- Hostinger document root: `/home/u876818953/domains/wheat-viper-505237.hostingersite.com/public_html`
- Pre-deploy backup: `/home/u876818953/domains/wheat-viper-505237.hostingersite.com/public_html.backup-20260809-051642`
- Earlier frontend backups remain beside the same document root for rollback.
- VPS API/listener/executor/exits release: `C:\fomocloud-releases\b722ff5`
- Remaining unchanged workers release: `C:\fomocloud-releases\b541db9`
- VPS database backup: `C:\fomocloud-backups\pre-v05-20260809-015754`

The deployed `index.html` matches the final validated static export byte-for-byte. Direct routes including `/signup/`, `/login/`, `/onboarding/`, `/app/`, `/app/traders/`, `/app/community/`, `/app/activity/`, `/app/positions/`, `/app/profile/`, and `/admin/` return HTTP 200. The PWA manifest launches installed apps at `/login/`, uses `display: standalone`, and service worker cache `fomocloud-v05-ui5` is deployed on the production origin.

## Runtime status

The API, listener, executor, and exits workers run from immutable release `b722ff5`. The unchanged market, balance, analytics, and notification workers remain on verified release `b541db9`. All services are configured to restart automatically:

- `fomocloud-api`
- `fomocloud-listener`
- `fomocloud-executor`
- `fomocloud-exits`
- `fomocloud-market-worker`
- `fomocloud-balance-worker`
- `fomocloud-analytics-worker`
- `fomocloud-notification-worker`

Production is intentionally in `simulation` mode with live execution disabled. MongoDB and Redis are healthy. CORS allows only the Hostinger frontend origin.

## Verified behavior

- Workspace type checking passes across all 21 tasks, and the production static export builds all 21 routes.
- All 28 Turbo test tasks pass; 36 assertions are executable listener/replay/risk/accounting/strategy tests and the remaining package test scripts are placeholders.
- All 12 workspace package runtime exports load from compiled JavaScript.
- Ten listener/replay, fourteen risk/accounting, and twelve strategy tests execute and pass.
- Signup, login, refresh rotation, session identity, and per-user profile/settings/trader isolation pass against the live API.
- A controlled source signal used a real Jupiter quote and fanned out into independent outcomes: one simulation copy, one watch-only decision, and no decision for an unrelated user.
- Cross-user private trader reads and mutations return 404, normal users receive 403 from Admin and are redirected away from `/admin/`, and foreign session revocation returns 404 without revoking the owner session.
- The live dashboard separates true account value from simulation positions and suppresses misleading zero-only performance charts.
- Custom followed wallets appear in the Following and My traders views with independent relationship, amount, chase, and profit settings.
- The database-backed Admin APIs for overview, users, traders, signals, copy decisions, trades, positions, providers, notifications, security, audit logs, config, broadcasts, and health return HTTP 200 for an admin token.
- Browser login, signup, onboarding, user dashboard, trader settings, responsive mobile shell, manifest, and service worker pass on the live Hostinger site.

## Deliberate production limits

- Live execution remains disabled until separately approved and funded.
- SMTP delivery is not configured, so email verification messages are not sent.
- X OAuth is not configured.
- No platform traders are fabricated or seeded. Add only verified public source wallets through Admin.
- Solana listener support is enabled. Other modeled chains remain adapter-ready only until their listeners are implemented and verified.

## Deploy or roll back

Always build from a clean `main`, verify the archive checksum, and create a new `public_html` backup before extracting an update. Do not deploy trading workers to Hostinger or another request-only runtime.

To roll back the frontend, clear `public_html` only after confirming the target domain, then extract the pre-deploy backup into the same document root. To roll back the backend, repoint all eight NSSM services to the previous immutable release and restore the matching database backup only when the schema change requires it.
