# KAIRO Hostinger deployment

The production split is **Hostinger static frontend + Windows VPS backend**. Hostinger builds and serves only `apps/web`; the VPS continues to run the API, MongoDB, Redis and persistent workers.

## Git-connected Web App

- Repository: `Lamarrsdrip/fomocloud`
- Branch: `main`
- Project/root directory: repository root (`.`)
- Node.js: `22.x`
- Package manager: `pnpm@10.14.0`
- Install: `corepack enable && pnpm install --frozen-lockfile`
- Build: `pnpm hostinger:build`
- Output directory: `apps/web/out`
- Start command / entry file: none; this is a static Next export
- Auto deployment: enabled for every push to `main`

## Environment

```env
NEXT_PUBLIC_API_URL=https://fomocloud-api.173-212-249-202.sslip.io
```

The API hostname remains a legacy infrastructure identifier until a first-party KAIRO domain is available. Do not point the production frontend at localhost.

Do not use File Manager or ZIP uploads for future releases. Verify the Hostinger deployment history shows the pushed commit SHA before declaring a release live.

Do not enable live execution during frontend deployment. `EXECUTION_MODE=simulation` and `LIVE_EXECUTION_ENABLED=false` remain enforced on the VPS.
