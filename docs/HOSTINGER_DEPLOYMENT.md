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
NEXT_PUBLIC_API_URL=https://fomocloud-api.173-212-249-202.sslip.io
```

The API hostname remains a legacy infrastructure identifier until a first-party MemeCloud domain is available. Do not point the production frontend at localhost.

The VPS `CORS_ALLOWED_ORIGINS` value must include both the legacy Hostinger origin and `https://palegreen-hippopotamus-562267.hostingersite.com` as separate comma-delimited origins. Verify the browser preflight returns `204` before releasing account features.

Do not use File Manager or ZIP uploads for future releases. Verify the Hostinger deployment history shows the pushed commit SHA before declaring a release live.

Do not enable live execution during frontend deployment. `EXECUTION_MODE=simulation` and `LIVE_EXECUTION_ENABLED=false` remain enforced on the VPS.
