import { test } from "node:test";
import assert from "node:assert/strict";
import { isQuote, classifySwapSide, quoteAmountUsd, EVM_DEFAULTS } from "./classify.js";

const BNB_NATIVE = EVM_DEFAULTS.BNB.native;
const BNB_STABLE = EVM_DEFAULTS.BNB.stables[0];
const MEME = "0x1111111111111111111111111111111111111111";

test("isQuote recognizes the native wrapped token and every listed stable, case-insensitively", () => {
  assert.equal(isQuote("BNB", BNB_NATIVE), true);
  assert.equal(isQuote("BNB", BNB_NATIVE.toUpperCase()), true);
  assert.equal(isQuote("BNB", BNB_STABLE), true);
  assert.equal(isQuote("BNB", MEME), false);
});

test("isQuote returns false for an unconfigured chain rather than throwing", () => {
  assert.equal(isQuote("SOLANA", BNB_NATIVE), false);
});

test("classifySwapSide: token0=quote, token1=mint, inbound quote/outbound mint is a BUY", () => {
  const pm = { token0: BNB_NATIVE, token1: MEME, d0: 18, d1: 18 };
  const c = classifySwapSide("BNB", pm, 100n, 0n, 0n, 500n);
  assert.deepEqual(c, { side: "BUY", mint: MEME, quoteToken: BNB_NATIVE, quoteRaw: 100n, quoteDec: 18 });
});

test("classifySwapSide: token0=quote, token1=mint, inbound mint/outbound quote is a SELL", () => {
  const pm = { token0: BNB_NATIVE, token1: MEME, d0: 18, d1: 18 };
  const c = classifySwapSide("BNB", pm, 0n, 500n, 100n, 0n);
  assert.deepEqual(c, { side: "SELL", mint: MEME, quoteToken: BNB_NATIVE, quoteRaw: 100n, quoteDec: 18 });
});

test("classifySwapSide: mint is token0 instead of token1 (roles reversed) still classifies correctly", () => {
  const pm = { token0: MEME, token1: BNB_NATIVE, d0: 9, d1: 18 };
  const buy = classifySwapSide("BNB", pm, 0n, 100n, 500n, 0n);
  assert.deepEqual(buy, { side: "BUY", mint: MEME, quoteToken: BNB_NATIVE, quoteRaw: 100n, quoteDec: 18 });
  const sell = classifySwapSide("BNB", pm, 500n, 0n, 0n, 100n);
  assert.deepEqual(sell, { side: "SELL", mint: MEME, quoteToken: BNB_NATIVE, quoteRaw: 100n, quoteDec: 18 });
});

test("classifySwapSide returns null for a quote/quote pair (e.g. native/stable) -- not a mint trade", () => {
  const pm = { token0: BNB_NATIVE, token1: BNB_STABLE, d0: 18, d1: 18 };
  assert.equal(classifySwapSide("BNB", pm, 100n, 0n, 0n, 100n), null);
});

test("classifySwapSide returns null for a non-quote/non-quote pair -- can't tell which side is being bought", () => {
  const other = "0x2222222222222222222222222222222222222222";
  const pm = { token0: MEME, token1: other, d0: 18, d1: 18 };
  assert.equal(classifySwapSide("BNB", pm, 100n, 0n, 0n, 100n), null);
});

test("classifySwapSide returns null when the amounts don't form a coherent in/out pair (e.g. all zero)", () => {
  const pm = { token0: BNB_NATIVE, token1: MEME, d0: 18, d1: 18 };
  assert.equal(classifySwapSide("BNB", pm, 0n, 0n, 0n, 0n), null);
});

test("quoteAmountUsd: a stable quote token is already USD-denominated, native price is irrelevant", () => {
  assert.equal(quoteAmountUsd("BNB", BNB_STABLE, 42, 0), 42);
});

test("quoteAmountUsd: the native token converts through the configured native/USD price", () => {
  assert.equal(quoteAmountUsd("BNB", BNB_NATIVE, 2, 600), 1200);
});

test("quoteAmountUsd: native quote with no configured price yields undefined, never a fabricated $0", () => {
  assert.equal(quoteAmountUsd("BNB", BNB_NATIVE, 2, 0), undefined);
});

test("quoteAmountUsd: an unrecognized quote token or chain yields undefined", () => {
  assert.equal(quoteAmountUsd("BNB", MEME, 2, 600), undefined);
  assert.equal(quoteAmountUsd("SOLANA", BNB_NATIVE, 2, 600), undefined);
});
