# MemeCloud Wallet-First Intelligence Rebuild

## Production invariant
MemeCloud does not crawl every new token. The primary discovery object is a public wallet with repeat, measurable edge. Tokens enter deep research only after activity from a PROVEN/PAPER/admin-watched wallet, or because an open user position must continue to be risk-managed.

## Pipeline
1. Candidate wallets come primarily from a bounded global realized-PnL trader leaderboard, plus owner-configured seed addresses, user/admin watch additions, and graph expansion around tokens already touched by trusted wallets.
2. Scoring uses realized P&L, win rate, sample depth, cross-token diversity, current form, activity, early-entry edge, copyability, robust forward outcomes and explicit risk/evidence completeness.
3. Automatic lifecycle: DISCOVERED -> ANALYZING -> PAPER_TRACKING -> PROVEN. Promotion is objective only; admin cannot directly prove a wallet. PROVEN can automatically demote on deterioration.
4. The Solana listener watches a bounded profiling pool plus watched/PAPER/PROVEN wallets continuously with the browser closed.
5. A tracked-wallet BUY creates a token research trigger. Market-worker spends capacity on open positions and wallet-triggered mints.
6. Global Brain evaluates only those mints/open positions and separates Momentum, Smart Money, Execution Quality, Risk and Evidence Completeness.
7. A PROVEN/ELITE wallet BUY can alert immediately. Convergence notification requires at least 5 distinct tracked wallets in the window.
8. Auto Trade remains separate from intelligence. Execution requires explicit authorization and all existing live-trading/risk gates.

## Cost controls
- No chain-wide Solana `onLogs("all")` scanner in the source tree.
- No broad EVM swap-log scanner in production.
- No trending/token-list crawl.
- Global profitable-wallet discovery uses only two bounded trader-leaderboard calls per discovery cycle (30D + 1W), then provider top-trader calls are limited to tokens already surfaced by trusted-wallet activity.
- `WALLET_PROFILE_WATCH_LIMIT` defaults to 150 profiling subscriptions.
- `BRAIN_LOOP_MS` defaults to 3000ms rather than the old 750ms DB loop.
- Real open positions always retain pricing/risk priority.

## Optional cold-start seed
Set `SMART_WALLET_SEED_ADDRESSES` to a comma-separated list of public Solana wallets. Seed status grants zero trust; objective scoring decides every stage.

## Transparency
Smart Money UI shows the complete public wallet address and an on-chain verification link. Whale size is separate from trading skill. Admin Watch is separate from objective PROVEN status.

## Rollout
Run the full monorepo typecheck/test/build, deploy in observation/simulation mode, verify wallet listener subscriptions, scorer promotions/demotions, Brain triggers, notification volume and provider/RPC usage, then enable live execution only through the normal owner-controlled gates.
