import {Connection,PublicKey} from "@solana/web3.js";
import {Queue,Worker} from "bullmq";
import {Redis} from "ioredis";
import {db} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {JupiterExecution} from "@memecloud/execution";
import {walletTier} from "@memecloud/brain";
import {RpcBudget,solanaRpcCandidates,pickHealthyRpc} from "@memecloud/shared";
import {FLOW_INGESTION_ATTEMPTS,FLOW_PROCESSING_STALE_MS,shouldQueue,terminalAfterFailure} from "./ingestion.js";
import {ownerDeltas} from "./parsing.js";

// Chain-wide discovery is deliberately lower priority than live positions/execution. That must
// mean "wait in a durable queue", never "discard the signature". Redis gives the queue durable
// retry semantics and ChainIngestionEvent remains the cross-restart audit/recovery source of truth.
const rpcRedis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const ingestionQueue=new Queue<{eventId:string}>("chain-signature-ingestion",{connection:rpcRedis});
const sharedRpcBudget=new RpcBudget(rpcRedis,"rpc-budget:solana",{
  capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),
  ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))
});

const USDC=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL="So11111111111111111111111111111111111111112";
const quotes=new Set([USDC,USDT,WSOL]);
const RATE_PER_SEC=Math.max(1,Number(process.env.FLOW_SCANNER_MAX_RPS??10));
const FLOW_QUEUE_PRIORITY=4;
const FLOW_PROCESS_CONCURRENCY=Math.max(1,Number(process.env.FLOW_SCANNER_CONCURRENCY??8));

let received=0,seen=0,swaps=0,saved=0,profiled=0,errors=0,inflight=0,reconnects=0,lastEventAt=Date.now();
let rateLimited=false,lastRateLimitAt:number|null=null,lastSuccessfulRpcAt:number|null=null,lastParsedSwapAt:number|null=null,lastDbWriteAt:number|null=null;
let persistedEvents=0,queueFailures=0,recovered=0,terminalFailures=0,sharedBudgetDenied=0,lastSharedBudgetDenyAt:number|null=null,lastKnownTokensRemaining:number|null=null;
let backlog={queued:0,retrying:0,processing:0,terminal:0,oldestAgeSec:null as number|null};

function isRateLimitError(e:unknown):boolean{return /429|too many requests|rate.?limit/i.test(String((e as any)?.message??e??""));}
function message(e:unknown):string{return String((e as any)?.message??e??"UNKNOWN_ERROR").slice(0,1000)}
function isUniqueError(e:unknown):boolean{return (e as any)?.code==="P2002"}
class RetryableIngestionError extends Error {}

let solUsd=0,solAt=0;
async function solPrice(jupiter:JupiterExecution){
  if(solUsd&&Date.now()-solAt<15_000)return solUsd;
  const q=await jupiter.quote({inputMint:WSOL,outputMint:USDC,amountRaw:"1000000000",slippageBps:100});
  solUsd=Number(q.outAmount)/1e6;solAt=Date.now();return solUsd;
}
async function stableAndNativeBalance(conn:Connection,jupiter:JupiterExecution,owner:string){
  let usd=0;
  try{usd+=(await conn.getBalance(new PublicKey(owner),"confirmed"))/1e9*await solPrice(jupiter)}catch{}
  for(const mint of [USDC,USDT])try{
    const rows=await conn.getParsedTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)},"confirmed");
    for(const row of rows.value)usd+=Number((row.account.data as any).parsed?.info?.tokenAmount?.uiAmount??0);
  }catch{}
  return usd;
}

async function markRetry(eventId:string,error:unknown){
  await db.chainIngestionEvent.updateMany({where:{id:eventId,status:{in:["SEEN","QUEUED","PROCESSING","RETRYING"]}},data:{status:"RETRYING",lastError:message(error),processingAt:null}});
}
async function enqueuePersistedEvent(eventId:string,priority=FLOW_QUEUE_PRIORITY){
  await ingestionQueue.add("parse-flow-signature",{eventId},{jobId:eventId,priority,attempts:FLOW_INGESTION_ATTEMPTS,backoff:{type:"exponential",delay:1_000},removeOnComplete:20_000,removeOnFail:20_000});
  await db.chainIngestionEvent.updateMany({where:{id:eventId,status:{in:["SEEN","QUEUED","RETRYING"]}},data:{status:"QUEUED",queuedAt:new Date(),lastError:null}});
}

