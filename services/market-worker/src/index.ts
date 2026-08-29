import {Connection,PublicKey} from "@solana/web3.js";
import { Redis } from "ioredis";
import {db} from "@memecloud/db";
import {JupiterExecution} from "@memecloud/execution";
import {BirdeyeClient} from "@memecloud/providers";
import {startHeartbeat} from "@memecloud/ops";
import {getConfig} from "@memecloud/config";
import {cachedTokenDecimals,RpcBudget,solanaRpcCandidates,pickHealthyRpc} from "@memecloud/shared";

const usdc=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quoteUsd=Math.max(1,Number(process.env.MARKET_QUOTE_USD??10));
const decimalsCache=new Map<string,{decimals:number;supply:number;at:number}>();
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
// Shared, cross-process Solana RPC budget -- same account, same bucket, as flow-worker. This
// worker marks real open positions' current value (trackedMints() pulls OPEN/PARTIALLY_CLOSED
// positions, not just discovery candidates), so its getTokenSupply calls draw at P2: well above
// pure background discovery (flow-worker, P4) since stale marks are user-visible, but still below
// the true real-money execution paths (exits/executor).
const sharedRpcBudget=new RpcBudget(redis,"rpc-budget:solana",{
  capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),
  ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))
});
let sharedBudgetDenied=0,lastSharedBudgetDenyAt:number|null=null;
let tracked=0,updates=0,richUpdates=0,quoteErrors=0,enrichmentErrors=0,running=false;

// Previously read once at process startup and cached forever — an Admin change to the RPC URL,
// Jupiter API key, or Birdeye key silently had no effect until someone manually restarted this
// service. Re-fetched every tick (a cheap AppConfig read, not per-mint) so config actually applies.
let conn:Connection,jupiter:JupiterExecution,birdeye:BirdeyeClient|null;
async function reloadConfig(){
  const marketCfg=await getConfig<any>("marketData"),execCfg=await getConfig<any>("execution");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[market-worker]");
  conn=new Connection(rpc,"confirmed");
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  const birdeyeKey=marketCfg?.birdeyeApiKey||process.env.BIRDEYE_API_KEY;
  birdeye=birdeyeKey?new BirdeyeClient(birdeyeKey,marketCfg?.birdeyeBaseUrl):null;
}
await reloadConfig();

async function tokenMeta(mint:string){
  const c=decimalsCache.get(mint);if(c&&Date.now()-c.at<60*60_000)return c;
  const shared=await sharedRpcBudget.tryAcquire("P2");
  if(!shared.granted){
    sharedBudgetDenied++;lastSharedBudgetDenyAt=Date.now();
    throw Object.assign(new Error("SHARED_RPC_BUDGET_EXCEEDED"),{code:"SHARED_RPC_BUDGET_EXCEEDED"});
  }
  const supply=await conn.getTokenSupply(new PublicKey(mint),"confirmed");
  const v={decimals:supply.value.decimals,supply:Number(supply.value.uiAmountString??0),at:Date.now()};
  decimalsCache.set(mint,v);
  // Supply is mutable so this call must always stay fresh, but the decimals half never
  // changes -- share it via cachedTokenDecimals' write path so exits/executor/paper-worker
  // can skip their own RPC call for mints market-worker has already resolved.
  cachedTokenDecimals(redis,mint,async()=>v.decimals).catch(()=>{});
  return v;
}

