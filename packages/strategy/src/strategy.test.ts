import test from "node:test";
import assert from "node:assert/strict";
import { dynamicChaseCapPct, evaluateEntry, evaluateExit, MarketSnapshot } from "./index.js";

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

const position={tp1Taken:false,tp2Taken:false,tp3Taken:false,principalRecoveredPct:0,peakProfitPct:0,remainingPct:100};
const healthy:MarketSnapshot={...strong,volumeAcceleration1m:1.1,volumeAcceleration5m:1.05,buys5m:120,sells5m:100,buyVolume5mUsd:120000,sellVolume5mUsd:100000,holderGrowth5mPct:1,smartMoneyNetFlow5mUsd:0,socialMentions5m:undefined,socialVelocity:undefined,socialSentiment:undefined};
const cooling:MarketSnapshot={...healthy,volumeAcceleration1m:.65,volumeAcceleration5m:.7,buys5m:80,sells5m:100,buyVolume5mUsd:80000,sellVolume5mUsd:100000};
const broken:MarketSnapshot={...healthy,volumeAcceleration1m:.1,volumeAcceleration5m:.2,buys5m:10,sells5m:100,buyVolume5mUsd:5000,sellVolume5mUsd:100000};

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

test("fresh ladder triggers at 100, 150, and 200 percent",()=>{
  const first=evaluateExit({...healthy,priceFromEntryPct:100},position);
  const second=evaluateExit({...healthy,priceFromEntryPct:150},{...position,tp1Taken:true});
  const third=evaluateExit({...healthy,priceFromEntryPct:200},{...position,tp1Taken:true,tp2Taken:true});
  assert.deepEqual([first.action,second.action,third.action],["PARTIAL_TP","PARTIAL_TP","PARTIAL_TP"]);
  assert.deepEqual(["nextTargetPct" in first?first.nextTargetPct:null,"nextTargetPct" in second?second.nextTargetPct:null],[150,200]);
});

test("established ladder triggers at 50 and 100 percent",()=>{
  const market={...healthy,ageMinutes:8*24*60};
  const first=evaluateExit({...market,priceFromEntryPct:50},position);
  const second=evaluateExit({...market,priceFromEntryPct:100},{...position,tp1Taken:true});
  assert.deepEqual([first.action,second.action],["PARTIAL_TP","PARTIAL_TP"]);
});

test("hyper harvests less and cooling harvests more than healthy",()=>{
  const hyperExit=evaluateExit({...strong,priceFromEntryPct:100},position);
  const healthyExit=evaluateExit({...healthy,priceFromEntryPct:100},position);
  const coolingExit=evaluateExit({...cooling,priceFromEntryPct:100},position);
  assert.equal(hyperExit.action,"PARTIAL_TP");assert.equal(healthyExit.action,"PARTIAL_TP");assert.equal(coolingExit.action,"PARTIAL_TP");
  if(hyperExit.action==="PARTIAL_TP"&&healthyExit.action==="PARTIAL_TP"&&coolingExit.action==="PARTIAL_TP"){
    assert.ok(hyperExit.sellPct<healthyExit.sellPct);
    assert.ok(coolingExit.sellPct>healthyExit.sellPct);
  }
});

test("healthy hyper runners have no hidden maximum-profit exit",()=>{
  for(const profit of [500,1000,2000,5000,10000]){
    const result=evaluateExit({...strong,priceFromEntryPct:profit,peakProfitPct:profit+100,drawdownFromPeakPct:2},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,principalRecoveredPct:100,peakProfitPct:profit+100,remainingPct:35});
    assert.equal(result.action,"HOLD",`expected HOLD at +${profit}%`);
  }
});

test("normal pullback exits while a hyper pullback reduces",()=>{
  const normal=evaluateExit({...healthy,priceFromEntryPct:200,drawdownFromPeakPct:25},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,peakProfitPct:260,remainingPct:35});
  const hyper=evaluateExit({...strong,priceFromEntryPct:500,drawdownFromPeakPct:35},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,peakProfitPct:700,remainingPct:35});
  assert.equal(normal.action,"EXIT");
  assert.equal(hyper.action,"REDUCE");
});

test("objective liquidity, routing, and creator failures force exits",()=>{
  for(const market of [
    {...healthy,sellRouteAvailable:false},
    {...healthy,liquidityChange5mPct:-70},
    {...healthy,creatorNetSell5mPct:80}
  ]) assert.equal(evaluateExit(market,{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true}).action,"EXIT");
});

test("buyer-flow and volume breakdown exits the runner",()=>{
  assert.equal(evaluateExit({...broken,priceFromEntryPct:80},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,peakProfitPct:120,remainingPct:40}).action,"EXIT");
});

test("source full exit only kills a runner when momentum also cools",()=>{
  const hyper=evaluateExit({...strong,sourceTraderSoldPct:100,priceFromEntryPct:300},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,peakProfitPct:320,remainingPct:35});
  const weak=evaluateExit({...cooling,sourceTraderSoldPct:100,priceFromEntryPct:80},{...position,tp1Taken:true,tp2Taken:true,tp3Taken:true,peakProfitPct:100,remainingPct:35});
  assert.equal(hyper.action,"HOLD");
  assert.equal(weak.action,"EXIT");
});
