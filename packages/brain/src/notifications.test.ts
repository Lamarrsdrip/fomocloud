import { test } from "node:test";
import assert from "node:assert/strict";
import { didStateUpgrade, isNewConvergence } from "./index.js";

test("no prior notification and a real state fires an upgrade", () => {
  assert.equal(didStateUpgrade(null, "BUILDING"), true);
  assert.equal(didStateUpgrade(undefined, "BREAKOUT_FLOW"), true);
});

test("SCANNING is never an upgrade -- there is nothing to notify about", () => {
  assert.equal(didStateUpgrade(null, "SCANNING"), false);
  assert.equal(didStateUpgrade("BUILDING", "SCANNING"), false);
});

test("a genuine tier increase fires exactly once", () => {
  assert.equal(didStateUpgrade("BUILDING", "BREAKOUT_FLOW"), true);
  assert.equal(didStateUpgrade("BREAKOUT_FLOW", "MONEY_RUSH"), true);
});

test("staying in the same tier on a later tick never re-fires -- this is the actual bug this replaced", () => {
  assert.equal(didStateUpgrade("BUILDING", "BUILDING"), false);
  assert.equal(didStateUpgrade("MONEY_RUSH", "MONEY_RUSH"), false);
});

test("dropping back down a tier is not an upgrade and must not notify", () => {
  assert.equal(didStateUpgrade("MONEY_RUSH", "BUILDING"), false);
  assert.equal(didStateUpgrade("BREAKOUT_FLOW", "SCANNING"), false);
});

test("a single wallet buying is not convergence", () => {
  assert.equal(isNewConvergence(1, 0), false);
});

test("two or more tracked wallets is genuine convergence, fired once", () => {
  assert.equal(isNewConvergence(2, 0), true);
  assert.equal(isNewConvergence(2, 1), true);
});

test("the same convergence count on a later tick never re-fires", () => {
  assert.equal(isNewConvergence(2, 2), false);
  assert.equal(isNewConvergence(3, 3), false);
});

test("a further real increase (2 -> 3 wallets) fires again", () => {
  assert.equal(isNewConvergence(3, 2), true);
});

test("convergence count dropping (a wallet's activity aged out of the window) never notifies", () => {
  assert.equal(isNewConvergence(1, 3), false);
});
