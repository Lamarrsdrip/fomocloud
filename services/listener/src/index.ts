import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { startHeartbeat } from "@memecloud/ops";
import { getConfig } from "@memecloud/config";
import { solanaRpcCandidates, pickHealthyRpc } from "@memecloud/shared";

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

const DEFAULT_QUOTES=[
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112"  // WSOL
];
const quoteMints=new Set((process.env.SOLANA_QUOTE_MINTS??DEFAULT_QUOTES.join(",")).split(",").map(x=>x.trim()).filter(Boolean));
const usdcMint=process.env.USDC_MINT_SOLANA??DEFAULT_QUOTES[0];

type Delta={mint:string;raw:bigint;decimals:number};
function tokenDeltas(tx:ParsedTransactionWithMeta,wallet:string):Delta[]{
  const pre=tx.meta?.preTokenBalances??[], post=tx.meta?.postTokenBalances??[];
  const map=new Map<string,{raw:bigint;decimals:number}>();
  const apply=(rows:typeof pre,sign:bigint)=>{
    for(const r of rows){
      if(r.owner!==wallet) continue;
      const cur=map.get(r.mint)??{raw:0n,decimals:r.uiTokenAmount.decimals};
      cur.raw+=sign*BigInt(r.uiTokenAmount.amount||"0"); cur.decimals=r.uiTokenAmount.decimals;
      map.set(r.mint,cur);
    }
  };
  apply(post,1n); apply(pre,-1n);
  return [...map].map(([mint,v])=>({mint,...v})).filter(x=>x.raw!==0n);
}


function ownerMintBalanceRaw(tx:ParsedTransactionWithMeta,wallet:string,mint:string,side:"pre"|"post"){
  const rows=side==="pre"?(tx.meta?.preTokenBalances??[]):(tx.meta?.postTokenBalances??[]);
  return rows.filter(r=>r.owner===wallet&&r.mint===mint).reduce((a,r)=>a+BigInt(r.uiTokenAmount.amount||"0"),0n);
}

function classifySwap(tx:ParsedTransactionWithMeta,wallet:string){
  const deltas=tokenDeltas(tx,wallet);
  const positives=deltas.filter(x=>x.raw>0n).sort((a,b)=>a.raw>b.raw?-1:1);
  const negatives=deltas.filter(x=>x.raw<0n).sort((a,b)=>a.raw<b.raw?-1:1);
  if(!positives.length||!negatives.length) return null;

  // Prefer a clear quote-asset <-> token leg. This prevents treating every token transfer as a buy.
  const spentQuote=negatives.find(x=>quoteMints.has(x.mint));
  const receivedQuote=positives.find(x=>quoteMints.has(x.mint));
  let input:Delta|undefined,output:Delta|undefined,action:"BUY"|"SELL";
  if(spentQuote){
    input=spentQuote; output=positives.find(x=>!quoteMints.has(x.mint)); action="BUY";
  }else if(receivedQuote){
    input=negatives.find(x=>!quoteMints.has(x.mint)); output=receivedQuote; action="SELL";
  }else{
    // Token-to-token with no recognized quote is ambiguous; don't invent a copy signal.
    return null;
  }
  if(!input||!output) return null;

  const inputRaw=(input.raw<0n?-input.raw:input.raw).toString();
  const outputRaw=(output.raw<0n?-output.raw:output.raw).toString();
  let sourcePriceUsd:number|undefined;
  if(action==="BUY"&&input.mint===usdcMint){
    const dollars=Number(inputRaw)/(10**input.decimals);
    const tokens=Number(outputRaw)/(10**output.decimals);
    if(Number.isFinite(dollars)&&Number.isFinite(tokens)&&tokens>0) sourcePriceUsd=dollars/tokens;
  }else if(action==="SELL"&&output.mint===usdcMint){
    const dollars=Number(outputRaw)/(10**output.decimals);
    const tokens=Number(inputRaw)/(10**input.decimals);
    if(Number.isFinite(dollars)&&Number.isFinite(tokens)&&tokens>0) sourcePriceUsd=dollars/tokens;
  }
  let sourceTokenBalanceBeforeRaw:string|undefined, sourceTokenBalanceAfterRaw:string|undefined, sourceSoldPct:number|undefined;
  if(action==="SELL"){
    const before=ownerMintBalanceRaw(tx,wallet,input.mint,"pre"), after=ownerMintBalanceRaw(tx,wallet,input.mint,"post");
    sourceTokenBalanceBeforeRaw=before.toString(); sourceTokenBalanceAfterRaw=after.toString();
    if(before>0n){
      const sold=before>after?before-after:0n;
      sourceSoldPct=Math.max(0,Math.min(100,Number((sold*10000n)/before)/100));
    }
  }
  return {action,inputMint:input.mint,outputMint:output.mint,inputRaw,outputRaw,sourcePriceUsd,sourceTokenBalanceBeforeRaw,sourceTokenBalanceAfterRaw,sourceSoldPct};
}

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
