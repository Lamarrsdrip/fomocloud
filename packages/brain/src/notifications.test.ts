import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWalletConvergence, didStateUpgrade, isNewConvergence, weightedConvergenceScore } from "./index.js";

test("no prior notification and a real state fires an upgrade", () => {
  assert.equal(didStateUpgrade(null, "BUILDING"), true);
  assert.equal(didStateUpgrade(undefined, "BREAKOUT_FLOW"), true);
});

test("SCANNING is never an upgrade -- there is nothing to notify about", () => {
  assert.equal(didStateUpgrade(null, "SCANNING"), false);
  assert.equal(didStateUpgrade("BUILDING", "SCANNING"), false);
});

test("a genuine tier increase fires exactly once", () => {
  assert.equal(didStateUpgrade("BUILDING", "BREAKOUT_FLOW"), true);
  assert.equal(didStateUpgrade("BREAKOUT_FLOW", "MONEY_RUSH"), true);
});

test("staying in the same tier on a later tick never re-fires -- this is the actual bug this replaced", () => {
  assert.equal(didStateUpgrade("BUILDING", "BUILDING"), false);
  assert.equal(didStateUpgrade("MONEY_RUSH", "MONEY_RUSH"), false);
});

test("dropping back down a tier is not an upgrade and must not notify", () => {
  assert.equal(didStateUpgrade("MONEY_RUSH", "BUILDING"), false);
  assert.equal(didStateUpgrade("BREAKOUT_FLOW", "SCANNING"), false);
});

test("a single wallet buying is not convergence", () => {
  assert.equal(isNewConvergence(1, 0), false);
});

test("five tracked wallets is genuine convergence, fired once", () => {
  assert.equal(isNewConvergence(5, 0), true);
  assert.equal(isNewConvergence(5, 4), true);
});

test("the same convergence count on a later tick never re-fires", () => {
  assert.equal(isNewConvergence(4, 0), false);
  assert.equal(isNewConvergence(5, 5), false);
});

test("a further real increase (2 -> 3 wallets) fires again", () => {
  assert.equal(isNewConvergence(6, 5), true);
});

test("convergence count dropping (a wallet's activity aged out of the window) never notifies", () => {
  assert.equal(isNewConvergence(3, 6), false);
});

test("a PROVEN wallet carries more convergence weight than a PAPER_TRACKING one", () => {
  const onePaper = weightedConvergenceScore([{ stage: "PAPER_TRACKING" }]);
  const oneProven = weightedConvergenceScore([{ stage: "PROVEN" }]);
  assert.ok(oneProven > onePaper, "a single PROVEN wallet should weigh more than a single PAPER_TRACKING wallet");
});

test("curation and verified meme capital raise priority without changing objective stage",()=>{
  const plain=weightedConvergenceScore([{stage:"PAPER_TRACKING",copyabilityScore:75,currentFormScore:65}]);
  const curatedWhale=weightedConvergenceScore([{stage:"PAPER_TRACKING",copyabilityScore:75,currentFormScore:65,source:"MEMECLOUD_CURATED",isMemeWhale:true,capitalScore:80}]);
  assert.ok(curatedWhale>plain);
  assert.ok(curatedWhale<weightedConvergenceScore([{stage:"PROVEN",copyabilityScore:80,currentFormScore:65}])*2);
});

test("weighted convergence can reach the notification threshold with fewer, higher-quality wallets", () => {
  const twoUnproven = weightedConvergenceScore([{ stage: "PAPER_TRACKING" }, { stage: "PAPER_TRACKING" }]);
  const oneProvenOnly = weightedConvergenceScore([{ stage: "PROVEN" }]);
  // Matches the master spec's own example: fewer PROVEN wallets can carry as much or more
  // credibility as more unknown/lower-quality ones.
  assert.ok(oneProvenOnly >= twoUnproven, "one PROVEN wallet should carry at least as much weight as two PAPER_TRACKING wallets");
});

test("repeat-early discovered wallets contribute only weak pre-proof convergence evidence", () => {
  const early=weightedConvergenceScore([{stage:"DISCOVERED",earlyRepeatHits:3,copyabilityScore:50,currentFormScore:50}]);
  const proven=weightedConvergenceScore([{stage:"PROVEN",copyabilityScore:80,currentFormScore:65}]);
  assert.ok(early>0);
  assert.ok(early<proven/5,"unproven early-wallet hint must stay far weaker than PROVEN skill");
  assert.ok(weightedConvergenceScore([{stage:"DISCOVERED",earlyRepeatHits:1,copyabilityScore:90,currentFormScore:90}])<0.15);
});


test("convergence alert is about distinct wallets, not score weight",()=>{
  assert.equal(isNewConvergence(4,0),false);
  assert.equal(isNewConvergence(5,0),true);
});

test("wallet-first product stages use exact 1 / 3 / 5 / 10 distinct-wallet thresholds",()=>{
  assert.equal(classifyWalletConvergence(0),"NONE");
  assert.equal(classifyWalletConvergence(1),"OBSERVED");
  assert.equal(classifyWalletConvergence(3),"RESEARCH_PRIORITY");
  assert.equal(classifyWalletConvergence(5,5),"SMART_MONEY_CONVERGENCE");
  assert.equal(classifyWalletConvergence(10,10),"MONEY_RUSH_CANDIDATE");
});

test("weak wallets cannot manufacture the strong 5/10 tiers",()=>{
  assert.equal(classifyWalletConvergence(5,2),"RESEARCH_PRIORITY");
  assert.equal(classifyWalletConvergence(10,9),"SMART_MONEY_CONVERGENCE");
  assert.notEqual(classifyWalletConvergence(10,9),"MONEY_RUSH_CANDIDATE");
});
