# Split deployment — Hostinger frontend + Windows VPS backend

## Frontend

Build `apps/web` as a Next static export with `NEXT_PUBLIC_API_URL` set to the public HTTPS VPS API. Upload `apps/web/out/*` directly to Hostinger `public_html`.

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

## Temporary cross-site refresh-cookie caveat

A Hostinger temporary domain and an `sslip.io` API hostname are different sites. Modern browsers can restrict third-party cookies, so short-lived access tokens still work but refresh-cookie behavior must be tested on the actual target browsers. The preferred production topology is first-party sibling hosts such as `app.example.com` + `api.example.com`.

## Deployment mode

Use:

```env
EXECUTION_MODE=simulation
LIVE_EXECUTION_ENABLED=false
```

Real chain monitoring and executable quotes can run in this mode; only money movement is simulated.


## Temporary-domain authentication note

A Hostinger `*.hostingersite.com` frontend and an `*.sslip.io` API are cross-site origins. The API uses a secure `SameSite=None` HttpOnly refresh cookie for that test topology, but some privacy-focused/mobile browsers may block third-party cookies entirely. For the real public launch, use first-party sibling domains such as `app.example.com` and `api.example.com`; this makes persistent session behavior materially more reliable without weakening token storage. Do not solve the temporary-domain limitation by putting long-lived refresh tokens in browser localStorage.
