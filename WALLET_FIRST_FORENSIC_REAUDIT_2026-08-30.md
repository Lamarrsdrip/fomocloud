# MemeCloud Wallet-First Forensic Re-audit — 2026-08-30

## Scope

This pass was performed specifically to ensure the wallet-first rebuild is not layered on top of the old token-firehose architecture and that wallet promotion / Brain decisions cannot claim more certainty than their evidence supports.

## Alignment defects found and fixed in this pass

1. **Old chain-wide scanner still existed underneath wallet-first discovery.** Removed `services/flow-worker` and `services/evm-flow-worker` from the active source tree. Deployment disables older installed scanner services.
2. **Execution readiness still required the removed Solana flow-scanner heartbeat.** Removed that dependency; the explicit-wallet listener plus real `ChainFlowObservation` freshness is authoritative.
3. **Wallet promotion could stall in a circular dependency.** First provider score now moves DISCOVERED -> ANALYZING when it has not yet qualified; the listener watches a bounded ANALYZING pool (`WALLET_PROFILE_WATCH_LIMIT`, default 150) to gather behavior. PAPER/PROVEN promotion can therefore happen automatically without broad-chain scanning.
4. **Cold start did not autonomously find profitable wallets without token scanning.** Added the provider's global Trader Gainers/Losers leaderboard as the primary bounded wallet-discovery source (30D + 1W realized-PnL windows). Optional `SMART_WALLET_SEED_ADDRESSES` remains a zero-trust owner seed. Graph expansion then discovers neighboring top-profit wallets only from tokens touched by trusted wallets.
5. **Admin decision route still contained stale PROVEN side effects after removing the PROVEN action.** Removed them. Admin can Watch/Unwatch/Pause/Reject; only scoring can PROVE.
6. **An admin-watched already-PROVEN wallet could have its TraderWallet monitoring status overwritten to WATCH_ONLY.** Existing wallet links are now left intact; WATCH_ONLY is only created when no link exists.
7. **Wallet evidence completeness could default missing provider coverage to 100%.** Missing provider coverage now defaults to 0, not perfect evidence.
8. **Risk evidence was not separately required for PROVEN.** `riskEvidenceCompleteness` is now explicit; PROVEN requires at least one objective wallet-risk channel (>=50%).
9. **Rug exposure could remain permanently unknown for manually added wallets.** Mature forward outcomes now derive objective rug-exposure evidence when at least five samples exist (share of <= -70% outcomes).
10. **Provider win rate could be 0.65 or 65 and score differently.** Normalized fractional win rates to percentage form.
11. **PROVEN could skip the meaningful paper stage in a single scoring pass.** A wallet must already be PAPER_TRACKING at tick start before it can become PROVEN.
12. **PROVEN could freeze forever or auto-paused wallets could never recover.** PROVEN is continuously re-scored; severe deterioration pauses it, milder deterioration demotes to PAPER, and only auto-paused wallets may objectively recover.
13. **Forward proof used an arithmetic mean in one path.** Promotion now uses the same robust/trimmed forward mean as the score engine.
14. **Brain could treat known wallets as whales.** Known-whale count now requires both a known wallet and a `WHALE_*` tier.
15. **Unknown token structure could look safe.** Missing critical token-risk evidence carries uncertainty and blocks BUY_NOW until enough independent structure evidence is known.
16. **Convergence notification semantics did not match the product.** Global convergence now requires at least 5 distinct tracked wallets. A single PROVEN/ELITE wallet buy has its own platform-wide notification path.
17. **Raw New Token Radar remained in API/UI/preferences.** Raw radar feed and preference exposure were removed; token existence alone does not notify.
18. **Brain loop was still running every 750ms despite the wallet-first upstream cadence.** Default loop is now 3 seconds (`BRAIN_LOOP_MS`, floor 1s), substantially reducing needless DB churn without sacrificing practical reaction time.
19. **Capability UI still claimed BNB/Ethereum discovery after their broad scanner removal.** Public config now reports wallet-first production honestly as Solana-only.
20. **Smart-money net flow depended on a snapshot field the market worker never populated.** Brain now computes 5-minute net flow directly from PAPER/PROVEN wallet observations, including sells.
21. **Whale activity could disappear after removing the old balance-enriching flow scanner.** Brain now also recognizes distinct $50K+ tracked buys as whale-sized capital without pretending that trade size is a verified wallet net worth.
22. **Wallet-triggered tokens could lack metadata because raw discovery was removed.** Listener now creates a minimal WALLET_TRIGGERED token record and market enrichment updates symbol/name/MC/liquidity only for those triggered tokens.

## Automatic PROVEN policy

PROVEN is automatic and cannot be manually granted. Current hard requirements include: >=20 mature forward signals; >=30 forward samples OR >=8 closed paper trades; robust forward mean >=5%; forward hit rate >=55%; copyability >=80; source quality >=75; skill >=76; consistency >=58; entry quality >=58; current form >=50; activity >=40; risk <=40; total evidence completeness >=75%; wallet-risk evidence completeness >=50%.

A top wallet can pass these thresholds; an unknown-risk or shallow/outlier wallet cannot. Once PROVEN, it remains under continuous rescoring and can be demoted automatically.

## Brain trade authority

Brain uses separate Momentum, Smart Money, Execution Quality, Risk, and Evidence Completeness dimensions. Quality-weighted smart-wallet convergence is a real scoring input. BUY_NOW additionally requires qualified capital, organic/accelerating flow, usable execution quality, multiple evidence channels, and adequate critical token-risk evidence. A high score with missing structure evidence is held at WATCH rather than BUY_NOW.

## Validation performed in this environment

- Pure TypeScript compile passed for `packages/discovery/src/index.ts` and `packages/brain/src/index.ts`.
- Syntax parse checks passed for all modified service/API/UI TypeScript/TSX files.
- Smoke checks confirmed: 4-wallet convergence does not alert; 5-wallet convergence does; missing token-risk evidence can score strongly but remains WATCH; complete strong evidence can reach MONEY_RUSH/BUY_NOW; unknown wallet-risk evidence cannot become PROVEN; elite-like repeated performance can become PROVEN.

## Validation not claimed

A complete dependency-backed monorepo `pnpm typecheck && pnpm test && pnpm build` was not run inside this artifact environment because the workspace dependencies are not installed here. That full gate must run after applying the ZIP and before production deployment. No real-money transaction was submitted by this audit.
