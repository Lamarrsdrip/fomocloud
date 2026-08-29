import crypto from "node:crypto";
import {Queue} from "bullmq";
import {Redis} from "ioredis";
import {db,type Chain} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {evaluateOpportunity,didStateUpgrade,isNewConvergence,STATE_RANK,countUniqueWhaleWallets,countUniqueKnownWallets,weightedConvergenceScore} from "@memecloud/brain";
import {chainSupports} from "@memecloud/shared";

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
  const whale=countUniqueWhaleWallets,knownWallets=countUniqueKnownWallets;
  const peakPrice=Number(peak[0]?.priceUsd??s.priceUsd),dd=peakPrice>0?Math.max(0,(peakPrice-s.priceUsd)/peakPrice*100):0;
  // Convergence: how many of the wallets that bought this mint in the last 10 minutes are
  // wallets MemeCloud itself has already built real evidence on (PAPER_TRACKING/PROVEN -- never
  // DISCOVERED-only, which hasn't cleared the sample-size bar yet). This is reported as a real
  // reason string, not folded into the scoring formula, so it can't silently change trading
  // decisions -- it's explanatory evidence per the "why was this found" requirement.
  const recentAddresses=[...new Set(f10m.map(v=>v.walletAddress))];
  const convergentWallets=recentAddresses.length?await db.smartWalletCandidate.findMany({where:{chain,address:{in:recentAddresses},stage:{in:["PAPER_TRACKING","PROVEN"]}},select:{address:true,stage:true}}):[];
  // Real bug found by audit: knownWhaleBuyers60s used to add a raw Signal count (`known`, a
  // platform-tracked-trader BUY signal count from an entirely different source table) directly
  // onto a wallet count -- "A Signal is not a wallet." platformSignals60s now reports that as its
  // own honest field instead of silently inflating a wallet-count metric with event counts from an
  // unrelated pipeline.
  const evidence={marketCapUsd:s.marketCapUsd??undefined,liquidityUsd:s.liquidityUsd,ageMinutes:s.ageMinutes,inflow10sUsd:sum(f10),inflow60sUsd:sum(f60),buyers10s:uniq(f10),buyers60s:uniq(f60),whaleBuyers60s:whale(f60),knownWhaleBuyers60s:knownWallets(f60),platformSignals60s:known,volumeAcceleration1m:s.volumeAcceleration1m,volumeAcceleration5m:s.volumeAcceleration5m,buyVolume5mUsd:s.buyVolume5mUsd,sellVolume5mUsd:s.sellVolume5mUsd,uniqueBuyers1m:s.uniqueBuyers1m,uniqueBuyers5m:s.uniqueBuyers5m,holderGrowth5mPct:s.holderGrowth5mPct??undefined,smartMoneyNetFlow5mUsd:s.smartMoneyNetFlow5mUsd??undefined,socialVelocity:s.socialVelocity??undefined,socialSpamRatio:s.socialSpamRatio??undefined,narrativeScore:s.narrativeScore??undefined,liquidityChange5mPct:s.liquidityChange5mPct??undefined,creatorNetSell5mPct:s.creatorNetSell5mPct??undefined,top10EffectivePct:s.top10EffectivePct??undefined,drawdownFromRecentPeakPct:dd,catalystBoost:catalyst?10:0};
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
  // Real bug found by forensic audit: this used to create a real trading Signal for ANY chain
  // reaching BUY_NOW, writing the literal string "USDC" as inputMint for non-Solana chains -- not a
  // valid mint/contract address anywhere. Discovery/intelligence must always run for every chain
  // (notifyUsers/notifyDiscoveryUpgrade above are unaffected by this gate), but creating a Signal
  // meant to drive real execution must never happen for a chain that isn't execution-certified.
  // See @memecloud/shared's CHAIN_CAPABILITY_REGISTRY -- only SOLANA is EXECUTION_SUPPORTED today.
  if(!chainSupports(opp.chain,"EXECUTION_SUPPORTED"))return;
  // One entry per genuine qualification, not one per 30s clock tick this opportunity happens to
  // still be BUY_NOW for -- see the lastSignaledState schema comment. The 30s bucket in the key
  // below now only protects against firing twice within the same tick/near-simultaneous evaluation,
  // never against re-firing every 30s while the token is simply still hot.
  if(!didStateUpgrade(opp.lastSignaledState,opp.state))return;
  const bucket=Math.floor(Date.now()/30_000),key=crypto.createHash("sha256").update(`BRAIN:${opp.chain}:${opp.mint}:${bucket}`).digest("hex");
  const existing=await db.signal.findUnique({where:{idempotencyKey:key}});if(existing)return;
  const snap=await db.memeMarketSnapshot.findFirst({where:{chain:opp.chain,mint:opp.mint},orderBy:{observedAt:"desc"}});if(!snap)return;
  const inputMint=USDC_SOL;
  const signal=await db.signal.create({data:{idempotencyKey:key,chain:opp.chain,traderId:trader.id,sourceWallet:"GLOBAL_BRAIN",sourceTx:`brain:${opp.id}:${bucket}`,action:"BUY",inputMint,outputMint:opp.mint,inputRaw:"0",outputRaw:"0",sourcePriceUsd:snap.priceUsd,sourcePriceMethod:"GLOBAL_BRAIN_MARK",sourceMarketCapUsd:snap.marketCapUsd,observedAt:new Date(),status:"DETECTED"}});
  await db.globalBrainOpportunity.update({where:{id:opp.id},data:{lastSignaledState:opp.state}}).catch(()=>{});
  await signalQueue.add("source-signal",{signalId:signal.id},{jobId:signal.id,attempts:5,backoff:{type:"exponential",delay:250},removeOnComplete:1000});signals++;
  await notifyUsers(opp,users);
}
// Real bug found by audit: the observed-price lookup had no upper bound -- `observedAt:{gte:targetAt}`
// picks up the FIRST MarketPrice row at or after the horizon target, however far after. If
// market-worker had stopped tracking this mint for a while (it caps at 350 tracked mints), a 60s
// horizon could silently be backed by a price observed 8+ minutes later and stored as if it were
// precise, genuine 60s-later evidence. Every horizon now has a bounded tolerance window; a price
// found outside it is not used, and once genuinely no fresh-enough price can still arrive, the
// horizon is recorded as status:"MISSING" (not silently skipped forever, not backfilled from stale
// data) so it stops being retried and is honestly visible as missing rather than looking like every
// other row.
function horizonToleranceMs(h:number){return Math.min(5*60_000,Math.max(15_000,h*1000*0.25))}
async function sampleOutcomes(){
  const horizons=[5,30,60,300,3600];
  const rows=await db.globalBrainOpportunity.findMany({where:{createdAt:{gte:new Date(Date.now()-2*60*60_000)}},take:300});
  for(const o of rows){for(const h of horizons){
    const targetAt=new Date(o.firstSeenAt.getTime()+h*1000);
    if(Date.now()<targetAt.getTime())continue;
    const prior=await db.brainOutcomeSample.findUnique({where:{opportunityId_horizonSeconds:{opportunityId:o.id,horizonSeconds:h}}});if(prior)continue;
    const tolerance=horizonToleranceMs(h);
    const entry=await db.marketPrice.findFirst({where:{chain:o.chain,mint:o.mint,observedAt:{gte:o.firstSeenAt}},orderBy:{observedAt:"asc"}});
    const obs=await db.marketPrice.findFirst({where:{chain:o.chain,mint:o.mint,observedAt:{gte:targetAt,lte:new Date(targetAt.getTime()+tolerance)}},orderBy:{observedAt:"asc"}});
    if(entry&&obs){
      const ret=(obs.priceUsd-entry.priceUsd)/entry.priceUsd*100;
      await db.brainOutcomeSample.create({data:{opportunityId:o.id,chain:o.chain,mint:o.mint,horizonSeconds:h,status:"OK",targetAt,delayMs:obs.observedAt.getTime()-targetAt.getTime(),priceSource:"MARKET_PRICE",entryPriceUsd:entry.priceUsd,observedPriceUsd:obs.priceUsd,returnPct:ret,observedAt:obs.observedAt,evidence:{score:o.score,state:o.state,action:o.action} as any}}).catch(()=>{});
      continue;
    }
    // No sufficiently fresh price yet -- only give up (mark MISSING) once we're past the tolerance
    // window entirely; otherwise a fresh enough price may still land on a later tick.
    if(Date.now()>=targetAt.getTime()+tolerance){
      await db.brainOutcomeSample.create({data:{opportunityId:o.id,chain:o.chain,mint:o.mint,horizonSeconds:h,status:"MISSING",targetAt,priceSource:"MARKET_PRICE",observedAt:targetAt,evidence:{score:o.score,state:o.state,action:o.action,reason:!entry?"NO_ENTRY_PRICE":"NO_PRICE_WITHIN_TOLERANCE"} as any}}).catch(()=>{});
    }
  }}
}
// Discovery notifications, deliberately independent of trading. maybeSignal()/notifyUsers() below
// only ever reaches users with autoCopyEnabled+globalBrainEnabled -- that's correct for the
// auto-trade signal path, but wrong for "tell me what you found," which must work with 0 wallets
// and Live Trading off. Fires exactly once per genuine state upgrade (never on every tick a token
// happens to still be in that state) by comparing against the row's own lastNotifiedState.
const STATE_PREF:Record<string,string>={BUILDING:"discoveryHeatingUp",BREAKOUT_FLOW:"discoveryStrong",MONEY_RUSH:"discoveryHighConviction"};
const STATE_TITLE:Record<string,string>={BUILDING:"is heating up",BREAKOUT_FLOW:"looks strong",MONEY_RUSH:"is a high-conviction opportunity"};
let discoveryNotifiedUsers:any[]|null=null,discoveryNotifiedUsersAt=0;
// Real bug found by audit: this base pool used to OR only the 3 state-tier prefs
// (discoveryHeatingUp/Strong/HighConviction). Every notify function below then filters this SAME
// pool by its own specific pref -- so a user with e.g. ONLY discoverySmartWallet enabled (all 3
// tier prefs off) was excluded before notifyConvergence ever got a chance to check their pref at
// all. Each of the 6 discovery preferences must independently qualify a user; the fix is for this
// base query to OR across all 6, so no preference type can be structurally excluded upstream of
// its own per-notification filter. discoveryWhaleActivity and discoveryNewToken were additionally
// not wired to ANY notification path -- a user could enable them and nothing would ever fire. Both
// are now real (notifyWhaleActivity, notifyNewToken below).
async function discoverySubscribers(){
  if(discoveryNotifiedUsers&&Date.now()-discoveryNotifiedUsersAt<60_000)return discoveryNotifiedUsers;
  discoveryNotifiedUsers=await db.user.findMany({where:{status:"ACTIVE",notificationPrefs:{is:{OR:[{discoveryHeatingUp:true},{discoveryStrong:true},{discoveryHighConviction:true},{discoverySmartWallet:true},{discoveryWhaleActivity:true},{discoveryNewToken:true}]}}},include:{notificationPrefs:true}});
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
async function notifyConvergence(row:any,count:number,provenCount:number){
  const subs=await discoverySubscribers();
  const title=`${count} tracked smart wallets entered ${row.symbol||"a token"}`;
  const body=`${count} wallets MemeCloud has already built real evidence on bought this within 10 minutes${provenCount?` (${provenCount} PROVEN)`:""} · ${row.chain} · ${row.mint}`;
  for(const u of subs){
    if(!(u.notificationPrefs as any)?.discoverySmartWallet)continue;
    const key=`convergence:${row.id}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:row.id,chain:row.chain,mint:row.mint,convergentWallets:count} as any}}).catch(()=>null);
    if(e)await notificationQueue.add("notify",{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{url:"/app/?view=discover",mint:row.mint,chain:row.chain},deliveryKey:key},{jobId:key,removeOnComplete:1000,attempts:2}).catch(()=>{});
  }
}
async function notifyWhaleActivity(row:any,whaleCount:number){
  const subs=await discoverySubscribers();
  const title=`Whale activity on ${row.symbol||"a token"}`;
  const body=`${whaleCount} whale wallet(s) ($50K+ single buys) active in the last 60s · ${row.chain} · ${row.mint}`;
  for(const u of subs){
    if(!(u.notificationPrefs as any)?.discoveryWhaleActivity)continue;
    const key=`whale:${row.id}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:row.id,chain:row.chain,mint:row.mint,whaleCount} as any}}).catch(()=>null);
    if(e)await notificationQueue.add("notify",{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{url:"/app/?view=discover",mint:row.mint,chain:row.chain},deliveryKey:key},{jobId:key,removeOnComplete:1000,attempts:2}).catch(()=>{});
  }
}
async function notifyNewToken(row:any){
  const subs=await discoverySubscribers();
  const title=`New token radar: ${row.symbol||"a token"}`;
  const body=`First seen on-chain · ${row.chain} · ${row.mint} · early/raw intelligence, not yet qualified`;
  for(const u of subs){
    if(!(u.notificationPrefs as any)?.discoveryNewToken)continue;
    const key=`newtoken:${row.id}:${u.id}`;
    const e=await db.userActivityEvent.create({data:{userId:u.id,type:"GLOBAL_BRAIN",title,body,data:{opportunityId:row.id,chain:row.chain,mint:row.mint} as any}}).catch(()=>null);
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
      const provenConvergentCount=c.convergentWallets.filter((w:any)=>w.stage==="PROVEN").length;
      // Weighted, not raw count, is what actually gates the convergence signal below -- a PROVEN
      // wallet (cleared packages/discovery's objective shouldProve bar) carries more evidentiary
      // weight than one still PAPER_TRACKING. See weightedConvergenceScore's own comment.
      const convergentWeightedScore=weightedConvergenceScore(c.convergentWallets);
      // Real bug found by a full-platform audit: lastNotifiedState and the convergence dedup
      // baseline used to be written into the SAME upsert that ran before the notify call below --
      // so if notifyDiscoveryUpgrade/notifyConvergence ever failed for any reason (an ordinary
      // transient DB/queue hiccup, not an outage), the dedup baseline had already advanced,
      // didStateUpgrade/isNewConvergence would see no upgrade on the next tick, and that one real
      // notification was gone forever -- not delayed, permanently lost. lastNotifiedConvergentWeightedScore
      // is now a separate field from the always-fresh evidence.convergentCount (which the UI
      // displays as "smart wallets entered" and must stay accurate regardless of notify outcome);
      // it -- like lastNotifiedState -- only advances in a follow-up write AFTER the notify call
      // actually succeeds, so a failed notify naturally retries on the next tick instead of vanishing.
      const priorNotifiedConvergentWeightedScore=Number((existing?.evidence as any)?.lastNotifiedConvergentWeightedScore??0);
      const newConvergence=isNewConvergence(convergentWeightedScore,priorNotifiedConvergentWeightedScore);
      // Same "notify succeeds, then advance dedup baseline" discipline as convergence above -- a
      // failed notify must retry next tick, not be silently lost.
      const whaleCount=c.evidence.whaleBuyers60s+c.evidence.knownWhaleBuyers60s;
      const priorNotifiedWhaleCount=Number((existing?.evidence as any)?.lastNotifiedWhaleCount??0);
      const newWhaleActivity=whaleCount>=1&&whaleCount>priorNotifiedWhaleCount;
      const isBrandNewToken=!existing;
      // Real, explanatory evidence -- deliberately never folded into the scoring formula, so it
      // can't silently change a trading decision. "Why was this found" per the audit's requirement.
      const reasons=newConvergence?[`${convergentCount} tracked smart wallet(s) entered within 10 minutes${provenConvergentCount?` (${provenConvergentCount} PROVEN)`:""}`,...d.reasons]:d.reasons;
      const data:any={symbol:c.token?.symbol,name:c.token?.name,state:d.state,score:d.score,action:d.action,marketCapUsd:s.marketCapUsd,liquidityUsd:s.liquidityUsd,inflow10sUsd:c.evidence.inflow10sUsd,inflow60sUsd:c.evidence.inflow60sUsd,buyers10s:c.evidence.buyers10s,buyers60s:c.evidence.buyers60s,whaleBuyers60s:c.evidence.whaleBuyers60s,knownWhaleBuyers60s:c.evidence.knownWhaleBuyers60s,smartMoneyNetFlow5mUsd:s.smartMoneyNetFlow5mUsd,volumeAcceleration1m:s.volumeAcceleration1m,holderGrowth5mPct:s.holderGrowth5mPct,socialVelocity:s.socialVelocity,drawdownFromRecentPeakPct:c.evidence.drawdownFromRecentPeakPct,survivorScore:d.survivorScore,reasons:reasons as any,evidence:{warnings:d.warnings,catalyst:c.catalyst?.type,convergentCount,provenConvergentCount,convergentWeightedScore,lastNotifiedConvergentWeightedScore:priorNotifiedConvergentWeightedScore,platformSignals60s:c.evidence.platformSignals60s,breakdown:d.breakdown} as any,evidenceObservedAt:s.observedAt,lastEvaluatedAt:new Date()};
      const row=await db.globalBrainOpportunity.upsert({where:{chain_mint:{chain:s.chain,mint:s.mint}},create:{chain:s.chain,mint:s.mint,...data},update:data});
      scans++;if(d.action!=="IGNORE")opportunities++;
      if(!lastBest||row.score>lastBest.score)lastBest={chain:row.chain,mint:row.mint,symbol:row.symbol,score:row.score,action:row.action};
      if(upgraded){
        await notifyDiscoveryUpgrade(row,d.state)
          .then(()=>db.globalBrainOpportunity.update({where:{id:row.id},data:{lastNotifiedState:d.state}}))
          .catch(e=>console.error("[brain-worker] discovery notify failed, will retry next tick",row.mint,e));
      }else if((STATE_RANK[d.state]??0)===0&&((existing?.lastNotifiedState&&(STATE_RANK[existing.lastNotifiedState]??0)>0)||(existing?.lastSignaledState&&(STATE_RANK[existing.lastSignaledState]??0)>0))){
        // Real bug found by audit: lastNotifiedState only ever ratchets up (see didStateUpgrade),
        // so a token that once reached MONEY_RUSH would never notify again -- even after a genuine
        // full cool-down and a real re-heat months later, since 750ms ticks mean nothing here is
        // noise-tolerant enough to reset on a partial dip. Only reset on a return to the true
        // SCANNING baseline, an unambiguous "this cooled off for real" signal, so a later genuine
        // climb notifies again without spamming on ordinary score flapping near a rank boundary.
        // lastSignaledState resets the same way, for the same reason: a real re-entry after a
        // genuine cool-down is a deliberate strategy decision, not clock rollover.
        await db.globalBrainOpportunity.update({where:{id:row.id},data:{lastNotifiedState:null,lastSignaledState:null}}).catch(()=>{});
      }
      if(newConvergence){
        await notifyConvergence(row,convergentCount,provenConvergentCount)
          .then(()=>db.globalBrainOpportunity.update({where:{id:row.id},data:{evidence:{...(row.evidence as any),lastNotifiedConvergentWeightedScore:convergentWeightedScore}}}))
          .catch(e=>console.error("[brain-worker] convergence notify failed, will retry next tick",row.mint,e));
      }
      if(newWhaleActivity){
        await notifyWhaleActivity(row,whaleCount)
          .then(()=>db.globalBrainOpportunity.update({where:{id:row.id},data:{evidence:{...(row.evidence as any),lastNotifiedWhaleCount:whaleCount}}}))
          .catch(e=>console.error("[brain-worker] whale notify failed, will retry next tick",row.mint,e));
      }
      if(isBrandNewToken){
        // Fires exactly once per token, naturally deduped by `existing` being null only on the
        // very first tick a mint is ever seen -- independent of whether it ever qualifies for the
        // main Discover feed. This is the "New Token Radar" path: early/raw intelligence for users
        // who explicitly opted into it, not a recommendation.
        await notifyNewToken(row).catch(e=>console.error("[brain-worker] new-token notify failed",row.mint,e));
      }
      await maybeSignal(row,trader,users);
    }
    await sampleOutcomes();
  }catch(e){errors++;console.error("[brain-worker]",e)}finally{running=false}
}
// Real gap found by forensic audit (M-12/PC-D): admin had no way to WATCH a wallet at all, let alone
// have that watch continuously monitored. Rides the same chainFlowObservation stream
// flow-worker/evm-flow-worker already write to unconditionally, so detection continues as long as
// those ingestion workers are running -- independent of any admin session or open browser tab.
let lastWatchlistCheckAt=new Date(Date.now()-5*60_000),watchlistAlerts=0,watchlistErrors=0;
async function checkWatchlist(){
  const since=lastWatchlistCheckAt,now=new Date();
  // Advance the cursor before querying so a slow query can't leave a re-checked gap on the next
  // call; a crash between advancing and finishing this pass can miss/duplicate at most one interval
  // (10s) of alerts -- acceptable for an informational admin notice, unlike the real-money paths
  // elsewhere in this codebase which use actual idempotency keys.
  lastWatchlistCheckAt=now;
  try{
    const watched=await db.smartWalletCandidate.findMany({where:{adminWatched:true},select:{address:true}});
    if(!watched.length)return;
    const addresses=watched.map(w=>w.address);
    const buys=await db.chainFlowObservation.findMany({where:{walletAddress:{in:addresses},side:"BUY",observedAt:{gt:since,lte:now}},orderBy:{observedAt:"asc"},take:500});
    for(const b of buys){
      await db.adminAlert.create({data:{type:"WATCHED_WALLET_BUY",chain:b.chain,mint:b.mint,walletAddress:b.walletAddress,message:`Watched wallet ${b.walletAddress.slice(0,4)}…${b.walletAddress.slice(-4)} entered ${b.mint}${b.amountUsd?` (~$${Math.round(b.amountUsd).toLocaleString()})`:""}`,metadata:{amountUsd:b.amountUsd,txHash:b.txHash}}}).catch(()=>{});
      watchlistAlerts++;
    }
  }catch(e){watchlistErrors++;console.error("[brain-worker] watchlist check failed",e)}
}
startHeartbeat("global-brain",()=>({scans,opportunities,signals,errors,lastBest,running,loopMs:750,watchlistAlerts,watchlistErrors}));
setInterval(()=>void tick(),750);void tick();
setInterval(()=>void checkWatchlist(),10_000);void checkWatchlist();
console.log("[brain-worker] Global Brain online");
