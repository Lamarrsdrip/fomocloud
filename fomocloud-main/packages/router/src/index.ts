export type Chain = "SOLANA"|"BASE"|"ETHEREUM"|"BNB"|"ARBITRUM"|"AVALANCHE"|"SUI"|"HYPERLIQUID";

export type RouteQuote = {
  venue:string;
  chain:Chain;
  inputAsset:string;
  outputAsset:string;
  inputAmountRaw:string;
  expectedOutputRaw:string;
  minOutputRaw:string;
  priceImpactPct:number;
  estimatedNetworkFeeUsd?:number;
  estimatedPlatformFeeUsd?:number;
  latencyMs?:number;
  metadata?:Record<string,unknown>;
};

export interface ExecutionAdapter {
  chain:Chain;
  name:string;
  quote(params:{inputAsset:string;outputAsset:string;amountRaw:string;slippageBps:number}):Promise<RouteQuote>;
  buildAndSubmit(params:{quote:RouteQuote;userId:string;tradingWallet:string}):Promise<{txHash:string}>;
  confirm(txHash:string):Promise<{confirmed:boolean;actualInputRaw?:string;actualOutputRaw?:string;feeUsd?:number}>;
}

export class SmartExecutionRouter {
  private byChain = new Map<Chain,ExecutionAdapter[]>();
  register(adapter:ExecutionAdapter) {
    const list=this.byChain.get(adapter.chain)??[];
    list.push(adapter); this.byChain.set(adapter.chain,list);
  }
  async bestQuote(chain:Chain, params:{inputAsset:string;outputAsset:string;amountRaw:string;slippageBps:number}) {
    const adapters=this.byChain.get(chain)??[];
    if(!adapters.length) throw new Error(`NO_EXECUTION_ADAPTER:${chain}`);
    const results=await Promise.allSettled(adapters.map(a=>a.quote(params)));
    const quotes=results.filter((r):r is PromiseFulfilledResult<RouteQuote>=>r.status==="fulfilled").map(r=>r.value);
    if(!quotes.length) throw new Error("NO_EXECUTABLE_ROUTE");
    // Prefer output after accounting for severe price impact. Tie-break with latency/fees.
    quotes.sort((a,b)=>{
      const ao=BigInt(a.expectedOutputRaw), bo=BigInt(b.expectedOutputRaw);
      if(ao!==bo) return ao>bo?-1:1;
      return (a.latencyMs??9999)-(b.latencyMs??9999);
    });
    return quotes[0];
  }
}
