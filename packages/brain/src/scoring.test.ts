import { test } from "node:test";
import assert from "node:assert/strict";
import { countUniqueWhaleWallets, countUniqueKnownWallets, countUniqueKnownWhaleWallets, evaluateOpportunity, type BrainEvidence } from "./index.js";

test("the same whale buying repeatedly counts as one whale, not one per buy", () => {
  const rows = [
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
  ];
  assert.equal(countUniqueWhaleWallets(rows), 1);
});

test("distinct whales each count once, regardless of buy count", () => {
  const rows = [
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
    { walletAddress: "whaleA", walletTier: "WHALE_100K" },
    { walletAddress: "whaleB", walletTier: "WHALE_50K" },
    { walletAddress: "whaleC", walletTier: "WHALE_1M" },
  ];
  assert.equal(countUniqueWhaleWallets(rows), 3);
});

test("a non-whale-tier wallet never counts as a whale", () => {
  assert.equal(countUniqueWhaleWallets([{ walletAddress: "small", walletTier: "FLOW" }]), 0);
  assert.equal(countUniqueWhaleWallets([{ walletAddress: "small" }]), 0);
});

test("known-wallet count dedupes the same known wallet buying repeatedly", () => {
  const rows = [
    { walletAddress: "kolA", knownWallet: true },
    { walletAddress: "kolA", knownWallet: true },
    { walletAddress: "randomWallet", knownWallet: false },
  ];
  assert.equal(countUniqueKnownWallets(rows), 1);
});

const baseEvidence: BrainEvidence = {
  liquidityUsd: 50_000, ageMinutes: 60,
  inflow10sUsd: 0, inflow60sUsd: 0, buyers10s: 0, buyers60s: 0,
  whaleBuyers60s: 0, knownWhaleBuyers60s: 0,
  volumeAcceleration1m: 1, volumeAcceleration5m: 1,
  buyVolume5mUsd: 1, sellVolume5mUsd: 1,
  uniqueBuyers1m: 0, uniqueBuyers5m: 0,
};

test("a neutral 50/100 narrative score contributes ~zero, not positive evidence", () => {
  const neutral = evaluateOpportunity({ ...baseEvidence, narrativeScore: 50 });
  const unset = evaluateOpportunity({ ...baseEvidence, narrativeScore: undefined });
  // Neutral (50) and genuinely unknown (defaults to neutral) must score the same -- 50 is not
  // "positive evidence" just because it's a non-zero number.
  assert.equal(neutral.score, unset.score);
});

test("a weak/negative narrative score (below the 50 midpoint) subtracts from the score, not adds", () => {
  const viable={...baseEvidence,inflow60sUsd:12000,buyers60s:8,uniqueBuyers1m:7,uniqueBuyers5m:12,volumeAcceleration1m:1.8,whaleBuyers60s:1};
  const weak = evaluateOpportunity({ ...viable, narrativeScore: 10 });
  const neutral = evaluateOpportunity({ ...viable, narrativeScore: 50 });
  assert.ok(weak.score < neutral.score, `weak narrative (${weak.score}) should score below neutral (${neutral.score})`);
});

test("a strong narrative score (above the 50 midpoint) adds to the score", () => {
  const viable={...baseEvidence,inflow60sUsd:12000,buyers60s:8,uniqueBuyers1m:7,uniqueBuyers5m:12,volumeAcceleration1m:1.8,whaleBuyers60s:1};
  const strong = evaluateOpportunity({ ...viable, narrativeScore: 90 });
  const neutral = evaluateOpportunity({ ...viable, narrativeScore: 50 });
  assert.ok(strong.score > neutral.score, `strong narrative (${strong.score}) should score above neutral (${neutral.score})`);
});

test("quality-capital evidence changes both Smart Money breakdown and the real trading score", () => {
  const withSmartMoney = evaluateOpportunity({ ...baseEvidence, whaleBuyers60s: 3, knownWhaleBuyers60s: 2, smartMoneyNetFlow5mUsd: 50000, smartWalletWeightedScore: 7, trackedSmartWallets: 3, provenSmartWallets: 2 });
  const withoutContext = evaluateOpportunity({ ...baseEvidence });
  assert.ok(withSmartMoney.breakdown.smartMoney > withoutContext.breakdown.smartMoney);
  assert.ok(withSmartMoney.score > withoutContext.score);
  for (const v of Object.values(withSmartMoney.breakdown)) {
    assert.ok(v >= 0 && v <= 100, `breakdown value ${v} out of 0-100 range`);
  }
});

