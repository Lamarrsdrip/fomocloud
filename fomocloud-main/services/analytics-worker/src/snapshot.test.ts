import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAccountSnapshot, type PositionRow, type CashRow } from "./snapshot.js";

function position(overrides: Partial<PositionRow>): PositionRow {
  return {
    costUsdMicros: 0n,
    entryTokenRaw: "1000000",
    remainingTokenRaw: "1000000",
    unrealizedPnlUsdMicros: 0n,
    realizedPnlUsdMicros: 0n,
    status: "OPEN",
    ...overrides,
  };
}

test("computeAccountSnapshot: account value is available cash plus full cost of a fully-open position", () => {
  const cash: CashRow[] = [{ availableUsdMicros: 100_000_000n, inTradesUsdMicros: 0n }];
  const positions = [position({ costUsdMicros: 50_000_000n, unrealizedPnlUsdMicros: 5_000_000n })];
  const s = computeAccountSnapshot(positions, cash);
  assert.equal(s.accountValueUsd, 155); // $100 available + ($50 cost + $5 unrealized)
  assert.equal(s.unrealizedPnlUsd, 5);
});

test("computeAccountSnapshot: a partially-closed position values only its remaining fraction of cost basis", () => {
  const cash: CashRow[] = [{ availableUsdMicros: 0n, inTradesUsdMicros: 0n }];
  const positions = [position({
    costUsdMicros: 100_000_000n, // $100 original cost
    entryTokenRaw: "1000000",
    remainingTokenRaw: "250000", // 25% of the position remains
    unrealizedPnlUsdMicros: 0n,
    status: "PARTIALLY_CLOSED",
  })];
  const s = computeAccountSnapshot(positions, cash);
  assert.equal(s.accountValueUsd, 25); // 25% of $100 cost remains open
});

test("computeAccountSnapshot: a fully CLOSED position contributes its realized P&L but zero open value", () => {
  const cash: CashRow[] = [{ availableUsdMicros: 0n, inTradesUsdMicros: 0n }];
  const positions = [position({
    costUsdMicros: 100_000_000n,
    remainingTokenRaw: "0",
    realizedPnlUsdMicros: 20_000_000n,
    status: "CLOSED",
  })];
  const s = computeAccountSnapshot(positions, cash);
  assert.equal(s.accountValueUsd, 0);
  assert.equal(s.realizedPnlUsd, 20);
  assert.equal(s.netPnlUsd, 20);
});

test("computeAccountSnapshot: malformed raw token amounts fall back to just the unrealized P&L instead of throwing", () => {
  const cash: CashRow[] = [{ availableUsdMicros: 0n, inTradesUsdMicros: 0n }];
  const positions = [position({
    costUsdMicros: 100_000_000n,
    entryTokenRaw: "not-a-number",
    remainingTokenRaw: "also-not-a-number",
    unrealizedPnlUsdMicros: 3_000_000n,
  })];
  const s = computeAccountSnapshot(positions, cash);
  assert.equal(s.accountValueUsd, 3);
});

test("computeAccountSnapshot: a zero-original-token position (original=0n) never divides by zero", () => {
  const cash: CashRow[] = [{ availableUsdMicros: 0n, inTradesUsdMicros: 0n }];
  const positions = [position({ costUsdMicros: 50_000_000n, entryTokenRaw: "0", remainingTokenRaw: "0", unrealizedPnlUsdMicros: 2_000_000n })];
  const s = computeAccountSnapshot(positions, cash);
  assert.ok(Number.isFinite(s.accountValueUsd));
  assert.equal(s.accountValueUsd, 2); // f=0, so only unrealized P&L counts
});

test("computeAccountSnapshot: multiple cash allocation rows sum together", () => {
  const cash: CashRow[] = [
    { availableUsdMicros: 30_000_000n, inTradesUsdMicros: 0n },
    { availableUsdMicros: 20_000_000n, inTradesUsdMicros: 0n },
  ];
  const s = computeAccountSnapshot([], cash);
  assert.equal(s.accountValueUsd, 50);
});
