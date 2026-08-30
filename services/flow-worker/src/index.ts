import {Connection,PublicKey} from "@solana/web3.js";
import {Redis} from "ioredis";
import {db} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {JupiterExecution} from "@memecloud/execution";
import {walletTier} from "@memecloud/brain";
import {RpcBudget,solanaRpcCandidates,pickHealthyRpc} from "@memecloud/shared";
import {ownerDeltas} from "./parsing.js";

// Shared, cross-process RPC budget: this worker's own token bucket below only bounds ITS OWN
// outbound rate, so five independently-rate-limited processes (this one, market-worker,
// balance-worker, social-worker, executor, exits) could each stay under their own private cap
// while collectively blowing through the shared Helius account's real limit -- which is exactly
// what happened before this existed. One Redis-backed bucket, shared by every RPC-calling
// process, with this worker drawing at P4 (background chain-wide discovery scanning) so it backs
// off first under real account pressure, ahead of exits/executor's real-money paths.
const rpcRedis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const sharedRpcBudget=new RpcBudget(rpcRedis,"rpc-budget:solana",{
  capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),
  ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))
});
let sharedBudgetDenied=0,lastSharedBudgetDenyAt:number|null=null,lastKnownTokensRemaining:number|null=null;

const USDC=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",USDT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",WSOL="So11111111111111111111111111111111111111112";
const quotes=new Set([USDC,USDT,WSOL]);
let seen=0,swaps=0,saved=0,profiled=0,errors=0,inflight=0,reconnects=0,lastEventAt=Date.now();
let rateLimited=false,lastRateLimitAt:number|null=null,lastSuccessfulRpcAt:number|null=null,lastParsedSwapAt:number|null=null,lastDbWriteAt:number|null=null,dropped=0;
// Adaptive load-shedding: on a 429, stop spawning new getParsedTransaction calls for a cooldown
// window instead of continuing to fire at full concurrency into a provider that just said "too
// many requests" -- this is what a real backoff has to do at the subscription-callback level,
// since the callback fires synchronously for every incoming log regardless of any in-flight
// request's outcome.
let backoffUntil=0;
function isRateLimitError(e:any):boolean{
  const s=String(e?.message??e??"");
  return /429|too many requests|rate.?limit/i.test(s);
}
// A real token bucket bounding actual outbound getParsedTransaction requests/sec, independent of
// how many log events arrive. This is deliberately separate from narrowing the subscription
// filter: narrowing to the SPL Token Program's mentions filter was tried and empirically failed in
// production (zero events delivered over a 4+ minute observation window, worse than the proven
// "all" subscription) -- so the subscription stays "all" (known to actually deliver events) and
// the request-rate problem is solved entirely on the outbound side instead, which cannot break
// event delivery since it never touches the subscription itself.
let tokens=0,lastRefillAt=Date.now();
const RATE_PER_SEC=Math.max(1,Number(process.env.FLOW_SCANNER_MAX_RPS??10));
const BUCKET_SIZE=RATE_PER_SEC*2;
function tryTakeToken():boolean{
  const now=Date.now(),elapsed=(now-lastRefillAt)/1000;
  if(elapsed>0){tokens=Math.min(BUCKET_SIZE,tokens+elapsed*RATE_PER_SEC);lastRefillAt=now}
  if(tokens<1)return false;
  tokens-=1;return true;
}
let solUsd=0,solAt=0;
async function solPrice(jupiter:JupiterExecution){if(solUsd&&Date.now()-solAt<15_000)return solUsd;const q=await jupiter.quote({inputMint:WSOL,outputMint:USDC,amountRaw:"1000000000",slippageBps:100});solUsd=Number(q.outAmount)/1e6;solAt=Date.now();return solUsd}
// ownerDeltas moved to ./parsing.ts so it's testable without triggering this file's top-level
// side effects (Redis connection, WS subscription start) on import.
async function stableAndNativeBalance(conn:Connection,jupiter:JupiterExecution,owner:string){let usd=0;try{usd+=(await conn.getBalance(new PublicKey(owner),"confirmed"))/1e9*await solPrice(jupiter)}catch{};for(const mint of [USDC,USDT])try{const rows=await conn.getParsedTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)},"confirmed");for(const r of rows.value)usd+=Number((r.account.data as any).parsed?.info?.tokenAmount?.uiAmount??0)}catch{};return usd}

