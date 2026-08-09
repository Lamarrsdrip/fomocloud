import { Connection, PublicKey } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@fomocloud/db";
import { startHeartbeat } from "@fomocloud/ops";
import { getConfig } from "@fomocloud/config";
import { classifySolanaSwap, SOLANA_USDC, SOLANA_USDT, WRAPPED_SOL } from "./decoder.js";
import { planSignatureReplay } from "./replay.js";

const marketCfg=await getConfig<any>("marketData");
const rpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
if(!rpc) throw new Error("SOLANA_RPC_HTTP / Admin marketData.solanaRpc is required for listener");
const conn=new Connection(rpc,(process.env.SOLANA_COMMITMENT as any)||"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const queue=new Queue("signals",{connection:redis});
const subscriptions=new Map<string,number>();
const checkpointSlots=new Map<string,bigint>();
let detected=0, decoded=0, replayed=0, replayGaps=0, errors=0;

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

async function handleSignature(traderId:string,wallet:string,signature:string):Promise<boolean>{
  detected++;
  const existing=await db.sourceTransaction.findUnique({where:{chain_txHash_walletAddress:{chain:"SOLANA",txHash:signature,walletAddress:wallet}}});
  if(existing) return true;
  const tx=await fetchParsedTransactionWithRetry(signature);
  if(!tx){errors++;return false;}
  if(tx.meta?.err) return true;

  await db.sourceTransaction.upsert({
    where:{chain_txHash_walletAddress:{chain:"SOLANA",txHash:signature,walletAddress:wallet}},update:{},
    create:{chain:"SOLANA",txHash:signature,walletAddress:wallet,slot:BigInt(tx.slot),blockTime:tx.blockTime?new Date(tx.blockTime*1000):null,rawJson:JSON.parse(JSON.stringify(tx))}
  });

  const swap=classifySolanaSwap(tx,wallet,quoteMints,usdcMint);
  if(!swap) return true;
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
  return true;
}

async function checkpointWallet(walletId:string,signature:string,slot:number){
  const nextSlot=BigInt(slot);
  const current=checkpointSlots.get(walletId)??0n;
  if(nextSlot<current) return;
  checkpointSlots.set(walletId,nextSlot);
  await db.traderWallet.update({where:{id:walletId},data:{
    lastSeenSignature:signature,lastSeenSlot:nextSlot,lastSeenAt:new Date(),monitoringStatus:"WATCHING",monitoringError:null
  }});
}

async function syncWallet(tw:any,pubkey:PublicKey){
  if(tw.lastSeenSlot!=null) checkpointSlots.set(tw.id,BigInt(tw.lastSeenSlot));
  const plan=await planSignatureReplay(
    (before,limit)=>conn.getSignaturesForAddress(pubkey,{before,limit},"confirmed"),
    tw.lastSeenSignature??undefined,
    Number(process.env.SOLANA_REPLAY_LIMIT??500)
  );
  if(plan.baseline){
    await checkpointWallet(tw.id,plan.baseline.signature,plan.baseline.slot);
    await db.traderWallet.update({where:{id:tw.id},data:{lastReplayAt:new Date(),monitoringStatus:"WATCHING",monitoringError:null}});
    return true;
  }
  if(!plan.complete){
    replayGaps++;
    await db.traderWallet.update({where:{id:tw.id},data:{monitoringStatus:"REPLAY_GAP",monitoringError:"Stored signature was not found within the bounded replay window. Manual review is required before monitoring resumes.",lastReplayAt:new Date()}});
    return false;
  }
  for(const item of plan.signatures){
    const processed=await handleSignature(tw.traderId,tw.address,item.signature);
    if(!processed) throw new Error(`Transaction ${item.signature} was unavailable after retries`);
    await checkpointWallet(tw.id,item.signature,item.slot);
    replayed++;
  }
  await db.traderWallet.update({where:{id:tw.id},data:{lastReplayAt:new Date(),monitoringStatus:"WATCHING",monitoringError:null}});
  return true;
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
  const wanted=new Set(wallets.filter(w=>w.chain==="SOLANA").map(w=>w.address));
  for(const [address,id] of subscriptions){
    if(!wanted.has(address)){await conn.removeOnLogsListener(id);subscriptions.delete(address);}
  }
  for(const tw of wallets){
    if(tw.chain!=="SOLANA"){
      if(tw.monitoringStatus!=="UNSUPPORTED_CHAIN") await db.traderWallet.update({where:{id:tw.id},data:{monitoringStatus:"UNSUPPORTED_CHAIN",monitoringError:"No source listener is implemented for this chain."}});
      continue;
    }
    try{
      const pubkey=new PublicKey(tw.address);
      const account=await conn.getAccountInfo(pubkey,"confirmed");
      if(account?.executable){
        const existingId=subscriptions.get(tw.address);
        if(existingId!=null){await conn.removeOnLogsListener(existingId);subscriptions.delete(tw.address);}
        await db.traderWallet.update({where:{id:tw.id},data:{monitoringStatus:"INVALID_SOURCE_PROGRAM",monitoringError:"This address is an executable Solana program, not a trader wallet."}});
        continue;
      }
      const safeToWatch=await syncWallet(tw,pubkey);
      if(!safeToWatch){
        const existingId=subscriptions.get(tw.address);
        if(existingId!=null){await conn.removeOnLogsListener(existingId);subscriptions.delete(tw.address);}
        continue;
      }
      if(!subscriptions.has(tw.address)){
        const id=conn.onLogs(pubkey,async (logs,context)=>{
          try{
            const processed=await handleSignature(tw.traderId,tw.address,logs.signature);
            if(processed) await checkpointWallet(tw.id,logs.signature,context.slot);
          }catch(e){
            errors++;
            await db.traderWallet.update({where:{id:tw.id},data:{monitoringStatus:"ERROR",monitoringError:e instanceof Error?e.message:String(e)}}).catch(()=>{});
            console.error("[listener] tx error",logs.signature,e);
          }
        },"confirmed");
        subscriptions.set(tw.address,id);
        console.log("[listener] watching",tw.trader.handle,tw.address);
      }
    }catch(e){
      errors++;
      await db.traderWallet.update({where:{id:tw.id},data:{monitoringStatus:"ERROR",monitoringError:e instanceof Error?e.message:String(e)}}).catch(()=>{});
      console.error("[listener] wallet sync error",tw.address,e);
    }
  }
}
startHeartbeat("solana-listener",()=>({subscriptions:subscriptions.size,detected,decoded,replayed,replayGaps,errors,rpc:new URL(rpc).host}));
await refreshWatchlist();
setInterval(()=>refreshWatchlist().catch(e=>{errors++;console.error(e)}),30_000);
console.log("[listener] running");
