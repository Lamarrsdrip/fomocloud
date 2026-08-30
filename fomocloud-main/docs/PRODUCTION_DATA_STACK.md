# Production data/execution stack

Recommended adapter layout (provider-neutral in code):

1. **Helius / direct Solana RPC**
   - watched-wallet events
   - raw/enhanced transaction provenance
   - independent chain reconciliation

2. **Birdeye**
   - real-time token price/transaction/OHLCV feeds
   - Solana sub-minute timeframes where available
   - holder distribution/top holders
   - token trade history

3. **Jupiter**
   - executable swap route/quote immediately before order submission
   - never use a decorative chart price as the sellability test

4. **Jito**
   - optional low-latency/MEV-protected transaction path
   - adaptive priority/tip policy
   - must still confirm that the transaction actually landed

5. **X/social provider**
   - asynchronous enrichment only
   - mention velocity, unique-author ratio, sentiment, spam/manipulation evidence
   - never delay a fast on-chain copy solely waiting for social API results

For thousands of users, monitor each unique source wallet once, normalize once, then fan the signal
out to followers. Do not open one market-data websocket per user.
