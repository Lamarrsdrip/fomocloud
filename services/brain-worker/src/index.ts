import crypto from "node:crypto";
import {Queue} from "bullmq";
import {Redis} from "ioredis";
import {db,type Chain} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {evaluateOpportunity,didStateUpgrade,isNewConvergence} from "@memecloud/brain";

const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const signalQueue=new Queue("signals",{connection:redis});
const notificationQueue=new Queue("user-notifications",{connection:redis});
const USDC_SOL=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let scans=0,opportunities=0,signals=0,errors=0,lastBest:any=null,running=false;

async function systemTrader(){
  const handle="memecloud-global-brain";
  let t=await db.trader.findUnique({where:{handle}});
  if(!t)t=await db.trader.create({data:{handle,displayName:"MemeCloud Global Brain",bio:"Autonomous chain-wide capital-flow intelligence",category:"GLOBAL_BRAIN",verification:"VERIFIED",kind:"PLATFORM",enabled:true,featured:true,recommended:true,trackingStatus:"PROVEN"}});
  return t;
}
async function ensureBrainFollowers(traderId:string){
  const users=await db.user.findMany({where:{status:"ACTIVE",tradingSettings:{is:{autoCopyEnabled:true,globalBrainEnabled:true}}},include:{tradingSettings:true}});
  for(const u of users)await db.userFollow.upsert({where:{userId_traderId:{userId:u.id,traderId}},update:{mode:"AUTO_COPY"},create:{userId:u.id,traderId,mode:"AUTO_COPY",fixedAmountUsd:u.tradingSettings?.defaultAmountUsd??100,maxChasePct:0,maxPositionUsd:0,maxTotalExposureUsd:0,minLiquidityUsd:0,stopLossPct:null,exitMode:"ADAPTIVE"}}).catch(()=>{});
  return users;
}
async function context(chain:Chain,mint:string,s:any){
  const now=Date.now(),since10=new Date(now-10_000),since60=new Date(now-60_000),since10m=new Date(now-10*60_000);
  const [f10,f60,f10m,known,token,catalyst,peak]=await Promise.all([
    db.chainFlowObservation.findMany({where:{chain,mint,side:"BUY",observedAt:{gte:since10}},select:{walletAddress:true,amountUsd:true,walletTier:true,knownWallet:true}}),
    db.chainFlowObservation.findMany({where:{chain,mint,side:"BUY",observedAt:{gte:since60}},select:{walletAddress:true,amountUsd:true,walletTier:true,knownWallet:true}}),
    db.chainFlowObservation.findMany({where:{chain,mint,side:"BUY",observedAt:{gte:since10m}},select:{walletAddress:true}}),
    db.signal.count({where:{chain,action:"BUY",outputMint:mint,observedAt:{gte:since60}}}),
    db.discoveryToken.findUnique({where:{chain_mint:{chain,mint}}}).catch(()=>null),
    db.catalystEvent.findFirst({where:{chain,mint,announcedAt:{gte:new Date(now-72*60*60_000)}},orderBy:{announcedAt:"desc"}}),
    db.marketPrice.findMany({where:{chain,mint,observedAt:{gte:new Date(now-7*24*60*60_000)}},orderBy:{priceUsd:"desc"},take:1})
  ]);
  const sum=(x:any[])=>x.reduce((a,v)=>a+Number(v.amountUsd??0),0),uniq=(x:any[])=>new Set(x.map(v=>v.walletAddress)).size;
  const whale=(x:any[])=>x.filter(v=>String(v.walletTier??"").startsWith("WHALE_")).length;
  const peakPrice=Number(peak[0]?.priceUsd??s.priceUsd),dd=peakPrice>0?Math.max(0,(peakPrice-s.priceUsd)/peakPrice*100):0;
  // Convergence: how many of the wallets that bought this mint in the last 10 minutes are
  // wallets MemeCloud itself has already built real evidence on (PAPER_TRACKING/PROVEN -- never
  // DISCOVERED-only, which hasn't cleared the sample-size bar yet). This is reported as a real
  // reason string, not folded into the scoring formula, so it can't silently change trading
  // decisions -- it's explanatory evidence per the "why was this found" requirement.
  const recentAddresses=[...new Set(f10m.map(v=>v.walletAddress))];
  const convergentWallets=recentAddresses.length?await db.smartWalletCandidate.findMany({where:{chain,address:{in:recentAddresses},stage:{in:["PAPER_TRACKING","PROVEN"]}},select:{address:true,stage:true}}):[];
  const evidence={marketCapUsd:s.marketCapUsd??undefined,liquidityUsd:s.liquidityUsd,ageMinutes:s.ageMinutes,inflow10sUsd:sum(f10),inflow60sUsd:sum(f60),buyers10s:uniq(f10),buyers60s:uniq(f60),whaleBuyers60s:whale(f60),knownWhaleBuyers60s:f60.filter(v=>v.knownWallet).length+known,volumeAcceleration1m:s.volumeAcceleration1m,volumeAcceleration5m:s.volumeAcceleration5m,buyVolume5mUsd:s.buyVolume5mUsd,sellVolume5mUsd:s.sellVolume5mUsd,uniqueBuyers1m:s.uniqueBuyers1m,uniqueBuyers5m:s.uniqueBuyers5m,holderGrowth5mPct:s.holderGrowth5mPct??undefined,smartMoneyNetFlow5mUsd:s.smartMoneyNetFlow5mUsd??undefined,socialVelocity:s.socialVelocity??undefined,socialSpamRatio:s.socialSpamRatio??undefined,narrativeScore:s.narrativeScore??undefined,liquidityChange5mPct:s.liquidityChange5mPct??undefined,creatorNetSell5mPct:s.creatorNetSell5mPct??undefined,top10EffectivePct:s.top10EffectivePct??undefined,drawdownFromRecentPeakPct:dd,catalystBoost:catalyst?10:0};
  return {evidence,token,catalyst,convergentWallets};
}
async function notifyUsers(opp:any,users:any[]){
  if(opp.score<65)return;
  const title=opp.action==="BUY_NOW"?`MemeCloud found fast money: ${opp.symbol||"token"}`:`MemeCloud is watching ${opp.symbol||"a token"}`;
  const body=`${opp.buyers10s} buyers in ~10s · ${opp.whaleBuyers60s+opp.knownWhaleBuyers60s} whale/known-wallet signals · score ${Math.round(opp.score)}/100 · ${opp.mint}`;
  for(const u of users){
    const key=`brain:${opp.id}:${Math.floor(Date.now()/60_000)}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:opp.id,chain:opp.chain,mint:opp.mint,score:opp.score,action:opp.action} as any}}).catch(()=>null);
    if(e)await notificationQueue.add("notify",{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{url:"/app/?view=discover",mint:opp.mint,chain:opp.chain},deliveryKey:key},{jobId:key,removeOnComplete:1000,attempts:2}).catch(()=>{});
  }
}
async function maybeSignal(opp:any,trader:any,users:any[]){
  const cfg=await getConfig<any>("brain");
  const threshold=Math.max(1,Math.min(100,Number(cfg?.autoEntryScore??76)));
  if(opp.action!=="BUY_NOW"||opp.score<threshold)return;
  const bucket=Math.floor(Date.now()/30_000),key=crypto.createHash("sha256").update(`BRAIN:${opp.chain}:${opp.mint}:${bucket}`).digest("hex");
  const existing=await db.signal.findUnique({where:{idempotencyKey:key}});if(existing)return;
  const snap=await db.memeMarketSnapshot.findFirst({where:{chain:opp.chain,mint:opp.mint},orderBy:{observedAt:"desc"}});if(!snap)return;
  const inputMint=opp.chain==="SOLANA"?USDC_SOL:"USDC";
  const signal=await db.signal.create({data:{idempotencyKey:key,chain:opp.chain,traderId:trader.id,sourceWallet:"GLOBAL_BRAIN",sourceTx:`brain:${opp.id}:${bucket}`,action:"BUY",inputMint,outputMint:opp.mint,inputRaw:"0",outputRaw:"0",sourcePriceUsd:snap.priceUsd,sourcePriceMethod:"GLOBAL_BRAIN_MARK",sourceMarketCapUsd:snap.marketCapUsd,observedAt:new Date(),status:"DETECTED"}});
  await signalQueue.add("source-signal",{signalId:signal.id},{jobId:signal.id,attempts:5,backoff:{type:"exponential",delay:250},removeOnComplete:1000});signals++;
  await notifyUsers(opp,users);
}
async function sampleOutcomes(){
  const horizons=[5,30,60,300,3600];
  const rows=await db.globalBrainOpportunity.findMany({where:{createdAt:{gte:new Date(Date.now()-2*60*60_000)}},take:300});
  for(const o of rows){for(const h of horizons){if(Date.now()-o.firstSeenAt.getTime()<h*1000)continue;const prior=await db.brainOutcomeSample.findUnique({where:{opportunityId_horizonSeconds:{opportunityId:o.id,horizonSeconds:h}}});if(prior)continue;const entry=await db.marketPrice.findFirst({where:{chain:o.chain,mint:o.mint,observedAt:{gte:o.firstSeenAt}},orderBy:{observedAt:"asc"}}),obs=await db.marketPrice.findFirst({where:{chain:o.chain,mint:o.mint,observedAt:{gte:new Date(o.firstSeenAt.getTime()+h*1000)}},orderBy:{observedAt:"asc"}});if(!entry||!obs)continue;const ret=(obs.priceUsd-entry.priceUsd)/entry.priceUsd*100;await db.brainOutcomeSample.create({data:{opportunityId:o.id,chain:o.chain,mint:o.mint,horizonSeconds:h,entryPriceUsd:entry.priceUsd,observedPriceUsd:obs.priceUsd,returnPct:ret,observedAt:obs.observedAt,evidence:{score:o.score,state:o.state,action:o.action} as any}}).catch(()=>{});}}
}
// Discovery notifications, deliberately independent of trading. maybeSignal()/notifyUsers() below
// only ever reaches users with autoCopyEnabled+globalBrainEnabled -- that's correct for the
// auto-trade signal path, but wrong for "tell me what you found," which must work with 0 wallets
// and Live Trading off. Fires exactly once per genuine state upgrade (never on every tick a token
// happens to still be in that state) by comparing against the row's own lastNotifiedState.
const STATE_PREF:Record<string,string>={BUILDING:"discoveryHeatingUp",BREAKOUT_FLOW:"discoveryStrong",MONEY_RUSH:"discoveryHighConviction"};
const STATE_TITLE:Record<string,string>={BUILDING:"is heating up",BREAKOUT_FLOW:"looks strong",MONEY_RUSH:"is a high-conviction opportunity"};
let discoveryNotifiedUsers:any[]|null=null,discoveryNotifiedUsersAt=0;
async function discoverySubscribers(){
  if(discoveryNotifiedUsers&&Date.now()-discoveryNotifiedUsersAt<60_000)return discoveryNotifiedUsers;
  discoveryNotifiedUsers=await db.user.findMany({where:{status:"ACTIVE",notificationPrefs:{is:{OR:[{discoveryHeatingUp:true},{discoveryStrong:true},{discoveryHighConviction:true}]}}},include:{notificationPrefs:true}});
  discoveryNotifiedUsersAt=Date.now();
  return discoveryNotifiedUsers;
}
async function notifyDiscoveryUpgrade(row:any,newState:string){
  const pref=STATE_PREF[newState];if(!pref)return;
  const subs=await discoverySubscribers();
  const title=`${row.symbol||"A token"} ${STATE_TITLE[newState]||"moved to "+newState}`;
  const body=`${row.reasons?.[0]||`Score ${Math.round(row.score)}/100`} · ${row.chain} · ${row.mint}`;
  for(const u of subs){
    if(!(u.notificationPrefs as any)?.[pref])continue;
    const key=`discovery:${row.id}:${newState}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:row.id,chain:row.chain,mint:row.mint,score:row.score,state:newState} as any}}).catch(()=>null);
    if(e)await notificationQueue.add("notify",{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{url:"/app/?view=discover",mint:row.mint,chain:row.chain},deliveryKey:key},{jobId:key,removeOnComplete:1000,attempts:2}).catch(()=>{});
  }
}
async function notifyConvergence(row:any,count:number){
  const subs=await discoverySubscribers();
  const title=`${count} tracked smart wallets entered ${row.symbol||"a token"}`;
  const body=`${count} wallets MemeCloud has already built real evidence on bought this within 10 minutes · ${row.chain} · ${row.mint}`;
  for(const u of subs){
    if(!(u.notificationPrefs as any)?.discoverySmartWallet)continue;
    const key=`convergence:${row.id}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:row.id,chain:row.chain,mint:row.mint,convergentWallets:count} as any}}).catch(()=>null);
    if(e)await notificationQueue.add("notify",{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{url:"/app/?view=discover",mint:row.mint,chain:row.chain},deliveryKey:key},{jobId:key,removeOnComplete:1000,attempts:2}).catch(()=>{});
  }
}
async function tick(){
  if(running)return;running=true;
  try{
    const cfg=await getConfig<any>("brain"),maxAge=Math.max(5_000,Number(cfg?.snapshotMaxAgeMs??45_000));
    const snaps=await db.memeMarketSnapshot.findMany({where:{observedAt:{gte:new Date(Date.now()-maxAge)}},orderBy:{observedAt:"desc"},take:800});
    const latest=new Map<string,any>();for(const s of snaps){const k=`${s.chain}:${s.mint}`;if(!latest.has(k))latest.set(k,s)}
    const trader=await systemTrader(),users=await ensureBrainFollowers(trader.id);
    for(const s of latest.values()){
      const c=await context(s.chain,s.mint,s),d=evaluateOpportunity(c.evidence);
      const existing=await db.globalBrainOpportunity.findUnique({where:{chain_mint:{chain:s.chain,mint:s.mint}}});
      const upgraded=didStateUpgrade(existing?.lastNotifiedState,d.state);
      const convergentCount=c.convergentWallets.length;
      const priorConvergentCount=Number((existing?.evidence as any)?.convergentCount??0);
      const newConvergence=isNewConvergence(convergentCount,priorConvergentCount);
      // Real, explanatory evidence -- deliberately never folded into the scoring formula, so it
      // can't silently change a trading decision. "Why was this found" per the audit's requirement.
      const reasons=newConvergence?[`${convergentCount} tracked smart wallet(s) entered within 10 minutes`,...d.reasons]:d.reasons;
      const data:any={symbol:c.token?.symbol,name:c.token?.name,state:d.state,score:d.score,action:d.action,marketCapUsd:s.marketCapUsd,liquidityUsd:s.liquidityUsd,inflow10sUsd:c.evidence.inflow10sUsd,inflow60sUsd:c.evidence.inflow60sUsd,buyers10s:c.evidence.buyers10s,buyers60s:c.evidence.buyers60s,whaleBuyers60s:c.evidence.whaleBuyers60s,knownWhaleBuyers60s:c.evidence.knownWhaleBuyers60s,smartMoneyNetFlow5mUsd:s.smartMoneyNetFlow5mUsd,volumeAcceleration1m:s.volumeAcceleration1m,holderGrowth5mPct:s.holderGrowth5mPct,socialVelocity:s.socialVelocity,drawdownFromRecentPeakPct:c.evidence.drawdownFromRecentPeakPct,survivorScore:d.survivorScore,reasons:reasons as any,evidence:{warnings:d.warnings,catalyst:c.catalyst?.type,convergentCount} as any,lastEvaluatedAt:new Date(),...(upgraded?{lastNotifiedState:d.state}:{})};
      const row=await db.globalBrainOpportunity.upsert({where:{chain_mint:{chain:s.chain,mint:s.mint}},create:{chain:s.chain,mint:s.mint,...data},update:data});
      scans++;if(d.action!=="IGNORE")opportunities++;
      if(!lastBest||row.score>lastBest.score)lastBest={chain:row.chain,mint:row.mint,symbol:row.symbol,score:row.score,action:row.action};
      if(upgraded)await notifyDiscoveryUpgrade(row,d.state).catch(e=>console.error("[brain-worker] discovery notify failed",row.mint,e));
      if(newConvergence)await notifyConvergence(row,convergentCount).catch(e=>console.error("[brain-worker] convergence notify failed",row.mint,e));
      await maybeSignal(row,trader,users);
    }
    await sampleOutcomes();
  }catch(e){errors++;console.error("[brain-worker]",e)}finally{running=false}
}
startHeartbeat("global-brain",()=>({scans,opportunities,signals,errors,lastBest,running,loopMs:750}));
setInterval(()=>void tick(),750);void tick();console.log("[brain-worker] Global Brain online");
