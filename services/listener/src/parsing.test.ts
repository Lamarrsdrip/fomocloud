import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySwap, tokenDeltas, usdcMint, PUMP_FUN_PROGRAM, JUPITER_V6_PROGRAM, RAYDIUM_AMM_V4_PROGRAM } from "./parsing.js";

const WALLET = "TRADER_WALLET";
const TOKEN = "MEME_TOKEN_MINT";

function balRow(owner: string, mint: string, amount: string, decimals = 6) {
  return { owner, mint, uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: amount } };
}
function tx(pre: any[], post: any[]): any {
  // classifySwap now requires the tracked wallet to have actually signed the transaction.
  return { meta: { preTokenBalances: pre, postTokenBalances: post }, transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } };
}

test("classifySwap detects a BUY: USDC spent, token received", () => {
  const t = tx(
    [balRow(WALLET, usdcMint, "1000000000")], // 1000 USDC before
    [balRow(WALLET, usdcMint, "900000000"), balRow(WALLET, TOKEN, "5000000000", 9)] // spent 100 USDC, received 5 tokens (9 decimals)
  );
  const result = classifySwap(t, WALLET);
  assert.equal(result?.action, "BUY");
  assert.equal(result?.inputMint, usdcMint);
  assert.equal(result?.outputMint, TOKEN);
  // sourcePriceUsd is the real per-token entry price this session's chase-% math depends on:
  // 100 USDC spent / 5 tokens received = $20/token.
  assert.equal(result?.sourcePriceUsd, 20);
  assert.equal(result?.amountUsd, 100);
});

test("classifySwap detects a SELL: token spent, USDC received, and computes sourceSoldPct", () => {
  const t = tx(
    [balRow(WALLET, TOKEN, "10000000000", 9), balRow(WALLET, usdcMint, "0")], // held 10000 tokens
    [balRow(WALLET, TOKEN, "5000000000", 9), balRow(WALLET, usdcMint, "50000000")] // sold half for 50 USDC
  );
  const result = classifySwap(t, WALLET);
  assert.equal(result?.action, "SELL");
  assert.equal(result?.inputMint, TOKEN);
  assert.equal(result?.outputMint, usdcMint);
  // Sold exactly half the pre-swap balance -- this is the number that sizes a mirror-sell for
  // every follower copying this wallet. A wrong value here either over- or under-sells real money.
  assert.equal(result?.sourceSoldPct, 50);
});

test("classifySwap returns null for a token-to-token swap with no recognized quote asset", () => {
  const t = tx(
    [balRow(WALLET, TOKEN, "1000000000", 9)],
    [balRow(WALLET, "OTHER_TOKEN_MINT", "2000000000", 9)]
  );
  // Deliberately ambiguous -- must not invent a copy signal rather than guess a wrong side/price.
  assert.equal(classifySwap(t, WALLET), null);
});

test("classifySwap returns null when the wallet has no net token movement", () => {
  const t = tx([balRow(WALLET, TOKEN, "1000000000", 9)], [balRow(WALLET, TOKEN, "1000000000", 9)]);
  assert.equal(classifySwap(t, WALLET), null);
});

test("classifySwap ignores balance rows belonging to other wallets in the same transaction", () => {
  const t = tx(
    [balRow(WALLET, usdcMint, "1000000000"), balRow("OTHER_WALLET", TOKEN, "999999999999", 9)],
    [balRow(WALLET, usdcMint, "900000000"), balRow(WALLET, TOKEN, "3000000000", 9), balRow("OTHER_WALLET", TOKEN, "1", 9)]
  );
  const deltas = tokenDeltas(t, WALLET);
  assert.ok(!deltas.some((d) => d.mint === "OTHER_WALLET"), "must never attribute another wallet's balance rows to the tracked wallet");
  const result = classifySwap(t, WALLET);
  assert.equal(result?.action, "BUY");
});

