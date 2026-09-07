// Hermetic unit tests for the Fomo-style 24H history + trader profile overlay. These test the
// pure computation functions in curatedRoutes.ts directly against synthetic in-memory rows --
// no database connection, no network call, no production Mongo access. DB-query-shaped behavior
// (which WalletActivity rows a Prisma `where` clause selects, cursor pagination against real
// data, canonical-trader lookup) is covered by source review of the shared predicate builders
// tested below, not by hitting a live database from this test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenQty, execPrice, performance, tokenRoundTrips, boughtMintsFrom, profileTradeStats,
  adminWalletFields, activeAdminWalletPredicate
} from "./curatedRoutes.js";

function row(overrides: any) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    action: "BUY",
    mint: "MintA",
    amountRaw: "1000000",
    decimals: 6,
    amountUsd: 100,
    observedAt: new Date(),
    ...overrides
  };
}

test("tokenQty computes decimal-adjusted quantity and rejects invalid input", () => {
  assert.equal(tokenQty(row({ amountRaw: "5000000", decimals: 6 })), 5);
  assert.equal(tokenQty(row({ amountRaw: "abc", decimals: 6 })), null);
  assert.equal(tokenQty(row({ amountRaw: "100", decimals: null })), 100);
});

test("execPrice is only derived when both quantity and USD value are known -- never invented", () => {
  assert.equal(execPrice(row({ amountRaw: "2000000", decimals: 6, amountUsd: 10 })), 5);
  assert.equal(execPrice(row({ amountRaw: "2000000", decimals: 6, amountUsd: null })), null);
  assert.equal(execPrice(row({ amountRaw: null, amountUsd: 10 })), null);
});

test("adminWalletFields and activeAdminWalletPredicate always require the full canonical-source invariant", () => {
  const wf = adminWalletFields();
  assert.equal(wf.source, "ADMIN");
  assert.equal(wf.verified, true);
  assert.equal(wf.chain, "SOLANA");
  assert.equal(wf.monitoringStatus, "ACTIVE");
  const p = activeAdminWalletPredicate();
  assert.equal(p.trader.kind, "PLATFORM");
  assert.equal(p.trader.enabled, true);
  // every field from adminWalletFields must still be present -- a future edit that narrows
  // activeAdminWalletPredicate without also narrowing adminWalletFields would break this.
  for (const key of Object.keys(wf)) assert.equal((p as any)[key], (wf as any)[key]);
});

test("a real BUY followed by a matching SELL produces a defensible realized PnL and win", () => {
  const since = new Date(Date.now() - 60_000);
  const buy = row({ action: "BUY", mint: "MintA", amountUsd: 100, amountRaw: "10000000", decimals: 6, observedAt: new Date(Date.now() - 30_000) });
  const sell = row({ action: "SELL", mint: "MintA", amountUsd: 150, amountRaw: "10000000", decimals: 6, observedAt: new Date(Date.now() - 10_000) });
  const perf = performance([buy, sell], since);
  assert.equal(perf.closed, 1);
  assert.equal(perf.wins, 1);
  assert.equal(perf.pnlUsd, 50);
  assert.equal(perf.trades, 2);
});

test("an unmatched SELL with no prior BUY never fabricates a realized PnL or a fake win", () => {
  const since = new Date(Date.now() - 60_000);
  const sell = row({ action: "SELL", mint: "MintB", amountUsd: 150, observedAt: new Date() });
  const perf = performance([sell], since);
  assert.equal(perf.closed, 0);
  assert.equal(perf.wins, 0);
  assert.equal(perf.pnlUsd, null, "no closed lot exists -- pnl must be unknown, not zero or invented");
});

test("a BUY with no matching SELL yet reports no fabricated closed trades or PnL", () => {
  const since = new Date(Date.now() - 60_000);
  const buy = row({ action: "BUY", mint: "MintC", amountUsd: 100, observedAt: new Date() });
  const perf = performance([buy], since);
  assert.equal(perf.closed, 0);
  assert.equal(perf.pnlUsd, null);
  assert.equal(perf.trades, 1);
});

test("TRANSFER_IN and AIRDROP rows are silently ignored by performance() -- never treated as trades", () => {
  const since = new Date(Date.now() - 60_000);
  const transfer = row({ action: "TRANSFER_IN", mint: "MintD", amountUsd: 999_999, observedAt: new Date() });
  const airdrop = row({ action: "AIRDROP", mint: "MintD", amountUsd: 999_999, observedAt: new Date() });
  const buy = row({ action: "BUY", mint: "MintA", amountUsd: 100, observedAt: new Date() });
  const withNoise = performance([transfer, airdrop, buy], since);
  const withoutNoise = performance([buy], since);
  assert.deepEqual(withNoise, withoutNoise, "a transfer/airdrop mixed into the row set must not change computed performance at all");
  assert.equal(withNoise.trades, 1, "only the real BUY counts as a trade");
});

