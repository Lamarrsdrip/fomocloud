import {Connection,PublicKey} from "@solana/web3.js";
import { Redis } from "ioredis";
import {db} from "@memecloud/db";
import {JupiterExecution} from "@memecloud/execution";
import {BirdeyeClient} from "@memecloud/providers";
import {startHeartbeat} from "@memecloud/ops";
import {getConfig} from "@memecloud/config";
import {cachedTokenDecimals,RpcBudget,solanaRpcCandidates,pickHealthyRpc,recordProviderMetric} from "@memecloud/shared";
import {aggregateChainFlow} from "./aggregate.js";
import {shouldRefreshMarketMint} from "./plan.js";
import {classifyTokenProvenance,deepResearchEligible} from "@memecloud/discovery";

const usdc=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quoteUsd=Math.max(1,Number(process.env.MARKET_QUOTE_USD??10));
const decimalsCache=new Map<string,{decimals:number;supply:number;at:number}>();
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
// Shared, cross-process Solana RPC budget for the remaining wallet-first services. This
// worker marks real open positions' current value (trackedMints() pulls OPEN/PARTIALLY_CLOSED
// positions, not just discovery candidates), so its getTokenSupply calls draw at P2: well above
// background discovery since stale marks are user-visible, but still below
// the true real-money execution paths (exits/executor).
const sharedRpcBudget=new RpcBudget(redis,"rpc-budget:solana",{
  capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),
  ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))
});
let sharedBudgetDenied=0,lastSharedBudgetDenyAt:number|null=null;
let tracked=0,updates=0,richUpdates=0,quoteErrors=0,enrichmentErrors=0,running=false,runningSince=0;
// Same class of bug found and fixed in brain-worker/solana-listener this session: an unbounded
// `if(running)return;running=true` lets one hung await (a provider/RPC call with no internal
// timeout) wedge every future tick forever while the heartbeat keeps reporting "healthy"
// regardless, on its own independent timer. This worker prices OPEN LIVE positions (P0) as well
// as discovery candidates -- a wedge here would silently stop real position mark-price updates.
const TICK_STALE_MS=5*60_000;
let jupiterRequests=0,rpcRequests=0,birdeyeRequests=0,quietTickExternalRequests=0,quietTickCacheHits=0,dbReads=0,redisReads=0;

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
  birdeye=birdeyeKey?new BirdeyeClient(birdeyeKey,marketCfg?.birdeyeBaseUrl,{redis,service:"market-worker",priority:"P2"}):null;
}
await reloadConfig();

