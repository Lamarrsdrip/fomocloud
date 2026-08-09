import test from "node:test";
import assert from "node:assert/strict";
import { CopySettingsSchema, decideCopy, percentMove, targetPrice, walletChasePct } from "./index.js";

const settings = CopySettingsSchema.parse({
  enabled:true,
  fixedAmountUsd:500,
  maxPositionUsd:750,
  maxTotalExposureUsd:2500,
  maxChasePct:40,
  minLiquidityUsd:0
});

test("wallet chase is source execution -> current executable price", () => {
  assert.equal(walletChasePct(1,1.35).toFixed(2),"35.00");
});

test("a +5000% 24h move is irrelevant to copy chase", () => {
  const dailyMovePct=5000; // informational context only; deliberately never passed to decideCopy.
  const sourceWalletExecution=1;
  const executableNow=1.35;
  const d=decideCopy({settings,sourcePriceUsd:sourceWalletExecution,currentPriceUsd:executableNow,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0});
  assert.equal(dailyMovePct,5000);
  assert.deepEqual(d,{allowed:true,amountUsd:"500.00"});
});

test("40% wallet chase can be accepted at a 40% user cap", () => {
  const d=decideCopy({settings,sourcePriceUsd:1,currentPriceUsd:1.40,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0});
  assert.equal(d.allowed,true);
});

test("30% wallet chase can be accepted at a 30% user cap", () => {
  const personal=CopySettingsSchema.parse({...settings,maxChasePct:30});
  assert.equal(decideCopy({settings:personal,sourcePriceUsd:1,currentPriceUsd:1.30,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0}).allowed,true);
});

test("50% wallet chase can be accepted only when the personal cap allows it", () => {
  const personal=CopySettingsSchema.parse({...settings,maxChasePct:50});
  assert.equal(decideCopy({settings:personal,sourcePriceUsd:1,currentPriceUsd:1.50,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0}).allowed,true);
});

test("chase above personal cap is held back", () => {
  const d=decideCopy({settings,sourcePriceUsd:1,currentPriceUsd:1.41,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0});
  assert.deepEqual(d,{allowed:false,reason:"PRICE_MOVED_TOO_FAR"});
});

test("55% hyper-style personal cap can accept 55%", () => {
  const hyper=CopySettingsSchema.parse({...settings,maxChasePct:55});
  const d=decideCopy({settings:hyper,sourcePriceUsd:1,currentPriceUsd:1.55,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0});
  assert.equal(d.allowed,true);
});

test("a quote beyond the 55% absolute user cap waits", () => {
  const hyper=CopySettingsSchema.parse({...settings,maxChasePct:55});
  assert.deepEqual(decideCopy({settings:hyper,sourcePriceUsd:1,currentPriceUsd:1.5501,availableUsd:2000,currentExposureUsd:0,tokenExposureUsd:0}),{allowed:false,reason:"PRICE_MOVED_TOO_FAR"});
});

test("caps at remaining token allocation", () => {
  const d=decideCopy({settings,sourcePriceUsd:1,currentPriceUsd:1.02,availableUsd:2000,currentExposureUsd:500,tokenExposureUsd:600});
  assert.deepEqual(d,{allowed:true,amountUsd:"150.00"});
});

test("math", () => {
  assert.equal(percentMove(284000,292000).toFixed(2),"2.82");
  assert.equal(targetPrice(1,30),1.3);
});
