# FomoCloud multi-chain + USDC trading cash

FomoCloud is chain-agnostic. The consumer app presents a unified **Trading Cash** amount, denominated
in USD and funded primarily with USDC.

A watched trader may buy on Solana, Base, Ethereum, BNB Chain, Arbitrum, Avalanche, Sui or another
enabled network. The intelligence layer stays universal; only the chain adapter changes.

Important implementation detail: USDC is chain-specific on-chain. A single visual Trading Cash
number does not mean one USDC token can magically be spent on every network. Production must either:

1. keep user-authorized USDC allocations on each enabled chain, or
2. use a reviewed smart-account/bridging design that can rebalance capital safely.

Never bridge automatically without explicit user authorization and clear fees/latency/risk.

Execution routes should be provider-neutral:
- Fomo, if it exposes a compliant official execution API suitable for automation;
- Jupiter or direct Solana routes on Solana;
- 0x / 1inch / Uniswap-compatible routing on EVM chains;
- chain-native routing adapters elsewhere.

The router compares real executable quotes and chooses the best allowed route. FomoCloud must not
scrape or automate a third-party consumer app when an official integration is unavailable.
