import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateChainFlow, type FlowRow } from "./aggregate.js";

const now = Date.now();
const since1m = new Date(now - 60_000);
function row(side: "BUY" | "SELL", amountUsd: number, wallet: string, secondsAgo: number): FlowRow {
  return { side, amountUsd, walletAddress: wallet, observedAt: new Date(now - secondsAgo * 1000) };
}

test("aggregateChainFlow separates 1m and 5m windows correctly", () => {
  const rows: FlowRow[] = [
    row("BUY", 100, "W1", 30), // within 1m
    row("BUY", 200, "W2", 200), // within 5m only
  ];
  const m = aggregateChainFlow(rows, since1m);
  assert.equal(m.volume1mUsd, 100);
  assert.equal(m.buyVolume5mUsd, 300);
  assert.equal(m.buys1m, 1);
  assert.equal(m.buys5m, 2);
});

test("aggregateChainFlow counts unique buyers, not raw buy events (repeat buyer counts once)", () => {
  const rows: FlowRow[] = [row("BUY", 50, "W1", 10), row("BUY", 75, "W1", 20), row("BUY", 10, "W2", 15)];
  const m = aggregateChainFlow(rows, since1m);
  assert.equal(m.uniqueBuyers1m, 2);
  assert.equal(m.buys1m, 3, "raw buy event count is still tracked separately from unique buyers");
});

test("aggregateChainFlow treats null amountUsd as 0, never as a crash or NaN", () => {
  const rows: FlowRow[] = [{ side: "BUY", amountUsd: null, walletAddress: "W1", observedAt: new Date(now - 5000) }];
  const m = aggregateChainFlow(rows, since1m);
  assert.equal(m.buyVolume5mUsd, 0);
  assert.ok(Number.isFinite(m.volumeAcceleration1m));
});

test("aggregateChainFlow's volumeAcceleration1m is neutral (1), not 0, with no 5m baseline -- 'not enough data' must not read as 'volume collapsing'", () => {
  const m = aggregateChainFlow([], since1m);
  assert.equal(m.volumeAcceleration1m, 1);
});

test("aggregateChainFlow computes real acceleration: last-minute pace vs the 5-minute average pace", () => {
  // All $500 of 5m volume happened in the most recent minute -- the whole 5m average ($100/min) is
  // concentrated into 1 minute, so acceleration should reflect that spike (5x), not read as normal.
  const rows: FlowRow[] = [row("BUY", 500, "W1", 10)];
  const m = aggregateChainFlow(rows, since1m);
  assert.equal(m.buyVolume5mUsd, 500);
  assert.equal(m.volumeAcceleration1m, 5); // 500 (1m) / (500/5) (avg per min) = 5x
});

test("aggregateChainFlow tracks sell volume and unique sellers independently of buy metrics", () => {
  const rows: FlowRow[] = [row("SELL", 300, "W1", 10), row("SELL", 100, "W2", 200)];
  const m = aggregateChainFlow(rows, since1m);
  assert.equal(m.sellVolume5mUsd, 400);
  assert.equal(m.uniqueSellers5m, 2);
  assert.equal(m.sells1m, 1);
  assert.equal(m.buyVolume5mUsd, 0);
});
