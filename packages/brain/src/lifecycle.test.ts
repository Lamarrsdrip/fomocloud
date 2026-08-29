import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLifecycle } from "./index.js";

const NOW = Date.now();
const fresh = (overrides: Partial<{ score: number; lastEvaluatedAt: Date; firstSeenAt: Date; inflow60sUsd: number; buyers60s: number; whaleBuyers60s: number; knownWhaleBuyers60s: number }> = {}) => ({
  score: 0,
  lastEvaluatedAt: new Date(NOW),
  firstSeenAt: new Date(NOW - 60 * 60_000),
  inflow60sUsd: 0,
  buyers60s: 0,
  whaleBuyers60s: 0,
  knownWhaleBuyers60s: 0,
  ...overrides,
});

test("a worker that stopped evaluating a token is STALE regardless of score", () => {
  const row = fresh({ score: 95, lastEvaluatedAt: new Date(NOW - 20 * 60_000) });
  assert.equal(classifyLifecycle(row, NOW), "STALE");
});

test("score thresholds map to the real trading-decision tiers", () => {
  assert.equal(classifyLifecycle(fresh({ score: 86 }), NOW), "HIGH_CONVICTION");
  assert.equal(classifyLifecycle(fresh({ score: 76 }), NOW), "STRONG");
  assert.equal(classifyLifecycle(fresh({ score: 64 }), NOW), "HEATING_UP");
  assert.equal(classifyLifecycle(fresh({ score: 56 }), NOW), "INTERESTING");
});

test("below the trading threshold, real non-zero evidence is still WATCHING, not hidden", () => {
  assert.equal(classifyLifecycle(fresh({ score: 40, inflow60sUsd: 12 }), NOW), "WATCHING");
  assert.equal(classifyLifecycle(fresh({ score: 40, buyers60s: 1 }), NOW), "WATCHING");
  assert.equal(classifyLifecycle(fresh({ score: 40, whaleBuyers60s: 1 }), NOW), "WATCHING");
  assert.equal(classifyLifecycle(fresh({ score: 40, knownWhaleBuyers60s: 1 }), NOW), "WATCHING");
});

test("zero evidence but genuinely just discovered is FOUND, not fabricated activity", () => {
  const row = fresh({ score: 20, firstSeenAt: new Date(NOW - 2 * 60_000) });
  assert.equal(classifyLifecycle(row, NOW), "FOUND");
});

test("zero evidence and not recently discovered is COOLING, never permanently live", () => {
  const row = fresh({ score: 20, firstSeenAt: new Date(NOW - 60 * 60_000) });
  assert.equal(classifyLifecycle(row, NOW), "COOLING");
});

test("STALE takes priority over every other classification", () => {
  const row = fresh({ score: 99, inflow60sUsd: 999, firstSeenAt: new Date(NOW - 1000), lastEvaluatedAt: new Date(NOW - 16 * 60_000) });
  assert.equal(classifyLifecycle(row, NOW), "STALE");
});
