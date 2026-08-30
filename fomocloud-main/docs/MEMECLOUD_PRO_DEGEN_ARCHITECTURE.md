# MemeCloud Professional-Degen Architecture

MemeCloud is a chain-first meme trading system. Saved whales/KOL wallets are one evidence source, not the only source.

## Hot path

1. `flow-worker` subscribes to Solana chain-wide transaction logs and extracts stable/WSOL <-> token swaps by owner.
2. Large/repeated wallets are profiled conservatively and saved to `SmartWalletCandidate`; $50K/$100K/$1M/$2M/$10M wallet tiers are stored as evidence.
3. `evm-flow-worker` subscribes to BNB/Ethereum V2-style DEX Swap logs, resolves the actual transaction sender, identifies quote-token pairs, and stores flows. BNB/ETH WebSocket RPC URLs are supplied in Admin > Global Brain.
4. Existing wallet listener continues watching verified whale/KOL wallets directly.
5. Existing market worker produces genuine executable marks and rich market snapshots.
6. `social-worker` adds X recent-search velocity when an X bearer token is configured.
7. `brain-worker` reevaluates live token evidence roughly every 750ms from cached/database observations and creates a Global Brain opportunity feed.
8. A qualified brain opportunity creates a normal source signal through the existing execution queue. This deliberately reuses the proven quote, per-user sizing, sell-route, signing, reconciliation, order and position pipeline instead of creating a second fake execution path.
9. Users opt into Global Brain and choose the percentage of available trading cash used per entry. Platform caps use `0 = no cap`; MemeCloud does not silently override user risk choices.
10. Default capital recovery is 3x: when the position value reaches the user's configured multiple, exits sells only enough current value to recover unrecovered original principal. The remainder stays as an evidence-managed runner.

## Important philosophy

- A token being +1,000%, +10,000% or more is not a hard blocker.
- A -60%/-70% drawdown is not automatically dead. The brain computes a survivor score from renewed buyers, whale convergence and volume reacceleration.
- Animal/funny/narrative tokens are not penalized simply for being memes.
- Concentration, creator activity, social spam and prior pump are evidence/warnings, not automatic death sentences.
- Hard blockers are reserved for execution-impossible states such as no executable sell route or an unusable route.
- No hardcoded daily drawdown or daily loss limit is added.
- Optional user caps are exactly that: optional.

## Multi-chain state

- Solana: existing source listener + new chain-wide flow scanner + Jupiter execution path.
- BNB: chain-wide V2-style DEX flow scanner is built. A production live swap execution adapter must be verified/configured before BNB live money is enabled.
- Ethereum: same EVM flow foundation; live execution adapter must be verified/configured.
- Robinhood is not treated as a blockchain and should be a separate broker/exchange adapter later.

## Binance Alpha

Binance Alpha is a catalyst stream, not a guaranteed-pump oracle. Store official Alpha/listing events as `CatalystEvent` and let the brain combine the catalyst with current flow. Do not scrape undocumented private interfaces. Binance's official 2026 developer catalog exposes Alpha Trading APIs; deployer should wire the officially documented endpoint available at deployment time.

## Learning

`BrainOutcomeSample` stores forward returns at 5s/30s/60s/5m/1h after opportunities. Learning is shadow evidence first. It should adjust scoring only after adequate repeated samples, never silently rewrite live code after a few lucky trades.
