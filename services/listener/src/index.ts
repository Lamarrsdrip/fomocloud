import { Connection, PublicKey } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { startHeartbeat } from "@memecloud/ops";
import { getConfig } from "@memecloud/config";
import { solanaRpcCandidates, pickHealthyRpc, RpcBudget, recordProviderMetric } from "@memecloud/shared";
import { classifySwap } from "./parsing.js";

const marketCfg=await getConfig<any>("marketData");
const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[listener]");
// Rebuilt on every refreshWatchlist() cycle (see below) so an Admin RPC change takes effect
// without a manual restart — this was previously read once at process startup and cached forever.
let conn=new Connection(rpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const capitalRpcBudget=new RpcBudget(redis,"rpc-budget:solana",{capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))});
const USDC_MINT=new PublicKey(process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const queue=new Queue("signals",{connection:redis});
const notificationQueue=new Queue("user-notifications",{connection:redis});
const forwardScheduleQueue=new Queue("discovery-forward-schedule",{connection:redis});
const paperQueue=new Queue("discovery-paper",{connection:redis});
const subscriptions=new Map<string,number>();
let detected=0, decoded=0, errors=0;
let capitalSnapshots=0,capitalSnapshotErrors=0,lastCapitalSnapshotAt=0;

function conservativeWhaleTier(usdcLowerBound:number){
  if(usdcLowerBound>=10_000_000)return "WHALE_10M";if(usdcLowerBound>=2_000_000)return "WHALE_2M";if(usdcLowerBound>=1_000_000)return "WHALE_1M";if(usdcLowerBound>=100_000)return "WHALE_100K";if(usdcLowerBound>=50_000)return "WHALE_50K";return null;
}
async function refreshOneCapitalSnapshot(){
  if(Date.now()-lastCapitalSnapshotAt<60_000)return;
  const staleBefore=new Date(Date.now()-6*3600_000).toISOString();
  const candidates=await db.smartWalletCandidate.findMany({where:{chain:"SOLANA",OR:[{adminWatched:true},{stage:"PROVEN"}]},orderBy:{updatedAt:"asc"},take:200});
  const candidate=candidates.find(c=>{const m=(c.metadata??{}) as any;return !m.walletBalanceObservedAt||m.walletBalanceObservedAt<staleBefore});
  if(!candidate)return;
  const granted=await capitalRpcBudget.tryAcquire("P1");if(!granted.granted)return;
  lastCapitalSnapshotAt=Date.now();const started=Date.now();
  try{
    await recordProviderMetric(redis,{provider:"SOLANA_RPC",endpoint:"getTokenAccountsByOwner:USDC",service:"listener",priority:"P1",providerClass:"CRITICAL",event:"request"});
    const accounts=await conn.getParsedTokenAccountsByOwner(new PublicKey(candidate.address),{mint:USDC_MINT},"confirmed");
    const usdcLowerBound=accounts.value.reduce((sum,a)=>sum+Number((a.account.data as any)?.parsed?.info?.tokenAmount?.uiAmountString??0),0);
    await recordProviderMetric(redis,{provider:"SOLANA_RPC",endpoint:"getTokenAccountsByOwner:USDC",service:"listener",priority:"P1",providerClass:"CRITICAL",event:"success",latencyMs:Date.now()-started});
    const prior=(candidate.metadata??{}) as any,observedAt=new Date().toISOString();
    await db.smartWalletCandidate.update({where:{id:candidate.id},data:{metadata:{...prior,walletBalanceUsd:usdcLowerBound,walletBalanceObservedAt:observedAt,walletBalanceSource:"WALLET_CAPITAL_SNAPSHOT:SOLANA_USDC_LOWER_BOUND",walletCapitalSnapshotScope:"USDC_ONLY_CONSERVATIVE_LOWER_BOUND",whaleTier:conservativeWhaleTier(usdcLowerBound)}}});capitalSnapshots++;
  }catch(e){capitalSnapshotErrors++;await recordProviderMetric(redis,{provider:"SOLANA_RPC",endpoint:"getTokenAccountsByOwner:USDC",service:"listener",priority:"P1",providerClass:"CRITICAL",event:"error"}).catch(()=>{});console.error("[listener] capital snapshot",candidate.address,e)}
}

// tokenDeltas/ownerMintBalanceRaw/classifySwap moved to ./parsing.ts so they're testable without
// triggering this file's top-level side effects (config fetch, RPC connection, Redis/BullMQ
// queues) on import.

async function fetchParsedTransactionWithRetry(signature:string){
  const waits=[0,120,300,700];
  for(const wait of waits){
    if(wait) await new Promise(r=>setTimeout(r,wait));
    const tx=await conn.getParsedTransaction(signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
    if(tx) return tx;
  }
  return null;
}

async function handleSignature(traderId:string,wallet:string,signature:string){
  detected++;
  const existing=await db.sourceTransaction.findUnique({where:{chain_txHash_walletAddress:{chain:"SOLANA",txHash:signature,walletAddress:wallet}}});
  if(existing) return;
  const tx=await fetchParsedTransactionWithRetry(signature);
  if(!tx||tx.meta?.err){if(!tx)errors++;return;}

  await db.sourceTransaction.create({
    data:{chain:"SOLANA",txHash:signature,walletAddress:wallet,slot:BigInt(tx.slot),blockTime:tx.blockTime?new Date(tx.blockTime*1000):null,rawJson:JSON.parse(JSON.stringify(tx))}
  });

  const swap=classifySwap(tx,wallet);
  if(!swap) return;
  decoded++;
  const tokenMint=swap.action==="BUY"?swap.outputMint:swap.inputMint;
  const idempotencyKey=crypto.createHash("sha256").update(["SOLANA",signature,wallet,tokenMint,swap.action].join(":")).digest("hex");
  // Wallet-first source of truth: persist flow only for wallets we explicitly monitor. This replaces
  // the old chain-wide all-logs firehose for normal production, while preserving the exact flow rows
  // Brain/market/scoring already consume.
  const observedAt=tx.blockTime?new Date(tx.blockTime*1000):new Date();
  const capitalCandidate=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:wallet}},select:{metadata:true}}).catch(()=>null);
  const capital=(capitalCandidate?.metadata??{}) as any;
  const capitalFresh=capital.walletBalanceObservedAt&&Date.now()-new Date(capital.walletBalanceObservedAt).getTime()<7*24*3600_000&&String(capital.walletBalanceSource??"").startsWith("WALLET_CAPITAL_SNAPSHOT:");
  await db.chainFlowObservation.create({data:{chain:"SOLANA",mint:tokenMint,walletAddress:wallet,txHash:signature,side:swap.action,amountUsd:swap.amountUsd,knownWallet:true,source:"WATCHED_WALLET_LISTENER",walletBalanceUsd:capitalFresh?Number(capital.walletBalanceUsd??0):undefined,walletTier:capitalFresh?capital.whaleTier??undefined:undefined,observedAt}}).catch((e:any)=>{if(e?.code!=="P2002")throw e});
  // A new monitored-wallet transaction is the event that makes this mint due
  // immediately. The market worker otherwise keeps its five-minute quiet cache.
  await redis.del(`market:due:SOLANA:${tokenMint}`).catch(()=>{});
  // A token record exists only because a monitored wallet touched it. This is metadata for the
  // wallet-triggered research pipeline, not a resurrection of broad New Token Radar scanning.
  await db.discoveryToken.upsert({where:{chain_mint:{chain:"SOLANA",mint:tokenMint}},update:{lastSeenAt:observedAt},create:{chain:"SOLANA",mint:tokenMint,source:"WALLET_TRIGGERED",discoveredAt:observedAt,lastSeenAt:observedAt,metadata:{firstSourceWallet:wallet,firstSourceTx:signature}}}).catch(()=>{});
  const signal=await db.signal.upsert({
    where:{idempotencyKey},update:{},
    create:{
      idempotencyKey,chain:"SOLANA",traderId,sourceWallet:wallet,sourceTx:signature,action:swap.action,
      inputMint:swap.inputMint,outputMint:swap.outputMint,inputRaw:swap.inputRaw,outputRaw:swap.outputRaw,
      sourcePriceUsd:swap.sourcePriceUsd,sourcePriceMethod:swap.sourcePriceUsd?"TX_USDC_RATIO":undefined,sourceTokenBalanceBeforeRaw:swap.sourceTokenBalanceBeforeRaw,
      sourceTokenBalanceAfterRaw:swap.sourceTokenBalanceAfterRaw,sourceSoldPct:swap.sourceSoldPct,observedAt
    }
  });
  await queue.add("source-signal",{signalId:signal.id},{jobId:signal.id,attempts:5,backoff:{type:"exponential",delay:500},removeOnComplete:1000});
  const trader=await db.trader.findUnique({where:{id:traderId},select:{trackingStatus:true,displayName:true,handle:true}});
  if(swap.action==="BUY"&&trader?.trackingStatus==="PROVEN"){
    const candidate=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:wallet}},select:{copyabilityScore:true,riskScore:true,metadata:true}}).catch(()=>null);
    const meta=(candidate?.metadata??{}) as any;
    const skill=Number(meta?.skillScore??candidate?.copyabilityScore??0);
    const elite=skill>=90&&Number(candidate?.riskScore??100)<=30&&Number(meta?.evidenceCompleteness??0)>=85&&Number(meta?.currentFormScore??0)>=60;
    const tier=elite?"Elite":"Proven";
    const users=await db.user.findMany({where:{status:"ACTIVE"},select:{id:true,notificationPrefs:true}});
    const token=tokenMint;
    const title=`${tier} wallet bought a token`;
    const body=`${trader.displayName||trader.handle||wallet} (${wallet}) bought ${token}. MemeCloud Brain is researching it now.`;
    for(const u of users){
      if(u.notificationPrefs?.pushEnabled===false)continue;
      const deliveryKey=`proven-wallet:${signature}:${wallet}:${u.id}`;
      await db.userActivityEvent.create({data:{userId:u.id,type:"SMART_WALLET_BUY",title,body,data:{chain:"SOLANA",mint:token,walletAddress:wallet,sourceTx:signature,tier,skill} as any}}).catch(()=>null);
      await notificationQueue.add("notify",{userId:u.id,type:"SMART_WALLET_BUY",title,body,data:{url:"/app/?view=discover",chain:"SOLANA",mint:token,walletAddress:wallet},deliveryKey},{jobId:deliveryKey,removeOnComplete:2000,attempts:3,backoff:{type:"exponential",delay:500}}).catch(()=>{});
    }
  }
  if(swap.action==="BUY" && trader && ["PAPER_TRACKING","PROVEN"].includes(trader.trackingStatus)){
    await forwardScheduleQueue.add("schedule",{signalId:signal.id},{jobId:`forward:${signal.id}`,removeOnComplete:1000});
    await paperQueue.add("paper",{signalId:signal.id},{jobId:`paper:${signal.id}`,removeOnComplete:1000,attempts:4,backoff:{type:"exponential",delay:1000}});
  }
}

