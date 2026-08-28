import {Connection,type ParsedTransactionWithMeta,PublicKey} from "@solana/web3.js";
import {db} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {JupiterExecution} from "@memecloud/execution";
import {walletTier} from "@memecloud/brain";

const USDC=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",USDT="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",WSOL="So11111111111111111111111111111111111111112";
const quotes=new Set([USDC,USDT,WSOL]);
// Every real swap this worker cares about necessarily moves SPL token balances, so every
// transaction it needs is guaranteed to invoke one of these two token programs -- subscribing to
// them instead of Solana's raw "all" log firehose (every transaction on all of mainnet, regardless
// of relevance) is what actually fixes the sustained RPC/Helius rate-limiting: "all" was generating
// request volume no realistic RPC tier can sustain, no matter how much pacing/backoff is added on
// top, since the demand itself was the problem, not the request rate per event.
const TOKEN_PROGRAM=new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM=new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
let seen=0,swaps=0,saved=0,profiled=0,errors=0,inflight=0,reconnects=0,lastEventAt=Date.now();
let rateLimited=false,lastRateLimitAt:number|null=null,lastSuccessfulRpcAt:number|null=null,lastParsedSwapAt:number|null=null,lastDbWriteAt:number|null=null;
// Adaptive load-shedding: on a 429, stop spawning new getParsedTransaction calls for a cooldown
// window instead of continuing to fire at full concurrency into a provider that just said "too
// many requests" -- this is what a real backoff has to do at the subscription-callback level,
// since the callback fires synchronously for every incoming log regardless of any in-flight
// request's outcome. Recovers additively (halves the remaining cooldown early on any success).
let backoffUntil=0;
function isRateLimitError(e:any):boolean{
  const s=String(e?.message??e??"");
  return /429|too many requests|rate.?limit/i.test(s);
}
let solUsd=0,solAt=0;
async function solPrice(jupiter:JupiterExecution){if(solUsd&&Date.now()-solAt<15_000)return solUsd;const q=await jupiter.quote({inputMint:WSOL,outputMint:USDC,amountRaw:"1000000000",slippageBps:100});solUsd=Number(q.outAmount)/1e6;solAt=Date.now();return solUsd}
function ownerDeltas(tx:ParsedTransactionWithMeta){const m=new Map<string,Map<string,{raw:bigint,dec:number}>>();const apply=(rows:any[],sgn:bigint)=>{for(const r of rows){if(!r.owner)continue;let w=m.get(r.owner);if(!w)m.set(r.owner,w=new Map());const c=w.get(r.mint)??{raw:0n,dec:r.uiTokenAmount.decimals};c.raw+=sgn*BigInt(r.uiTokenAmount.amount||"0");c.dec=r.uiTokenAmount.decimals;w.set(r.mint,c)}};apply(tx.meta?.postTokenBalances??[],1n);apply(tx.meta?.preTokenBalances??[],-1n);return m}
async function stableAndNativeBalance(conn:Connection,jupiter:JupiterExecution,owner:string){let usd=0;try{usd+=(await conn.getBalance(new PublicKey(owner),"confirmed"))/1e9*await solPrice(jupiter)}catch{};for(const mint of [USDC,USDT])try{const rows=await conn.getParsedTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)},"confirmed");for(const r of rows.value)usd+=Number((r.account.data as any).parsed?.info?.tokenAmount?.uiAmount??0)}catch{};return usd}

async function processSig(conn:Connection,jupiter:JupiterExecution,brainCfg:any,dedupe:Set<string>,MAX:number,sig:string){
  // Load-shedding: while in an active backoff window (set below on a real 429), skip new work
  // entirely instead of queueing it -- a queue would just mean the same burst hits the provider the
  // instant the window ends. Dropping some chain-wide events during a genuine rate-limit window is
  // the correct tradeoff for a discovery/sampling pipeline; it is never acceptable to keep
  // hammering a provider that just said "too many requests."
  if(Date.now()<backoffUntil)return;
  if(dedupe.has(sig)||inflight>=MAX)return;dedupe.add(sig);if(dedupe.size>5000)dedupe.clear();inflight++;
  try{
    seen++;lastEventAt=Date.now();
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
      await db.chainFlowObservation.create({data:{chain:"SOLANA",mint,walletAddress:owner,txHash:sig,side,amountUsd,walletBalanceUsd:bal,walletTier:tier,knownWallet:known,source:"SOLANA_TOKEN_PROGRAM_LOGS",observedAt:tx.blockTime?new Date(tx.blockTime*1000):new Date()}}).then(()=>{saved++;lastDbWriteAt=Date.now()}).catch(()=>{});
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
  const rpc=cfg?.heliusRpc||cfg?.solanaRpc||process.env.SOLANA_RPC_HTTP;
  if(!rpc)throw new Error("SOLANA_RPC_REQUIRED");
  conn=new Connection(rpc,"confirmed");
  currentRpcHost=new URL(rpc).host;
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  MAX=Math.max(2,Number(brainCfg?.solanaFlowConcurrency??12));
  dedupe=new Set<string>();
  enabled=String(brainCfg?.solanaChainWideEnabled??process.env.SOLANA_CHAIN_WIDE_SCAN??"true")!=="false";
  subs=[];
  if(enabled){
    const onLog=(l:any)=>{if(!l.err)void processSig(conn,jupiter,brainCfg,dedupe,MAX,l.signature)};
    subs=[conn.onLogs(TOKEN_PROGRAM,onLog,"confirmed"),conn.onLogs(TOKEN_2022_PROGRAM,onLog,"confirmed")];
    lastEventAt=Date.now();
    console.log("[flow-worker] subscribed to token-program logs, sub ids",subs,"rpc",currentRpcHost);
  }
}

async function watchdog(){
  if(!enabled)return;
  // Token-program log volume on Solana mainnet is high enough that any real, live subscription
  // sees events within a small number of seconds. 90s of total silence is the connection being
  // dead, not the chain being idle -- this is distinct from the per-request backoff window above,
  // which only pauses new getParsedTransaction calls, not the subscription itself.
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
  enabled,subscriptions:subs.length,rpc:currentRpcHost,seen,swaps,saved,profiled,errors,inflight,reconnects,
  maxConcurrency:MAX,rateLimited,backoffActiveMs:Math.max(0,backoffUntil-Date.now()),
  silentForSec:Math.round((Date.now()-lastEventAt)/1000),
  lastSuccessfulRpcAgoSec:lastSuccessfulRpcAt?Math.round((Date.now()-lastSuccessfulRpcAt)/1000):null,
  lastRateLimitAgoSec:lastRateLimitAt?Math.round((Date.now()-lastRateLimitAt)/1000):null,
  lastParsedSwapAgoSec:lastParsedSwapAt?Math.round((Date.now()-lastParsedSwapAt)/1000):null,
  lastDbWriteAgoSec:lastDbWriteAt?Math.round((Date.now()-lastDbWriteAt)/1000):null
}));
setInterval(()=>void watchdog(),15_000);
console.log("[flow-worker] Solana token-program flow scanner",enabled?"online":"disabled");
