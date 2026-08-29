# MemeCloud Hostinger deployment

The production split is **Hostinger static frontend + Windows VPS backend**. Hostinger builds and serves only `apps/web`; the VPS continues to run the API, MongoDB, Redis and persistent workers.

## Git-connected Web App

- Repository: `Lamarrsdrip/fomocloud`
- Branch: `main`
- Project/root directory: `apps/web`
- Node.js: `22.x`
- Package manager: `npm`
- Build: `npm run build`
- Output directory: `out`
- Start command / entry file: none; this is a static Next export
- Auto deployment: enabled for every push to `main`

## Environment

```env
NEXT_PUBLIC_API_URL=https://meme-api.xaucloud.io
```

`meme-api.xaucloud.io` is a first-party sibling subdomain of the frontend's own `meme.xaucloud.io` (Caddy site block added and TLS verified 2026-08-29). This env var **overrides** the fallback baked into `apps/web/lib/api.ts` at build time -- setting it here is what actually takes effect in production, regardless of the source fallback. Do not revert this to the legacy `*.sslip.io` host: that domain is cross-site relative to the frontend, and WebKit-based in-app browsers (including Phantom's) silently drop the SameSite=None session cookie in that configuration, which was the confirmed root cause of Phantom login sessions failing to persist. Do not point the production frontend at localhost.

The VPS `CORS_ALLOWED_ORIGINS` value must include both the legacy Hostinger origin and `https://palegreen-hippopotamus-562267.hostingersite.com` as separate comma-delimited origins. Verify the browser preflight returns `204` before releasing account features.

Do not use File Manager or ZIP uploads for future releases. Verify the Hostinger deployment history shows the pushed commit SHA before declaring a release live.

Do not enable live execution during frontend deployment. Keep `EXECUTION_MODE=simulation` on the VPS and the DB-backed Owner live-trading request OFF.
