export type CandidateMetrics={totalPnlUsd:number;realizedPnlUsd:number;volumeUsd:number;tradeCount:number;profitableTrades:number;winRatePct?:number;recentSignalReturnsPct:number[];averageObservedChasePct?:number;insiderRiskPct?:number;rugExposurePct?:number};
const clamp=(n:number,a=0,b=100)=>Math.min(b,Math.max(a,n));
function robustMean(xs:number[]){if(!xs.length)return 0;const s=[...xs].sort((a,b)=>a-b);const cut=Math.floor(s.length*.1);const body=s.slice(cut,s.length-cut||undefined);return body.reduce((a,b)=>a+b,0)/Math.max(1,body.length)}
// Real bug found by forensic audit: `m.insiderRiskPct??0` and `m.rugExposurePct??0` treated MISSING
// provider evidence (the risk fetch failed/never ran) identically to a VERIFIED 0%-risk reading --
// "unknown" silently became "safe." A wallet whose insider/rug data was never successfully fetched
// could score as low-risk purely because nothing was ever measured. UNKNOWN must never equal SAFE:
// unmeasured risk now uses a conservative non-zero default penalty (not the max penalty either --
// that would wrongly blacklist a wallet for a provider outage), and evidenceCompleteness is returned
// so PROVEN eligibility (shouldProve, below) can independently require sufficiently complete
// evidence rather than relying on the default penalty alone to gate real-money trust.
const UNKNOWN_RISK_DEFAULT_PCT=25;
export function scoreWallet(m:CandidateMetrics){
  const winRate=m.winRatePct??(m.tradeCount?m.profitableTrades/m.tradeCount*100:0);
  const sampleScore=clamp(Math.log10(Math.max(1,m.tradeCount))*35);
  const efficiency=m.volumeUsd>0?m.totalPnlUsd/m.volumeUsd:0;
  const pnlScore=clamp(50+efficiency*180);
  const consistency=clamp(winRate*.78+sampleScore*.22);
  const forward=robustMean(m.recentSignalReturnsPct);
  const forwardScore=clamp(50+forward*1.2);
  const chasePenalty=clamp(((m.averageObservedChasePct??20)-20)*1.2,0,35);
  const insiderKnown=m.insiderRiskPct!==undefined,rugKnown=m.rugExposurePct!==undefined;
  const insiderPenalty=clamp((insiderKnown?m.insiderRiskPct!:UNKNOWN_RISK_DEFAULT_PCT)*.8,0,45);
  const rugPenalty=clamp((rugKnown?m.rugExposurePct!:UNKNOWN_RISK_DEFAULT_PCT)*.8,0,35);
  const evidenceCompleteness=clamp(((insiderKnown?1:0)+(rugKnown?1:0))/2*100);
  const riskScore=clamp(insiderPenalty+rugPenalty+Math.max(0,50-winRate)*.35);
  const entryQuality=clamp(55+forward*.8-chasePenalty);
  const copyability=clamp(consistency*.24+pnlScore*.20+forwardScore*.30+entryQuality*.18+sampleScore*.08-riskScore*.45);
  const sourceQuality=clamp(consistency*.35+pnlScore*.35+sampleScore*.15+(100-riskScore)*.15);
  return {sourceQualityScore:Math.round(sourceQuality),copyabilityScore:Math.round(copyability),consistencyScore:Math.round(consistency),entryQualityScore:Math.round(entryQuality),riskScore:Math.round(riskScore),forwardMeanPct:Number(forward.toFixed(2)),evidenceCompleteness:Math.round(evidenceCompleteness)}
}
export function shouldPaperTrack(s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number},trades:number){return trades>=15&&s.copyabilityScore>=68&&s.sourceQualityScore>=65&&s.riskScore<=55}
// evidenceCompleteness defaults to 100 for callers that don't yet track it (e.g. an older stored
// snapshot without the field) so this signature change doesn't retroactively block previously-earned
// PROVEN status on candidates scored before this fix; new scoring passes always supply the real value.
export function shouldProve(s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number},forwardSignals:number,forwardMeanPct:number,evidenceCompleteness=100){return forwardSignals>=20&&forwardMeanPct>5&&s.copyabilityScore>=78&&s.sourceQualityScore>=72&&s.riskScore<=42&&evidenceCompleteness>=50}
