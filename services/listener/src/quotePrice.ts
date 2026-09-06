import { db } from "@memecloud/db";

// SOL-denominated swaps were leaving amountUsd null, which is why a real Pump.fun buy rendered as
// "bought Unknown token" with no value attached. USDC/USDT legs are already 1:1, so the only thing
// missing was a SOL/USD mark at trade time.
//
// The price is taken from the market snapshots this platform already writes (no new provider call,
// no new API key) and cached in-process, so a burst of 40 swaps costs at most one lookup per
// minute rather than 40 provider requests.
export const WSOL_MINT="So11111111111111111111111111111111111111112";
const CACHE_MS=60_000;
let cached:{price:number;at:number}|null=null;

export function solUsdCacheForTest(){return cached}
export function resetSolUsdCache(){cached=null}

/** Most recent trustworthy SOL/USD mark, or null when we genuinely do not know it. */
export async function solUsdPrice(now=Date.now()):Promise<number|null>{
  if(cached&&now-cached.at<CACHE_MS)return cached.price;
  const snap=await db.memeMarketSnapshot.findFirst({
    where:{chain:"SOLANA",mint:WSOL_MINT,priceUsd:{gt:0},observedAt:{gte:new Date(now-30*60_000)}},
    orderBy:{observedAt:"desc"},select:{priceUsd:true}
  }).catch(()=>null);
  const price=Number(snap?.priceUsd??0);
  if(!Number.isFinite(price)||price<=0)return null;   // honest null beats an invented number
  cached={price,at:now};
  return price;
}

export type QuoteLeg={quoteMint:string;quoteSymbol:string;quoteAmount:number;amountUsd?:number};

/** Resolve what the wallet actually spent/received, in its real asset, plus a USD value if known. */
export async function resolveQuoteLeg(input:{quoteMint:string;rawAmount:bigint;decimals:number;usdcMint:string;usdtMint:string}):Promise<QuoteLeg>{
  const {quoteMint,rawAmount,decimals,usdcMint,usdtMint}=input;
  const amount=Number(rawAmount<0n?-rawAmount:rawAmount)/10**decimals;
  if(quoteMint===usdcMint)return {quoteMint,quoteSymbol:"USDC",quoteAmount:amount,amountUsd:amount};
  if(quoteMint===usdtMint)return {quoteMint,quoteSymbol:"USDT",quoteAmount:amount,amountUsd:amount};
  if(quoteMint===WSOL_MINT){
    const sol=await solUsdPrice();
    return {quoteMint,quoteSymbol:"SOL",quoteAmount:amount,amountUsd:sol?amount*sol:undefined};
  }
  return {quoteMint,quoteSymbol:quoteMint.slice(0,4),quoteAmount:amount};
}
