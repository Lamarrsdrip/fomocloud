# FomoCloud

A mobile-first, App-Store-quality web application for on-chain social copy trading.

## What this repository is

This is a **real implementation scaffold**, not a fake trading dashboard. It includes:

- polished user web/PWA
- wallet-signature authentication architecture
- trader registry and watchlist
- Solana on-chain listener service
- normalized copy signals
- risk/chase/duplicate controls
- quote/execution adapter layer
- 24/7 position + exit worker
- PostgreSQL financial ledger
- Redis queues
- protected admin surface
- WebSocket/SSE-ready realtime API
- simulation/live execution separation
- deployment + security documentation
- tests for the money/risk logic

The application defaults to **simulation** and refuses live execution unless explicitly enabled.
That is intentional: no repository can safely execute public-user funds until a real signing/
delegation provider, production RPCs, secrets, and controlled live tests are configured.

## Product rule

> A quote is not a trade. A submitted transaction is not a confirmed trade.
> The UI only labels a trade CONFIRMED after the chain/execution provider confirms it.

There are no seed-phrase or raw-private-key input fields.

## Architecture

```text
Web/PWA
  │
  ├── API / auth / trader registry / settings
  │
  └── realtime stream
        │
Solana Listener ──> Signal Normalizer ──> Redis
                                      │
                                      v
                               Execution Worker
                          risk → quote → signer → submit
                                      │
                                      v
                                 PostgreSQL
                                      │
                                      v
                                  Exit Worker
                             TP / SL / source exits
```

## Quick start

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`.

## Live-money activation

Do **not** change `LIVE_EXECUTION_ENABLED=true` until you have completed `docs/LIVE_READINESS.md`.

For unattended trading, a normal wallet connection is insufficient. Production needs a
real policy-controlled signing/delegation architecture. This repo deliberately exposes that
behind `SignerProvider` instead of storing user seed phrases.

Recommended production model:

1. User connects their primary wallet and proves ownership with a signed challenge.
2. User provisions/authorizes a dedicated trading authority with explicit spend/exposure limits.
3. Backend workers can only sign the allowed swap actions through the configured signer provider.
4. User can pause/revoke the authority.
5. Primary-wallet seed/private key never reaches this app.

See `docs/SECURITY.md` and `docs/ARCHITECTURE.md`.

## Trader discovery

Fomo or similar social apps can be used by a person to discover traders, but this application
does not scrape or automate them. Production signals come from **verified public on-chain wallet
addresses** stored in the trader registry.

## Deployment

- `apps/web`: Vercel or long-running Node hosting.
- `apps/api`: long-running Node service.
- `services/listener`: persistent process with WebSocket/RPC access.
- `services/executor`: persistent worker.
- `services/exits`: persistent worker.
- PostgreSQL + Redis: managed production services recommended.

## Important

Crypto copy trading is high risk. Historical trader performance does not guarantee future
returns, token liquidity can disappear, and on-chain transactions can fail or execute with
slippage. This software must go through security review and controlled low-value live testing
before public launch.


## FomoCloud adaptive meme-trading policy

FomoCloud does **not** claim to "100% know" that a token is safe or that a dip has ended.
Those things cannot be known with certainty. The engine combines on-chain evidence, executable
liquidity, holder/authority risk, wallet flow, volume and social momentum into explicit states.

Default profit ladder:

| Token class | TP1 | TP2 | TP3 | Runner |
|---|---:|---:|---:|---:|
| Established token | +50% sell 35% | +100% sell 25% | — | keep 40% |
| New token (<=24h) | +100% sell 30% | +150% sell 20% | +200% sell 15% | keep 35% |

There is **no arbitrary maximum take-profit** on the runner. A strong winner can stay open at
+500%, +1000%, +5000% or more while buying pressure, volume, liquidity and social momentum remain
healthy. The trailing distance dynamically tightens as momentum cools.

See `docs/TRADING_POLICY.md`.


## FomoCloud Meme Intelligence v3

The v3 strategy is intentionally designed for the speed and convexity of memecoins.

- Fresh-meme chase is dynamic, normally around 35–40% and up to ~55% only under exceptional hyper momentum.
- Only catastrophic facts are hard blockers. Ordinary warnings change confidence/size.
- A late-but-good signal can become `WAIT_PULLBACK` instead of being permanently discarded.
- Entry scoring blends order flow, liquidity, holder growth, source-wallet quality and social velocity.
- Social/API enrichment never blocks the hot execution path.
- New-token default harvests are +100%, +150%, +200%, followed by an uncapped adaptive runner.
- Established default harvests are +50%, +100%, followed by an uncapped adaptive runner.
- Hyper winners deliberately get wider 32–38% runner breathing room and smaller partial sells.
- The strategy forward-tracks both accepted and rejected signals so thresholds can be improved from evidence.

See `docs/MEME_INTELLIGENCE_V3.md`.


## Multi-chain USDC trading cash

FomoCloud is no longer Solana-only. The consumer model is a unified **Trading Cash** balance
denominated in USD/USDC, while chain adapters handle Solana, Base, Ethereum, BNB and future networks.

All external provider configuration is intended to be manageable through the protected admin
configuration system. Secrets are marked as secret records and should be encrypted with KMS/HSM in
production.

Web push is built in using standards-based VAPID + service workers, so Firebase is not required for
browser push notifications. SMTP email and queued broadcasts are also included.
