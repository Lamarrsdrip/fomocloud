import test from "node:test";
import assert from "node:assert/strict";
import {resolveEffectiveTradeSettings,evaluateUserProfitPlan} from "./tradeSettings.js";

const base:any={sizingMode:"PERCENT",percentBalance:2,defaultAmountUsd:100,maxAmountPerTradeUsd:500,maxTotalExposureUsd:2000,maxConcurrentPositions:5,maxSlippageBps:1200,stopLossPct:12,takeProfitMode:"ADVANCED",tp1Pct:50,tp1SellPct:25,tp2Pct:100,tp2SellPct:25,tp3Pct:200,tp3SellPct:25,runnerPct:25,capitalRecoveryEnabled:false,trailingEnabled:false,sourceSellBehavior:"BRAIN_DECIDES",scalperCopyEnabled:false};
const state={tp1Taken:false,tp2Taken:false,tp3Taken:false,principalRecoveredPct:0,peakProfitPct:0,remainingPct:100};

test("global stop-loss survives effective settings resolution",()=>{const s=resolveEffectiveTradeSettings(base,{useCustomSettings:false});assert.equal(s.stopLossPct,12)});
test("configured stop-loss produces a full protective exit",()=>{const s=resolveEffectiveTradeSettings(base,{useCustomSettings:false});const i=evaluateUserProfitPlan(s,{profitPct:-12.1,drawdownFromPeakPct:0},state);assert.equal(i.action,"EXIT");if(i.action==="EXIT")assert.equal(i.tag,"USER_STOP_LOSS")});
test("live slippage has a hard platform ceiling",()=>{const s=resolveEffectiveTradeSettings({...base,maxSlippageBps:99_999},{useCustomSettings:false});assert.equal(s.maxSlippageBps,5000)});