test("evidenceCompleteness in the breakdown reflects how many optional fields are actually present", () => {
  const noOptionalFields = evaluateOpportunity({ ...baseEvidence });
  const allOptionalFields = evaluateOpportunity({
    ...baseEvidence,
    marketCapUsd: 1_000_000, holderGrowth5mPct: 5, smartMoneyNetFlow5mUsd: 1000,
    socialVelocity: 1.2, socialSpamRatio: 0.1, narrativeScore: 60,
    liquidityChange5mPct: 2, creatorNetSell5mPct: 0, top10EffectivePct: 20,
    bundledSupplyPct: 3, creatorHoldingPct: 2, lpRiskScore: 5, smartWalletWeightedScore: 2,
  });
  assert.equal(noOptionalFields.breakdown.evidenceCompleteness, 0);
  assert.equal(allOptionalFields.breakdown.evidenceCompleteness, 100);
});

test("random old token with tiny flow never becomes a qualified opportunity", () => {
  const d=evaluateOpportunity({...baseEvidence,ageMinutes:60*24*30,liquidityUsd:9_000,inflow60sUsd:150,buyers60s:2,uniqueBuyers1m:2,uniqueBuyers5m:3,volumeAcceleration1m:1.05});
  assert.equal(d.state,"SCANNING");
  assert.equal(d.action,"IGNORE");
});

test("quality smart-money convergence changes the real decision score", () => {
  const plain=evaluateOpportunity({...baseEvidence,inflow60sUsd:20_000,buyers60s:12,uniqueBuyers1m:10,uniqueBuyers5m:18,volumeAcceleration1m:2.2,liquidityUsd:80_000});
  const smart=evaluateOpportunity({...baseEvidence,inflow60sUsd:20_000,buyers60s:12,uniqueBuyers1m:10,uniqueBuyers5m:18,volumeAcceleration1m:2.2,liquidityUsd:80_000,trackedSmartWallets:4,provenSmartWallets:3,smartWalletWeightedScore:8,smartMoneyNetFlow5mUsd:65_000});
  assert.ok(smart.score>plain.score,`smart-money score ${smart.score} must exceed plain-flow score ${plain.score}`);
  assert.ok(smart.breakdown.smartMoney>plain.breakdown.smartMoney);
});

test("young token with proven-wallet convergence, real money and acceleration can become Money Rush", () => {
  const d=evaluateOpportunity({...baseEvidence,ageMinutes:18,liquidityUsd:120_000,marketCapUsd:650_000,inflow10sUsd:28_000,inflow60sUsd:130_000,buyers10s:18,buyers60s:55,uniqueBuyers1m:48,uniqueBuyers5m:110,whaleBuyers60s:2,trackedSmartWallets:5,provenSmartWallets:4,smartWalletWeightedScore:11,smartMoneyNetFlow5mUsd:190_000,volumeAcceleration1m:4.2,volumeAcceleration5m:3.1,buyVolume5mUsd:420_000,sellVolume5mUsd:140_000,liquidityChange5mPct:18,holderGrowth5mPct:9,socialVelocity:2.4,narrativeScore:78,top10EffectivePct:36,bundledSupplyPct:4,creatorNetSell5mPct:0});
  assert.ok(["BREAKOUT_FLOW","MONEY_RUSH"].includes(d.state),`got ${d.state} score ${d.score}`);
  assert.equal(d.action,"BUY_NOW");
  assert.ok(d.evidenceChannels>=4);
});


test("known wallet is not automatically a whale",()=>{
  assert.equal(countUniqueKnownWhaleWallets([{walletAddress:"smart",knownWallet:true,walletTier:"FLOW"}]),0);
  assert.equal(countUniqueKnownWhaleWallets([{walletAddress:"whale",knownWallet:true,walletTier:"WHALE_100K"}]),1);
});

test("missing token-structure evidence cannot produce BUY_NOW",()=>{
  const d=evaluateOpportunity({...baseEvidence,liquidityUsd:150000,inflow10sUsd:40000,inflow60sUsd:180000,buyers10s:20,buyers60s:60,uniqueBuyers1m:50,uniqueBuyers5m:100,provenSmartWallets:5,trackedSmartWallets:6,smartWalletWeightedScore:12,smartMoneyNetFlow5mUsd:200000,volumeAcceleration1m:4,volumeAcceleration5m:3,buyVolume5mUsd:400000,sellVolume5mUsd:100000});
  assert.notEqual(d.action,"BUY_NOW");
  assert.ok(d.warnings.some(w=>w.includes("structure evidence")));
});
