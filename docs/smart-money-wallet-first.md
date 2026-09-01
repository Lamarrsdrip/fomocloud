# MemeCloud wallet-first smart-money architecture

## Authority and provenance

- `MANUAL_REVIEW` submits a public wallet for identification and objective scoring. It grants no trust.
- `PLATFORM_ADDED` and `MEMECLOUD_CURATED` preserve externally researched provenance and receive priority monitoring. They do not grant `PROVEN` or `ELITE`.
- `PROVEN` remains an objective scoring-worker result requiring fresh provider evidence, forward observations, risk evidence, breadth, current form and paper proof.
- `ELITE` is a derived public tier over a currently `PROVEN` wallet; Admin has no endpoint that can assign it.
- Legacy `ADMIN_MANUAL` rows are preserved and mapped to `PLATFORM_ADDED` with `UNKNOWN_LEGACY_SOURCE` when the historical research source was not stored.

## Capital is not skill

Meme-whale classification requires recent real meme-position evidence: a $50K+ observed meme position, substantial multi-token meme buy volume, or meaningful stable capital combined with material meme deployment. A large idle USDC balance alone never earns a whale badge. Smart Degen classification requires repeatable skill, breadth, current activity and meaningful meme position sizes. Neither classification changes objective stage.

## Event path and provider cost

1. Admin-curated, proven, paper-tracked or targeted launchpad-counterparty wallet is monitored.
2. A real transaction creates a wallet-triggered token record and a cheap executable mark.
3. Token origin is recorded as verified launchpad, known DEX migration or unknown. Pump.fun mint-suffix evidence is high-confidence provenance, not a safety claim.
4. Deep Birdeye structure research runs only for an open position, a recognized launchpad token with qualified evidence, or exceptional smart-money evidence on an unknown-origin token.
5. Brain uses distinct qualified wallets. Repeated buys by one wallet never increase convergence.

The old periodic global trader-leaderboard scan is removed. Targeted counterparty expansion runs at most hourly and only from tokens already surfaced by qualified wallets. Wallet PnL scoring continues locally every ten minutes, but Birdeye refresh is limited to four provider requests per cycle by default, uses 6/12/24-hour priority TTLs, and opens a one-hour global circuit after quota exhaustion. Quota exhaustion cannot promote a wallet from stale provider evidence and cannot stop on-chain/forward scoring.
