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
// Real gap found by forensic audit (M-16/C-8): the platform's only user/admin-visible number was
// one opaque composite score. "87/100" answers nothing about WHY -- is it whale activity, raw
// momentum, or thin/risky liquidity carrying the number? Breakdown is purely additive/diagnostic:
// computed from the exact same BrainEvidence inputs as the score above, never fed back into it, so
// this cannot change any real trading decision -- it only explains one that's already made.
export type BrainBreakdown={momentum:number;smartMoney:number;executionQuality:number;risk:number;evidenceCompleteness:number};
// The persisted discovery-stage funnel (M-4/M-6/PC-F): every GlobalBrainOpportunity row's `state`
// column is one of these 4 values, written by brain-worker on every tick -- never client-computed,
// never a free-text string. This is deliberately separate from the read-time, staleness-aware
// `lifecycleStatus` (see classifyLifecycle below): that one can legitimately downgrade to STALE
// purely from data going quiet, which a persisted funnel stage must never do on its own.
export type BrainState="SCANNING"|"BUILDING"|"BREAKOUT_FLOW"|"MONEY_RUSH";
export type BrainDecision={score:number;action:"BUY_NOW"|"WATCH"|"IGNORE";state:BrainState;reasons:string[];warnings:string[];survivorScore:number;breakdown:BrainBreakdown};
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
  // Real bug found by audit (JS operator precedence, ?? binds looser than -): as written this
  // parsed as (e.narrativeScore ?? (50-50)) = (e.narrativeScore ?? 0), not the intended "center a
  // 0-100 narrative score around its neutral midpoint of 50, defaulting unknown to neutral." A
  // real narrativeScore was being added to the score in raw proportion to its own value (so even a
  // weak/negative 10/100 narrative ADDED +0.5 instead of correctly subtracting), while only the
  // unknown case coincidentally landed on the right answer (0). 50/100 must contribute ~0, not be
  // silently treated as positive evidence.
  score+=clamp(((e.narrativeScore??50)-50)*.05,-3,3);
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
  const state:BrainState=score>=86?"MONEY_RUSH":score>=76?"BREAKOUT_FLOW":score>=64?"BUILDING":"SCANNING";
  const action=score>=76?"BUY_NOW":score>=56?"WATCH":"IGNORE";
  const breakdown=scoreBreakdown(e,flowRatio,whaleDensity);
  return {score,action,state,reasons,warnings,survivorScore,breakdown};
}

// Same evidence, five human-legible lenses instead of one number. Each is independently clamped
// 0-100; none of these values feed back into `score` above or each other.
function scoreBreakdown(e:BrainEvidence,flowRatio:number,whaleDensity:number):BrainBreakdown{
  const momentum=clamp(
    clamp(Math.log10(1+e.inflow10sUsd)*9,0,26)+
    clamp(Math.log10(1+e.inflow60sUsd)*6,0,22)+
    clamp(e.buyers10s*2.6,0,20)+
    clamp((e.volumeAcceleration1m-1)*14,-10,22)+
    clamp((flowRatio-1)*10,-10,20)+
    clamp((e.holderGrowth5mPct??0)*1,-8,10)
  );
  const smartMoney=clamp(
    clamp(whaleDensity*9,0,55)+
    clamp(e.knownWhaleBuyers60s*15,0,30)+
    clamp((e.smartMoneyNetFlow5mUsd??0)/Math.max(5000,e.liquidityUsd)*40,-15,25)
  );
  // A proxy for "can real size actually get filled here" from evidence Brain already has (no quote
  // exists yet at this stage -- the executor's own price-impact check at quote time remains the
  // actual authority on executability; this is explanatory, not a promise).
  const executionQuality=clamp(
    clamp(Math.log10(1+e.liquidityUsd)*14,0,70)-
    clamp(Math.max(0,(e.top10EffectivePct??0)-40)*.6,0,30)
  );
  const risk=clamp(
    clamp(Math.max(0,-(e.liquidityChange5mPct??0))*.8,0,30)+
    clamp((e.creatorNetSell5mPct??0)*.4,0,30)+
    clamp((e.socialSpamRatio??0)*100*.25,0,15)+
    clamp(Math.max(0,(e.top10EffectivePct??0)-50)*.5,0,25)+
    (e.liquidityUsd<5_000?15:0)
  );
  // How many of the OPTIONAL evidence fields (provider-dependent; can genuinely be unavailable) are
  // actually present. Same UNKNOWN-!=-SAFE discipline as packages/discovery's evidenceCompleteness:
  // this number existing lets a caller distinguish "confidently evaluated" from "mostly guessed."
  const optionalFields:(keyof BrainEvidence)[]=["holderGrowth5mPct","smartMoneyNetFlow5mUsd","socialVelocity","socialSpamRatio","narrativeScore","liquidityChange5mPct","creatorNetSell5mPct","top10EffectivePct","marketCapUsd"];
  const present=optionalFields.filter(k=>e[k]!==undefined).length;
  const evidenceCompleteness=Math.round((present/optionalFields.length)*100);
  return {momentum:Math.round(momentum),smartMoney:Math.round(smartMoney),executionQuality:Math.round(executionQuality),risk:Math.round(risk),evidenceCompleteness};
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
export const STATE_RANK:Record<BrainState,number>={SCANNING:0,BUILDING:1,BREAKOUT_FLOW:2,MONEY_RUSH:3};
export function didStateUpgrade(priorNotifiedState:BrainState|null|undefined,newState:BrainState):boolean{
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

// Real gap found by forensic audit (M-15/PC-H): convergence used to count every tracked wallet
// identically -- "2 PAPER_TRACKING wallets" and "2 PROVEN wallets" registered as the same evidence
// strength, when a PROVEN wallet has cleared a real, objective bar (packages/discovery's
// shouldProve) that a PAPER_TRACKING one hasn't yet. Weighting PROVEN higher means fewer
// higher-quality wallets can register the same convergence signal as more lower-quality ones,
// matching the master spec's own example: "3 PROVEN wallets entering carries more credibility than
// 3 unknown buyers." Fed into the exact same isNewConvergence() dedup above -- only what number
// gets passed in changes, not the dedup logic itself.
const CONVERGENCE_WEIGHT:Record<string,number>={PROVEN:2,PAPER_TRACKING:1};
export function weightedConvergenceScore(wallets:{stage:string}[]):number{
  return wallets.reduce((sum,w)=>sum+(CONVERGENCE_WEIGHT[w.stage]??0),0);
}

// Extracted so the dedup logic itself is directly testable without a database (same rationale as
// didStateUpgrade/isNewConvergence above). Real bug this replaced: the inline version in
// brain-worker counted raw BUY EVENTS per wallet-tier filter, not distinct wallets -- one whale
// buying 4 times in 60s reported as "4 whales", not "1 whale, 4 buys", and fed directly into
// evaluateOpportunity's whaleDensity (real scoring, not just display).
export function countUniqueWhaleWallets(rows:{walletAddress:string;walletTier?:string|null}[]):number{
  return new Set(rows.filter(r=>String(r.walletTier??"").startsWith("WHALE_")).map(r=>r.walletAddress)).size;
}
export function countUniqueKnownWallets(rows:{walletAddress:string;knownWallet?:boolean|null}[]):number{
  return new Set(rows.filter(r=>r.knownWallet).map(r=>r.walletAddress)).size;
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
