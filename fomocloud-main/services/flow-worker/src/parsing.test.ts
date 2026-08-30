import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerDeltas } from "./parsing.js";

function tx(pre: any[], post: any[]): any {
  return { meta: { preTokenBalances: pre, postTokenBalances: post } };
}

test("ownerDeltas computes a positive delta for a wallet that received tokens (a buy)", () => {
  const t = tx(
    [{ owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "1000", decimals: 6 } }],
    [{ owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "5000", decimals: 6 } }]
  );
  const deltas = ownerDeltas(t);
  assert.equal(deltas.get("WALLET1")?.get("MINTA")?.raw, 4000n);
});

test("ownerDeltas computes a negative delta for a wallet that sent tokens (a sell)", () => {
  const t = tx(
    [{ owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "5000", decimals: 6 } }],
    [{ owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "1000", decimals: 6 } }]
  );
  const deltas = ownerDeltas(t);
  assert.equal(deltas.get("WALLET1")?.get("MINTA")?.raw, -4000n);
});

test("ownerDeltas treats a wallet with no prior balance row as starting from zero (a first-ever buy)", () => {
  const t = tx([], [{ owner: "WALLET2", mint: "MINTB", uiTokenAmount: { amount: "2500", decimals: 9 } }]);
  const deltas = ownerDeltas(t);
  assert.equal(deltas.get("WALLET2")?.get("MINTB")?.raw, 2500n);
  assert.equal(deltas.get("WALLET2")?.get("MINTB")?.dec, 9);
});

test("ownerDeltas skips rows with no owner rather than throwing or attributing to 'undefined'", () => {
  const t = tx([], [{ owner: null, mint: "MINTC", uiTokenAmount: { amount: "999", decimals: 6 } }]);
  const deltas = ownerDeltas(t);
  assert.equal(deltas.size, 0);
});

test("ownerDeltas tracks multiple wallets and multiple mints independently in one transaction", () => {
  const t = tx(
    [
      { owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "1000", decimals: 6 } },
      { owner: "WALLET2", mint: "MINTB", uiTokenAmount: { amount: "500", decimals: 6 } },
    ],
    [
      { owner: "WALLET1", mint: "MINTA", uiTokenAmount: { amount: "0", decimals: 6 } },
      { owner: "WALLET2", mint: "MINTB", uiTokenAmount: { amount: "1500", decimals: 6 } },
    ]
  );
  const deltas = ownerDeltas(t);
  assert.equal(deltas.get("WALLET1")?.get("MINTA")?.raw, -1000n);
  assert.equal(deltas.get("WALLET2")?.get("MINTB")?.raw, 1000n);
});

test("ownerDeltas handles a missing meta object without throwing (an empty result, not a crash)", () => {
  const deltas = ownerDeltas({} as any);
  assert.equal(deltas.size, 0);
});
