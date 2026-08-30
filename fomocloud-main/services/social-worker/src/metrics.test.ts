import { test } from "node:test";
import assert from "node:assert/strict";
import { computePulseMetrics, type TweetRow } from "./metrics.js";

const NOW = Date.parse("2026-01-01T00:15:00.000Z");
function tweet(minutesAgo: number, authorId: string, text: string): TweetRow {
  return { created_at: new Date(NOW - minutesAgo * 60_000).toISOString(), author_id: authorId, text };
}

test("computePulseMetrics: no tweets at all never produces NaN/Infinity", () => {
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, [], NOW);
  assert.equal(m.mentions5m, 0);
  assert.equal(m.mentions15m, 0);
  assert.equal(m.uniqueAuthors5m, 0);
  assert.ok(Number.isFinite(m.sentiment));
  assert.ok(Number.isFinite(m.velocity));
  assert.ok(Number.isFinite(m.spamRatio));
});

test("computePulseMetrics: separates the 5m window from the full 15m window", () => {
  const rows = [tweet(1, "a", "moon"), tweet(10, "b", "moon")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.equal(m.mentions5m, 1);
  assert.equal(m.mentions15m, 2);
});

test("computePulseMetrics: counts unique authors, not raw mention count", () => {
  const rows = [tweet(1, "a", "moon"), tweet(2, "a", "bullish"), tweet(3, "b", "gem")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.equal(m.mentions5m, 3);
  assert.equal(m.uniqueAuthors5m, 2);
});

test("computePulseMetrics: sentiment is positive when bullish keywords dominate", () => {
  const rows = [tweet(1, "a", "this is going to moon"), tweet(1, "b", "bullish af"), tweet(1, "c", "rug")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.ok(m.sentiment > 0);
});

test("computePulseMetrics: sentiment is negative when rug/scam keywords dominate", () => {
  const rows = [tweet(1, "a", "this is a rug"), tweet(1, "b", "scam alert"), tweet(1, "c", "moon")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.ok(m.sentiment < 0);
});

test("computePulseMetrics: neutral text with no keyword matches at all is 0, not NaN", () => {
  const rows = [tweet(1, "a", "just a normal tweet with no signal words")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.equal(m.sentiment, 0);
});

test("computePulseMetrics: spamRatio is high when one author floods the 5m window", () => {
  const rows = [tweet(1, "a", "moon"), tweet(1, "a", "moon"), tweet(1, "a", "moon"), tweet(1, "a", "moon")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.ok(m.spamRatio >= 0.7);
});

test("computePulseMetrics: spamRatio is low when every mention is a distinct author", () => {
  const rows = [tweet(1, "a", "moon"), tweet(1, "b", "moon"), tweet(1, "c", "moon"), tweet(1, "d", "moon")];
  const m = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, rows, NOW);
  assert.equal(m.spamRatio, 0);
});

test("computePulseMetrics: velocity rewards a genuine recent spike over steady older volume", () => {
  const spike = [tweet(1, "a", "moon"), tweet(1, "b", "moon"), tweet(1, "c", "moon"), tweet(1, "d", "moon")];
  const steady = [tweet(1, "a", "moon"), tweet(8, "b", "moon"), tweet(9, "c", "moon"), tweet(10, "d", "moon")];
  const mSpike = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, spike, NOW);
  const mSteady = computePulseMetrics({ symbol: "FOO", mint: "mint1" }, steady, NOW);
  assert.ok(mSpike.velocity > mSteady.velocity);
});

test("computePulseMetrics: falls back to an empty symbol string, never undefined/null, when the token has none", () => {
  const m = computePulseMetrics({ mint: "mint1" }, [], NOW);
  assert.equal(m.symbol, "");
  assert.equal(m.mint, "mint1");
});
