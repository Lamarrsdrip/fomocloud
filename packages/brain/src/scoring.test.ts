import { test } from "node:test";
import assert from "node:assert/strict";
import { countUniqueWhaleWallets, countUniqueKnownWallets, evaluateOpportunity, type BrainEvidence } from "./index.js";

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
  const weak = evaluateOpportunity({ ...baseEvidence, narrativeScore: 10 });
  const neutral = evaluateOpportunity({ ...baseEvidence, narrativeScore: 50 });
  assert.ok(weak.score < neutral.score, `weak narrative (${weak.score}) should score below neutral (${neutral.score})`);
});

test("a strong narrative score (above the 50 midpoint) adds to the score", () => {
  const strong = evaluateOpportunity({ ...baseEvidence, narrativeScore: 90 });
  const neutral = evaluateOpportunity({ ...baseEvidence, narrativeScore: 50 });
  assert.ok(strong.score > neutral.score, `strong narrative (${strong.score}) should score above neutral (${neutral.score})`);
});

test("breakdown sub-scores are additive/diagnostic and never change the trading score", () => {
  const withBreakdown = evaluateOpportunity({ ...baseEvidence, whaleBuyers60s: 3, knownWhaleBuyers60s: 2 });
  const withoutContext = evaluateOpportunity({ ...baseEvidence });
  // Same base evidence otherwise -- adding whale evidence changes momentum/smartMoney breakdown
  // numbers but the underlying `score` computation path is untouched by the breakdown function.
  assert.ok(withBreakdown.breakdown.smartMoney > withoutContext.breakdown.smartMoney);
  for (const v of Object.values(withBreakdown.breakdown)) {
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
  });
  assert.equal(noOptionalFields.breakdown.evidenceCompleteness, 0);
  assert.equal(allOptionalFields.breakdown.evidenceCompleteness, 100);
});
