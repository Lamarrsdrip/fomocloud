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
  bundledSupplyPct?:number; creatorHoldingPct?:number; mintAuthorityActive?:boolean; freezeAuthorityActive?:boolean; token2022DangerousExtension?:boolean; lpRiskScore?:number;
  drawdownFromRecentPeakPct?:number; catalystBoost?:number;
  trackedSmartWallets?:number; provenSmartWallets?:number; smartWalletWeightedScore?:number;
};
export type BrainBreakdown={momentum:number;smartMoney:number;executionQuality:number;risk:number;evidenceCompleteness:number};
export type BrainState="SCANNING"|"BUILDING"|"BREAKOUT_FLOW"|"MONEY_RUSH";
export type BrainDecision={score:number;action:"BUY_NOW"|"WATCH"|"IGNORE";state:BrainState;reasons:string[];warnings:string[];survivorScore:number;breakdown:BrainBreakdown;evidenceChannels:number};
const clamp=(n:number,a=0,b=100)=>Math.min(b,Math.max(a,n));
const ratio=(a:number,b:number)=>a/Math.max(1,b);

function scoreBreakdown(e:BrainEvidence,flowRatio:number,whaleDensity:number):BrainBreakdown{
  const momentum=clamp(
    clamp(Math.log10(1+e.inflow10sUsd)*8,0,24)+
    clamp(Math.log10(1+e.inflow60sUsd)*5,0,20)+
    clamp(e.buyers10s*2.2,0,18)+
    clamp(e.buyers60s*.55,0,14)+
    clamp((e.volumeAcceleration1m-1)*15,-12,24)+
    clamp((flowRatio-1)*12,-12,22)+
    clamp((e.holderGrowth5mPct??0)*1.1,-8,12)
  );
  const smartMoney=clamp(
    clamp((e.smartWalletWeightedScore??0)*14,0,50)+
    clamp((e.provenSmartWallets??0)*12,0,30)+
    clamp(whaleDensity*8,0,35)+
    clamp((e.smartMoneyNetFlow5mUsd??0)/Math.max(5_000,e.liquidityUsd)*45,-15,30)
  );
  const executionQuality=clamp(
    clamp(Math.log10(1+e.liquidityUsd)*14,0,72)-
    clamp(Math.max(0,(e.top10EffectivePct??0)-45)*.55,0,28)
  );
  const criticalRiskFields=[e.liquidityChange5mPct,e.top10EffectivePct,e.bundledSupplyPct,e.creatorHoldingPct,e.lpRiskScore];
  const riskKnown=criticalRiskFields.filter(v=>v!==undefined).length/criticalRiskFields.length;
  // Unknown token structure is not the same as verified-safe structure. Add uncertainty risk instead
  // of silently substituting zero for every missing holder/LP field.
  const unknownRiskPenalty=(1-riskKnown)*24;
  const risk=clamp(
    clamp(Math.max(0,-(e.liquidityChange5mPct??0))*.85,0,32)+
    clamp((e.creatorNetSell5mPct??0)*.5,0,35)+
    clamp((e.socialSpamRatio??0)*100*.20,0,20)+
    clamp(Math.max(0,(e.top10EffectivePct??0)-60)*.45,0,20)+
    clamp(Math.max(0,(e.bundledSupplyPct??0)-20)*.7,0,24)+
    clamp(Math.max(0,(e.creatorHoldingPct??0)-10)*.8,0,20)+
    clamp((e.lpRiskScore??0)*.22,0,22)+unknownRiskPenalty+
    (e.mintAuthorityActive?8:0)+(e.freezeAuthorityActive?10:0)+(e.token2022DangerousExtension?15:0)+
    (e.liquidityUsd<5_000?20:0)
  );
  const optionalFields:(keyof BrainEvidence)[]=["holderGrowth5mPct","smartMoneyNetFlow5mUsd","socialVelocity","socialSpamRatio","narrativeScore","liquidityChange5mPct","creatorNetSell5mPct","top10EffectivePct","bundledSupplyPct","creatorHoldingPct","lpRiskScore","marketCapUsd","smartWalletWeightedScore"];
  const present=optionalFields.filter(k=>e[k]!==undefined).length;
  return {momentum:Math.round(momentum),smartMoney:Math.round(smartMoney),executionQuality:Math.round(executionQuality),risk:Math.round(risk),evidenceCompleteness:Math.round((present/optionalFields.length)*100)};
}