// Receipt is persisted/queued before any provider work. A duplicate WebSocket delivery only
// increments receivedCount; it cannot produce a second parsed transaction.
async function captureSignature(signature:string){
  received++;lastEventAt=Date.now();
  try{
    const event=await db.chainIngestionEvent.upsert({
      where:{chain_signature_source:{chain:"SOLANA",signature,source:"SOLANA_ALL_LOGS"}},
      create:{chain:"SOLANA",signature,source:"SOLANA_ALL_LOGS",status:"SEEN",priority:FLOW_QUEUE_PRIORITY,receivedAt:new Date()},
      update:{receivedCount:{increment:1}}
    });
    persistedEvents++;
    if(!shouldQueue(event.status))return;
    try{await enqueuePersistedEvent(event.id,event.priority)}catch(e){
      queueFailures++;await markRetry(event.id,e).catch(()=>{});
      console.error("[flow-worker] persisted signature could not be queued",signature,e);
    }
  }catch(e){
    // If both Mongo and Redis are unavailable, no process can durably accept a new log. This is
    // deliberately loud/metric-visible rather than silently pretending the event was sampled.
    errors++;queueFailures++;console.error("[flow-worker] signature receipt persistence failed",signature,e);
  }
}

let conn:Connection,jupiter:JupiterExecution,dedupeSubs:number[]=[],MAX=12,enabled=true,currentRpcHost="",brainCfg:any;

async function persistObservation(data:{mint:string;walletAddress:string;txHash:string;side:"BUY"|"SELL";amountUsd?:number;walletBalanceUsd?:number;walletTier:string;knownWallet:boolean;observedAt:Date}){
  try{
    await db.chainFlowObservation.create({data:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",...data}});
    saved++;lastDbWriteAt=Date.now();
  }catch(e){if(!isUniqueError(e))throw e;}
}

async function processIngestionEvent(eventId:string){
  const claim=await db.chainIngestionEvent.updateMany({where:{id:eventId,status:{in:["SEEN","QUEUED","RETRYING"]}},data:{status:"PROCESSING",processingAt:new Date(),attemptCount:{increment:1},lastError:null}});
  if(!claim.count)return; // already persisted, terminal, or owned by another worker.
  inflight++;seen++;
  try{
    const event=await db.chainIngestionEvent.findUniqueOrThrow({where:{id:eventId},select:{signature:true}});
    const budget=await sharedRpcBudget.tryAcquire("P4");
    lastKnownTokensRemaining=budget.tokensRemaining;
    if(!budget.granted){sharedBudgetDenied++;lastSharedBudgetDenyAt=Date.now();throw new RetryableIngestionError("SHARED_RPC_BUDGET_DENIED");}
    const tx=await conn.getParsedTransaction(event.signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
    lastSuccessfulRpcAt=Date.now();rateLimited=false;
    if(!tx)throw new RetryableIngestionError("TRANSACTION_NOT_YET_AVAILABLE");
    await db.chainIngestionEvent.update({where:{id:eventId},data:{status:"PARSED",parsedAt:new Date()}});
    if(!tx.meta?.err){
      for(const [owner,deltas] of ownerDeltas(tx)){
        const positive=[...deltas.entries()].filter(([,value])=>value.raw>0n),negative=[...deltas.entries()].filter(([,value])=>value.raw<0n);
        const spent=negative.find(([mint])=>quotes.has(mint)),got=positive.find(([mint])=>!quotes.has(mint));
        const receivedQuote=positive.find(([mint])=>quotes.has(mint)),sold=negative.find(([mint])=>!quotes.has(mint));
        let side:"BUY"|"SELL"|null=null,mint="",quote:any;
        if(spent&&got){side="BUY";mint=got[0];quote=spent}else if(receivedQuote&&sold){side="SELL";mint=sold[0];quote=receivedQuote}else continue;
        swaps++;lastParsedSwapAt=Date.now();
        const quoteMint=quote[0],quoteValue=quote[1],quoteAmount=Number(quoteValue.raw<0n?-quoteValue.raw:quoteValue.raw)/(10**quoteValue.dec);
        let amountUsd:number|undefined;
        if(quoteMint===USDC||quoteMint===USDT)amountUsd=quoteAmount;
        else if(quoteMint===WSOL)try{amountUsd=quoteAmount*await solPrice(jupiter)}catch{}
        const known=Boolean(await db.traderWallet.findUnique({where:{chain_address:{chain:"SOLANA",address:owner}}})||await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:owner}}}));
        let balance:number|undefined,tier="FLOW";
        const profileThreshold=Math.max(1000,Number(brainCfg?.profileTradeUsd??5000));
        if((amountUsd??0)>=profileThreshold||known){
          balance=await stableAndNativeBalance(conn,jupiter,owner);tier=walletTier(balance);profiled++;
          if((balance??0)>=50_000&&!known)await db.smartWalletCandidate.upsert({
            where:{chain_address:{chain:"SOLANA",address:owner}},
            create:{chain:"SOLANA",address:owner,stage:"DISCOVERED",source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:balance,discoveredBy:"CHAIN_WIDE_SWAP"} as any},
            update:{source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:balance,lastSeenBy:"CHAIN_WIDE_SWAP"} as any}
          });
        }
        await persistObservation({mint,walletAddress:owner,txHash:event.signature,side,amountUsd,walletBalanceUsd:balance,walletTier:tier,knownWallet:known,observedAt:tx.blockTime?new Date(tx.blockTime*1000):new Date()});
      }
    }
    await db.chainIngestionEvent.update({where:{id:eventId},data:{status:"PERSISTED",persistedAt:new Date(),lastError:null,processingAt:null}});
  }catch(e){
    errors++;if(isRateLimitError(e)){rateLimited=true;lastRateLimitAt=Date.now();}
    await markRetry(eventId,e).catch(markError=>console.error("[flow-worker] could not record retry",eventId,markError));
    throw e;
  }finally{inflight--;}
}

