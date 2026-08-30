import { test } from "node:test";
import assert from "node:assert/strict";
import { BirdeyeClient } from "./index.js";

// Real gap found by forensic audit (M-51): this package's test script was `echo providers tests` --
// a green no-op -- despite normalizeToken/normalizeTrader/normalizeWalletPnl being exactly the kind
// of pure, easy-to-get-subtly-wrong logic that has already caused real production bugs this session
// (Birdeye's field names vary by endpoint -- e.g. "market_cap" vs "marketcap" vs "market_cap_usd" --
// and this is the ONLY place that inconsistency gets normalized before feeding scoring/discovery).
const client = new BirdeyeClient("fake-key-for-tests");

test("normalizeToken reads whichever field name variant a given Birdeye endpoint actually used", () => {
  const snakeCase = client.normalizeToken({ address: "MINT1", symbol: "FOO", market_cap: 500000, liquidity: 20000, volume_24h_usd: 10000 });
  assert.equal(snakeCase.mint, "MINT1");
  assert.equal(snakeCase.marketCapUsd, 500000);
  assert.equal(snakeCase.liquidityUsd, 20000);

  const camelCase = client.normalizeToken({ token_address: "MINT2", token_symbol: "BAR", marketCap: 750000, liquidityUsd: 30000, v24hUSD: 15000 });
  assert.equal(camelCase.mint, "MINT2");
  assert.equal(camelCase.marketCapUsd, 750000);
  assert.equal(camelCase.liquidityUsd, 30000);
  assert.equal(camelCase.volume24hUsd, 15000);
});

test("normalizeToken returns undefined (not 0 or a crash) for genuinely missing fields", () => {
  const empty = client.normalizeToken({});
  assert.equal(empty.mint, undefined);
  assert.equal(empty.marketCapUsd, undefined);
  // Undefined, not 0 -- a real gap elsewhere in this codebase (fixed this session) was exactly this
  // class of bug: missing evidence silently becoming a real-looking zero.
});

test("normalizeTrader extracts Birdeye's own wallet risk tags (dev/bundler/sniper)", () => {
  const tagged = client.normalizeTrader({ owner: "WALLET1", totalPnl: 1000, tags: ["sniper", "high_frequency"] });
  assert.equal(tagged.address, "WALLET1");
  assert.deepEqual(tagged.tags, ["sniper", "high_frequency"]);
});

test("normalizeTrader never throws on a malformed/missing tags field", () => {
  const noTags = client.normalizeTrader({ owner: "WALLET2" });
  assert.deepEqual(noTags.tags, []);
  const malformedTags = client.normalizeTrader({ owner: "WALLET3", tags: "not-an-array" });
  assert.deepEqual(malformedTags.tags, []);
});

test("normalizeWalletPnl defaults numeric fields to 0, not undefined -- this feeds scoreWallet directly", () => {
  const empty = client.normalizeWalletPnl({});
  assert.equal(empty.totalPnlUsd, 0);
  assert.equal(empty.realizedPnlUsd, 0);
  assert.equal(empty.volumeUsd, 0);
  assert.equal(empty.tradeCount, 0);
  // winRate is deliberately left undefined when absent (scoreWallet falls back to computing it from
  // profitableTrades/tradeCount itself) -- it must NOT default to 0, which would look like "100% losing."
  assert.equal(empty.winRate, undefined);
});

test("normalizeWalletPnl reads real values across the documented field-name variants", () => {
  const parsed = client.normalizeWalletPnl({ total_pnl: 50000, realized_pnl: 40000, win_rate: 62.5, trade_count: 80 });
  assert.equal(parsed.totalPnlUsd, 50000);
  assert.equal(parsed.realizedPnlUsd, 40000);
  assert.equal(parsed.winRate, 62.5);
  assert.equal(parsed.tradeCount, 80);
});

test("normalizeMarket never fabricates a 24h token age or zero creator holding when evidence is missing", () => {
  const parsed=client.normalizeMarket({price:1,liquidity:10000},{},{},{});
  assert.equal(parsed.ageMinutes,-1);
  assert.equal(parsed.creatorHoldingPct,undefined);
});


test("normalizeWalletPnl normalizes fractional win-rate to percent and exposes evidence completeness",()=>{
  const fractional=client.normalizeWalletPnl({total_pnl:10,realized_pnl:8,volume_usd:100,trade_count:10,win_count:7,win_rate:.7});
  assert.equal(fractional.winRate,70);
  assert.equal(fractional.evidenceCompletenessPct,100);
  const sparse=client.normalizeWalletPnl({total_pnl:10});
  assert.ok(sparse.evidenceCompletenessPct<50);
});