async function tokenMeta(mint:string){
  const c=decimalsCache.get(mint);if(c&&Date.now()-c.at<60*60_000)return c;
  const shared=await sharedRpcBudget.tryAcquire("P2");
  if(!shared.granted){
    sharedBudgetDenied++;lastSharedBudgetDenyAt=Date.now();
    throw Object.assign(new Error("SHARED_RPC_BUDGET_EXCEEDED"),{code:"SHARED_RPC_BUDGET_EXCEEDED"});
  }
  const rpcStarted=Date.now();rpcRequests++;
  await recordProviderMetric(redis,{provider:"SOLANA_RPC",endpoint:"getTokenSupply",service:"market-worker",priority:"P2",providerClass:"CRITICAL",event:"request"});
  const supply=await conn.getTokenSupply(new PublicKey(mint),"confirmed");
  await recordProviderMetric(redis,{provider:"SOLANA_RPC",endpoint:"getTokenSupply",service:"market-worker",priority:"P2",providerClass:"CRITICAL",event:"success",latencyMs:Date.now()-rpcStarted});
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
  // A wallet-first market mark exists to support a live position or a recent
  // qualified-wallet event.  Repricing a wallet's yesterday-old token on every
  // loop is neither event-driven nor useful, and was the primary source of
  // avoidable Jupiter/Birdeye spend.
  const since=new Date(Date.now()-2*60*60_000);
  dbReads+=3;
  const [positions,qualityWallets,signals]=await Promise.all([
    db.position.findMany({where:{chain:"SOLANA",status:{in:["OPEN","PARTIALLY_CLOSED"]}},select:{mint:true},take:2000}),
    db.smartWalletCandidate.findMany({where:{OR:[{stage:{in:["PAPER_TRACKING","PROVEN"]}},{adminWatched:true}]},select:{address:true,stage:true,source:true,metadata:true},take:1000}),
    db.signal.findMany({where:{chain:"SOLANA",action:"BUY",observedAt:{gte:since}},select:{outputMint:true,sourceWallet:true},orderBy:{observedAt:"desc"},take:1500})
  ]);
  const addresses=[...new Set(qualityWallets.map(w=>w.address))];
  if(addresses.length)dbReads++;
  const flows=addresses.length?await db.chainFlowObservation.findMany({
    where:{chain:"SOLANA",side:"BUY",walletAddress:{in:addresses},observedAt:{gte:since}},
    select:{mint:true,walletAddress:true,amountUsd:true,observedAt:true},orderBy:{observedAt:"desc"},take:2500
  }):[];
  const excluded=new Set([usdc,"So11111111111111111111111111111111111111112"]);
  const positionMints=[...new Set(positions.map(p=>p.mint))];
  const walletMints=[...new Set(flows.map(f=>f.mint))];
  const signalMints=[...new Set(signals.filter(s=>addresses.includes(s.sourceWallet)).map(s=>s.outputMint))];
  // P0: real positions can never be dropped. P1: tokens just bought by objectively tracked wallets.
  // P2: their source signals. Raw discoveryToken rows are deliberately NOT a pricing source anymore.
  const unique=[...new Set([...positionMints,...walletMints,...signalMints])].filter(m=>!excluded.has(m));
  const maxTracked=Math.max(positionMints.length,Math.max(25,Number(process.env.WALLET_FIRST_MARKET_MINT_LIMIT??80)));
  const mints=unique.slice(0,maxTracked),candidateByAddress=new Map(qualityWallets.map((w:any)=>[w.address,w]));
  const tokenRows=mints.length?await db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,metadata:true}}):[];
  const tokenByMint=new Map(tokenRows.map((t:any)=>[t.mint,t]));
  const deepEligible=new Set<string>();
  for(const mint of mints){
    const rows=flows.filter(f=>f.mint===mint),wallets=[...new Set(rows.map(f=>f.walletAddress))].map(a=>candidateByAddress.get(a)).filter(Boolean) as any[];
    const provenance=((tokenByMint.get(mint)?.metadata??{}) as any).tokenProvenance??classifyTokenProvenance({mint});
    if(deepResearchEligible({origin:provenance.origin,distinctQualifiedWallets:wallets.length,provenWallets:wallets.filter(w=>w.stage==="PROVEN").length,curatedWallets:wallets.filter(w=>["MEMECLOUD_CURATED","PLATFORM_ADDED"].includes(w.source)).length,memeWhales:wallets.filter(w=>(w.metadata as any)?.isMemeWhale).length,materialCapitalUsd:rows.reduce((n,r)=>n+Number(r.amountUsd??0),0),openPosition:positionMints.includes(mint)}))deepEligible.add(mint);
  }
  return {mints,openPositionMints:new Set(positionMints),deepEligible};
}

async function jupiterMark(mint:string){
  const meta=await tokenMeta(mint);
  const amountRaw=String(Math.round(quoteUsd*1_000_000));
  const started=Date.now();jupiterRequests++;
  await recordProviderMetric(redis,{provider:"JUPITER",endpoint:"quote",service:"market-worker",priority:"P2",providerClass:"CRITICAL",event:"request"});
  const q=await jupiter.quote({inputMint:usdc,outputMint:mint,amountRaw,slippageBps:1500});
  await recordProviderMetric(redis,{provider:"JUPITER",endpoint:"quote",service:"market-worker",priority:"P2",providerClass:"CRITICAL",event:"success",latencyMs:Date.now()-started});
  const tokens=Number(q.outAmount)/(10**meta.decimals);
  if(!Number.isFinite(tokens)||tokens<=0)throw new Error("INVALID_JUPITER_MARK");
  const priceUsd=quoteUsd/tokens,marketCapUsd=meta.supply>0?meta.supply*priceUsd:undefined;
  return {priceUsd,marketCapUsd,priceImpactPct:Math.abs(Number(q.priceImpactPct??0))};
}

