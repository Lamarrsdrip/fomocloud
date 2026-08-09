import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@fomocloud/db";
import { startHeartbeat } from "@fomocloud/ops";
import { calculateExitAccounting, calculatePositionMark } from "@fomocloud/shared";

const connection=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const notificationQueue=new Queue("user-notifications",{connection});
let scanned=0,marked=0,stale=0,errors=0,profitEvents=0,ticking=false;

async function userEvent(userId:string,type:string,title:string,body:string,data:Record<string,unknown>={}){
  const event=await db.userActivityEvent.create({data:{userId,type,title,body,data:data as any}});
  // The activity row is the durable event identity. Reusing it as BullMQ jobId +
  // Notification.deliveryKey prevents DB notification duplicates when a worker retries.
  await notificationQueue.add("notify",{userId,type,title,body,data,deliveryKey:event.id},{jobId:event.id,removeOnComplete:1000,attempts:3,backoff:{type:"exponential",delay:1000}});
}

/**
 * Simulation-only price floors. These do not invent momentum, volume or social evidence.
 * `takeProfitPct >= 75` uses the fresh-meme ladder (default 100/150/200, 30/20/15%
 * of the original position). Lower first targets use the established ladder (default
 * 50/100, 35/25%). The remainder is always a runner; there is deliberately no final TP.
 */
async function applySimulationProfitFloors(p:any,current:number,entry:number){
  let remaining=BigInt(p.remainingTokenRaw), original=BigInt(p.entryTokenRaw);
  if(remaining<=0n||original<=0n)return remaining;
  const gainPct=((current-entry)/entry)*100;
  const freshStyle=Number(p.takeProfitPct)>=75;
  const first=Math.max(1,Number(p.takeProfitPct));
  const ladder=freshStyle
    ? [{name:"TP1",target:first,partial:0.30},{name:"TP2",target:first+50,partial:0.20},{name:"TP3",target:first+100,partial:0.15}]
    : [{name:"TP1",target:first,partial:0.35},{name:"TP2",target:Math.max(100,first*2),partial:0.25}];
  const prior=await db.positionExit.findMany({where:{positionId:p.id,reason:{in:ladder.map(x=>`${x.name}_SIMULATION`)}} ,select:{reason:true}});
  const done=new Set(prior.map(x=>x.reason));

  for(const step of ladder){
    const reason=`${step.name}_SIMULATION`;
    if(gainPct+1e-9<step.target||done.has(reason)||remaining<=0n)continue;
    let rawToExit=(original*BigInt(Math.round(step.partial*1_000_000)))/1_000_000n;
    if(rawToExit<=0n)rawToExit=1n;
    if(rawToExit>remaining)rawToExit=remaining;
    const accounting=calculateExitAccounting({entryTokenRaw:p.entryTokenRaw,remainingTokenRaw:remaining.toString(),tokenRaw:rawToExit.toString(),costUsd:p.costUsd,avgEntryPriceUsd:entry,executionPriceUsd:current});
    const pnl=accounting.realizedPnlUsd;
    const next=BigInt(accounting.remainingTokenRaw);
    await db.$transaction([
      db.positionExit.create({data:{positionId:p.id,reason,tokenRaw:accounting.tokenRaw,proceedsUsd:accounting.netProceedsUsd,pnlUsd:pnl}}),
      db.position.update({where:{id:p.id},data:{remainingTokenRaw:next.toString(),realizedPnlUsd:{increment:pnl},profitTakenUsd:{increment:Math.max(0,pnl)},status:next<=0n?"CLOSED":"PARTIALLY_CLOSED",closedAt:next<=0n?new Date():undefined}})
    ]);
    remaining=next; done.add(reason); profitEvents++;
    await userEvent(
      p.userId,
      next<=0n?"POSITION_CLOSED":"PROFIT_TAKEN",
      `${step.name} profit taken in simulation`,
      `${step.name} triggered at +${step.target.toFixed(0)}%. ${Math.round(step.partial*100)}% of the original position was simulated as sold at the latest genuine market mark. The remaining runner stays open.`,
      {positionId:p.id,targetPct:step.target,partialPct:step.partial*100,pnlUsd:pnl,mode:"SIMULATION"}
    );
  }
  return remaining;
}

async function tick(){
  const positions=await db.position.findMany({where:{status:{in:["OPEN","PARTIALLY_CLOSED"]}},take:1000});
  scanned+=positions.length;
  for(const p of positions){
    try{
      if(!p.avgEntryPriceUsd||p.avgEntryPriceUsd<=0) continue;
      const price=await db.marketPrice.findFirst({where:{chain:p.chain,mint:p.mint},orderBy:{observedAt:"desc"}});
      if(!price || Date.now()-price.observedAt.getTime()>60_000){stale++;continue;}
      const current=price.priceUsd, entry=p.avgEntryPriceUsd;
      let remaining=BigInt(p.remainingTokenRaw);

      if(p.mode==="SIMULATION") remaining=await applySimulationProfitFloors(p,current,entry);

      const mark=calculatePositionMark({entryTokenRaw:p.entryTokenRaw,remainingTokenRaw:remaining.toString(),costUsd:p.costUsd,avgEntryPriceUsd:entry,currentPriceUsd:current});
      await db.position.update({
        where:{id:p.id},
        data:{
          currentPriceUsd:current,
          peakPriceUsd:Math.max(p.peakPriceUsd??entry,current),
          unrealizedPnlUsd:mark.unrealizedPnlUsd,
          lastMarkedAt:new Date()
        }
      });
      marked++;

      // The runner intentionally has no arbitrary final TP. Adaptive trailing still requires a
      // complete genuine market snapshot (flow/volume/liquidity/trend), so this worker never
      // fabricates those inputs. Live exits remain fail-closed until the reviewed signer exists.
    }catch(e){errors++;console.error("[exits]",p.id,e);}
  }
}
async function guardedTick(){
  if(ticking)return;
  ticking=true;
  try{await tick()}catch(e){errors++;console.error("[exits]",e)}finally{ticking=false}
}
startHeartbeat("exits",()=>({scanned,marked,stale,errors,profitEvents,ticking}));
setInterval(()=>void guardedTick(),3000);
void guardedTick();
console.log("[exits] monitoring positions");
