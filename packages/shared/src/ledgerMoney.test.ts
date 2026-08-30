import { test } from "node:test";
import assert from "node:assert/strict";
import { usdToMicros, microsToUsd, positionUsdFields, tradingCashUsdFields } from "./index.js";

// Real gap found by forensic audit (M-30): Prisma+MongoDB doesn't support Decimal, so LedgerEntry
// uses integer micro-USD (BigInt) instead. This is exactly the boundary where a naive float
// multiply-then-truncate would silently lose the "exact" property the whole point of this exercise
// is to guarantee.
test("usdToMicros is exact for values whose float64 representation isn't exact", () => {
  // 0.1 * 1_000_000 in raw JS float arithmetic is 99999.99999999999, not 100000 -- a naive
  // `BigInt(0.1 * 1_000_000)` would truncate to 99999n, silently losing a millionth of a dollar
  // per occurrence. Math.round is what makes this actually exact.
  assert.equal(usdToMicros(0.1), 100_000n);
  assert.equal(usdToMicros(19.99), 19_990_000n);
  assert.equal(usdToMicros(0.01), 10_000n);
});

test("usdToMicros handles negative amounts (buy spend) and zero", () => {
  assert.equal(usdToMicros(-25.5), -25_500_000n);
  assert.equal(usdToMicros(0), 0n);
});

test("usdToMicros rejects non-finite input rather than silently storing garbage", () => {
  assert.throws(() => usdToMicros(NaN), /USD_TO_MICROS_NON_FINITE/);
  assert.throws(() => usdToMicros(Infinity), /USD_TO_MICROS_NON_FINITE/);
});

test("microsToUsd round-trips exactly through usdToMicros for realistic dollar amounts", () => {
  for (const usd of [0.01, 0.1, 1, 19.99, 100.5, 1234.56, 999999.99]) {
    assert.equal(microsToUsd(usdToMicros(usd)), usd);
  }
});

test("positionUsdFields converts every BigInt-micros field to a plain number under the original name", () => {
  const raw = {
    costUsdMicros: 25_000_000n,
    avgEntryPriceUsdMicros: 500_000n,
    currentPriceUsdMicros: 750_000n,
    peakPriceUsdMicros: 900_000n,
    realizedPnlUsdMicros: 5_000_000n,
    unrealizedPnlUsdMicros: -1_500_000n,
    profitTakenUsdMicros: 5_000_000n,
  };
  const converted = positionUsdFields(raw);
  assert.equal(converted.costUsd, 25);
  assert.equal(converted.avgEntryPriceUsd, 0.5);
  assert.equal(converted.currentPriceUsd, 0.75);
  assert.equal(converted.peakPriceUsd, 0.9);
  assert.equal(converted.realizedPnlUsd, 5);
  assert.equal(converted.unrealizedPnlUsd, -1.5);
  assert.equal(converted.profitTakenUsd, 5);
});

test("positionUsdFields preserves null for nullable price fields (a genuinely unset entry price), never coercing to 0", () => {
  const raw = {
    costUsdMicros: 25_000_000n,
    avgEntryPriceUsdMicros: null,
    currentPriceUsdMicros: null,
    peakPriceUsdMicros: null,
    realizedPnlUsdMicros: 0n,
    unrealizedPnlUsdMicros: 0n,
    profitTakenUsdMicros: 0n,
  };
  const converted = positionUsdFields(raw);
  assert.equal(converted.avgEntryPriceUsd, null);
  assert.equal(converted.currentPriceUsd, null);
  assert.equal(converted.peakPriceUsd, null);
});

test("positionUsdFields' merged object is safe to JSON.stringify (the raw BigInt micros fields are nulled to undefined, not left in)", () => {
  const raw = {
    id: "abc123",
    costUsdMicros: 25_000_000n,
    avgEntryPriceUsdMicros: 500_000n,
    currentPriceUsdMicros: 750_000n,
    peakPriceUsdMicros: 900_000n,
    realizedPnlUsdMicros: 5_000_000n,
    unrealizedPnlUsdMicros: -1_500_000n,
    profitTakenUsdMicros: 5_000_000n,
  };
  const merged = { ...raw, ...positionUsdFields(raw) };
  // This is the actual failure mode being guarded against: JSON.stringify throws a TypeError on a
  // real BigInt value (unlike `undefined`, which it silently omits) -- exactly what every apps/api
  // response containing a raw Position row would have hit if this weren't handled.
  assert.doesNotThrow(() => JSON.stringify(merged));
  const parsed = JSON.parse(JSON.stringify(merged));
  assert.equal(parsed.costUsd, 25);
  assert.equal("costUsdMicros" in parsed, false);
});

test("tradingCashUsdFields converts and is safe to JSON.stringify", () => {
  const raw = { id: "xyz", availableUsdMicros: 100_000_000n, inTradesUsdMicros: 50_000_000n };
  const merged = { ...raw, ...tradingCashUsdFields(raw) };
  assert.doesNotThrow(() => JSON.stringify(merged));
  const parsed = JSON.parse(JSON.stringify(merged));
  assert.equal(parsed.availableUsd, 100);
  assert.equal(parsed.inTradesUsd, 50);
  assert.equal("availableUsdMicros" in parsed, false);
});
