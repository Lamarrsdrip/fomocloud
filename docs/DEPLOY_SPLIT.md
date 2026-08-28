# Split deployment — Hostinger frontend + Windows VPS backend

## Frontend

Hostinger Web App Git integration checks out GitHub `main`, runs `pnpm hostinger:build`, and publishes `apps/web/out` as a static Next export. Future releases must use Git auto-deployment rather than File Manager or ZIP uploads.

Required routes are emitted as directory `index.html` files because `trailingSlash: true` is enabled:

- `/`
- `/signup/`
- `/login/`
- `/onboarding/`
- `/app/`
- `/admin/`

## VPS

Keep API and all workers on localhost/internal ports behind Caddy. Only Caddy HTTPS should be public.

Recommended persistent services:

- `memecloud-api`
- `memecloud-listener`
- `memecloud-executor`
- `memecloud-exits`
- `memecloud-market-worker`
- `memecloud-balance-worker`
- `memecloud-analytics-worker`
- `memecloud-notification-worker`

MongoDB and Redis remain loopback/private. Do not expose 27017 or 6379 publicly.

## CORS

Set `CORS_ALLOWED_ORIGINS` to the Hostinger temporary domain and later the production app domain. Do not use `*` for authenticated endpoints.

## Cross-site refresh-cookie caveat (resolved 2026-08-29 for production)

Production now uses first-party sibling hosts: frontend `meme.xaucloud.io`, API `meme-api.xaucloud.io` (Caddy site block added, TLS verified). Set Hostinger's `NEXT_PUBLIC_API_URL` to `https://meme-api.xaucloud.io` -- see `HOSTINGER_DEPLOYMENT.md`. This section's caveat still applies to any temporary/staging Hostinger domain still pointed at an `sslip.io` API host: those remain genuinely cross-site, and WebKit-based in-app browsers (confirmed with Phantom's) silently drop the SameSite=None refresh cookie there, breaking session persistence.

## Deployment mode

Use:

```env
EXECUTION_MODE=simulation
LIVE_EXECUTION_ENABLED=false
```

Real chain monitoring and executable quotes can run in this mode; only money movement is simulated.


## Temporary-domain authentication note (legacy staging hosts only)

A Hostinger `*.hostingersite.com` frontend and an `*.sslip.io` API are cross-site origins. The API uses a secure `SameSite=None` HttpOnly refresh cookie for that test topology, but some privacy-focused/mobile browsers may block third-party cookies entirely -- this was the confirmed root cause of Phantom in-app-browser login sessions failing to persist in production. Production has moved to first-party sibling domains (`meme.xaucloud.io` / `meme-api.xaucloud.io`, see above) specifically to fix this. Do not solve the temporary-domain limitation by putting long-lived refresh tokens in browser localStorage.