// Real bug found by audit: the old order was signals-first (up to 1500, 48h of history) into a
// flat .slice(0,350) -- if signal volume alone exceeded 350 unique mints, OPEN LIVE POSITIONS could
// be silently excluded entirely, since positions were concatenated second. exits' mark-to-market
// depends on this worker's MarketPrice rows staying fresh; a position never receiving a fresh price
// means stop-loss/take-profit protection silently stops working for real money, with zero signal
// that anything was wrong (no error, just an untracked mint). Priority now: P0 real open positions
// (never capped away -- the slice floor always leaves room for every one of them), P1 recently-
// discovered/hot tokens, P2 historical signal activity backfills whatever's left. Also added
// explicit recency ordering to signals/discoveries, which previously had none -- "most recent N"
// wasn't actually guaranteed to mean recent without it.
async function trackedMints(){
  const since=new Date(Date.now()-48*60*60_000);
  const [positions,discoveries,signals]=await Promise.all([
    db.position.findMany({where:{chain:"SOLANA",status:{in:["OPEN","PARTIALLY_CLOSED"]}},select:{mint:true},take:2000}),
    db.discoveryToken.findMany({where:{chain:"SOLANA",lastSeenAt:{gte:since}},select:{mint:true},orderBy:{lastSeenAt:"desc"},take:300}),
    db.signal.findMany({where:{chain:"SOLANA",action:"BUY",observedAt:{gte:since}},select:{outputMint:true},orderBy:{observedAt:"desc"},take:1500})
  ]);
  const excluded=new Set([usdc,"So11111111111111111111111111111111111111112"]);
  const unique=[...new Set([...positions.map(p=>p.mint),...discoveries.map(x=>x.mint),...signals.map(s=>s.outputMint)])].filter(m=>!excluded.has(m));
  const positionCount=new Set(positions.map(p=>p.mint)).size;
  return unique.slice(0,Math.max(350,positionCount+350));
}

async function jupiterMark(mint:string){
  const meta=await tokenMeta(mint);
  const amountRaw=String(Math.round(quoteUsd*1_000_000));
  const q=await jupiter.quote({inputMint:usdc,outputMint:mint,amountRaw,slippageBps:1500});
  const tokens=Number(q.outAmount)/(10**meta.decimals);
  if(!Number.isFinite(tokens)||tokens<=0)throw new Error("INVALID_JUPITER_MARK");
  const priceUsd=quoteUsd/tokens,marketCapUsd=meta.supply>0?meta.supply*priceUsd:undefined;
  return {priceUsd,marketCapUsd,priceImpactPct:Math.abs(Number(q.priceImpactPct??0))};
}

async function chainFlowMetrics(mint:string){
  const since5=new Date(Date.now()-5*60_000),since1=new Date(Date.now()-60_000);
  const rows=await db.chainFlowObservation.findMany({where:{chain:"SOLANA",mint,observedAt:{gte:since5}},select:{side:true,amountUsd:true,walletAddress:true,observedAt:true}});
  let buyVolume5mUsd=0,sellVolume5mUsd=0,buyVolume1mUsd=0,buys1m=0,sells1m=0,buys5m=0,sells5m=0;
  const buyers1m=new Set<string>(),buyers5m=new Set<string>(),sellers5m=new Set<string>();
  for(const r of rows){
    const usd=Number(r.amountUsd??0),within1m=r.observedAt>=since1;
    if(r.side==="BUY"){buyVolume5mUsd+=usd;buys5m++;buyers5m.add(r.walletAddress);if(within1m){buyVolume1mUsd+=usd;buys1m++;buyers1m.add(r.walletAddress)}}
    else{sellVolume5mUsd+=usd;sells5m++;sellers5m.add(r.walletAddress);if(within1m)sells1m++;}
  }
  const avgPerMin=buyVolume5mUsd/5;
  const volumeAcceleration1m=avgPerMin>0?buyVolume1mUsd/avgPerMin:1;
  return {buys1m,sells1m,buys5m,sells5m,buyVolume5mUsd,sellVolume5mUsd,volume1mUsd:buyVolume1mUsd,volume5mUsd:buyVolume5mUsd+sellVolume5mUsd,uniqueBuyers1m:buyers1m.size,uniqueBuyers5m:buyers5m.size,uniqueSellers5m:sellers5m.size,volumeAcceleration1m};
}