async function processSig(conn:Connection,jupiter:JupiterExecution,brainCfg:any,dedupe:Set<string>,MAX:number,sig:string){
  // The subscription being alive is proven by a log notification arriving at all, independent of
  // whether this worker chooses to act on it -- update watchdog freshness unconditionally so
  // deliberate rate-limit/token-bucket shedding below is never mistaken for a dead connection.
  lastEventAt=Date.now();
  if(dedupe.has(sig))return;dedupe.add(sig);if(dedupe.size>5000)dedupe.clear();
  // Load-shedding, in order: an active 429 backoff window always wins (a queue would just mean the
  // same burst hits the provider the instant the window ends); then the real requests/sec token
  // bucket, which bounds actual outbound RPC calls independent of inbound log volume -- this is
  // what actually fixes sustained rate-limiting, since narrowing the subscription itself was tried
  // and empirically failed (see git history: zero events delivered for 4+ minutes in production);
  // then the existing concurrency cap. Dropping some chain-wide events under real pressure is the
  // correct tradeoff for a discovery/sampling pipeline -- it is never acceptable to keep hammering
  // a provider that's already saying "too many requests."
  if(Date.now()<backoffUntil){dropped++;return}
  if(!tryTakeToken()){dropped++;return}
  if(inflight>=MAX){dropped++;return}
  // This worker's own token bucket above already passed -- now check the shared, cross-process
  // account budget. At P4, this is the first thing to back off once other services' real-money or
  // higher-priority RPC usage is eating into the shared account's headroom.
  const shared=await sharedRpcBudget.tryAcquire("P4");
  lastKnownTokensRemaining=shared.tokensRemaining;
  if(!shared.granted){dropped++;sharedBudgetDenied++;lastSharedBudgetDenyAt=Date.now();return}
  inflight++;
  try{
    seen++;
    const tx=await conn.getParsedTransaction(sig,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
    lastSuccessfulRpcAt=Date.now();
    if(rateLimited){rateLimited=false;backoffUntil=0}
    if(!tx||tx.meta?.err)return;
    for(const [owner,d] of ownerDeltas(tx)){
      const pos=[...d.entries()].filter(([,v])=>v.raw>0n),neg=[...d.entries()].filter(([,v])=>v.raw<0n);
      const spent=neg.find(([m])=>quotes.has(m)),got=pos.find(([m])=>!quotes.has(m)),received=pos.find(([m])=>quotes.has(m)),sold=neg.find(([m])=>!quotes.has(m));
      let side:"BUY"|"SELL"|null=null,mint="",quote:any;
      if(spent&&got){side="BUY";mint=got[0];quote=spent}else if(received&&sold){side="SELL";mint=sold[0];quote=received}else continue;
      swaps++;lastParsedSwapAt=Date.now();
      let amountUsd:number|undefined;
      const qmint=quote[0],qv=quote[1],qamt=Number(qv.raw<0n?-qv.raw:qv.raw)/(10**qv.dec);
      if(qmint===USDC||qmint===USDT)amountUsd=qamt;else if(qmint===WSOL)try{amountUsd=qamt*await solPrice(jupiter)}catch{};
      const known=Boolean(await db.traderWallet.findUnique({where:{chain_address:{chain:"SOLANA",address:owner}}})||await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:owner}}}));
      let bal:number|undefined,tier="FLOW";
      const profileThreshold=Math.max(1000,Number(brainCfg?.profileTradeUsd??5000));
      if((amountUsd??0)>=profileThreshold||known){
        bal=await stableAndNativeBalance(conn,jupiter,owner);tier=walletTier(bal);profiled++;
        if((bal??0)>=50_000&&!known)await db.smartWalletCandidate.upsert({where:{chain_address:{chain:"SOLANA",address:owner}},create:{chain:"SOLANA",address:owner,stage:"DISCOVERED",source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:bal,discoveredBy:"CHAIN_WIDE_SWAP"} as any},update:{source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:bal,lastSeenBy:"CHAIN_WIDE_SWAP"} as any}}).catch(()=>{});
      }
      await db.chainFlowObservation.create({data:{chain:"SOLANA",mint,walletAddress:owner,txHash:sig,side,amountUsd,walletBalanceUsd:bal,walletTier:tier,knownWallet:known,source:"SOLANA_ALL_LOGS",observedAt:tx.blockTime?new Date(tx.blockTime*1000):new Date()}}).then(()=>{saved++;lastDbWriteAt=Date.now()}).catch(()=>{});
    }
  }catch(e){
    errors++;
    if(isRateLimitError(e)){
      rateLimited=true;lastRateLimitAt=Date.now();
      // Fixed 10s cooldown per hit, refreshed (not stacked) on each subsequent 429 -- sustained
      // pressure keeps the window open, but a single hit never balloons into an ever-growing delay.
      backoffUntil=Math.max(backoffUntil,Date.now()+10_000);
    }else{
      console.error("[flow-worker]",sig,e);
    }
  }finally{inflight--}
}

