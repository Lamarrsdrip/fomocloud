export type CandidateMetrics={
  totalPnlUsd:number;
  realizedPnlUsd:number;
  volumeUsd:number;
  tradeCount:number;
  profitableTrades:number;
  winRatePct?:number;
  recentSignalReturnsPct:number[];
  averageObservedChasePct?:number;
  insiderRiskPct?:number;
  rugExposurePct?:number;
  realizedPnl7dUsd?:number;
  winRate7dPct?:number;
  distinctTokens30d?:number;
  lastActivityHours?:number;
  earlyEntryEdgePct?:number;
};
const clamp=(n:number,a=0,b=100)=>Math.min(b,Math.max(a,n));
function robustMean(xs:number[]){
  if(!xs.length)return 0;
  const s=[...xs].sort((a,b)=>a-b),cut=Math.floor(s.length*.1);
  const body=s.slice(cut,s.length-cut||undefined);
  return body.reduce((a,b)=>a+b,0)/Math.max(1,body.length);
}
function downsideMean(xs:number[]){
  const neg=xs.filter(x=>x<0);
  return neg.length?neg.reduce((a,b)=>a+b,0)/neg.length:0;
}

// Missing risk evidence is not safe evidence. A provider gap gets a moderate penalty and lowers
// evidence completeness, while a verified 0% remains genuinely better. This keeps temporary
// provider failures from auto-blacklisting a skilled wallet without ever letting UNKNOWN become 0.
const UNKNOWN_RISK_DEFAULT_PCT=25;

/**
 * Meme-wallet scoring is intentionally skill-first, not wealth-first.
 *
 * The old model over-weighted total PnL / volume and could therefore flatter a wallet whose current
 * moonbag was mostly unrealized. This version gives realized profitability, repeated forward edge,
 * cross-token diversity, current form and copyability their own authority. Wallet balance is not an
 * input at all -- a small wallet with repeatable early-entry skill can outrank a rich but mediocre
 * whale, while whale size remains a separate piece of evidence in the Brain.
 */
export function scoreWallet(m:CandidateMetrics){
  const winRate=clamp(m.winRatePct??(m.tradeCount?m.profitableTrades/m.tradeCount*100:0));
  const sampleScore=clamp(Math.log10(Math.max(1,m.tradeCount))*36);
  const diversityScore=m.distinctTokens30d==null?50:clamp(Math.log10(Math.max(1,m.distinctTokens30d))*42);

  // Realized efficiency is the core profitability measure. Total PnL remains useful context, but
  // cannot manufacture skill while profits are still only floating.
  const realizedEfficiency=m.volumeUsd>0?m.realizedPnlUsd/m.volumeUsd:0;
  const realizedPnlScore=clamp(50+realizedEfficiency*240);
  const unrealizedPositive=Math.max(0,m.totalPnlUsd-m.realizedPnlUsd);
  const unrealizedReliance=m.totalPnlUsd>0?clamp(unrealizedPositive/Math.max(1,m.totalPnlUsd)*100):0;

  const consistency=clamp(winRate*.70+sampleScore*.18+diversityScore*.12);
  const forward=robustMean(m.recentSignalReturnsPct);
  const forwardHitRate=m.recentSignalReturnsPct.length?m.recentSignalReturnsPct.filter(x=>x>0).length/m.recentSignalReturnsPct.length*100:50;
  const forwardDownside=Math.abs(downsideMean(m.recentSignalReturnsPct));
  const forwardScore=clamp(50+forward*1.15+(forwardHitRate-50)*.28-forwardDownside*.22);

  const chasePenalty=clamp(((m.averageObservedChasePct??20)-20)*1.15,0,38);
  const earlyEdge=m.earlyEntryEdgePct==null?50:clamp(50+m.earlyEntryEdgePct*.9);

  // Current form is separate from durability. No 7D window = neutral, not zero/bad.
  const sevenDayPnl=m.realizedPnl7dUsd;
  const pnlForm=sevenDayPnl==null?50:clamp(50+(sevenDayPnl/Math.max(2_500,Math.abs(m.realizedPnlUsd)*.35))*35);
  const winForm=m.winRate7dPct==null?50:clamp(m.winRate7dPct);
  const currentFormScore=clamp(pnlForm*.55+winForm*.45);

  const h=m.lastActivityHours;
  const activityScore=h==null?50:h<=6?100:h<=24?88:h<=72?68:h<=168?48:25;

  const insiderKnown=m.insiderRiskPct!==undefined,rugKnown=m.rugExposurePct!==undefined;
  const insiderPenalty=clamp((insiderKnown?m.insiderRiskPct!:UNKNOWN_RISK_DEFAULT_PCT)*.8,0,45);
  const rugPenalty=clamp((rugKnown?m.rugExposurePct!:UNKNOWN_RISK_DEFAULT_PCT)*.8,0,35);
  const evidenceCompleteness=clamp(((insiderKnown?1:0)+(rugKnown?1:0))/2*100);
  const riskScore=clamp(insiderPenalty+rugPenalty+Math.max(0,48-winRate)*.34+Math.max(0,unrealizedReliance-70)*.12);

  const entryQuality=clamp(52+forward*.78+(earlyEdge-50)*.22-chasePenalty);
  const skillScore=clamp(
    realizedPnlScore*.26+
    consistency*.24+
    forwardScore*.25+
    diversityScore*.10+
    earlyEdge*.15
  );
  const copyability=clamp(
    skillScore*.30+
    forwardScore*.22+
    currentFormScore*.14+
    entryQuality*.14+
    activityScore*.08+
    sampleScore*.12-
    riskScore*.43-
    unrealizedReliance*.08
  );
  const sourceQuality=clamp(
    skillScore*.42+
    consistency*.18+
    currentFormScore*.14+
    activityScore*.08+
    sampleScore*.08+
    (100-riskScore)*.10
  );

  return {
    sourceQualityScore:Math.round(sourceQuality),
    copyabilityScore:Math.round(copyability),
    consistencyScore:Math.round(consistency),
    entryQualityScore:Math.round(entryQuality),
    riskScore:Math.round(riskScore),
    skillScore:Math.round(skillScore),
    currentFormScore:Math.round(currentFormScore),
    activityScore:Math.round(activityScore),
    forwardMeanPct:Number(forward.toFixed(2)),
    forwardHitRatePct:Number(forwardHitRate.toFixed(1)),
    evidenceCompleteness:Math.round(evidenceCompleteness),
    unrealizedReliancePct:Math.round(unrealizedReliance),
    diversityScore:Math.round(diversityScore)
  };
}

export function shouldPaperTrack(s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number},trades:number){
  return trades>=15&&s.copyabilityScore>=65&&s.sourceQualityScore>=65&&s.riskScore<=55;
}

export function shouldProve(
  s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number;currentFormScore?:number;activityScore?:number},
  forwardSignals:number,
  forwardMeanPct:number,
  evidenceCompleteness=100
){
  return forwardSignals>=20&&forwardMeanPct>5&&s.copyabilityScore>=78&&s.sourceQualityScore>=72&&s.riskScore<=42&&evidenceCompleteness>=50&&(s.currentFormScore??50)>=42&&(s.activityScore??50)>=35;
}