// Real fallback when Birdeye isn't configured: no liquidity/holder data available (kept honestly
// at 0/null, never guessed), but price and buy/sell flow are genuine on-chain data already being
// collected, so Global Brain still has something real to score instead of nothing at all.
async function basicSnapshot(mint:string,j:{priceUsd:number;marketCapUsd?:number;priceImpactPct:number}){
  const m=await chainFlowMetrics(mint);
  const observedAt=new Date();
  const snap=await db.memeMarketSnapshot.create({data:{
    chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd:0,ageMinutes:1440,
    volume1mUsd:m.volume1mUsd,volume5mUsd:m.volume5mUsd,volume15mUsd:m.volume5mUsd,
    volumeAcceleration1m:m.volumeAcceleration1m,volumeAcceleration5m:1,
    buys1m:m.buys1m,sells1m:m.sells1m,buys5m:m.buys5m,sells5m:m.sells5m,
    buyVolume5mUsd:m.buyVolume5mUsd,sellVolume5mUsd:m.sellVolume5mUsd,
    uniqueBuyers1m:m.uniqueBuyers1m,uniqueBuyers5m:m.uniqueBuyers5m,uniqueSellers5m:m.uniqueSellers5m,
    source:"JUPITER+CHAIN_FLOW",provenance:{jupiter:{priceImpactPct:j.priceImpactPct},birdeye:null} as any,observedAt
  }});
  await redis.set(`meme:SOLANA:${mint}`,JSON.stringify(snap),"EX",45);
  return snap;
}

async function richSnapshot(mint:string,j:{priceUsd:number;marketCapUsd?:number;priceImpactPct:number}){
  if(!birdeye)return null;
  const [m,t,h,l]=await Promise.all([
    birdeye.marketData(mint),
    birdeye.tradeData(mint),
    birdeye.holderProfile(mint),
    birdeye.exitLiquidity(mint)
  ]);
  const x=birdeye.normalizeMarket(m,t,h,l);
  // Jupiter's actual executable mark is preferred for price. Birdeye provides the deeper context.
  const observedAt=new Date();
  const snap=await db.memeMarketSnapshot.create({data:{
    chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:x.marketCapUsd??j.marketCapUsd,liquidityUsd:Number(x.liquidityUsd??0),exitLiquidityUsd:x.exitLiquidityUsd,
    ageMinutes:Number(x.ageMinutes??1440),volume1mUsd:Number(x.volume1mUsd??0),volume5mUsd:Number(x.volume5mUsd??0),volume15mUsd:Number(x.volume15mUsd??0),
    volumeAcceleration1m:Number(x.volumeAcceleration1m??1),volumeAcceleration5m:Number(x.volumeAcceleration5m??1),
    buys1m:Number(x.buys1m??0),sells1m:Number(x.sells1m??0),buys5m:Number(x.buys5m??0),sells5m:Number(x.sells5m??0),
    buyVolume5mUsd:Number(x.buyVolume5mUsd??0),sellVolume5mUsd:Number(x.sellVolume5mUsd??0),
    uniqueBuyers1m:Number(x.uniqueBuyers1m??0),uniqueBuyers5m:Number(x.uniqueBuyers5m??0),uniqueSellers5m:Number(x.uniqueSellers5m??0),
    holderCount:x.holderCount,holderGrowth5mPct:x.holderGrowth5mPct,top10EffectivePct:x.top10EffectivePct,bundledSupplyPct:x.bundledSupplyPct,
    creatorHoldingPct:x.creatorHoldingPct,liquidityChange5mPct:x.liquidityChange5mPct,
    source:"JUPITER+BIRDEYE",provenance:{jupiter:{priceImpactPct:j.priceImpactPct},birdeye:{marketData:true,tradeData:true,holderProfile:true,exitLiquidity:true}},observedAt
  }});
  await redis.set(`meme:SOLANA:${mint}`,JSON.stringify(snap),"EX",45);
  richUpdates++;
  return snap;
}