test("classifySwap does not compute sourcePriceUsd when neither leg is USDC (e.g. a SOL-denominated swap)", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const t = tx(
    [balRow(WALLET, SOL, "5000000000", 9)],
    [balRow(WALLET, SOL, "4000000000", 9), balRow(WALLET, TOKEN, "1000000000", 9)]
  );
  const result = classifySwap(t, WALLET);
  assert.equal(result?.action, "BUY");
  // Real gap this guards against: inventing a USD price from a non-USDC leg would silently feed a
  // fabricated number into chase-% math. Undefined (not 0, not guessed) is the only honest value.
  assert.equal(result?.sourcePriceUsd, undefined);
});

// Native SOL fixtures: accountKeys[0] is the fee-paying tracked wallet, preBalances/postBalances
// are lamports indexed the same way. No SPL quote-token balance is touched at all here -- this is
// exactly a Pump.fun-style native-SOL buy, which the SPL-only quote-leg checks above would miss.
function nativeTx(opts: { preLamports: number; postLamports: number; fee?: number; programInvoked?: string; pre?: any[]; post?: any[]; signer?: boolean }): any {
  return {
    meta: {
      err: null,
      fee: opts.fee ?? 5000,
      logMessages: opts.programInvoked ? [`Program ${opts.programInvoked} invoke [1]`] : [],
      preBalances: [opts.preLamports],
      postBalances: [opts.postLamports],
      preTokenBalances: opts.pre ?? [],
      postTokenBalances: opts.post ?? [],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: opts.signer !== false }] } },
  };
}

test("classifySwap detects a native-SOL Pump.fun BUY with no WSOL balance touched", () => {
  const t = nativeTx({
    preLamports: 2_000_000_000, postLamports: 999_995_000, programInvoked: PUMP_FUN_PROGRAM,
    pre: [balRow(WALLET, TOKEN, "0", 5)], post: [balRow(WALLET, TOKEN, "200000", 5)],
  });
  const result = classifySwap(t, WALLET);
  assert.equal(result?.action, "BUY");
  assert.equal(result?.outputMint, TOKEN);
  assert.equal(result?.inputMethod, "NATIVE_SOL_BALANCE");
});

test("classifySwap detects native-SOL BUY/SELL through Jupiter and Raydium alike", () => {
  const buyViaJupiter = classifySwap(nativeTx({
    preLamports: 2_000_000_000, postLamports: 999_995_000, programInvoked: JUPITER_V6_PROGRAM,
    pre: [balRow(WALLET, TOKEN, "0", 5)], post: [balRow(WALLET, TOKEN, "200000", 5)],
  }), WALLET);
  const buyViaRaydium = classifySwap(nativeTx({
    preLamports: 2_000_000_000, postLamports: 999_995_000, programInvoked: RAYDIUM_AMM_V4_PROGRAM,
    pre: [balRow(WALLET, TOKEN, "0", 5)], post: [balRow(WALLET, TOKEN, "200000", 5)],
  }), WALLET);
  assert.equal(buyViaJupiter?.action, "BUY");
  assert.equal(buyViaRaydium?.action, "BUY");
});

test("classifySwap rejects an identical lamport/token balance change with no recognized swap program invoked", () => {
  // Same balances as the Pump.fun BUY above, minus the program log line -- this is exactly a dev
  // sending tokens to a whale (transfer fee paid from the whale's own lamports, or none at all),
  // not a trade. Must not become a BUY just because lamports happened to move.
  const t = nativeTx({
    preLamports: 2_000_000_000, postLamports: 999_995_000,
    pre: [balRow(WALLET, TOKEN, "0", 5)], post: [balRow(WALLET, TOKEN, "200000", 5)],
  });
  assert.equal(classifySwap(t, WALLET), null);
});

test("classifySwap ignores fee-only lamport drift on a plain inbound token transfer (no program invoked)", () => {
  const t = nativeTx({
    preLamports: 1_000_000_000, postLamports: 999_995_000,
    pre: [balRow(WALLET, TOKEN, "0", 5)], post: [balRow(WALLET, TOKEN, "500000", 5)],
  });
  assert.equal(classifySwap(t, WALLET), null);
});
