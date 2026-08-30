import { Connection, PublicKey } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { startHeartbeat } from "@memecloud/ops";
import { getConfig } from "@memecloud/config";
import { solanaRpcCandidates, pickHealthyRpc } from "@memecloud/shared";
import { classifySwap } from "./parsing.js";

const marketCfg=await getConfig<any>("marketData");
const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[listener]");
// Rebuilt on every refreshWatchlist() cycle (see below) so an Admin RPC change takes effect
// without a manual restart — this was previously read once at process startup and cached forever.
let conn=new Connection(rpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const queue=new Queue("signals",{connection:redis});
const forwardScheduleQueue=new Queue("discovery-forward-schedule",{connection:redis});
const paperQueue=new Queue("discovery-paper",{connection:redis});
const subscriptions=new Map<string,number>();
let detected=0, decoded=0, errors=0;

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
  const signal=await db.signal.upsert({
    where:{idempotencyKey},update:{},
    create:{
      idempotencyKey,chain:"SOLANA",traderId,sourceWallet:wallet,sourceTx:signature,action:swap.action,
      inputMint:swap.inputMint,outputMint:swap.outputMint,inputRaw:swap.inputRaw,outputRaw:swap.outputRaw,
      sourcePriceUsd:swap.sourcePriceUsd,sourcePriceMethod:swap.sourcePriceUsd?"TX_USDC_RATIO":undefined,sourceTokenBalanceBeforeRaw:swap.sourceTokenBalanceBeforeRaw,
      sourceTokenBalanceAfterRaw:swap.sourceTokenBalanceAfterRaw,sourceSoldPct:swap.sourceSoldPct,observedAt:tx.blockTime?new Date(tx.blockTime*1000):new Date()
    }
  });
  await queue.add("source-signal",{signalId:signal.id},{jobId:signal.id,attempts:5,backoff:{type:"exponential",delay:500},removeOnComplete:1000});
  const trader=await db.trader.findUnique({where:{id:traderId},select:{trackingStatus:true}});
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
async function refreshWatchlist(){
  await reconnectIfConfigChanged();
  // Watch every enabled verified source wallet ONCE. Fan-out happens downstream per user.
  // This also lets the platform track public trader history before a user enables Auto Copy.
  const wallets=await db.traderWallet.findMany({
    where:{
      verified:true,
      OR:[
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
}
startHeartbeat("solana-listener",()=>({subscriptions:subscriptions.size,detected,decoded,errors,rpc:currentRpcHost}));
await refreshWatchlist();
setInterval(()=>refreshWatchlist().catch(e=>{errors++;console.error(e)}),30_000);
console.log("[listener] running");
