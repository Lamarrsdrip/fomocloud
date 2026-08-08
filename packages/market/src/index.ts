export type TokenMarketPulse = {
  mint:string;
  priceUsd:number;
  marketCapUsd?:number;
  liquidityUsd:number;
  volume1mUsd:number;
  volume5mUsd:number;
  volume15mUsd:number;
  buys1m:number;
  sells1m:number;
  buys5m:number;
  sells5m:number;
  buyVolume5mUsd:number;
  sellVolume5mUsd:number;
  uniqueBuyers1m:number;
  uniqueBuyers5m:number;
  uniqueSellers5m:number;
  holderCount?:number;
  holderGrowth5mPct?:number;
  top10EffectivePct?:number;
  largestRealWalletPct?:number;
  observedAt:number;
  sources:string[];
};

export interface MarketDataProvider {
  getPulse(mint:string):Promise<TokenMarketPulse>;
  subscribe?(mints:string[], onPulse:(pulse:TokenMarketPulse)=>void):Promise<()=>Promise<void>|void>;
}

/**
 * Production recommendation:
 * - Birdeye real-time price/tx/OHLCV + holder-distribution feeds
 * - direct Solana/Helius data as independent provenance
 * - executable Jupiter quote immediately before execution
 *
 * Never let a single display-price provider be the source of truth for a sell.
 */
export class CompositeMarketData {
  constructor(private providers:MarketDataProvider[]){}
  async getPulse(mint:string):Promise<TokenMarketPulse>{
    const results = await Promise.allSettled(this.providers.map(p=>p.getPulse(mint)));
    const good = results.filter((r):r is PromiseFulfilledResult<TokenMarketPulse>=>r.status==="fulfilled").map(r=>r.value);
    if (!good.length) throw new Error("MARKET_DATA_UNAVAILABLE");
    good.sort((a,b)=>b.observedAt-a.observedAt);
    return {...good[0], sources:[...new Set(good.flatMap(x=>x.sources))]};
  }
}