// A dead/stalled WebSocket subscription must never look identical to "the chain is just quiet" —
// Solana mainnet always has continuous swap activity, so silence here means the connection died,
// not that nothing happened. Re-fetching config on every (re)connect also fixes the separate
// staleness bug where this worker was pinned to whatever RPC URL Admin had saved at process
// startup, silently ignoring later Admin config changes without a manual restart.
let conn:Connection,jupiter:JupiterExecution,dedupe=new Set<string>(),MAX=12,subs:number[]=[],enabled=true,currentRpcHost="";

async function connectAndSubscribe(){
  const cfg=await getConfig<any>("marketData"),brainCfg=await getConfig<any>("brain"),execCfg=await getConfig<any>("execution");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(cfg),"[flow-worker]");
  conn=new Connection(rpc,"confirmed");
  currentRpcHost=new URL(rpc).host;
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  MAX=Math.max(2,Number(brainCfg?.solanaFlowConcurrency??12));
  dedupe=new Set<string>();
  enabled=String(brainCfg?.solanaChainWideEnabled??process.env.SOLANA_CHAIN_WIDE_SCAN??"true")!=="false";
  subs=[];
  if(enabled){
    // Narrowing this to a mentions(TOKEN_PROGRAM) filter was tried and reverted: it is API-correct
    // (every real swap does invoke the token program) but empirically delivered zero events over a
    // 4+ minute production observation window, worse than "all" which is proven to actually work.
    // The real rate-limit fix lives entirely on the outbound side now (the token bucket above).
    subs=[conn.onLogs("all",l=>{if(!l.err)void processSig(conn,jupiter,brainCfg,dedupe,MAX,l.signature)},"confirmed")];
    lastEventAt=Date.now();
    console.log("[flow-worker] subscribed, sub id",subs[0],"rpc",currentRpcHost,"maxRps",RATE_PER_SEC);
  }
}

async function watchdog(){
  if(!enabled)return;
  // Chain-wide log volume on Solana mainnet is high enough that any real, live subscription sees
  // events within a small number of seconds. 90s of total silence is the connection being dead,
  // not the chain being idle -- this is distinct from the per-request backoff window above, which
  // only pauses new getParsedTransaction calls, not the subscription itself.
  const silentMs=Date.now()-lastEventAt;
  if(silentMs>90_000){
    reconnects++;
    console.warn(`[flow-worker] no events for ${Math.round(silentMs/1000)}s — reconnecting (reconnect #${reconnects})`);
    try{
      for(const s of subs)await conn.removeOnLogsListener(s).catch(()=>{});
    }catch{}
    try{
      await connectAndSubscribe();
    }catch(e){
      errors++;console.error("[flow-worker] reconnect failed",e);
      lastEventAt=Date.now()-60_000; // retry again in 30s rather than waiting a full 90s
    }
  }
}

await connectAndSubscribe();
startHeartbeat("solana-flow-scanner",()=>({
  enabled,subscriptions:subs.length,rpc:currentRpcHost,seen,swaps,saved,profiled,errors,dropped,inflight,reconnects,
  maxConcurrency:MAX,maxRequestsPerSec:RATE_PER_SEC,rateLimited,backoffActiveMs:Math.max(0,backoffUntil-Date.now()),
  silentForSec:Math.round((Date.now()-lastEventAt)/1000),
  lastSuccessfulRpcAgoSec:lastSuccessfulRpcAt?Math.round((Date.now()-lastSuccessfulRpcAt)/1000):null,
  lastRateLimitAgoSec:lastRateLimitAt?Math.round((Date.now()-lastRateLimitAt)/1000):null,
  lastParsedSwapAgoSec:lastParsedSwapAt?Math.round((Date.now()-lastParsedSwapAt)/1000):null,
  lastDbWriteAgoSec:lastDbWriteAt?Math.round((Date.now()-lastDbWriteAt)/1000):null,
  sharedRpcBudgetPriority:"P4",sharedRpcBudgetDenied:sharedBudgetDenied,
  lastSharedRpcBudgetDenyAgoSec:lastSharedBudgetDenyAt?Math.round((Date.now()-lastSharedBudgetDenyAt)/1000):null,
  lastKnownSharedTokensRemaining:lastKnownTokensRemaining
}));
setInterval(()=>void watchdog(),15_000);
console.log("[flow-worker] chain-wide Solana flow scanner",enabled?"online":"disabled");
