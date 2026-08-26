# MemeCloud launch checklist

Production target:
- Frontend: `https://meme.xaucloud.io` via Hostinger Git/Web App auto deploy from `main`.
- Backend: Windows VPS `173.212.249.202`, `C:\memecloud`.
- API: use a dedicated HTTPS subdomain such as `https://meme-api.xaucloud.io` through existing Caddy/reverse proxy.

Before live funds:
1. `pnpm install`
2. `pnpm db:generate`
3. `pnpm db:push`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build`
7. `OWNER_EMAIL=idrisgana25@gmail.com pnpm --filter @memecloud/db owner:promote`
8. Install/restart only MemeCloud Windows services.
9. Confirm `/health`, Admin > Health, Global Brain, flow scanner and social worker heartbeats.
10. Configure actual RPC/provider/signer keys from Owner Control Center.
11. Keep simulation until live signer and actual low-value buy+sell reconciliation are verified for that chain.
12. Enable live only from backend environment after successful controlled test. Never call a quote or simulated fill a live trade.
