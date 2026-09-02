// Regression coverage for a real production incident: conn.onLogs websocket subscriptions have
// no built-in liveness/reconnect in @solana/web3.js. A silent drop left every subscription id
// sitting in the listener's map forever with a dead underlying socket -- detected/decoded/errors
// all froze at the exact same timestamp with no thrown error, no crash, and the process's own
// heartbeat kept reporting "healthy" throughout (it just reads in-memory counters on its own
// independent timer, with no idea the actual event stream had stopped). This tests the pure
// decision of when pollSlotLiveness forces a reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReconnect } from "./parsing.js";

const SLOT_STALE_MS = 90_000, FORCED_MS = 15 * 60_000;

test("a cold-start (lastSlotAt never set) does not force a reconnect on its own", () => {
  const d = shouldReconnect({ now: 1_000_000, lastSlotAt: 0, lastForcedReconnectAt: 1_000_000, slotStaleMs: SLOT_STALE_MS, forcedIntervalMs: FORCED_MS });
  assert.equal(d.reconnect, false);
});

test("a fresh slot observation does not force a reconnect", () => {
  const now = 1_000_000;
  const d = shouldReconnect({ now, lastSlotAt: now - 10_000, lastForcedReconnectAt: now - 10_000, slotStaleMs: SLOT_STALE_MS, forcedIntervalMs: FORCED_MS });
  assert.equal(d.reconnect, false);
});

test("a slot observation older than the stale bound forces a reconnect -- this is the exact silent-websocket-death case", () => {
  const now = 1_000_000;
  const d = shouldReconnect({ now, lastSlotAt: now - (SLOT_STALE_MS + 1), lastForcedReconnectAt: now - 1_000, slotStaleMs: SLOT_STALE_MS, forcedIntervalMs: FORCED_MS });
  assert.equal(d.reconnect, true);
  assert.match(d.reason!, /slot poll stale/);
});

test("the periodic forced-refresh interval fires even when slots are fresh -- defense in depth against any other silent-death mode", () => {
  const now = 1_000_000;
  const d = shouldReconnect({ now, lastSlotAt: now - 5_000, lastForcedReconnectAt: now - (FORCED_MS + 1), slotStaleMs: SLOT_STALE_MS, forcedIntervalMs: FORCED_MS });
  assert.equal(d.reconnect, true);
  assert.equal(d.reason, "periodic refresh");
});

test("a stale slot takes priority over -- and its reason is distinguishable from -- the periodic reason", () => {
  const now = 1_000_000;
  const d = shouldReconnect({ now, lastSlotAt: now - (SLOT_STALE_MS + 1), lastForcedReconnectAt: now - (FORCED_MS + 1), slotStaleMs: SLOT_STALE_MS, forcedIntervalMs: FORCED_MS });
  assert.equal(d.reconnect, true);
  assert.match(d.reason!, /slot poll stale/);
});