/**
 * Professional-degen opportunity scoring.
 *
 * A token does not become a recommendation merely because a few tiny buys refreshed it. The main
 * score is driven by independent quality-capital evidence (PROVEN/PAPER smart wallets, whales,
 * smart-money net flow) plus accelerating organic flow. Meme culture is allowed to help, never used
 * as a substitute for money. Old/dead coins can re-awaken, but they must prove it with genuinely new
 * capital and acceleration rather than one small buy touching an old pool.
 */
export function evaluateOpportunity(e:BrainEvidence):BrainDecision{
  const reasons:string[]=[],warnings:string[]=[];
  const flowRatio=ratio(e.buyVolume5mUsd,e.sellVolume5mUsd);
  const whaleDensity=e.whaleBuyers60s+e.knownWhaleBuyers60s*1.35;
  const breakdown=scoreBreakdown(e,flowRatio,whaleDensity);

  const qualifiedSmart=(e.smartWalletWeightedScore??0)>=2||(e.provenSmartWallets??0)>=1;
  const meaningfulWhale=e.whaleBuyers60s>=1||e.knownWhaleBuyers60s>=1;
  const smartNet=(e.smartMoneyNetFlow5mUsd??0)>=Math.max(2_500,e.liquidityUsd*.03);
  const strongFlow=e.inflow60sUsd>=5_000||e.buyers60s>=5||e.volumeAcceleration1m>=1.5;
  const organicFlow=e.buyers60s>=3||e.uniqueBuyers1m>=3||e.inflow60sUsd>=2_500;
  const accelerating=e.volumeAcceleration1m>=1.25||e.volumeAcceleration5m>=1.2||flowRatio>=1.35;
  const hasQualifiedCapital=qualifiedSmart||meaningfulWhale||smartNet;
  const evidenceChannels=[qualifiedSmart,meaningfulWhale,smartNet,organicFlow,accelerating,(e.socialVelocity??0)>=1.4,(e.holderGrowth5mPct??0)>=2].filter(Boolean).length;

  let score=breakdown.momentum*.34+breakdown.smartMoney*.38+breakdown.executionQuality*.12+(100-breakdown.risk)*.10;
  score+=clamp(((e.narrativeScore??50)-50)*.05,-3,3);
  score+=clamp(((e.socialVelocity??1)-1)*3,-3,6);
  score+=clamp(e.catalystBoost??0,0,8);

  const ageKnown=Number.isFinite(e.ageMinutes)&&e.ageMinutes>=0;
  const age=ageKnown?e.ageMinutes:Number.POSITIVE_INFINITY;
  const reawakening=hasQualifiedCapital&&strongFlow&&e.volumeAcceleration1m>=1.5;
  if(ageKnown&&age<=180&&hasQualifiedCapital)score+=5;
  else if(ageKnown&&age>7*24*60&&!reawakening)score-=18;
  else if(ageKnown&&age>24*60&&!reawakening)score-=10;
  if(!hasQualifiedCapital)score-=10;
  if(!organicFlow)score-=8;
  if(breakdown.evidenceCompleteness<30)score-=5;

  const dd=Math.max(0,e.drawdownFromRecentPeakPct??0);
  const survivorScore=clamp((dd>=45?18:0)+(dd>=65?16:0)+Math.min(24,e.buyers60s*.8)+Math.min(24,breakdown.smartMoney*.24)+Math.min(18,Math.max(0,e.volumeAcceleration1m-1)*9));
  if(dd>=45&&survivorScore>=60&&reawakening){score+=8;reasons.push("Deep-dip token is genuinely re-awakening with quality capital");}

  if((e.provenSmartWallets??0)>0)reasons.push(`${e.provenSmartWallets} PROVEN meme wallet(s) entered recently`);
  else if((e.trackedSmartWallets??0)>=2)reasons.push(`${e.trackedSmartWallets} verified smart-wallet candidates are converging`);
  if(e.whaleBuyers60s>=1)reasons.push(`${e.whaleBuyers60s} whale-tier or $50K+ tracked buy(s) joined in the last minute`);
  if(e.inflow10sUsd>=10_000)reasons.push(`$${Math.round(e.inflow10sUsd).toLocaleString()} entered in ~10s`);
  else if(e.inflow60sUsd>=5_000)reasons.push(`$${Math.round(e.inflow60sUsd).toLocaleString()} entered in ~60s`);
  if(e.buyers60s>=5)reasons.push(`${e.buyers60s} independent wallet addresses bought in ~60s`);
  if(e.volumeAcceleration1m>=1.5)reasons.push(`Volume is accelerating ${e.volumeAcceleration1m.toFixed(1)}x`);
  if(flowRatio>=1.5)reasons.push(`Buy money is ${flowRatio.toFixed(1)}x sell money`);
  if((e.socialVelocity??0)>=1.5)reasons.push("Community/social attention is accelerating behind the money flow");
  if(ageKnown&&age>24*60&&reawakening)reasons.push("Older token is only resurfacing because fresh capital is re-accelerating it");

  const criticalRiskKnown=[e.liquidityChange5mPct,e.top10EffectivePct,e.bundledSupplyPct,e.creatorHoldingPct,e.lpRiskScore].filter(v=>v!==undefined).length;
  const riskEvidenceReady=criticalRiskKnown>=3;

  if((e.liquidityChange5mPct??0)<-35)warnings.push("Liquidity is falling quickly");
  if((e.creatorNetSell5mPct??0)>40)warnings.push("Creator/dev selling is heavy");
  if((e.socialSpamRatio??0)>.75)warnings.push("Social activity looks heavily automated");
  if((e.top10EffectivePct??0)>85)warnings.push("Holder concentration is extreme");
  if((e.bundledSupplyPct??0)>35)warnings.push("Bundled supply is unusually high");
  if((e.creatorHoldingPct??0)>20)warnings.push("Creator-linked supply is unusually high");
  if((e.lpRiskScore??0)>75)warnings.push("Liquidity structure has high rug risk");
  if(e.freezeAuthorityActive)warnings.push("Freeze authority is still active");
  if(e.token2022DangerousExtension)warnings.push("Token extensions require extra execution caution");
  if(e.liquidityUsd<5_000)warnings.push("Very thin liquidity: actual execution may be unusable");
  if(!riskEvidenceReady)warnings.push("Token structure evidence is incomplete; automatic entry is held back");
  if(!ageKnown)warnings.push("Token launch age is not verified yet");
  else if(age>7*24*60&&!reawakening)warnings.push("Old token has not shown enough re-awakening evidence");

  score=clamp(Math.round(score));
  const severeStructure=breakdown.risk>=80||e.liquidityUsd<2_500;
  const moneyRush=score>=82&&evidenceChannels>=4&&hasQualifiedCapital&&strongFlow&&accelerating&&breakdown.executionQuality>=38&&riskEvidenceReady&&!severeStructure;
  const breakout=!moneyRush&&score>=68&&evidenceChannels>=3&&hasQualifiedCapital&&strongFlow&&breakdown.executionQuality>=30&&riskEvidenceReady&&!severeStructure;
  const building=!moneyRush&&!breakout&&score>=52&&evidenceChannels>=2&&(hasQualifiedCapital||strongFlow)&&!severeStructure;
  const state:BrainState=moneyRush?"MONEY_RUSH":breakout?"BREAKOUT_FLOW":building?"BUILDING":"SCANNING";
  const action=(moneyRush||breakout)?"BUY_NOW":building?"WATCH":"IGNORE";
  return {score,action,state,reasons,warnings,survivorScore,breakdown,evidenceChannels};
}

