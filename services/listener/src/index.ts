import { Connection, PublicKey } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@fomocloud/db";
import { startHeartbeat } from "@fomocloud/ops";
import { getConfig } from "@fomocloud/config";
import { classifySolanaSwap, SOLANA_USDC, SOLANA_USDT, WRAPPED_SOL } from "./decoder.js";

const marketCfg=await getConfig<any>("marketData");
const rpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
if(!rpc) throw new Error("SOLANA_RPC_HTTP / Admin marketData.solanaRpc is required for listener");
const conn=new Connection(rpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const queue=new Queue("signals",{connection:redis});
const subscriptions=new Map<string,number>();
let detected=0, decoded=0, errors=0;

const DEFAULT_QUOTES=[
  SOLANA_USDC,
  SOLANA_USDT,
  WRAPPED_SOL
];
const quoteMints=new Set((process.env.SOLANA_QUOTE_MINTS??DEFAULT_QUOTES.join(",")).split(",").map(x=>x.trim()).filter(Boolean));
const usdcMint=process.env.USDC_MINT_SOLANA??DEFAULT_QUOTES[0];

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

  const swap=classifySolanaSwap(tx,wallet,quoteMints,usdcMint);
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
}

async function refreshWatchlist(){
  // Watch every enabled verified source wallet ONCE. Fan-out happens downstream per user.
  // This also lets the platform track public trader history before a user enables Auto Copy.
  const wallets=await db.traderWallet.findMany({
    where:{
      verified:true,
      trader:{enabled:true,OR:[{kind:"PLATFORM"},{kind:"CUSTOM",follows:{some:{}}}]}
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
startHeartbeat("solana-listener",()=>({subscriptions:subscriptions.size,detected,decoded,errors,rpc:new URL(rpc).host}));
await refreshWatchlist();
setInterval(()=>refreshWatchlist().catch(e=>{errors++;console.error(e)}),30_000);
console.log("[listener] running");
