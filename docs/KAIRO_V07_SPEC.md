# KAIRO v0.7 — Product + Trading Intelligence Specification

## Product identity
KAIRO is an independent on-chain meme trading platform. It does not depend on Fomo.
Users may:
1. run Bot Trading / Auto Copy,
2. follow platform-ranked smart traders and copy them,
3. use Manual Trading,
4. browse Daily Discovery for high-momentum tokens,
5. browse Daily Leaderboard for highest-performing/copyable traders.

## Non-negotiable data rule
Never fabricate market, wallet, P&L, leaderboard, discovery, social, volume, liquidity, holder, whale, or execution data.
Unavailable inputs must be UNKNOWN/UNAVAILABLE and must not silently become neutral/positive evidence.

## Momentum philosophy
A token's 24h percentage gain is context only. +1,000%, +100,000%, or +1,000,000% must never be an automatic blocker.
CHASE = movement from the tracked source wallet's actual execution price to KAIRO's current executable quote.
Decisioning must emphasize current evidence: executable liquidity, reverse sell route, price impact, volume acceleration, buy/sell flow,
unique buyers/sellers, net flow, proven smart-wallet clustering, creator/deployer behavior, holder concentration, token mechanics,
market structure, source-wallet quality/copyability and social momentum when genuine data is available.

## Market states
DISCOVERING -> EMERGING -> ACCELERATING -> HYPER -> MATURE_TREND -> COOLING -> DISTRIBUTION -> DEAD.
HYPER may tolerate more chase when current evidence is exceptionally strong. COOLING requires better entry.
DISTRIBUTION/unsafe sellability can block entry.

## Smart Trader Discovery
Discover candidates from public on-chain meme activity; identify wallets repeatedly entering successful tokens before expansion;
exclude/penalize deployers, creator-linked wallets, suspicious funding clusters, bundled launch actors and non-copyable snipers.
Score historical trader quality AND realistic copyability after detection delay, executable quote, slippage and fees.
Stages: DISCOVERED -> ANALYZING -> CANDIDATE -> PAPER_TRACKING -> PROVEN -> PLATFORM_TRADER.
Do not promote solely from historical backtests; require forward paper samples.

## Follow / Copy Trader
Users can Follow, Watch Only, or Auto Copy a Platform Trader.
One source wallet is monitored once globally; one normalized source signal fans out to eligible followers.
Each user gets an independent decision based on their mode, allocated USDC, max trade, exposure, authorization and execution quote.
Following a trader must not automatically grant wallet spending authority.

## Manual Trading
Manual users can select a discovered token, see genuine live intelligence and request a real executable quote.
Manual order submission uses the same sellability/quote/confirmation/reconciliation plumbing as bot execution.
Manual trading never displays pretend fills.

## Daily Discovery
A user-facing Discover page must show genuinely computed current candidates for manual traders:
- token/symbol + chain
- current market cap
- liquidity
- volume / volume acceleration
- buy/sell flow and net flow
- unique buyer trend when available
- number/quality of tracked smart wallets buying
- creator/holder risk when available
- market state
- momentum score with evidence
- last updated
- manual Trade button
Do not rank by 24h % alone. Persist snapshots so daily ranking is reproducible and auditable.

## Daily Trader Leaderboard
Rank PLATFORM_TRADER wallets daily using realized/copy-adjusted performance, not one lucky trade.
Show 24H / 7D / 30D views where sufficient data exists:
- realized return/P&L
- copy-adjusted return
- wins/losses/sample size
- drawdown
- average chase
- copyability score
- current status
- Follow / Auto Copy controls
Do not expose fake names. Unidentified wallets use Smart Wallet #<short-id>.

## Exit strategy
Fresh/new token defaults: partial at +100%, +150%, +200%, then runner.
Established token defaults: partial at +50%, +100%, then runner.
HYPER sells less at partials; COOLING can sell more.
No arbitrary maximum-profit liquidation: +500%, +2,000%, +5,000%, +10,000% may continue if evidence remains healthy.
Continuously reassess smart-wallet distribution, buyer flow, volume, liquidity, creator behavior, market structure and sellability.
Failed exits must retry idempotently and must never double-sell.

## Live money
LIVE must fail closed unless real wallet authorization, real quote/build/sign/submit/confirm/reconciliation and exit path are proven.
Never collect seed phrases/private keys.
Use restricted/delegated signer architecture with revocation and limits.
Before public LIVE: tiny owner BUY -> confirmation/reconciliation -> partial SELL -> restart/idempotency test -> final SELL -> P&L reconciliation.

## User app navigation
Home / Discover / Trade / Traders / Portfolio.
Trading mode selector: Manual | Bot.
Portfolio: Trading Cash, open positions, realized/unrealized P&L, history, copied-from attribution, TP/runner status.
Trader detail: performance evidence, copyability, recent source trades, followers, Follow, Watch, Auto Copy.

## Admin
Users; Platform Traders; Candidate Wallets; Daily Discovery; Signals; Decisions; Trades; Positions; Providers/API config;
Execution/Signer; Email; Push; Broadcast; Health; Audit.
Admin can promote/demote traders but cannot fabricate performance.
