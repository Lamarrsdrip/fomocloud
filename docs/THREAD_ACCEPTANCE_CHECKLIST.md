# MemeCloud thread acceptance checklist

Status in this file is deliberately evidence-based. `DONE` means the behavior is implemented and has direct code/test or production evidence. `PARTIAL` and `NOT DONE` remain release blockers for the final thread acceptance, even when a safer interim behavior already exists.

## Production recovery and persistence

- **DONE — public frontend, API HTTPS, TLS, CORS, login, refresh and authenticated session.** Live external verification was completed against `https://meme.xaucloud.io` and `https://meme-api.xaucloud.io`; real signup/login/refresh/`GET /v1/me` passed before and after the controlled reboot.
- **DONE — MongoDB, Redis, Caddy, API and MemeCloud worker persistence.** Windows services were configured for automatic startup and survived one controlled VPS reboot. MongoDB remained on `C:\mongo\data`, replica set `rs0`; MongoDB and Redis stayed loopback-only.
- **DONE — proxy and port ownership.** Caddy terminates HTTPS for `meme-api.xaucloud.io` and proxies to `127.0.0.1:4000`; the raw public-4000 firewall rule was disabled after validation; no unrelated XAUCloud/ClipForge services were changed.
- **DONE — current service release consistency at recovery time.** Every `memecloud-*` NSSM service referenced `C:\memecloud-releases\cdf1ce2`; no stale duplicate port-4000 service was left running.
- **PARTIAL — current source deployment.** Recovery release is live, but the source changes tracked by this checklist are not live until their final commit is built, deployed to a new VPS release, and the Hostinger frontend is proven to serve the same `main` SHA.

## Wallet-first architecture

- **DONE — no chain-wide random-token scanner in the active service set.** Brain Admin defaults wallet-first and no active worker has a broad mint scan path (`apps/web/components/admin/Config.tsx`, `services/brain-worker/src/index.ts`, `services/discovery-worker/src/index.ts`).
- **DONE — qualified wallets are the Brain discovery gate.** `services/brain-worker/src/index.ts` forms eligible mints only from recent tracked-wallet buys plus open user positions; unknown mints cannot enter deep Brain evaluation.
- **DONE — graph/leaderboard wallet discovery gives no automatic trust.** `services/discovery-worker/src/index.ts` creates `DISCOVERED` candidates and requires objective profiling/forward proof before `PAPER_TRACKING` or `PROVEN`.
- **PARTIAL — curated/platform-added source.** API creation supports `MEMECLOUD_CURATED` and `PLATFORM_ADDED` with source/reason provenance and no trust bypass (`apps/api/src/adminRoutes.ts`). Admin entry fields, migration of legacy manual records, and every user-facing source label still require completion.
- **DONE — objective lifecycle and demotion.** Scoring promotion/demotion and auto-pause gates are implemented in `services/scoring-worker/src/index.ts` and scoring tests under `packages/discovery`.
- **PARTIAL — inactive/dead/cooling lifecycle.** Brain lifecycle presentation exists (`packages/brain/src/lifecycle.test.ts`), but the directory and every wallet detail surface must still be audited for consistent cooling/inactive terminology.
- **PARTIAL — 7D/30D/90D performance.** 7D and provider 30D inputs exist; a truthful, user-visible 90D series is not yet proven end-to-end.
- **PARTIAL — early-entry evidence/provenance.** Early-entry is accepted only when present, but its current upstream provenance and display need end-to-end proof.
- **PARTIAL — rug exposure vs catastrophic loss.** Unknown risk is penalized and never treated as zero; the existing derived `<= -70%` outcome must be separated from genuine rug evidence rather than labeled rug exposure.

## Wallet activity and data truth

- **DONE — activity timestamps come from observed chain evidence.** API no longer falls back to scoring/`updatedAt`; Admin Active Now uses `metadata.lastObservedTradeAt` (`apps/api/src/server.ts`, `apps/web/components/admin/Whales.tsx`).
- **DONE — full address remains available.** Candidate and activity API records retain the complete public address; abbreviation is presentation-only.
- **PARTIAL — buy/add/trim/exit event feed.** Chain flow records preserve transaction, side, amount and observed time, and watched-wallet notifications are event-backed. User-facing add/trim semantics need a complete behavioral audit.
- **NOT DONE — current holdings truth.** Recent last-side activity is not proof of current balance. Every surface must use verified balances or explicitly say `last observed`; fabricated `HOLDING` state is prohibited.
- **PARTIAL — whale evidence.** API badges now require a fresh timestamped balance observation (`apps/api/src/server.ts`, `services/scoring-worker/src/index.ts`), but the `walletBalanceUsd` producer still needs proof that it measures total wallet balance rather than transaction size.
- **DONE — zero trades cannot imply complete evidence.** Discovery scoring tests treat missing provider/behavior evidence as unknown and reduce completeness (`packages/discovery/src/discovery.test.ts`).

## Smart Money UX and relationships

- **PARTIAL — directory tiers.** Candidate/Watching/Proven/Elite and whale summaries exist; dedicated filters/labels for MemeCloud Picks, Platform Added, Copyable, Newly Discovered, Being Verified and Cooling require completion.
- **NOT DONE — dedicated MemeCloud Picks section.** Curated records can be stored, but the full user-facing Picks section is not yet implemented.
- **PARTIAL — wallet detail and wallet activity.** APIs expose candidate evidence and recent flow; required current-vs-last-observed semantics and 7D/30D/90D performance need completion.
- **PARTIAL — token-to-wallet graph / Smart Money in this Token.** Brain computes tracked distinct-wallet convergence and net flow. Token detail must still expose the complete curated/Elite/Proven/whale relationship with entry/add/trim/exit evidence.
- **DONE — Fund has a dedicated wallet destination.** `apps/web/app/app/page.tsx` routes Fund/Wallet to `EmbeddedWalletPanel`, not Profile/Account; production browser behavior remains to be verified after deployment.

