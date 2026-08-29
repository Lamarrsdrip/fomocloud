import test from "node:test";import assert from "node:assert/strict";import {scoreWallet,shouldPaperTrack,shouldProve} from "./index.js";
test("good wallet passes paper threshold",()=>{const s=scoreWallet({totalPnlUsd:180000,realizedPnlUsd:150000,volumeUsd:700000,tradeCount:80,profitableTrades:52,winRatePct:65,recentSignalReturnsPct:[12,28,-8,44,17,60,9,33],averageObservedChasePct:16,insiderRiskPct:3,rugExposurePct:4});assert.ok(s.copyabilityScore>=65);assert.ok(shouldPaperTrack(s,80));});
test("insider risk prevents proof",()=>{const s=scoreWallet({totalPnlUsd:500000,realizedPnlUsd:500000,volumeUsd:700000,tradeCount:25,profitableTrades:20,winRatePct:80,recentSignalReturnsPct:[80,70,100],averageObservedChasePct:70,insiderRiskPct:80,rugExposurePct:30});assert.ok(s.riskScore>50);assert.equal(shouldProve(s,50,80),false);});
test("unknown risk evidence is not treated as safe -- scoreWallet marks incompleteness explicitly",()=>{
  // Identical inputs except insiderRiskPct/rugExposurePct are genuinely absent (provider fetch never
  // succeeded) rather than a verified 0. Missing evidence must score worse, not the same or better.
  const base={totalPnlUsd:180000,realizedPnlUsd:150000,volumeUsd:700000,tradeCount:80,profitableTrades:60,winRatePct:75,recentSignalReturnsPct:[12,28,8,44,17,60,9,33],averageObservedChasePct:16};
  const known=scoreWallet({...base,insiderRiskPct:3,rugExposurePct:4});
  const unknown=scoreWallet(base);
  assert.equal(known.evidenceCompleteness,100);
  assert.equal(unknown.evidenceCompleteness,0);
  assert.ok(unknown.riskScore>known.riskScore,"missing evidence must not score as safer than verified low risk");
});
test("evidence-completeness gate blocks PROVEN independently of the risk-score penalty",()=>{
  // Same excellent scores either way (riskScore forced to 0, well past every other shouldProve
  // threshold) -- only evidenceCompleteness differs. This proves the completeness gate is a real,
  // independent check, not just riding on the default risk penalty happening to be harsh enough.
  const excellent={copyabilityScore:85,sourceQualityScore:80,riskScore:0};
  assert.equal(shouldProve(excellent,30,10,0),false);
  assert.equal(shouldProve(excellent,30,10,49),false);
  assert.equal(shouldProve(excellent,30,10,50),true);
  assert.equal(shouldProve(excellent,30,10,100),true);
  // Default evidenceCompleteness (omitted 4th arg) stays 100 for backward compatibility with older
  // stored candidates that predate this field, so this fix doesn't retroactively strip PROVEN.
  assert.equal(shouldProve(excellent,30,10),true);
});
