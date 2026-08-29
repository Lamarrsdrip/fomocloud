export type BrainEvidence={
  marketCapUsd?:number; liquidityUsd:number; ageMinutes:number;
  inflow10sUsd:number; inflow60sUsd:number; buyers10s:number; buyers60s:number;
  whaleBuyers60s:number; knownWhaleBuyers60s:number;
  volumeAcceleration1m:number; volumeAcceleration5m:number;
  buyVolume5mUsd:number; sellVolume5mUsd:number;
  uniqueBuyers1m:number; uniqueBuyers5m:number;
  holderGrowth5mPct?:number; smartMoneyNetFlow5mUsd?:number;
  socialVelocity?:number; socialSpamRatio?:number; narrativeScore?:number;
  liquidityChange5mPct?:number; creatorNetSell5mPct?:number; top10EffectivePct?:number;
  drawdownFromRecentPeakPct?:number; catalystBoost?:number;
};
export type BrainDecision={score:number;action:"BUY_NOW"|"WATCH"|"IGNORE";state:string;reasons:string[];warnings:string[];survivorScore:number};
const clamp=(n:number,a=0,b=100)=>Math.min(b,Math.max(a,n));
const ratio=(a:number,b:number)=>a/Math.max(1,b);

/**
 * Professional-degen scoring: violent price history, concentration, funny narrative, or a deep dip
 * are not automatic blockers. The brain asks whether capital, buyers, liquidity and attention are
 * accelerating NOW. Execution impossibility is handled later by the execution adapter.
 */
export function evaluateOpportunity(e:BrainEvidence):BrainDecision{
  const reasons:string[]=[], warnings:string[]=[];
  const flowRatio=ratio(e.buyVolume5mUsd,e.sellVolume5mUsd);
  const whaleDensity=e.whaleBuyers60s+e.knownWhaleBuyers60s*1.5;
  let score=24;
  score+=clamp(Math.log10(1+e.inflow10sUsd)*7,0,22);
  score+=clamp(Math.log10(1+e.inflow60sUsd)*5,0,20);
  score+=clamp(e.buyers10s*2.2,0,18);
  score+=clamp(e.buyers60s*.45,0,14);
  score+=clamp(whaleDensity*3.1,0,20);
  score+=clamp((e.volumeAcceleration1m-1)*10, -8,18);
  score+=clamp((flowRatio-1)*8,-10,16);
  score+=clamp((e.holderGrowth5mPct??0)*.8,-5,10);
  score+=clamp((e.smartMoneyNetFlow5mUsd??0)/Math.max(5000,e.liquidityUsd)*18,-8,14);
  score+=clamp(((e.socialVelocity??1)-1)*5,-4,10);
  score+=clamp((e.narrativeScore??50-50)*.05,-3,3);
  score+=clamp(e.catalystBoost??0,0,15);
  const dd=Math.max(0,e.drawdownFromRecentPeakPct??0);
  const survivorScore=clamp((dd>=45?20:0)+(dd>=65?20:0)+Math.min(25,e.buyers60s*.7)+Math.min(20,whaleDensity*3)+Math.min(15,Math.max(0,e.volumeAcceleration1m-1)*8));
  if(dd>=45&&survivorScore>=55){score+=10;reasons.push("Deep-dip survivor is attracting fresh capital again");}
  if(e.inflow10sUsd>=10_000)reasons.push(`$${Math.round(e.inflow10sUsd).toLocaleString()} entered in ~10s`);
  if(e.buyers10s>=5)reasons.push(`${e.buyers10s} buyers arrived in ~10s`);
  if(e.whaleBuyers60s>=2)reasons.push(`${e.whaleBuyers60s} $50K+ wallet(s) joined the flow`);
  if(e.knownWhaleBuyers60s>=1)reasons.push(`${e.knownWhaleBuyers60s} known whale/KOL wallet(s) are buying`);
  if(e.volumeAcceleration1m>=1.5)reasons.push(`Volume acceleration ${e.volumeAcceleration1m.toFixed(1)}x`);
  if(flowRatio>=1.5)reasons.push(`Buy money is ${flowRatio.toFixed(1)}x sell money`);
  if((e.socialVelocity??0)>=1.5)reasons.push("Social attention is accelerating behind the flow");
  if((e.liquidityChange5mPct??0)<-45)warnings.push("Liquidity is falling quickly");
  if((e.creatorNetSell5mPct??0)>50)warnings.push("Creator/dev selling is heavy");
  if((e.socialSpamRatio??0)>.75)warnings.push("Social activity looks heavily automated");
  if(e.liquidityUsd<5_000)warnings.push("Very thin liquidity: execution quality must be checked at actual size");
  score=clamp(Math.round(score));
  const state=score>=86?"MONEY_RUSH":score>=76?"BREAKOUT_FLOW":score>=64?"BUILDING":"SCANNING";
  const action=score>=76?"BUY_NOW":score>=56?"WATCH":"IGNORE";
  return {score,action,state,reasons,warnings,survivorScore};
}

