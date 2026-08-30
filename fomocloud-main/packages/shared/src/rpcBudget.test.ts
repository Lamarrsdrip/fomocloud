import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTokenBucket, RpcBudget, RESERVE_FRACTION, type RedisEvalClient } from "./index.js";

test("a full bucket grants a P0 request and takes exactly one token", () => {
  const r = computeTokenBucket({ capacity: 10, ratePerSec: 5, reserveFraction: 0, state: null, now: 1000 });
  assert.equal(r.granted, true);
  assert.equal(r.tokens, 9);
});

test("P5's large reserve blocks a request even when tokens remain, if below its reserve line", () => {
  // capacity 10, P5 reserve fraction 0.6 -> must keep 6 in reserve after the draw
  const r = computeTokenBucket({
    capacity: 10, ratePerSec: 5, reserveFraction: RESERVE_FRACTION.P5,
    state: { tokens: 6, updatedAt: 1000 }, now: 1000,
  });
  assert.equal(r.granted, false, "6 - 1 = 5, which is below the 6-token P5 reserve line");
  assert.equal(r.tokens, 6, "a denied request must not consume a token");
});

test("P0's zero reserve keeps granting all the way down to the last token -- this is the whole point", () => {
  const r = computeTokenBucket({
    capacity: 10, ratePerSec: 5, reserveFraction: RESERVE_FRACTION.P0,
    state: { tokens: 1, updatedAt: 1000 }, now: 1000,
  });
  assert.equal(r.granted, true);
  assert.equal(r.tokens, 0);
});

test("P0 is refused only once the bucket is truly empty", () => {
  const r = computeTokenBucket({
    capacity: 10, ratePerSec: 5, reserveFraction: RESERVE_FRACTION.P0,
    state: { tokens: 0, updatedAt: 1000 }, now: 1000,
  });
  assert.equal(r.granted, false);
  assert.equal(r.tokens, 0);
});

test("tokens refill proportionally to elapsed time, capped at capacity", () => {
  const r = computeTokenBucket({
    capacity: 10, ratePerSec: 5, reserveFraction: 0,
    state: { tokens: 0, updatedAt: 1000 }, now: 3000, // 2s elapsed * 5/s = 10 refilled, capped at 10
  });
  assert.equal(r.granted, true);
  assert.equal(r.tokens, 9, "10 refilled, capped at capacity, minus the 1 just drawn");
});

test("no time elapsed means no refill -- a request right after a denial stays denied", () => {
  const r = computeTokenBucket({
    capacity: 10, ratePerSec: 5, reserveFraction: RESERVE_FRACTION.P4,
    state: { tokens: 0, updatedAt: 1000 }, now: 1000,
  });
  assert.equal(r.granted, false);
});

test("a first-ever request with no prior state starts from a full bucket", () => {
  const r = computeTokenBucket({ capacity: 20, ratePerSec: 3, reserveFraction: 0, state: null, now: 5000 });
  assert.equal(r.granted, true);
  assert.equal(r.tokens, 19);
});

test("higher priority tiers reserve strictly more headroom than lower ones -- P0 < P1 < ... < P5", () => {
  const tiers = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(RESERVE_FRACTION[tiers[i]] > RESERVE_FRACTION[tiers[i - 1]], `${tiers[i]} must reserve more than ${tiers[i - 1]}`);
  }
});

test("RpcBudget.tryAcquire invokes eval with the priority's reserve fraction and parses a grant", async () => {
  const calls: unknown[][] = [];
  const redis: RedisEvalClient = {
    async eval(script, numKeys, ...args) {
      calls.push([numKeys, ...args]);
      return [1, "4.5"];
    },
  };
  const budget = new RpcBudget(redis, "rpc-budget:helius", { capacity: 10, ratePerSec: 5 });
  const result = await budget.tryAcquire("P2");
  assert.equal(result.granted, true);
  assert.equal(result.tokensRemaining, 4.5);
  const [numKeys, key, capacity, ratePerSec, reserveFraction] = calls[0];
  assert.equal(numKeys, 1);
  assert.equal(key, "rpc-budget:helius");
  assert.equal(capacity, 10);
  assert.equal(ratePerSec, 5);
  assert.equal(reserveFraction, RESERVE_FRACTION.P2);
});

test("RpcBudget.tryAcquire parses a denial from eval correctly", async () => {
  const redis: RedisEvalClient = { async eval() { return [0, "2"]; } };
  const budget = new RpcBudget(redis, "rpc-budget:helius", { capacity: 10, ratePerSec: 5 });
  const result = await budget.tryAcquire("P5");
  assert.equal(result.granted, false);
  assert.equal(result.tokensRemaining, 2);
});

test("RpcBudget fails open (grants) when Redis is unreachable -- a coordination outage must not silently stall every worker", async () => {
  const redis: RedisEvalClient = { async eval() { throw new Error("redis down"); } };
  const budget = new RpcBudget(redis, "rpc-budget:helius", { capacity: 10, ratePerSec: 5 });
  const result = await budget.tryAcquire("P0");
  assert.equal(result.granted, true);
});