async function chainFlowMetrics(mint:string){
  const since5=new Date(Date.now()-5*60_000),since1=new Date(Date.now()-60_000);
  const rows=await db.chainFlowObservation.findMany({where:{chain:"SOLANA",mint,observedAt:{gte:since5}},select:{side:true,amountUsd:true,walletAddress:true,observedAt:true}});
  return aggregateChainFlow(rows,since1);
}

// Real fallback when Birdeye isn't configured: no liquidity/holder data available (kept honestly
// at 0/null, never guessed), but price and buy/sell flow are genuine on-chain data already being
// collected, so Global Brain still has something real to score instead of nothing at all.
async function basicSnapshot(mint:string,j:{priceUsd:number;marketCapUsd?:number;priceImpactPct:number}){
  const m=await chainFlowMetrics(mint);
  const observedAt=new Date();
  const snap=await db.memeMarketSnapshot.create({data:{
    chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd:0,ageMinutes:-1,
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
  // Deep structure is not price data.  Cache one complete Birdeye enrichment
  // across all workers for fifteen minutes; intermediate marks still use the
  // executable Jupiter price and observed wallet flow without spending four
  // additional Birdeye calls.
  const richKey=`market:rich:SOLANA:${mint}`;
  redisReads++;if(await redis.get(richKey))return null;
  const [m,t,h,l]=await Promise.all([
    birdeye.marketData(mint),
    birdeye.tradeData(mint),
    birdeye.holderProfile(mint),
    birdeye.exitLiquidity(mint)
  ]);
  birdeyeRequests+=4;
  const x=birdeye.normalizeMarket(m,t,h,l);
  const tokenInfo=birdeye.normalizeToken(m);
  // Jupiter's actual executable mark is preferred for price. Birdeye provides the deeper context.
  const observedAt=new Date();
  const snap=await db.memeMarketSnapshot.create({data:{
    chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:x.marketCapUsd??j.marketCapUsd,liquidityUsd:Number(x.liquidityUsd??0),exitLiquidityUsd:x.exitLiquidityUsd,
    ageMinutes:Number(x.ageMinutes??-1),volume1mUsd:Number(x.volume1mUsd??0),volume5mUsd:Number(x.volume5mUsd??0),volume15mUsd:Number(x.volume15mUsd??0),
    volumeAcceleration1m:Number(x.volumeAcceleration1m??1),volumeAcceleration5m:Number(x.volumeAcceleration5m??1),
    buys1m:Number(x.buys1m??0),sells1m:Number(x.sells1m??0),buys5m:Number(x.buys5m??0),sells5m:Number(x.sells5m??0),
    buyVolume5mUsd:Number(x.buyVolume5mUsd??0),sellVolume5mUsd:Number(x.sellVolume5mUsd??0),
    uniqueBuyers1m:Number(x.uniqueBuyers1m??0),uniqueBuyers5m:Number(x.uniqueBuyers5m??0),uniqueSellers5m:Number(x.uniqueSellers5m??0),
    holderCount:x.holderCount,holderGrowth5mPct:x.holderGrowth5mPct,top10EffectivePct:x.top10EffectivePct,bundledSupplyPct:x.bundledSupplyPct,
    creatorHoldingPct:x.creatorHoldingPct,liquidityChange5mPct:x.liquidityChange5mPct,
    source:"JUPITER+BIRDEYE",provenance:{jupiter:{priceImpactPct:j.priceImpactPct},birdeye:{marketData:true,tradeData:true,holderProfile:true,exitLiquidity:true}},observedAt
  }});
  await redis.set(`meme:SOLANA:${mint}`,JSON.stringify(snap),"EX",45);
  await redis.set(richKey,"1","EX",15*60);
  await db.discoveryToken.upsert({where:{chain_mint:{chain:"SOLANA",mint}},update:{symbol:tokenInfo.symbol,name:tokenInfo.name,marketCapUsd:x.marketCapUsd??j.marketCapUsd,liquidityUsd:Number(x.liquidityUsd??0),tokenAgeMin:Number(x.ageMinutes??-1),lastSeenAt:observedAt},create:{chain:"SOLANA",mint,symbol:tokenInfo.symbol,name:tokenInfo.name,source:"WALLET_TRIGGERED",marketCapUsd:x.marketCapUsd??j.marketCapUsd,liquidityUsd:Number(x.liquidityUsd??0),tokenAgeMin:Number(x.ageMinutes??-1),discoveredAt:observedAt,lastSeenAt:observedAt}}).catch(()=>{});
  richUpdates++;
  return snap;
}

async function updateMint(mint:string,priority:"P0"|"P2",deep:boolean){
  try{
    const j=await jupiterMark(mint);
    const observedAt=new Date();
    let liquidityUsd:number|undefined;
    try{
      const rich=deep?await richSnapshot(mint,j):null;
      if(rich)liquidityUsd=rich.liquidityUsd;
      else await basicSnapshot(mint,j);
    }catch(e){enrichmentErrors++;console.error("[market-worker] enrichment",mint,e);await basicSnapshot(mint,j).catch(()=>{})}
    await db.marketPrice.create({data:{chain:"SOLANA",mint,priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd,source:birdeye?"JUPITER_EXECUTABLE+BIRDEYE":"JUPITER_EXECUTABLE_QUOTE",observedAt}});
    await redis.set(`price:SOLANA:${mint}`,JSON.stringify({priceUsd:j.priceUsd,marketCapUsd:j.marketCapUsd,liquidityUsd,source:"JUPITER_EXECUTABLE_QUOTE",observedAt:observedAt.toISOString()}),"EX",priority==="P0"?60:300);
    // An open position is deliberately repriced every tick for stop/exit safety.
    // A wallet-discovered research mint is due at most every five minutes unless a
    // new on-chain event clears this key. This is the quiet-day guarantee.
    if(priority!=="P0")await redis.set(`market:due:SOLANA:${mint}`,"1","EX",300);
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
  if(running&&Date.now()-runningSince<TICK_STALE_MS)return;running=true;runningSince=Date.now();
  try{
    await reloadConfig().catch(e=>console.error("[market-worker] config reload failed, keeping previous clients",e));
    const plan=await trackedMints();const mints=plan.mints;tracked=mints.length;
    const before={jupiter:jupiterRequests,rpc:rpcRequests,birdeye:birdeyeRequests};
    let cacheHits=0;
    const errorsBefore=quoteErrors;
    // Avoid bursting provider limits. Admin can run more workers later if the paid plan supports it.
    const batch=Math.max(1,Math.min(8,Number(process.env.MARKET_BATCH_SIZE??4)));
    for(let i=0;i<mints.length;i+=batch){
      await Promise.all(mints.slice(i,i+batch).map(async mint=>{
        const priority=plan.openPositionMints.has(mint)?"P0":"P2";
        if(priority!=="P0"){
          redisReads++;
          const dueCachePresent=Boolean(await redis.get(`market:due:SOLANA:${mint}`));
          if(!shouldRefreshMarketMint(false,dueCachePresent)){cacheHits++;return;}
        }
        await updateMint(mint,priority,plan.deepEligible.has(mint));
      }));
      await new Promise(r=>setTimeout(r,adaptiveDelayMs));
    }
    quietTickCacheHits=cacheHits;
    quietTickExternalRequests=(jupiterRequests-before.jupiter)+(rpcRequests-before.rpc)+(birdeyeRequests-before.birdeye);
    if(quoteErrors>errorsBefore)adaptiveDelayMs=Math.min(maxDelayMs,Math.round(adaptiveDelayMs*1.6));
    else adaptiveDelayMs=Math.max(baseDelayMs,Math.round(adaptiveDelayMs*0.85));
  }finally{running=false}
}
startHeartbeat("market-worker",()=>({tracked,updates,richUpdates,quoteErrors,enrichmentErrors,adaptiveDelayMs,richProvider:birdeye?"BIRDEYE":"NOT_CONFIGURED",running,
  jupiterRequests,rpcRequests,birdeyeRequests,quietTickExternalRequests,quietTickCacheHits,dbReads,redisReads,
  sharedRpcBudgetPriority:"P2",sharedRpcBudgetDenied:sharedBudgetDenied,
  lastSharedRpcBudgetDenyAgoSec:lastSharedBudgetDenyAt?Math.round((Date.now()-lastSharedBudgetDenyAt)/1000):null
}));
// This is a bounded position/wallet freshness loop, not a token-discovery
// sweep.  New mints enter only through watched-wallet observations above.
setInterval(()=>void tick(),Math.max(30_000,Number(process.env.MARKET_INTERVAL_MS??30_000)));
void tick();
console.log("[market-worker] running");