// DISCOVERY != AUTO-TRADE QUALIFICATION. action:"IGNORE" (score<56) is the trading-decision
// threshold and must gate execution, not visibility -- a token with real, non-zero evidence below
// that bar is still a genuine discovery worth showing. lastEvaluatedAt alone is never sufficient
// evidence on its own (a worker touches it every tick regardless of real flow); a genuinely-recent
// firstSeenAt covers a just-discovered token that hasn't accumulated scored evidence yet.
export type LifecycleRow={score:number;lastEvaluatedAt:Date;firstSeenAt:Date;inflow60sUsd:number;buyers60s:number;whaleBuyers60s:number;knownWhaleBuyers60s:number};
export function classifyLifecycle(row:LifecycleRow,now:number):string{
  // A worker stopped evaluating this token (dropped out of the snapshot pipeline) -- never let it
  // keep looking "live" just because the row still exists in the database.
  if(now-row.lastEvaluatedAt.getTime()>15*60_000)return "STALE";
  if(row.score>=86)return "HIGH_CONVICTION";
  if(row.score>=76)return "STRONG";
  if(row.score>=64)return "HEATING_UP";
  if(row.score>=56)return "INTERESTING";
  const hasEvidence=row.inflow60sUsd>0||row.buyers60s>0||row.whaleBuyers60s>0||row.knownWhaleBuyers60s>0;
  if(hasEvidence)return "WATCHING";
  if(now-row.firstSeenAt.getTime()<10*60_000)return "FOUND";
  return "COOLING";
}

// Real state ranking behind brain-worker's "notify exactly once per genuine upgrade" rule.
// Extracted as a pure function (was inline in the worker's tick()) so the dedup logic itself is
// directly testable without a database.
export const STATE_RANK:Record<string,number>={SCANNING:0,BUILDING:1,BREAKOUT_FLOW:2,MONEY_RUSH:3};
export function didStateUpgrade(priorNotifiedState:string|null|undefined,newState:string):boolean{
  const priorRank=STATE_RANK[priorNotifiedState??"SCANNING"]??0;
  const newRank=STATE_RANK[newState]??0;
  return newRank>priorRank&&newRank>0;
}

// Convergence notifications must fire exactly once per genuine increase in tracked-smart-wallet
// count, never repeatedly for the same count on every tick, and never for a single wallet (which
// isn't "convergence" -- that's just one wallet buying, already covered by ordinary evidence).
export function isNewConvergence(convergentCount:number,priorConvergentCount:number):boolean{
  return convergentCount>=2&&convergentCount>priorConvergentCount;
}

export function walletTier(balanceUsd?:number){
  const b=Number(balanceUsd??0);
  if(b>=10_000_000)return "WHALE_10M";
  if(b>=2_000_000)return "WHALE_2M";
  if(b>=1_000_000)return "WHALE_1M";
  if(b>=100_000)return "WHALE_100K";
  if(b>=50_000)return "WHALE_50K";
  return "FLOW";
}