let currentRpcHost=new URL(rpc).host;
async function reconnectIfConfigChanged(){
  const fresh=await getConfig<any>("marketData");
  // Re-running the real health probe here (not just re-reading the raw config) means this also
  // self-heals: once a failed-over primary (e.g. Helius) recovers, the next check picks it again
  // automatically, same as reconnecting to a genuine Admin-edited RPC URL.
  const freshRpc=await pickHealthyRpc(solanaRpcCandidates(fresh),"[listener]");
  const freshHost=new URL(freshRpc).host;
  if(freshHost===currentRpcHost)return;
  console.log("[listener] RPC changed (Admin edit or automatic failover)",currentRpcHost,"->",freshHost,"— reconnecting");
  for(const [,id] of subscriptions)await conn.removeOnLogsListener(id).catch(()=>{});
  subscriptions.clear();
  conn=new Connection(freshRpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
  currentRpcHost=freshHost;
}
async function ensureObservationTrader(){
  return db.trader.upsert({where:{handle:"memecloud-observation"},update:{enabled:false,trackingStatus:"WATCH_ONLY"},create:{handle:"memecloud-observation",displayName:"MemeCloud Observation",bio:"Internal public-wallet observation source. Not copy-eligible.",category:"SMART_MONEY_OBSERVATION",verification:"UNVERIFIED",kind:"PLATFORM",enabled:false,featured:false,recommended:false,defaultSelected:false,trackingStatus:"WATCH_ONLY"}});
}

async function refreshWatchlist(){
  await reconnectIfConfigChanged();
  // Watch every enabled verified source wallet ONCE. Fan-out happens downstream per user.
  // This also lets the platform track public trader history before a user enables Auto Copy.
  const observationTrader=await ensureObservationTrader();
  const profileLimit=Math.max(25,Math.min(300,Number(process.env.WALLET_PROFILE_WATCH_LIMIT??150)));
  const [adminCandidates,profilingCandidates]=await Promise.all([
    db.smartWalletCandidate.findMany({where:{chain:"SOLANA",adminWatched:true},select:{address:true}}),
    db.smartWalletCandidate.findMany({where:{chain:"SOLANA",stage:"ANALYZING",adminWatched:false},orderBy:[{sourceQualityScore:"desc"},{lastScoredAt:"desc"}],take:profileLimit,select:{address:true}})
  ]);
  const observationAddresses=[...new Set([...adminCandidates.map(c=>c.address),...profilingCandidates.map(c=>c.address)])];
  for(const address of observationAddresses){
    const isAdmin=adminCandidates.some(c=>c.address===address);
    await db.traderWallet.upsert({where:{chain_address:{chain:"SOLANA",address}},update:{},create:{traderId:observationTrader.id,chain:"SOLANA",address,verified:true,source:isAdmin?"ADMIN_WATCHLIST":"OBJECTIVE_PROFILING",verificationMethod:"PUBLIC_CHAIN_ADDRESS",evidenceNote:"Public wallet observed for objective scoring. Identity is not asserted and observation grants no copy authority.",verifiedAt:new Date(),monitoringStatus:"WATCH_ONLY"}}).catch(()=>{});
  }
  const observationAddressSet=new Set(observationAddresses);
  const staleObservationWallets=await db.traderWallet.findMany({where:{traderId:observationTrader.id},select:{id:true,address:true}});
  for(const w of staleObservationWallets)if(!observationAddressSet.has(w.address))await db.traderWallet.delete({where:{id:w.id}}).catch(()=>{});
  const wallets=await db.traderWallet.findMany({
    where:{
      verified:true,
      OR:[
        {monitoringStatus:"WATCH_ONLY"},
        {trader:{trackingStatus:{in:["PAPER_TRACKING","PROVEN"]}}},
        {trader:{enabled:true,OR:[{kind:"PLATFORM"},{kind:"CUSTOM",follows:{some:{}}}]}}
      ]
    },
    include:{trader:true}
  });
  const wanted=new Set(wallets.map(w=>w.address));
  for(const [address,id] of subscriptions){
    if(!wanted.has(address)){await conn.removeOnLogsListener(id);subscriptions.delete(address);}
  }
  for(const tw of wallets){
    if(tw.chain!=="SOLANA"||subscriptions.has(tw.address)) continue;
    try{
      const pubkey=new PublicKey(tw.address);
      const id=conn.onLogs(pubkey,async logs=>{
        try{await handleSignature(tw.traderId,tw.address,logs.signature);}
        catch(e){errors++;console.error("[listener] tx error",logs.signature,e);}
      },"confirmed");
      subscriptions.set(tw.address,id);
      console.log("[listener] watching",tw.trader.handle,tw.address);
    }catch(e){errors++;console.error("[listener] invalid wallet",tw.address,e);}
  }
  await refreshOneCapitalSnapshot();
}
startHeartbeat("solana-listener",()=>({subscriptions:subscriptions.size,detected,decoded,errors,rpc:currentRpcHost,capitalSnapshots,capitalSnapshotErrors,capitalSnapshotMethod:"USDC_ONLY_CONSERVATIVE_LOWER_BOUND"}));
await refreshWatchlist();
setInterval(()=>refreshWatchlist().catch(e=>{errors++;console.error(e)}),30_000);
console.log("[listener] running");