async function refreshBacklog(){
  const now=Date.now(),staleBefore=new Date(now-FLOW_PROCESSING_STALE_MS);
  const stale=await db.chainIngestionEvent.updateMany({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:"PROCESSING",processingAt:{lt:staleBefore}},data:{status:"RETRYING",processingAt:null,lastError:"PROCESSING_LEASE_EXPIRED"}});
  if(stale.count)recovered+=stale.count;
  const events=await db.chainIngestionEvent.findMany({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:{in:["SEEN","QUEUED","RETRYING"]}},orderBy:[{priority:"asc"},{receivedAt:"asc"}],take:200});
  for(const event of events)try{await enqueuePersistedEvent(event.id,event.priority);recovered++;}catch(e){queueFailures++;await markRetry(event.id,e).catch(()=>{});}
  const [queued,retrying,processing,terminal,oldest]=await Promise.all([
    db.chainIngestionEvent.count({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:"QUEUED"}}),
    db.chainIngestionEvent.count({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:"RETRYING"}}),
    db.chainIngestionEvent.count({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:"PROCESSING"}}),
    db.chainIngestionEvent.count({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:"TERMINAL_FAILURE"}}),
    db.chainIngestionEvent.findFirst({where:{chain:"SOLANA",source:"SOLANA_ALL_LOGS",status:{in:["SEEN","QUEUED","RETRYING","PROCESSING"]}},orderBy:{receivedAt:"asc"},select:{receivedAt:true}})
  ]);
  backlog={queued,retrying,processing,terminal,oldestAgeSec:oldest?Math.round((now-oldest.receivedAt.getTime())/1000):null};terminalFailures=terminal;
}

