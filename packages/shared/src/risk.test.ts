import test from "node:test";
import assert from "node:assert/strict";
import { CopySettingsSchema, decideCopy, percentMove, targetPrice } from "./index.js";

const settings = CopySettingsSchema.parse({ enabled:true, fixedAmountUsd:500, maxPositionUsd:750, maxTotalExposureUsd:2500, maxChasePct:10 });

test("chase blocks late entry", () => {
  const d = decideCopy({settings, sourcePriceUsd:1, currentPriceUsd:1.41, availableUsd:2000, currentExposureUsd:0, tokenExposureUsd:0});
  assert.deepEqual(d, {allowed:false, reason:"PRICE_MOVED_TOO_FAR"});
});

test("caps at remaining token allocation", () => {
  const d = decideCopy({settings, sourcePriceUsd:1, currentPriceUsd:1.02, availableUsd:2000, currentExposureUsd:500, tokenExposureUsd:600});
  assert.deepEqual(d, {allowed:true, amountUsd:"150.00"});
});

test("math", () => {
  assert.equal(percentMove(284000,292000).toFixed(2),"2.82");
  assert.equal(targetPrice(1,30),1.3);
});