export type LifecycleRow={score:number;lastEvaluatedAt:Date;firstSeenAt:Date;inflow60sUsd:number;buyers60s:number;whaleBuyers60s:number;knownWhaleBuyers60s:number;state?:BrainState};
export function classifyLifecycle(row:LifecycleRow,now:number):string{
  if(now-row.lastEvaluatedAt.getTime()>15*60_000)return "STALE";
  if(row.state==="MONEY_RUSH")return "HIGH_CONVICTION";
  if(row.state==="BREAKOUT_FLOW")return "STRONG";
  if(row.state==="BUILDING")return "HEATING_UP";
  const hasEvidence=row.inflow60sUsd>0||row.buyers60s>0||row.whaleBuyers60s>0||row.knownWhaleBuyers60s>0;
  if(hasEvidence)return "WATCHING";
  if(now-row.firstSeenAt.getTime()<10*60_000)return "FOUND";
  return "COOLING";
}

export const STATE_RANK:Record<BrainState,number>={SCANNING:0,BUILDING:1,BREAKOUT_FLOW:2,MONEY_RUSH:3};
export function didStateUpgrade(priorNotifiedState:BrainState|null|undefined,newState:BrainState):boolean{
  const priorRank=STATE_RANK[priorNotifiedState??"SCANNING"]??0;
  const newRank=STATE_RANK[newState]??0;
  return newRank>priorRank&&newRank>0;
}
export function isNewConvergence(convergentCount:number,priorConvergentCount:number):boolean{return convergentCount>=5&&convergentCount>priorConvergentCount;}

