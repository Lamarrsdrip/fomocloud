import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initials, timeAgo, urlB64ToBytes, whaleCount, feedLine, eventLine,
  qualityLabel, lifecycleLabel, decisionActionLabel, smartMoneyFilterLabel,
  positionMath, deviceLabel,
} from "./format.js";

test("initials: takes the first letter of up to the first two words, uppercased", () => {
  assert.equal(initials("Jane Doe"), "JD");
  assert.equal(initials("solo"), "S");
  assert.equal(initials("multiple   spaces  here"), "MS");
});
test("initials: falls back to 'U' for missing/empty names, never crashes on undefined", () => {
  assert.equal(initials(undefined), "U");
  assert.equal(initials(null), "U");
  assert.equal(initials(""), "U");
});

test("timeAgo: renders seconds, minutes, hours, and days in the expected bucket", () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now - 5_000).toISOString()), "5s ago");
  assert.equal(timeAgo(new Date(now - 5 * 60_000).toISOString()), "5m ago");
  assert.equal(timeAgo(new Date(now - 5 * 3600_000).toISOString()), "5h ago");
  assert.equal(timeAgo(new Date(now - 5 * 86400_000).toISOString()), "5d ago");
});
test("timeAgo: a timestamp in the future still reads as at least 1s ago, never negative", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(timeAgo(future), "1s ago");
});

test("urlB64ToBytes: round-trips a base64url VAPID-style key into the expected byte values", () => {
  // "AAECAw" (no padding, base64url) decodes to bytes [0,1,2,3]
  const bytes = urlB64ToBytes("AAECAw");
  assert.deepEqual([...bytes], [0, 1, 2, 3]);
});

test("whaleCount: sums whale + known-whale buyer counts, treats missing fields as 0", () => {
  assert.equal(whaleCount({ whaleBuyers60s: 3, knownWhaleBuyers60s: 2 }), 5);
  assert.equal(whaleCount({}), 0);
});

test("feedLine: MONEY_RUSH state takes priority and reports real wallet/inflow counts", () => {
  const f = feedLine({ state: "MONEY_RUSH", whaleBuyers60s: 4, inflow60sUsd: 5000, symbol: "DOGE" });
  assert.equal(f.emoji, "🐋");
  assert.match(f.text, /DOGE/);
});
test("feedLine: falls back to a 'watching' line with chain and score when nothing else qualifies", () => {
  const f = feedLine({ chain: "SOLANA", score: 42, symbol: "FOO" });
  assert.equal(f.emoji, "👀");
  assert.match(f.sub, /SOLANA/);
  assert.match(f.sub, /42/);
});

test("eventLine: maps a known type to its emoji and carries through title/body/createdAt", () => {
  const e = eventLine({ type: "PROFIT_TAKEN", title: "Profit taken", body: "$10", createdAt: "2026-01-01" });
  assert.equal(e.emoji, "💰");
  assert.equal(e.text, "Profit taken");
  assert.equal(e.at, "2026-01-01");
});
test("eventLine: an unrecognized type falls back to a generic emoji rather than undefined", () => {
  const e = eventLine({ type: "SOME_NEW_TYPE", title: "x", body: "y", createdAt: "2026-01-01" });
  assert.equal(e.emoji, "📣");
});

test("qualityLabel: buckets scores into the 4 documented tiers", () => {
  assert.equal(qualityLabel(90), "Strong setup");
  assert.equal(qualityLabel(60), "Building evidence");
  assert.equal(qualityLabel(45), "Early — thin evidence");
  assert.equal(qualityLabel(10), "Just watching");
});

test("lifecycleLabel: known statuses map to their human label, unknown passes through unchanged", () => {
  assert.equal(lifecycleLabel("HEATING_UP"), "Heating up");
  assert.equal(lifecycleLabel("SOME_FUTURE_STATUS"), "SOME_FUTURE_STATUS");
});

test("decisionActionLabel: known actions map to plain language, unknown falls back to a de-slugged version", () => {
  assert.equal(decisionActionLabel("WAIT_PULLBACK"), "Waiting for a Better Entry");
  assert.equal(decisionActionLabel("SOME_NEW_ACTION"), "SOME NEW ACTION");
});

test("smartMoneyFilterLabel: maps each filter id to its display label, defaulting to All", () => {
  assert.equal(smartMoneyFilterLabel("hot"), "Hot Now");
  assert.equal(smartMoneyFilterLabel("new"), "Newly Discovered");
  assert.equal(smartMoneyFilterLabel("proven"), "Proven");
  assert.equal(smartMoneyFilterLabel("whales"), "Meme Whales");
  assert.equal(smartMoneyFilterLabel("smart-degens"), "Smart Degens");
  assert.equal(smartMoneyFilterLabel("all"), "All");
  assert.equal(smartMoneyFilterLabel("unknown"), "All");
});

test("positionMath: a fully open position values 100% of its cost basis plus unrealized P&L", () => {
  const m = positionMath({ entryTokenRaw: "1000", remainingTokenRaw: "1000", costUsd: 100, unrealizedPnlUsd: 20 });
  assert.equal(m.fraction, 1);
  assert.equal(m.remainingCost, 100);
  assert.equal(m.currentValue, 120);
  assert.equal(m.pnlPct, 20);
});
test("positionMath: a partially-closed position values only its remaining token fraction", () => {
  const m = positionMath({ entryTokenRaw: "1000", remainingTokenRaw: "250", costUsd: 100, unrealizedPnlUsd: 0 });
  assert.equal(m.fraction, 0.25);
  assert.equal(m.remainingCost, 25);
});
test("positionMath: malformed/missing raw amounts fall back safely instead of throwing", () => {
  const m = positionMath({ entryTokenRaw: "not-a-number", remainingTokenRaw: "also-bad", unrealizedPnlUsd: 7 });
  assert.equal(m.currentValue, 7);
  assert.equal(m.pnlPct, 0);
});

test("deviceLabel: parses a real mobile Safari user-agent into device + browser", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  assert.equal(deviceLabel(ua), "iPhone · Safari");
});
test("deviceLabel: falls back to 'Unknown device' when no user-agent is available", () => {
  assert.equal(deviceLabel(undefined), "Unknown device");
  assert.equal(deviceLabel(null), "Unknown device");
});
