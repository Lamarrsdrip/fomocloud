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
  catastrophicLossRatePct?:number;
  providerEvidenceCompletenessPct?:number;
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
  const riskEvidence=((insiderKnown?1:0)+(rugKnown?1:0))/2*100;
  const providerEvidence=clamp(m.providerEvidenceCompletenessPct??0);
  const behaviorEvidence=clamp(((m.distinctTokens30d!==undefined?1:0)+(m.lastActivityHours!==undefined?1:0)+(m.averageObservedChasePct!==undefined?1:0)+(m.earlyEntryEdgePct!==undefined?1:0))/4*100);
  const forwardEvidence=clamp(m.recentSignalReturnsPct.length/20*100);
  // PROVEN means we have several independent kinds of evidence, not merely a PnL endpoint plus an
  // assumed-zero risk field. Provider completeness, risk provenance, observed behavior and forward
  // outcomes all contribute. Unknown stays unknown and can never look fully verified.
  const evidenceCompleteness=clamp(providerEvidence*.35+riskEvidence*.25+behaviorEvidence*.20+forwardEvidence*.20);
  // A -70% outcome is catastrophic performance evidence, not proof of a rug.
  // Only a separately verified token-structure signal may enter rugExposurePct.
  const catastrophicPenalty=clamp((m.catastrophicLossRatePct??0)*.25,0,20);
  const riskScore=clamp(insiderPenalty+rugPenalty+catastrophicPenalty+Math.max(0,48-winRate)*.34+Math.max(0,unrealizedReliance-70)*.12);

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
    riskEvidenceCompleteness:Math.round(riskEvidence),
    unrealizedReliancePct:Math.round(unrealizedReliance),
    diversityScore:Math.round(diversityScore)
  };
}

export type WalletPromotionScores={
  copyabilityScore:number;sourceQualityScore:number;riskScore:number;
  skillScore?:number;consistencyScore?:number;entryQualityScore?:number;
  currentFormScore?:number;activityScore?:number;forwardHitRatePct?:number;
  evidenceCompleteness?:number;riskEvidenceCompleteness?:number;
};

export function shouldPaperTrack(s:WalletPromotionScores,trades:number){
  // Paper tracking is cheap and reversible, but still requires repeated skill. Wealth alone or one
  // lucky trade is not enough. Hard floors cannot be weakened by an admin config value.
  return trades>=20&&s.copyabilityScore>=65&&s.sourceQualityScore>=65&&s.riskScore<=52&&
    (s.skillScore??65)>=62&&(s.consistencyScore??60)>=52&&(s.evidenceCompleteness??0)>=55;
}

export function shouldProve(
  s:WalletPromotionScores,
  forwardSignals:number,
  robustForwardMeanPct:number,
  evidenceCompleteness=s.evidenceCompleteness??100,
  closedPaperTrades=0
){
  // PROVEN is real-money authority. Require repeatable forward edge, breadth of evidence, current
  // form and copyability. A huge outlier cannot promote a wallet because the worker passes the
  // robust/trimmed forward mean, not a raw arithmetic mean. At least some evidence must come from
  // actual MemeCloud paper copies, unless the forward sample is exceptionally deep.
  const proofDepth=closedPaperTrades>=8||forwardSignals>=30;
  return proofDepth&&forwardSignals>=20&&robustForwardMeanPct>=5&&
    s.copyabilityScore>=80&&s.sourceQualityScore>=75&&s.riskScore<=40&&
    evidenceCompleteness>=75&&(s.riskEvidenceCompleteness??0)>=50&&(s.skillScore??80)>=76&&(s.consistencyScore??60)>=58&&
    (s.entryQualityScore??60)>=58&&(s.currentFormScore??55)>=50&&(s.activityScore??50)>=40&&
    (s.forwardHitRatePct??55)>=55;
}

export * from "./walletIntelligence.js";
