import test from "node:test";
import assert from "node:assert/strict";
import { MOBILE_NAV_IDS, normalizeAppView } from "./appNavigation";

test("mobile navigation is exactly Home, Hunt, Trade, Wallet, More", () => {
  assert.deepEqual(MOBILE_NAV_IDS, ["home", "discover", "trade", "positions", "more"]);
  assert.equal(new Set(MOBILE_NAV_IDS).size, 5);
});

test("legacy wallet and positions URLs resolve to the one Wallet destination", () => {
  assert.equal(normalizeAppView("wallet"), "positions");
  assert.equal(normalizeAppView("positions"), "positions");
  assert.equal(normalizeAppView(null, "/app/wallet/"), "positions");
});

test("hidden legacy routes resolve to their real existing views", () => {
  assert.equal(normalizeAppView(null, "/app/history/"), "activity");
  assert.equal(normalizeAppView(null, "/app/notifications/"), "profile");
  assert.equal(normalizeAppView(null, "/app/settings/"), "profile");
  assert.equal(normalizeAppView("admin-only"), "home");
});
