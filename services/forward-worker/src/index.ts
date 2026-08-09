import {Queue,Worker} from "bullmq";
import { Redis } from "ioredis";
import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";

const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const q=new Queue("forward-observations",{connection:redis});
const horizons=[30,60,300,900,3600,21600,86400];
let scheduled=0,observed=0,missed=0,errors=0;

async function scheduleSignal(signalId:string){
  for(const seconds of horizons){
    const id=`${signalId}:${seconds}`;
    await q.add("observe",{signalId,horizonSeconds:seconds},{jobId:id,delay:seconds*1000,removeOnComplete:20000,attempts:4,backoff:{type:"exponential",delay:5000}});
    scheduled++;
  }
}

new Worker("discovery-forward-schedule",async job=>{if(job.data.signalId)await scheduleSignal(String(job.data.signalId))},{connection:redis,concurrency:20});

new Worker("forward-observations",async job=>{
  try{
    const signal=await db.signal.findUnique({where:{id:String(job.data.signalId)},include:{trader:{include:{wallets:true}}}});
    if(!signal||signal.action!=="BUY")return;
    const mint=signal.outputMint;
    const market=await db.marketPrice.findFirst({where:{chain:signal.chain,mint},orderBy:{observedAt:"desc"}});
    if(!market||Date.now()-market.observedAt.getTime()>120_000){missed++;throw new Error("FRESH_MARKET_PRICE_UNAVAILABLE")}
    const source=Number(signal.sourcePriceUsd??0);
    const ret=source>0?(market.priceUsd/source-1)*100:undefined;
    await db.sourceSignalObservation.upsert({
      where:{signalId_horizonSeconds:{signalId:signal.id,horizonSeconds:Number(job.data.horizonSeconds)}},
      update:{observedPriceUsd:market.priceUsd,returnPct:ret,marketCapUsd:market.marketCapUsd,liquidityUsd:market.liquidityUsd,observedAt:new Date()},
      create:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:signal.chain,mint,horizonSeconds:Number(job.data.horizonSeconds),sourcePriceUsd:source||undefined,observedPriceUsd:market.priceUsd,returnPct:ret,marketCapUsd:market.marketCapUsd,liquidityUsd:market.liquidityUsd,observedAt:new Date()}
    });
    observed++;
  }catch(e){errors++;throw e}
},{connection:redis,concurrency:40});

startHeartbeat("forward-worker",()=>({scheduled,observed,missed,errors}));
console.log("[forward-worker] running");
