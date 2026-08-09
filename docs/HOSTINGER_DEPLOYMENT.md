# Hostinger production deployment

The production split is **Hostinger static frontend + Windows VPS backend**. Hostinger serves the exported PWA only. The VPS runs the API, MongoDB, Redis, and persistent workers.

## Current verified release

- Date: 2026-08-09
- Git branch: `main`
- Git commit: `b541db9`
- Frontend: `https://wheat-viper-505237.hostingersite.com`
- API: `https://fomocloud-api.173-212-249-202.sslip.io`
- Frontend archive: `fomocloud-frontend-b541db9.zip`
- Frontend SHA-256: `0dcbacd06f898fc293331f166a56e83a6a1d2b671dbc9a89496249d5c1b54d57`
- Hostinger document root: `/home/u876818953/domains/wheat-viper-505237.hostingersite.com/public_html`
- Pre-deploy backup: `/home/u876818953/fomocloud-backups/public_html-pre-b541db9-20260809-022740.tar.gz`
- VPS release: `C:\fomocloud-releases\b541db9`
- VPS database backup: `C:\fomocloud-backups\pre-v05-20260809-015754`

The deployed `index.html` matches the release archive byte-for-byte. Direct routes including `/signup/`, `/login/`, `/onboarding/`, `/app/`, `/app/traders/`, and `/admin/` return HTTP 200. The PWA service worker is registered and activated with the production origin as its scope.

## Runtime status

The following Windows services run from the exact `b541db9` release and are configured to restart automatically:

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

- Clean Windows install, Prisma generation, type checking, builds, and all 28 Turbo tasks pass.
- All 12 workspace package runtime exports load from compiled JavaScript.
- Seven risk tests and four strategy tests execute and pass.
- Signup, login, refresh rotation, session identity, and per-user profile/settings/trader isolation pass against the live API.
- One source signal fans out once into two independent per-user copy decisions and activity records.
- Browser login, onboarding, dashboard, trader data, API requests, mobile layout, manifest, and service worker pass on the live Hostinger site.

## Deliberate production limits

- Live execution remains disabled until separately approved and funded.
- SMTP delivery is not configured, so email verification messages are not sent.
- X OAuth is not configured.
- No platform traders are fabricated or seeded. Add only verified public source wallets through Admin.
- Solana listener support is enabled. Other modeled chains remain adapter-ready only until their listeners are implemented and verified.

## Deploy or roll back

Always build from a clean `main`, verify the archive checksum, and create a new `public_html` backup before extracting an update. Do not deploy trading workers to Hostinger or another request-only runtime.

To roll back the frontend, clear `public_html` only after confirming the target domain, then extract the pre-deploy backup into the same document root. To roll back the backend, repoint all eight NSSM services to the previous immutable release and restore the matching database backup only when the schema change requires it.
