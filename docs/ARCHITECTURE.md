# Architecture

## Consumer UX

The consumer site is intentionally not an operations dashboard. It is a mobile-first product
surface with progressive disclosure. Users see portfolio, followed traders, positions and
activity. Infrastructure details remain in the separate admin application.

## Chain listener

`services/listener` subscribes to verified Solana trader wallets. It stores the raw confirmed
source transaction before producing a signal. A `(chain, txHash, wallet)` database constraint
prevents replay after reconnect.

Generic token-balance delta classification is included as a safe baseline. Before production,
add protocol-specific decoding and fixture tests for the DEX/aggregators your tracked wallets use.

## Copy pipeline

Every signal has an idempotency key. Every `(signal,user)` pair can create only one CopyDecision.
This protects users from duplicate WebSocket events and worker retries.

The risk engine checks:

- auto-copy status
- available allocation
- total exposure
- per-token exposure
- minimum liquidity (when known)
- maximum chase (when source/current price are known)
- maximum configured trade size

Unknown market/safety data must be treated conservatively for LIVE execution. Do not invent it.

## Execution

`packages/execution` contains a Jupiter quote/swap adapter and a `SignerProvider` interface.

The repository deliberately does not include a server database column for a user's primary wallet
seed/private key.

A production signer adapter should be backed by a reviewed policy-controlled wallet/delegation
system. The adapter must enforce the user's approved limits independently of frontend state.

## Exit engine

Targets are based on executable quotes, not display prices. In a complete live deployment, add a
price/quote adapter that understands token decimals and converts the exit quote to USD/USDC.
Only a confirmed sell should update realized P&L.

## Scaling

For thousands of users:

- subscribe once per unique source wallet, not once per follower
- fan out one normalized signal to affected users via queue
- horizontally scale stateless executor workers
- use MongoDB/Prisma unique constraints as the final idempotency barrier
- shard/partition high-volume event tables when necessary
- cache trader profiles and public market data
- use at least two production RPC providers
- keep execution workers close to RPC/provider regions
- instrument signal-to-submit and submit-to-confirm latency