async function updateMint(mint:string){
  try{
    const j=await jupiterMark(mint);
    const observedAt=new Date();
    let liquidityUsd:number|undefined;
    try{
      const rich=await richSnapshot(mint,j);
      if(rich)liquidityUsd=rich.liquidityUsd;
      else await basicSnapshot(mint,j);
    }catch(e){enrichmentErrors++;console.error("[market-worker] enrichment",mint,e);await basicSnapshot(mint,j).catch(()=>{})}
    await db.marketPrice.create({data:{chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd,source:birdeye?"JUPITER_EXECUTABLE+BIRDEYE":"JUPITER_EXECUTABLE_QUOTE",observedAt}});
    await redis.set(`price:SOLANA:${mint}`,JSON.stringify({priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd,source:"JUPITER_EXECUTABLE_QUOTE",observedAt:observedAt.toISOString()}),"EX",90);
    updates++;
    const old=await db.marketPrice.findMany({where:{chain:"SOLANA",mint},orderBy:{observedAt:"desc"},skip:1440,take:500,select:{id:true}});
    if(old.length)await db.marketPrice.deleteMany({where:{id:{in:old.map(x=>x.id)}}});
    const oldRich=await db.memeMarketSnapshot.findMany({where:{chain:"SOLANA",mint},orderBy:{observedAt:"desc"},skip:720,take:300,select:{id:true}});
    if(oldRich.length)await db.memeMarketSnapshot.deleteMany({where:{id:{in:oldRich.map(x=>x.id)}}});
  }catch(e:any){
    // A shared-budget denial is this worker correctly backing off for another, higher-priority
    // consumer -- not a provider-side failure, so it must not feed the adaptive-backoff counter
    // below (that would slow this worker's own pace for a reason unrelated to its own error rate).
    if(e?.code==="SHARED_RPC_BUDGET_EXCEEDED")return;
    quoteErrors++;console.error("[market-worker]",mint,e);
  }
}

// Adaptive backoff: sustained provider 429s mean the current pace exceeds whatever tier the
// configured API key actually has, and hammering harder only makes it worse. Slow down when
// errors are actively happening; ease back toward the base pace once they stop. This is scoped
// entirely to this price-polling worker — it does not touch @memecloud/execution, so it has no
// effect on the real BUY/SELL path in executor/exits.
let adaptiveDelayMs=Number(process.env.MARKET_BATCH_DELAY_MS??500);
const baseDelayMs=adaptiveDelayMs,maxDelayMs=Math.max(baseDelayMs,8000);
async function tick(){
  if(running)return;running=true;
  try{
    await reloadConfig().catch(e=>console.error("[market-worker] config reload failed, keeping previous clients",e));
    const mints=await trackedMints();tracked=mints.length;
    const errorsBefore=quoteErrors;
    // Avoid bursting provider limits. Admin can run more workers later if the paid plan supports it.
    const batch=Math.max(1,Math.min(8,Number(process.env.MARKET_BATCH_SIZE??4)));
    for(let i=0;i<mints.length;i+=batch){
      await Promise.all(mints.slice(i,i+batch).map(updateMint));
      await new Promise(r=>setTimeout(r,adaptiveDelayMs));
    }
    if(quoteErrors>errorsBefore)adaptiveDelayMs=Math.min(maxDelayMs,Math.round(adaptiveDelayMs*1.6));
    else adaptiveDelayMs=Math.max(baseDelayMs,Math.round(adaptiveDelayMs*0.85));
  }finally{running=false}
}
startHeartbeat("market-worker",()=>({tracked,updates,richUpdates,quoteErrors,enrichmentErrors,adaptiveDelayMs,richProvider:birdeye?"BIRDEYE":"NOT_CONFIGURED",running,
  sharedRpcBudgetPriority:"P2",sharedRpcBudgetDenied:sharedBudgetDenied,
  lastSharedRpcBudgetDenyAgoSec:lastSharedBudgetDenyAt?Math.round((Date.now()-lastSharedBudgetDenyAt)/1000):null
}));
setInterval(()=>void tick(),Math.max(3000,Number(process.env.MARKET_INTERVAL_MS??7000)));
void tick();
console.log("[market-worker] running");