## Convergence and Brain safety

- **DONE — distinct-wallet convergence.** Brain uses address sets; repeated buys by one wallet count once (`services/brain-worker/src/index.ts`, `packages/brain` tests).
- **DONE — quality weighting.** Proven/Paper stages and current form feed `weightedConvergenceScore`; unverified wallets do not contribute trading authority.
- **DONE — whale count is distinct from skill.** Whale event counts and skilled-wallet convergence are separate inputs; a whale label does not make a wallet Proven.
- **PARTIAL — exact 3/5/10 product thresholds.** Building/convergence and Money Rush are implemented, but every requested threshold must be asserted directly in behavioral tests and UI wording.
- **DONE — missing risk evidence is not certainty.** Creator/holder/mint/freeze/sellability evidence is optional/unknown rather than synthesized safe; Brain warns and BUY gates require evidence (`packages/brain`, `packages/discovery`).
- **DONE — execution paths preserve fresh quotes and idempotency.** Live buy/exit paths use fresh execution data and durable `LiveExecutionAttempt`/transaction-hash protection; isolated Mongo replica-set API tests pass all 10 auth/financial invariants.

## Provider cost architecture

- **DONE — old recurring X token-search firehose removed.** `services/social-worker/src/index.ts` has no interval and sends zero X requests.
- **DONE — background X health probe removed.** `apps/api/src/server.ts` excludes `social`; manual Admin test remains explicit.
- **NOT DONE — on-demand X intelligence.** Qualified event queue/consumer, chain+mint cache, query hash, priority, hourly/daily hard budgets and optional Brain enrichment still need implementation. Disabling X entirely is only the safe interim state.
- **NOT DONE — X read/write accounting separation.** Required telemetry and separate budgets/credentials are not yet implemented.
- **PARTIAL — Birdeye progressive enrichment.** Market deep enrichment has a 15-minute Redis guard, but it lacks cross-process single-flight coalescing, shared endpoint cache, negative caching, static-vs-dynamic TTLs, and full telemetry.
- **PARTIAL — Solana RPC priority.** A Redis-backed account budget reserves P0/P1 capacity and token decimals are shared indefinitely (`packages/shared/src/rpcBudget.ts`, `packages/shared/src/index.ts`). Full provider-call inventory and all caller priority validation remain.
- **PARTIAL — Jupiter usage.** Execution always requests fresh quotes, but `services/market-worker/src/index.ts` can still quote every tracked mint each 30-second tick; that violates the requested quiet-day cost target.
- **NOT DONE — provider request telemetry/Admin Usage page.** Per-provider/endpoint hour/day/month counts, cache hits, actual calls, errors, rate limits, budget percent, top consumer and requests saved are not yet present.
- **NOT DONE — threshold cost alerts.** Automatic 50/75/90/95% warnings and optional-enrichment shutdown are not yet implemented.
- **PARTIAL — optional-provider health.** X is no longer part of background degradation; all health/readiness surfaces still need an explicit critical-vs-optional audit.

## Security

- **PARTIAL — dependency remediation.** Next.js, Prisma, Nodemailer and vulnerable transitive packages were upgraded/overridden. Production audit fell from 33 findings (12 high, 20 moderate, 1 low) to three high upstream/no-fixed-version findings. The remaining advisories require safe patching or a documented upstream blocker without removing business-critical wallet/auth features.
- **DONE — no reckless major production migration.** No destructive Prisma migration, database reset, wallet/balance mutation, credential rotation, or execution-mode change was performed.
- **PARTIAL — production hardening verification.** HTTPS/CORS/auth persistence is verified; final dependency tree/SBOM-style inventory, secrets/log review and live post-deployment scan remain.

## Tests, deployment and cleanup

- **DONE — monorepo typecheck.** 30/30 tasks passed after the dependency changes.
- **DONE — API database regression tests.** 10/10 passed against an isolated loopback-only Mongo replica set with repository indexes; production DB was never used.
- **DONE — package/worker unit suites in the full run.** 57/59 Turbo tasks passed; the only prior task failure was the missing local test `DATABASE_URL`, now resolved and retested.
- **IN PROGRESS — production frontend build.** Next.js 15.5.24 optimized build is running and must finish successfully before commit.
- **NOT DONE — new behavioral tests.** Required X eligibility/cache/budget, Birdeye concurrent coalescing, market quiet-tick, cache expiry/hit, provider priority, holdings truth and 80-mint-cap assertions still need implementation.
- **NOT DONE — final commit/push/deploy.** Final source must be committed, pushed to `origin/main`, remote SHA verified, deployed to Hostinger and a new VPS release, and all NSSM process paths confirmed.
- **NOT DONE — post-change live verification.** Login/refresh/session, Home, Smart Money, Fund, real wallet samples, workers, Brain, market freshness, CORS/TLS and mixed-content checks must be repeated against the final deployed SHA.
- **BLOCKED UNTIL LIVE VERIFICATION — release cleanup.** No release may be removed until every active service path is protected, current release plus one known-good rollback are retained, and live auth/workers pass. Disk before/after must be recorded.