test("boughtMintsFrom includes only mints with a real verified BUY -- never a transfer/airdrop-only mint", () => {
  const buy = row({ action: "BUY", mint: "BoughtMint" });
  const transferOnly = row({ action: "TRANSFER_IN", mint: "TransferOnlyMint" });
  const airdropOnly = row({ action: "AIRDROP", mint: "AirdropOnlyMint" });
  const sellOnly = row({ action: "SELL", mint: "SellOnlyMintNeverBought" });
  const mints = boughtMintsFrom([buy, transferOnly, airdropOnly, sellOnly]);
  assert.ok(mints.has("BoughtMint"));
  assert.ok(!mints.has("TransferOnlyMint"), "a token merely transferred in must never qualify as a tracked holding");
  assert.ok(!mints.has("AirdropOnlyMint"), "an airdropped token must never qualify as a tracked holding");
  assert.ok(!mints.has("SellOnlyMintNeverBought"), "a sell with no prior buy on record must not retroactively qualify the mint");
});

test("tokenRoundTrips: firstEntryAt is pinned to the first BUY and is never overwritten by a later SELL", () => {
  const firstBuyAt = new Date(Date.now() - 3 * 60 * 60_000);
  const laterSellAt = new Date(Date.now() - 60_000);
  const buy = row({ action: "BUY", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 100, observedAt: firstBuyAt });
  const sell = row({ action: "SELL", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 150, observedAt: laterSellAt });
  const [entry] = tokenRoundTrips([sell, buy], new Map(), new Map(), true);
  assert.equal(entry.firstEntryAt.getTime(), firstBuyAt.getTime());
  assert.equal(entry.lastTradeAt.getTime(), laterSellAt.getTime());
});

test("tokenRoundTrips: a bought-then-fully-sold token is EXITED_OR_MOVED, not silently dropped, when holdings are known", () => {
  const buy = row({ action: "BUY", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 100 });
  const sell = row({ action: "SELL", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 150 });
  const holdings = new Map(); // wallet no longer holds it
  const [entry] = tokenRoundTrips([buy, sell], holdings, new Map(), true);
  assert.equal(entry.status, "EXITED_OR_MOVED");
  assert.equal(entry.buys, 1);
  assert.equal(entry.sells, 1);
});

test("tokenRoundTrips: a bought-and-still-held token is HOLDING when the current on-chain balance is known", () => {
  const buy = row({ action: "BUY", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 100 });
  const holdings = new Map([["MintA", { amount: 10, valueUsd: 20 }]]);
  const [entry] = tokenRoundTrips([buy], holdings, new Map(), true);
  assert.equal(entry.status, "HOLDING");
  assert.equal(entry.currentAmount, 10);
});

test("tokenRoundTrips: when the current on-chain balance could not be fetched, status is UNKNOWN -- never fabricated as EXITED", () => {
  const buy = row({ action: "BUY", mint: "MintA", amountRaw: "10000000", decimals: 6, amountUsd: 100 });
  const [entry] = tokenRoundTrips([buy], new Map(), new Map(), /* holdingsKnown */ false);
  assert.equal(entry.status, "UNKNOWN");
});

test("tokenRoundTrips: rapid individual scalper swaps are each preserved, not collapsed into one row", () => {
  const events = Array.from({ length: 6 }, (_, i) => row({
    action: i % 2 === 0 ? "BUY" : "SELL", mint: "MintA", amountRaw: "1000000", decimals: 6, amountUsd: 10 + i,
    observedAt: new Date(Date.now() - (6 - i) * 1000)
  }));
  const [entry] = tokenRoundTrips(events, new Map(), new Map(), true);
  assert.equal(entry.buys, 3);
  assert.equal(entry.sells, 3);
  assert.equal(entry.buys + entry.sells, events.length, "every individual verified swap must remain counted -- none silently merged away");
});

test("profileTradeStats never fabricates volume from rows with unknown USD value", () => {
  const since = new Date(Date.now() - 60_000);
  const knownBuy = row({ action: "BUY", amountUsd: 100, observedAt: new Date() });
  const unknownBuy = row({ action: "BUY", amountUsd: null, observedAt: new Date() });
  const stats = profileTradeStats([knownBuy, unknownBuy], since);
  assert.equal(stats.trades, 2);
  assert.equal(stats.volumeUsd, 100, "a row with unknown USD value must not contribute NaN or an invented amount to volume");
});