async function connectAndSubscribe(){
  const cfg=await getConfig<any>("marketData");brainCfg=await getConfig<any>("brain");
  const execCfg=await getConfig<any>("execution"),rpc=await pickHealthyRpc(solanaRpcCandidates(cfg),"[flow-worker]");
  conn=new Connection(rpc,"confirmed");currentRpcHost=new URL(rpc).host;
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  MAX=Math.max(2,Number(brainCfg?.solanaFlowConcurrency??12));
  enabled=String(brainCfg?.solanaChainWideEnabled??process.env.SOLANA_CHAIN_WIDE_SCAN??"true")!=="false";
  dedupeSubs=[];
  if(enabled){dedupeSubs=[conn.onLogs("all",log=>{if(!log.err)void captureSignature(log.signature)},"confirmed")];lastEventAt=Date.now();console.log("[flow-worker] subscribed",dedupeSubs[0],"rpc",currentRpcHost,"maxRps",RATE_PER_SEC);}
}
async function watchdog(){
  if(!enabled)return;
  const silentMs=Date.now()-lastEventAt;if(silentMs<=90_000)return;
  reconnects++;console.warn(`[flow-worker] no events for ${Math.round(silentMs/1000)}s — reconnecting (#${reconnects})`);
  for(const sub of dedupeSubs)await conn.removeOnLogsListener(sub).catch(()=>{});
  try{await connectAndSubscribe()}catch(e){errors++;console.error("[flow-worker] reconnect failed",e);lastEventAt=Date.now()-60_000;}
}

await connectAndSubscribe();
const worker=new Worker("chain-signature-ingestion",job=>processIngestionEvent(String(job.data.eventId)),{connection:rpcRedis,concurrency:FLOW_PROCESS_CONCURRENCY,limiter:{max:RATE_PER_SEC,duration:1000}});
worker.on("failed",(job,error)=>{
  if(!job||!terminalAfterFailure(job.attemptsMade,Number(job.opts.attempts??FLOW_INGESTION_ATTEMPTS)))return;
  void db.chainIngestionEvent.updateMany({where:{id:String(job.data.eventId),status:"RETRYING"},data:{status:"TERMINAL_FAILURE",terminalAt:new Date(),lastError:message(error),processingAt:null}}).then(result=>{if(result.count)terminalFailures++;}).catch(e=>console.error("[flow-worker] could not persist terminal failure",e));
});

await refreshBacklog().catch(e=>{errors++;console.error("[flow-worker] initial backlog recovery failed",e)});
startHeartbeat("solana-flow-scanner",()=>({
  enabled,subscriptions:dedupeSubs.length,rpc:currentRpcHost,received,persistedEvents,seen,swaps,saved,profiled,errors,inflight,reconnects,maxConcurrency:MAX,maxRequestsPerSec:RATE_PER_SEC,rateLimited,
  silentForSec:Math.round((Date.now()-lastEventAt)/1000),lastSuccessfulRpcAgoSec:lastSuccessfulRpcAt?Math.round((Date.now()-lastSuccessfulRpcAt)/1000):null,lastRateLimitAgoSec:lastRateLimitAt?Math.round((Date.now()-lastRateLimitAt)/1000):null,lastParsedSwapAgoSec:lastParsedSwapAt?Math.round((Date.now()-lastParsedSwapAt)/1000):null,lastDbWriteAgoSec:lastDbWriteAt?Math.round((Date.now()-lastDbWriteAt)/1000):null,
  sharedRpcBudgetPriority:"P4",sharedRpcBudgetDenied:sharedBudgetDenied,lastSharedRpcBudgetDenyAgoSec:lastSharedBudgetDenyAt?Math.round((Date.now()-lastSharedBudgetDenyAt)/1000):null,lastKnownSharedTokensRemaining:lastKnownTokensRemaining,queueFailures,recovered,terminalFailures,backlog
}));
setInterval(()=>void watchdog(),15_000);
setInterval(()=>void refreshBacklog().catch(e=>{errors++;console.error("[flow-worker] backlog recovery failed",e)}),15_000);
console.log("[flow-worker] durable chain-wide Solana flow scanner",enabled?"online":"disabled");
