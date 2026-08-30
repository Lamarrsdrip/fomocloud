import test from "node:test";
import assert from "node:assert/strict";
import { dynamicChaseCapPct, evaluateEntry, evaluateExit, MarketSnapshot, priceDrawdownFromPeakPct } from "./index.js";

const strong:MarketSnapshot = {
  ageMinutes:10, liquidityUsd:250000, marketCapUsd:600000, sourceMarketCapUsd:450000,
  priceFromSourcePct:33, priceFromEntryPct:0, peakProfitPct:0, drawdownFromPeakPct:0,
  volume1mUsd:90000, volume5mUsd:260000, volume15mUsd:500000,
  volumeAcceleration1m:2.7, volumeAcceleration5m:1.5,
  buys1m:90,sells1m:30,buys5m:320,sells5m:120,buyVolume5mUsd:210000,sellVolume5mUsd:80000,
  uniqueBuyers1m:75,uniqueBuyers5m:240,uniqueSellers5m:90,
  holderGrowth5mPct:10,top10EffectivePct:35,bundledSupplyPct:5,creatorHoldingPct:3,
  smartMoneyNetFlow5mUsd:30000,sourceTraderStillHolding:true,sourceTraderSoldPct:0,
  mintAuthorityActive:false,freezeAuthorityActive:false,token2022DangerousExtension:false,
  sellRouteAvailable:true,executablePriceImpactPct:2.5,liquidityChange5mPct:12,
  socialMentions1m:180,socialMentions5m:500,socialMentions15m:900,socialUniqueAuthors5m:280,
  socialVelocity:1.8,socialSentiment:.55,socialSpamRatio:.08,influencerQualityScore:78,narrativeScore:82
};

test("fresh hyper meme allows roughly 40-55% chase", ()=>{
  assert.ok(dynamicChaseCapPct(strong) >= 40);
  const d=evaluateEntry(strong,85);
  assert.equal(d.action,"BUY_NOW");
});

test("hard blocker still stops no-sell-route token", ()=>{
  const d=evaluateEntry({...strong,sellRouteAvailable:false},90);
  assert.equal(d.action,"SKIP");
});

test("late but good token can wait for pullback instead of permanent rejection", ()=>{
  const d=evaluateEntry({...strong,priceFromSourcePct:75,volumeAcceleration1m:1.2,socialVelocity:1.0},80);
  assert.ok(["WAIT_PULLBACK","BUY_SMALLER"].includes(d.action));
});

test("5000 percent hyper runner can keep breathing", ()=>{
  const r=evaluateExit({...strong,priceFromEntryPct:5000,peakProfitPct:5200,drawdownFromPeakPct:3},
    {tp1Taken:true,tp2Taken:true,tp3Taken:true,principalRecoveredPct:100,peakProfitPct:5200,remainingPct:35});
  assert.equal(r.action,"HOLD");
});

test("drawdown is always calculated from peak price, not profit percentage", ()=>{
  // Entry $1, peak $51 (+5000%), current $49 (+4800%). The actual price pullback is
  // only 3.92%, so runner protection must not see a fabricated 200% collapse.
  assert.ok(Math.abs(priceDrawdownFromPeakPct(51,49) - 3.921568627) < 0.000001);
  assert.equal(priceDrawdownFromPeakPct(51,51),0);
  assert.equal(priceDrawdownFromPeakPct(0,49),0);
});
