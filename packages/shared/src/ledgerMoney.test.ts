import { test } from "node:test";
import assert from "node:assert/strict";
import { usdToMicros, microsToUsd } from "./index.js";

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
