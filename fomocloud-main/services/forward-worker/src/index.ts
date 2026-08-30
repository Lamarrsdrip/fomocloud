import {Queue,Worker} from "bullmq";
import {Redis} from "ioredis";
import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {FORWARD_HORIZONS,classifyObservation,toleranceForHorizonMs} from "./horizon.js";

type ForwardJob={signalId:string;horizonSeconds:number;targetAtMs:number;maxToleranceMs:number};
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const q=new Queue<ForwardJob>("forward-observations",{connection:redis});
let scheduled=0,observed=0,missing=0,late=0,invalid=0,errors=0;

async function scheduleSignal(signalId:string){
  const signal=await db.signal.findUnique({where:{id:signalId},select:{observedAt:true,action:true}});
  if(!signal||signal.action!=="BUY")return;
  for(const horizonSeconds of FORWARD_HORIZONS){
    const targetAtMs=signal.observedAt.getTime()+horizonSeconds*1000;
    const maxToleranceMs=toleranceForHorizonMs(horizonSeconds);
    const delay=Math.max(0,targetAtMs-Date.now());
    const id=`${signalId}:${horizonSeconds}`;
    await q.add("observe",{signalId,horizonSeconds,targetAtMs,maxToleranceMs},{jobId:id,delay,removeOnComplete:20_000,attempts:4,backoff:{type:"exponential",delay:5_000}});
    scheduled++;
  }
}

async function upsertObservation(signal:any,horizonSeconds:number,data:any){
  await db.sourceSignalObservation.upsert({
    where:{signalId_horizonSeconds:{signalId:signal.id,horizonSeconds}},
    update:data,
    create:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:signal.chain,mint:signal.outputMint,horizonSeconds,...data}
  });
}

new Worker("discovery-forward-schedule",async job=>{if(job.data.signalId)await scheduleSignal(String(job.data.signalId))},{connection:redis,concurrency:20});

new Worker<ForwardJob>("forward-observations",async job=>{
  try{
    const signal=await db.signal.findUnique({where:{id:String(job.data.signalId)}});
    if(!signal||signal.action!=="BUY")return;
    const horizonSeconds=Number(job.data.horizonSeconds);
    const targetAtMs=Number(job.data.targetAtMs)||signal.observedAt.getTime()+horizonSeconds*1000;
    const maxToleranceMs=Number(job.data.maxToleranceMs)||toleranceForHorizonMs(horizonSeconds);
    const now=Date.now(),targetAt=new Date(targetAtMs),windowStart=new Date(targetAtMs-maxToleranceMs),windowEnd=new Date(targetAtMs+maxToleranceMs);
    // Never substitute the latest mark. A delayed worker can use a historically captured mark only
    // when it actually sits within the requested horizon's tolerance window.
    const prices=await db.marketPrice.findMany({where:{chain:signal.chain,mint:signal.outputMint,observedAt:{gte:windowStart,lte:windowEnd}},orderBy:{observedAt:"asc"},take:200});
    const market=prices.reduce<any|null>((best,row)=>!best||Math.abs(row.observedAt.getTime()-targetAtMs)<Math.abs(best.observedAt.getTime()-targetAtMs)?row:best,null);
    const source=signal.sourcePriceUsd==null?undefined:Number(signal.sourcePriceUsd);
    const status=classifyObservation(now,targetAtMs,maxToleranceMs,Boolean(source&&source>0),Boolean(market));
    const base={status,targetAt,maxToleranceMs,delayMs:now-targetAtMs,sourcePriceUsd:source,observedAt:market?.observedAt??targetAt,data:{targetAt:targetAt.toISOString(),maxToleranceMs,actualObservedAt:market?.observedAt?.toISOString()??null,workerDelayMs:now-targetAtMs} as any};
    if(status==="MISSING"){
      missing++;await upsertObservation(signal,horizonSeconds,base);return;
    }
    if(status==="INVALID"){
      invalid++;await upsertObservation(signal,horizonSeconds,{...base,observedPriceUsd:market?.priceUsd,marketCapUsd:market?.marketCapUsd,liquidityUsd:market?.liquidityUsd});return;
    }
    const ret=(market!.priceUsd/source!-1)*100;
    if(status==="LATE")late++;else observed++;
    await upsertObservation(signal,horizonSeconds,{...base,observedPriceUsd:market!.priceUsd,returnPct:ret,marketCapUsd:market!.marketCapUsd,liquidityUsd:market!.liquidityUsd});
  }catch(e){errors++;throw e}
},{connection:redis,concurrency:40});

startHeartbeat("forward-worker",()=>({scheduled,observed,missing,late,invalid,errors}));
console.log("[forward-worker] running");
