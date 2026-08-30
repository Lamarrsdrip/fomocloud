# MemeCloud Architecture Map (M-1)

Generated from the actual current codebase (HEAD after commit 46dd1fd), not from intent or documentation drift. See `FORENSIC_AUDIT_FINAL.md` for the requirement-by-requirement audit this supports.

## Intelligence pipeline

```
PUBLIC CHAIN (Solana mainnet, BNB/ETH when configured)
   |
   v
RAW INGESTION
  services/flow-worker        (Solana chain-wide log subscription, real WS reconnect+watchdog)
  services/evm-flow-worker    (BNB/ETH swap-log subscription, WS reconnect+watchdog)
  -> writes ChainFlowObservation (per-wallet buy/sell events, walletTier, knownWallet flag)
   |
   v
TOKEN/WALLET OBSERVATIONS
  services/discovery-worker
    scan()              -- Birdeye trending/token-list -> topTraders (TOKEN-FIRST)
    scanFromChainFlow() -- groups ChainFlowObservation by mint, re-tags ALREADY-KNOWN wallets
    scanWalletFirst()   -- groups ChainFlowObservation by wallet, profiles addresses by their
                           OWN repeated-early-entry behavior across independently-qualifying
                           tokens (WALLET-FIRST/CONVERGENCE-FIRST; added this session)
  -> writes DiscoveryToken, SmartWalletCandidate (stage=DISCOVERED)
   |
   v
SMART WALLET PROFILING
  services/scoring-worker
    fetches Birdeye walletPnlSummary (30d authoritative + 7d additional-evidence window)
    packages/discovery.scoreWallet() -- wealth-free scoring (win rate, PnL efficiency, sample
      size, forward returns, chase/insider/rug penalties, evidenceCompleteness)
    shouldPaperTrack() / shouldProve() gate stage transitions:
      DISCOVERED -> PAPER_TRACKING -> PROVEN (or REJECTED / PAUSED, auto-demotion on decline)
  -> updates SmartWalletCandidate.stage/scores; PROVEN requires evidenceCompleteness>=50 AND
     >=20 forward samples of CLOSED (not open/unrealized) paper trades
   |
   v
MARKET INTELLIGENCE
  services/market-worker -- prices open LIVE positions at P0 priority, discovery candidates lower
  packages/shared RpcBudget/pickHealthyRpc -- shared cross-process RPC priority tiers + failover,
    now validates an indexed method (getTokenSupply) not just getHealth
  -> writes MemeMarketSnapshot, MarketPrice
   |
   v
GLOBAL BRAIN
  services/brain-worker (750ms tick)
    packages/brain.evaluateOpportunity() -- score + breakdown (Momentum/SmartMoney/
      ExecutionQuality/Risk/EvidenceCompleteness, additive/diagnostic only)
    weightedConvergenceScore() -- PROVEN wallets count 2x a PAPER_TRACKING wallet
    checkWatchlist() (10s interval) -- admin-watched-wallet buy detection -> AdminAlert
  -> writes/updates GlobalBrainOpportunity (state, score, evidence JSON incl. breakdown)
   |
   v
USER INTELLIGENCE
  apps/api /v1/brain/feed -- qualified feed (score>=56) + separate newTokenRadar (score<56,
    <30min old) -- NOT the same list; New Token Radar is early/unqualified, not a recommendation
  6 independent notification preferences (discoveryNewToken/SmartWallet/WhaleActivity/
    HeatingUp/Strong/HighConviction), each independently qualifying a user (fixed this session --
    previously 3 of 6 structurally excluded users who enabled only one)
   |
   v
ENTRY DECISION
  brain-worker maybeSignal() -- gated on chainSupports(chain,"EXECUTION_SUPPORTED") (only SOLANA
    today; non-Solana opportunities never reach execution regardless of score)
  -> writes Signal (idempotency-keyed per 30s bucket + state-upgrade ratchet, no repeat-BUY spam)
   |
   v
EXECUTION
  services/executor -- copy-buy from Signal, decisionKey-idempotent, Privy reference_id
    ambiguous-broadcast recovery, real on-chain delta reconciliation before CONFIRMED
  services/listener -- detects source-wallet sells, fans out to followers' copy decisions
  -> writes Order, LiveExecutionAttempt, Position (LIVE or SIMULATION)
   |
   v
POSITION
  services/exits (3s tick) -- adaptive TP/stop/principal-recovery, P2002 race-safe on both
    buy and sell paths, stale/missing market data never fabricates a sell condition
   |
   v
EXIT
  same executor/exits real on-chain reconciliation, PositionExit created atomically with
  Position.realizedPnlUsd increment and a LedgerEntry (SELL_PROCEEDS) in one $transaction
   |
   v
RECONCILIATION
  services/balance-worker -- real on-chain USDC/SOL balance sync; RPC failure -> skip write
    (preserve last-known-good), never fabricate $0; deposit detection -> LedgerEntry (DEPOSIT)
   |
   v
PORTFOLIO
  apps/api /v1/me/dashboard -- single authoritative aggregation (available/inTrades/
    accountValue/realized/unrealized/today), no competing frontend recalculation
```

## Wallet -> execution authority chain

```
WALLET (Privy embedded, delegated signer)
   |
   v
DEPOSIT (balance-worker detects on-chain USDC/SOL transfer, idempotent via unique
         (chain,txHash,walletAddress,assetMint), LedgerEntry DEPOSIT on confirmation)
   |
   v
BALANCE (real on-chain sync only; RPC failure leaves last-known-good in place)
   |
   v
TRADING CASH (TradingCashAllocation.availableUsdMicros/inTradesUsdMicros, BigInt micro-USD)
   |
   v
EXECUTION AUTHORITY (Wallet.tradingEnabled + permissionRef + permissionExpiry check on
                      every buy/sell; execution capability is separate from and does not
                      control whether intelligence/discovery runs)
```

## Financial ledger (added this session)

`LedgerEntry` (BigInt `amountUsdMicros`) is an immutable, append-only audit trail written
atomically alongside the state change it documents (BUY_SPEND, SELL_PROCEEDS, DEPOSIT so far;
WITHDRAWAL/NETWORK_FEE/PLATFORM_FEE/ADJUSTMENT/REVERSAL types exist but have no writers yet).
It does NOT replace TradingCashAllocation as the source of truth for *current* balance --
that stays resynced from real on-chain state. The ledger is for reconciling *what happened*.

## Multi-chain capability registry (`packages/shared` `CHAIN_CAPABILITY_REGISTRY`)

| Chain | Discovery | Wallet profiling | Market data | Quote | Buy | Sell | Confirm | Reconcile | Execution |
|---|---|---|---|---|---|---|---|---|---|
| SOLANA | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| BASE / ETHEREUM / BNB / ARBITRUM / AVALANCHE / SUI / HYPERLIQUID | Yes | No | No | No | No | No | No | No | No |

Non-Solana chains are discovery-only by explicit registry, not by accident of what code
happens to exist -- `brain-worker.maybeSignal()` checks this before ever creating a Signal.

## Known gaps (see FORENSIC_AUDIT_FINAL.md for the full, current list)
- EVM ingestion has real reconnect/watchdog logic but is dormant (no BNB_RPC_WS/ETH_RPC_WS
  configured in production).
- No true chaos/process-crash testing has been run against a live environment (none available
  in this working environment).
- Full UX/product redesign (Home Pulse, Wallet, Smart Money nav, Admin desk, mobile QA) is
  largely not started; Token Detail and Discover have partial updates.
- API (`apps/api/src/server.ts`, ~2450 lines) and frontend pages remain large single files;
  the domain-split refactor has not been done.
