import test from "node:test";import assert from "node:assert/strict";import {scoreWallet,shouldPaperTrack,shouldProve} from "./index.js";
test("good wallet passes paper threshold",()=>{const s=scoreWallet({totalPnlUsd:180000,realizedPnlUsd:150000,volumeUsd:700000,tradeCount:80,profitableTrades:52,winRatePct:65,recentSignalReturnsPct:[12,28,-8,44,17,60,9,33,14,21,11,25,7,19,18,23,9,16,27,12],averageObservedChasePct:16,insiderRiskPct:3,rugExposurePct:4,providerEvidenceCompletenessPct:100,distinctTokens30d:15,lastActivityHours:2,earlyEntryEdgePct:12});assert.ok(s.copyabilityScore>=65);assert.ok(shouldPaperTrack(s,80));});
test("insider risk prevents proof",()=>{const s=scoreWallet({totalPnlUsd:500000,realizedPnlUsd:500000,volumeUsd:700000,tradeCount:25,profitableTrades:20,winRatePct:80,recentSignalReturnsPct:[80,70,100],averageObservedChasePct:70,insiderRiskPct:80,rugExposurePct:30});assert.ok(s.riskScore>50);assert.equal(shouldProve(s,50,80),false);});
test("unknown risk evidence is not treated as safe -- scoreWallet marks incompleteness explicitly",()=>{
  // Identical inputs except insiderRiskPct/rugExposurePct are genuinely absent (provider fetch never
  // succeeded) rather than a verified 0. Missing evidence must score worse, not the same or better.
  const base={totalPnlUsd:180000,realizedPnlUsd:150000,volumeUsd:700000,tradeCount:80,profitableTrades:60,winRatePct:75,recentSignalReturnsPct:[12,28,8,44,17,60,9,33],averageObservedChasePct:16};
  const known=scoreWallet({...base,insiderRiskPct:3,rugExposurePct:4});
  const unknown=scoreWallet(base);
  assert.ok(known.evidenceCompleteness>unknown.evidenceCompleteness);
  assert.ok(unknown.riskScore>known.riskScore,"missing evidence must not score as safer than verified low risk");
});
test("evidence-completeness gate blocks PROVEN independently of the risk-score penalty",()=>{
  // Same excellent scores either way (riskScore forced to 0, well past every other shouldProve
  // threshold) -- only evidenceCompleteness differs. This proves the completeness gate is a real,
  // independent check, not just riding on the default risk penalty happening to be harsh enough.
  const excellent={copyabilityScore:90,sourceQualityScore:85,riskScore:10,riskEvidenceCompleteness:100,skillScore:88,consistencyScore:75,entryQualityScore:80,currentFormScore:70,activityScore:80,forwardHitRatePct:65};
  assert.equal(shouldProve(excellent,30,10,0,10),false);
  assert.equal(shouldProve(excellent,30,10,74,10),false);
  assert.equal(shouldProve(excellent,30,10,75,10),true);
  assert.equal(shouldProve(excellent,30,10,100,10),true);
});

test("realized repeat skill outranks a mostly-unrealized moonbag",()=>{
  const realized=scoreWallet({totalPnlUsd:180000,realizedPnlUsd:165000,realizedPnl7dUsd:24000,volumeUsd:650000,tradeCount:90,profitableTrades:61,winRatePct:67,winRate7dPct:70,distinctTokens30d:22,lastActivityHours:3,recentSignalReturnsPct:[14,22,9,31,-5,18,27,11],averageObservedChasePct:14,insiderRiskPct:4,rugExposurePct:5,earlyEntryEdgePct:18});
  const moonbag=scoreWallet({totalPnlUsd:600000,realizedPnlUsd:20000,realizedPnl7dUsd:-1000,volumeUsd:650000,tradeCount:25,profitableTrades:12,winRatePct:48,winRate7dPct:40,distinctTokens30d:4,lastActivityHours:96,recentSignalReturnsPct:[3,-12,4,-8,5],averageObservedChasePct:45,insiderRiskPct:4,rugExposurePct:5});
  assert.ok(realized.skillScore>moonbag.skillScore);
  assert.ok(realized.copyabilityScore>moonbag.copyabilityScore);
  assert.ok(moonbag.unrealizedReliancePct>realized.unrealizedReliancePct);
});

test("current activity and form are explicit evidence, not hidden inside wealth",()=>{
  const hot=scoreWallet({totalPnlUsd:100000,realizedPnlUsd:90000,realizedPnl7dUsd:18000,volumeUsd:500000,tradeCount:70,profitableTrades:45,winRatePct:64,winRate7dPct:72,distinctTokens30d:18,lastActivityHours:2,recentSignalReturnsPct:[12,16,22,8,-4,19],insiderRiskPct:3,rugExposurePct:4});
  const cold=scoreWallet({totalPnlUsd:100000,realizedPnlUsd:90000,realizedPnl7dUsd:-5000,volumeUsd:500000,tradeCount:70,profitableTrades:45,winRatePct:64,winRate7dPct:38,distinctTokens30d:18,lastActivityHours:240,recentSignalReturnsPct:[12,16,22,8,-4,19],insiderRiskPct:3,rugExposurePct:4});
  assert.ok(hot.currentFormScore>cold.currentFormScore);
  assert.ok(hot.activityScore>cold.activityScore);
  assert.ok(hot.copyabilityScore>cold.copyabilityScore);
});


test("PROVEN requires real proof depth and cannot be manufactured by one outlier",()=>{
  const s={copyabilityScore:92,sourceQualityScore:88,riskScore:8,riskEvidenceCompleteness:100,skillScore:90,consistencyScore:80,entryQualityScore:82,currentFormScore:75,activityScore:90,forwardHitRatePct:60};
  assert.equal(shouldProve(s,20,40,90,0),false,"20 observations with zero closed paper trades are not enough proof depth");
  assert.equal(shouldProve(s,30,6,90,0),true,"deep objective forward sample can prove without eight closed paper trades");
  assert.equal(shouldProve({...s,forwardHitRatePct:40},30,20,90,10),false,"poor hit rate cannot hide behind a high mean");
});


test("PROVEN cannot be granted while all wallet-risk evidence is unknown",()=>{
  const s={copyabilityScore:95,sourceQualityScore:92,riskScore:20,riskEvidenceCompleteness:0,skillScore:94,consistencyScore:90,entryQualityScore:90,currentFormScore:90,activityScore:100,forwardHitRatePct:80};
  assert.equal(shouldProve(s,40,25,100,15),false);
});
