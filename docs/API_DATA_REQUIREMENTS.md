# External data/API requirements vs VPS-derived analytics

The VPS should compute derived analytics itself where raw genuine data is available. It cannot invent external facts.

| Function | Preferred raw source | VPS can derive? | External service still needed? |
|---|---|---:|---|
| Source wallet events | chain RPC/WebSocket | yes, decode/fan-out | genuine RPC/node source required |
| Source-wallet chase | source execution + executable quote | yes | quote/raw transaction sources required |
| Solana executable price | Jupiter quote | cache/window locally | Jupiter/route source required |
| Token supply | Solana RPC | market-cap estimate from supply × executable price | RPC required |
| Volume / unique buyers | raw DEX transactions | yes if decoder coverage is complete | enriched provider helpful until full protocol decoders exist |
| Holder concentration | chain account/indexed holder data | partially | specialized/indexed provider may be practical |
| EVM logs | EVM RPC/WebSocket | yes | RPC endpoint required |
| EVM execution | 0x/1inch/Uniswap-compatible adapter | route locally, execution external/on-chain | official route/RPC required |
| X account linking | X OAuth2 | no | X developer credentials required |
| Social mention velocity | X/social raw feed | yes after collection | legitimate social API/data source required |
| Email | SMTP | queue locally | SMTP provider required |
| Web Push | browser Push API + VAPID | yes | no Firebase required |

Do not claim multi-chain execution is working merely because an adapter type exists. The Admin UI should distinguish configured, adapter-ready and genuinely tested chains.