export type WalletConvergenceStage="NONE"|"OBSERVED"|"RESEARCH_PRIORITY"|"SMART_MONEY_CONVERGENCE"|"MONEY_RUSH_CANDIDATE";
/** Product thresholds are based on distinct wallets; repeated buys never increase this count. */
export function classifyWalletConvergence(distinctQualifiedWallets:number,strongIndependentWallets=distinctQualifiedWallets):WalletConvergenceStage{
  const distinct=Math.max(0,Math.floor(distinctQualifiedWallets));
  const strong=Math.max(0,Math.min(distinct,Math.floor(strongIndependentWallets)));
  if(distinct>=10&&strong>=10)return "MONEY_RUSH_CANDIDATE";
  if(distinct>=5&&strong>=5)return "SMART_MONEY_CONVERGENCE";
  if(distinct>=3)return "RESEARCH_PRIORITY";
  if(distinct>=1)return "OBSERVED";
  return "NONE";
}

const CONVERGENCE_WEIGHT:Record<string,number>={PROVEN:2.5,PAPER_TRACKING:1,ANALYZING:.35,DISCOVERED:.2};
export function weightedConvergenceScore(wallets:{stage:string;copyabilityScore?:number|null;currentFormScore?:number|null;earlyRepeatHits?:number|null}[]):number{
  return Number(wallets.reduce((sum,w)=>{
    const base=CONVERGENCE_WEIGHT[w.stage]??0;
    if(!base)return sum;
    const quality=w.copyabilityScore==null?1:clamp(Number(w.copyabilityScore)/80,.7,1.25);
    const form=w.currentFormScore==null?1:clamp(Number(w.currentFormScore)/65,.75,1.2);
    const early=(w.stage==="DISCOVERED"||w.stage==="ANALYZING")?clamp(Number(w.earlyRepeatHits??0)/3,0,1.25):1;
    return sum+base*quality*form*early;
  },0).toFixed(2));
}
export function countUniqueWhaleWallets(rows:{walletAddress:string;walletTier?:string|null}[]):number{return new Set(rows.filter(r=>String(r.walletTier??"").startsWith("WHALE_")).map(r=>r.walletAddress)).size;}
export function countUniqueKnownWallets(rows:{walletAddress:string;knownWallet?:boolean|null}[]):number{return new Set(rows.filter(r=>r.knownWallet).map(r=>r.walletAddress)).size;}
export function countUniqueKnownWhaleWallets(rows:{walletAddress:string;knownWallet?:boolean|null;walletTier?:string|null}[]):number{return new Set(rows.filter(r=>r.knownWallet&&String(r.walletTier??"").startsWith("WHALE_")).map(r=>r.walletAddress)).size;}
export function walletTier(balanceUsd?:number){
  const b=Number(balanceUsd??0);
  if(b>=10_000_000)return "WHALE_10M";
  if(b>=2_000_000)return "WHALE_2M";
  if(b>=1_000_000)return "WHALE_1M";
  if(b>=100_000)return "WHALE_100K";
  if(b>=50_000)return "WHALE_50K";
  return "FLOW";
}
