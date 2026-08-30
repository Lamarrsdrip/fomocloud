import { test } from "node:test";
import assert from "node:assert/strict";
import { pushAllowed, emailWorthSending } from "./decisions.js";

test("pushAllowed defaults to true for a known type with no preference row at all", () => {
  assert.equal(pushAllowed("TRADE_COPIED", undefined), true);
  assert.equal(pushAllowed("TRADE_COPIED", null), true);
});

test("pushAllowed defaults to true for an unrecognized type", () => {
  assert.equal(pushAllowed("SOME_FUTURE_TYPE", {}), true);
});

test("pushAllowed respects each per-type preference field", () => {
  assert.equal(pushAllowed("TRADER_SIGNAL", { traderBought: false }), false);
  assert.equal(pushAllowed("TRADE_COPIED", { tradeCopied: false }), false);
  assert.equal(pushAllowed("TRADE_SKIPPED", { skippedTrade: false }), false);
  assert.equal(pushAllowed("WAIT_PULLBACK", { skippedTrade: false }), false);
  assert.equal(pushAllowed("PROFIT_TAKEN", { profitTaken: false }), false);
  assert.equal(pushAllowed("POSITION_CLOSED", { positionClosed: false }), false);
});

test("pushAllowed: SECURITY_ALERT respects securityAlerts -- regression test for the 'wired to nothing' bug fixed this session", () => {
  assert.equal(pushAllowed("SECURITY_ALERT", { securityAlerts: false }), false);
  assert.equal(pushAllowed("SECURITY_ALERT", { securityAlerts: true }), true);
  assert.equal(pushAllowed("SECURITY_ALERT", {}), true);
});

test("pushAllowed: a global pushEnabled:false overrides every per-type preference, even one explicitly set to true", () => {
  assert.equal(pushAllowed("SECURITY_ALERT", { pushEnabled: false, securityAlerts: true }), false);
  assert.equal(pushAllowed("TRADE_COPIED", { pushEnabled: false, tradeCopied: true }), false);
});

test("emailWorthSending only includes the 4 types worth the cost of an email", () => {
  assert.equal(emailWorthSending("TRADE_COPIED"), true);
  assert.equal(emailWorthSending("PROFIT_TAKEN"), true);
  assert.equal(emailWorthSending("POSITION_CLOSED"), true);
  assert.equal(emailWorthSending("SECURITY_ALERT"), true);
  assert.equal(emailWorthSending("TRADER_SIGNAL"), false);
  assert.equal(emailWorthSending("TRADE_SKIPPED"), false);
});
