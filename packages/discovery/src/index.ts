export type CandidateMetrics={totalPnlUsd:number;realizedPnlUsd:number;volumeUsd:number;tradeCount:number;profitableTrades:number;winRatePct?:number;recentSignalReturnsPct:number[];averageObservedChasePct?:number;insiderRiskPct?:number;rugExposurePct?:number};
const clamp=(n:number,a=0,b=100)=>Math.min(b,Math.max(a,n));
function robustMean(xs:number[]){if(!xs.length)return 0;const s=[...xs].sort((a,b)=>a-b);const cut=Math.floor(s.length*.1);const body=s.slice(cut,s.length-cut||undefined);return body.reduce((a,b)=>a+b,0)/Math.max(1,body.length)}
export function scoreWallet(m:CandidateMetrics){
  const winRate=m.winRatePct??(m.tradeCount?m.profitableTrades/m.tradeCount*100:0);
  const sampleScore=clamp(Math.log10(Math.max(1,m.tradeCount))*35);
  const efficiency=m.volumeUsd>0?m.totalPnlUsd/m.volumeUsd:0;
  const pnlScore=clamp(50+efficiency*180);
  const consistency=clamp(winRate*.78+sampleScore*.22);
  const forward=robustMean(m.recentSignalReturnsPct);
  const forwardScore=clamp(50+forward*1.2);
  const chasePenalty=clamp(((m.averageObservedChasePct??20)-20)*1.2,0,35);
  const insiderPenalty=clamp((m.insiderRiskPct??0)*.8,0,45);
  const rugPenalty=clamp((m.rugExposurePct??0)*.8,0,35);
  const riskScore=clamp(insiderPenalty+rugPenalty+Math.max(0,50-winRate)*.35);
  const entryQuality=clamp(55+forward*.8-chasePenalty);
  const copyability=clamp(consistency*.24+pnlScore*.20+forwardScore*.30+entryQuality*.18+sampleScore*.08-riskScore*.45);
  const sourceQuality=clamp(consistency*.35+pnlScore*.35+sampleScore*.15+(100-riskScore)*.15);
  return {sourceQualityScore:Math.round(sourceQuality),copyabilityScore:Math.round(copyability),consistencyScore:Math.round(consistency),entryQualityScore:Math.round(entryQuality),riskScore:Math.round(riskScore),forwardMeanPct:Number(forward.toFixed(2))}
}
export function shouldPaperTrack(s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number},trades:number){return trades>=15&&s.copyabilityScore>=68&&s.sourceQualityScore>=65&&s.riskScore<=55}
export function shouldProve(s:{copyabilityScore:number;sourceQualityScore:number;riskScore:number},forwardSignals:number,forwardMeanPct:number){return forwardSignals>=20&&forwardMeanPct>5&&s.copyabilityScore>=78&&s.sourceQualityScore>=72&&s.riskScore<=42}
