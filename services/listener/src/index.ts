import { Connection, PublicKey } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { startHeartbeat } from "@memecloud/ops";
import { getConfig } from "@memecloud/config";
import { solanaRpcCandidates, pickHealthyRpc } from "@memecloud/shared";
import { classifySwap, shouldReconnect } from "./parsing.js";
import { persistWalletActivity, enrichPendingWalletTokens } from "./activity.js";
import { planSignatureReplay } from "./replay.js";
import {classifyTokenProvenance} from "@memecloud/discovery";

const marketCfg=await getConfig<any>("marketData");
const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[listener]");
// Rebuilt on every refreshWatchlist() cycle (see below) so an Admin RPC change takes effect
// without a manual restart — this was previously read once at process startup and cached forever.
let conn=new Connection(rpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const queue=new Queue("signals",{connection:redis});
const notificationQueue=new Queue("user-notifications",{connection:redis});
const subscriptions=new Map<string,number>();
let detected=0, decoded=0, errors=0;
// `conn.onLogs` websocket subscriptions have no built-in liveness/reconnect: a silent network
// drop (confirmed live -- this is exactly what happened in production: detected/decoded/errors
// all froze mid-run with no thrown error, no crash, nothing to make the process exit) leaves every
// subscription ID sitting in `subscriptions` forever with a dead underlying socket. refreshWatchlist
// only subscribes wallets NOT already in that map, so a silently-dead connection is never noticed
// or recovered on its own -- the heartbeat below kept reporting "healthy" throughout because it
// just reads these counters on its own independent timer, with no idea the actual event stream had
// stopped. lastEventAt/lastSlotAt below are the real liveness proof: lastEventAt only advances on
// an actual onLogs callback firing (proves wallet activity is genuinely reaching us), lastSlotAt
// advances on an independent getSlot() poll that runs regardless of wallet activity (proves the
// RPC connection itself is alive even during a genuine wallet-quiet stretch). Either going stale
// past SLOT_POLL_STALE_MS triggers a hard reconnect; a periodic unconditional reconnect on top of
// that is cheap insurance (~23 subscriptions) against any other silent-death mode this doesn't
// directly detect.
let lastEventAt=0,lastSlotAt=0,currentSlot=0,slotPollErrors=0,reconnects=0;
const SLOT_POLL_STALE_MS=90_000;
const FORCED_RECONNECT_MS=15*60_000;
// planSignatureReplay (replay.ts) already existed, fully tested, and was never actually wired up
// anywhere -- meaning every reconnect (whether from a config change, or the hard reconnect this
// session added for the silent-websocket-death case) was already silently losing whatever
// happened to a watched wallet during the gap before this fix: onLogs only fires for events after
// a subscription is (re-)established, never for what was missed while it was down. Cursor is
// process-lifetime, not persisted -- a full process restart baselines fresh rather than replaying
// (this matches replay.ts's own "baselines a newly verified wallet" behavior for an unknown
// cursor, and avoids ever guessing how far back a genuinely cold start should reach).
const lastSeenSignature=new Map<string,string>();
let replays=0,replayFailures=0;
// Detection latency: how long after a swap actually landed on chain did MemeCloud durably record
// it. Measured from the transaction's own blockTime, so it includes RPC delivery, fetch and write.
// A bounded ring buffer keeps this free -- no extra storage, no provider calls.
const detectionLatencies:number[]=[];
function recordDetectionLatency(blockTimeSec?:number|null){
  if(!blockTimeSec)return;
  const ms=Date.now()-blockTimeSec*1000;
  if(ms<0||ms>15*60_000)return; // replayed/backfilled history is not a live detection measurement
  detectionLatencies.push(ms);
  if(detectionLatencies.length>500)detectionLatencies.shift();
}
function latencyStats(){
  if(!detectionLatencies.length)return {samples:0,medianMs:null,p95Ms:null};
  const a=[...detectionLatencies].sort((x,y)=>x-y);
  const q=(p:number)=>a[Math.min(a.length-1,Math.floor(a.length*p))];
  return {samples:a.length,medianMs:q(0.5),p95Ms:q(0.95)};
}
async function replayMissedSignatures(traderId:string,address:string,pubkey:PublicKey){
  const cursor=lastSeenSignature.get(address);
  if(!cursor)return;
  try{
    const plan=await planSignatureReplay(
      async(before,limit)=>conn.getSignaturesForAddress(pubkey,{before,limit},"confirmed"),
      cursor
    );
    if(!plan.complete){
      // Fails closed by design (see replay.ts) rather than guessing across an unbounded gap --
      // logged so a genuinely long outage is visible, not silently accepted as "nothing missed".
      console.warn("[listener] replay incomplete for",address,"- gap too large or cursor not found; resuming from current activity only");
      return;
    }
    for(const sig of plan.signatures){
      await handleSignature(traderId,address,sig.signature).catch(e=>{errors++;console.error("[listener] replay tx error",sig.signature,e)});
      lastSeenSignature.set(address,sig.signature);
    }
    if(plan.signatures.length)replays+=plan.signatures.length;
  }catch(e){replayFailures++;console.error("[listener] replay failed",address,e)}
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
  detected++;lastEventAt=Date.now();
  const existing=await db.sourceTransaction.findUnique({where:{chain_txHash_walletAddress:{chain:"SOLANA",txHash:signature,walletAddress:wallet}}});
  if(existing){
    await persistWalletActivity(traderId,wallet,signature,existing.rawJson as any);
    return;
  }
  const tx=await fetchParsedTransactionWithRetry(signature);
  if(!tx||tx.meta?.err){if(!tx)errors++;return;}

  recordDetectionLatency(tx.blockTime);
  await persistWalletActivity(traderId,wallet,signature,tx);
  await db.sourceTransaction.upsert({
    where:{chain_txHash_walletAddress:{chain:"SOLANA",txHash:signature,walletAddress:wallet}},update:{},
    create:{chain:"SOLANA",txHash:signature,walletAddress:wallet,slot:BigInt(tx.slot),blockTime:tx.blockTime?new Date(tx.blockTime*1000):null,rawJson:JSON.parse(JSON.stringify(tx))}
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
  await db.chainFlowObservation.create({data:{chain:"SOLANA",mint:tokenMint,walletAddress:wallet,txHash:signature,side:swap.action,amountUsd:swap.amountUsd,knownWallet:true,source:"WATCHED_WALLET_LISTENER",walletBalanceUsd:capitalFresh?Number(capital.walletBalanceUsd??0):undefined,walletTier:capitalFresh&&capital.isMemeWhale?capital.whaleTier??"WHALE_MEME_VERIFIED":undefined,observedAt}}).catch((e:any)=>{if(e?.code!=="P2002")throw e});
  // A new monitored-wallet transaction is the event that makes this mint due
  // immediately. The market worker otherwise keeps its five-minute quiet cache.
  await redis.del(`market:due:SOLANA:${tokenMint}`).catch(()=>{});
  // A token record exists only because a monitored wallet touched it. This is metadata for the
  // wallet-triggered research pipeline, not a resurrection of broad New Token Radar scanning.
  const tokenProvenance=classifyTokenProvenance({mint:tokenMint});
  await db.discoveryToken.upsert({where:{chain_mint:{chain:"SOLANA",mint:tokenMint}},update:{lastSeenAt:observedAt},create:{chain:"SOLANA",mint:tokenMint,source:"WALLET_TRIGGERED",discoveredAt:observedAt,lastSeenAt:observedAt,metadata:{firstSourceWallet:wallet,firstSourceTx:signature,tokenProvenance,provenanceObservedAt:observedAt.toISOString(),migrationStatus:"UNKNOWN"}}}).catch(()=>{});
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
  // Wallet-first v1: the forward-observation and paper-trading queues existed only to build
  // promotion evidence for the retired candidate lifecycle. Their sole consumer (scoring-worker)
  // is retired, so enqueuing here would just accumulate Redis jobs and spend Jupiter quotes on
  // paper trades nothing reads. Admin curation replaces promotion evidence entirely.
}

let currentRpcHost=new URL(rpc).host;
// Tears down every subscription and opens a fresh Connection so a silently-dead websocket can't
// keep masquerading as subscribed forever. Safe to call anytime: refreshWatchlist's normal 30s
// cycle repopulates `subscriptions` from scratch immediately afterward.
async function hardReconnect(reason:string){
  reconnects++;
  console.warn("[listener] hard reconnect:",reason);
  for(const [,id] of subscriptions)await conn.removeOnLogsListener(id).catch(()=>{});
  subscriptions.clear();
  const fresh=await getConfig<any>("marketData").catch(()=>null);
  const freshRpc=fresh?await pickHealthyRpc(solanaRpcCandidates(fresh),"[listener]").catch(()=>rpc):rpc;
  conn=new Connection(freshRpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
  currentRpcHost=new URL(freshRpc).host;
  lastSlotAt=0;
}
let lastForcedReconnectAt=Date.now();
// A truly dead connection can hang getSlot() forever rather than reject it -- an unbounded await
// here would mean this very staleness check never gets a chance to run again on this interval
// firing, silently defeating the whole recovery path. The timeout guarantees this function always
// reaches the staleness check below within a bounded time, whichever way the poll resolves.
function withTimeout<T>(p:Promise<T>,ms:number):Promise<T>{
  return Promise.race([p,new Promise<T>((_,rej)=>setTimeout(()=>rej(new Error("slot poll timed out")),ms))]);
}
async function pollSlotLiveness(){
  try{
    currentSlot=await withTimeout(conn.getSlot("confirmed"),10_000);
    lastSlotAt=Date.now();
  }catch(e){
    slotPollErrors++;
    console.error("[listener] slot poll failed",(e as any)?.message??e);
  }
  const now=Date.now();
  const decision=shouldReconnect({now,lastSlotAt,lastForcedReconnectAt,slotStaleMs:SLOT_POLL_STALE_MS,forcedIntervalMs:FORCED_RECONNECT_MS});
  if(decision.reconnect){
    lastForcedReconnectAt=now;
    await hardReconnect(decision.reason!).catch(e=>console.error("[listener] reconnect failed",e));
  }
}
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
  // Wallet-first v1: ONLY Admin-added, verified Solana wallets on enabled PLATFORM traders
  // are platform signal sources. User-added public wallets and auto-discovered candidates never
  // enter the platform-wide listener.
  const wallets=await db.traderWallet.findMany({
    where:{chain:"SOLANA",verified:true,source:"ADMIN",trader:{kind:"PLATFORM",enabled:true}},
    include:{trader:true}
  });
  const wanted=new Set(wallets.map(w=>w.address));
  for(const [address,id] of subscriptions){
    if(!wanted.has(address)){await conn.removeOnLogsListener(id).catch(()=>{});subscriptions.delete(address);}
  }
  for(const tw of wallets){
    if(subscriptions.has(tw.address))continue;
    try{
      const pubkey=new PublicKey(tw.address);
      const id=conn.onLogs(pubkey,async logs=>{
        lastSeenSignature.set(tw.address,logs.signature);
        try{await handleSignature(tw.traderId,tw.address,logs.signature);}
        catch(e){errors++;console.error("[listener] tx error",logs.signature,e);}
      },"confirmed");
      subscriptions.set(tw.address,id);
      console.log("[listener] watching admin trader",tw.trader.handle,tw.address);
      if(lastSeenSignature.has(tw.address)) await replayMissedSignatures(tw.traderId,tw.address,pubkey);
      else {
        const [newest]=await conn.getSignaturesForAddress(pubkey,{limit:1},"confirmed").catch(()=>[]);
        if(newest)lastSeenSignature.set(tw.address,newest.signature);
      }
    }catch(e){errors++;console.error("[listener] invalid admin wallet",tw.address,e);}
  }
}

startHeartbeat("solana-listener",()=>({subscriptions:subscriptions.size,detected,decoded,errors,rpc:currentRpcHost,lastEventAt:lastEventAt?new Date(lastEventAt).toISOString():null,lastSlotAt:lastSlotAt?new Date(lastSlotAt).toISOString():null,currentSlot,slotPollErrors,reconnects,replays,replayFailures,detectionLatency:latencyStats()}));
await refreshWatchlist();
setInterval(()=>refreshWatchlist().catch(e=>{errors++;console.error(e)}),30_000);
setInterval(()=>void pollSlotLiveness(),20_000);void pollSlotLiveness();
console.log("[listener] running");

setInterval(()=>void enrichPendingWalletTokens().catch(e=>console.error("[listener] metadata backfill",e)),30_000);
