import test from "node:test";
import assert from "node:assert/strict";
import { depositStatus, extractInboundDeposits, rawToDecimalString, SOL_NATIVE_MINT } from "./deposits.js";

const wallet = "Wallet111111111111111111111111111111111";
const usdc = "Usdc1111111111111111111111111111111111";
function tx(overrides: any = {}) {
  return {
    transaction: {message: {accountKeys: [{pubkey: wallet, signer: false}, {pubkey: "payer", signer: true}]}},
    meta: {err: null, preBalances: [1_000_000_000, 9], postBalances: [1_500_000_000, 8], preTokenBalances: [], postTokenBalances: []},
    ...overrides
  };
}

test("external positive SOL delta is a supported deposit", () => {
  assert.deepEqual(extractInboundDeposits(tx(), wallet, usdc), [{assetMint: SOL_NATIVE_MINT, symbol: "SOL", decimals: 9, amountRaw: "500000000", supported: true}]);
});

test("wallet-signed swap is never mislabeled as a deposit", () => {
  const signed = tx(); signed.transaction.message.accountKeys[0].signer = true;
  signed.meta.postTokenBalances = [{owner: wallet, mint: usdc, uiTokenAmount: {amount: "1000000", decimals: 6}}];
  assert.deepEqual(extractInboundDeposits(signed, wallet, usdc), []);
});

test("USDC and unsupported SPL deltas are separated without losing raw precision", () => {
  const parsed = tx(); parsed.meta.postBalances[0] = parsed.meta.preBalances[0];
  parsed.meta.preTokenBalances = [{owner: wallet, mint: usdc, uiTokenAmount: {amount: "900719925474099300000", decimals: 6}}];
  parsed.meta.postTokenBalances = [
    {owner: wallet, mint: usdc, uiTokenAmount: {amount: "900719925475099300000", decimals: 6}},
    {owner: wallet, mint: "UnknownMint", uiTokenAmount: {amount: "42", decimals: 0}}
  ];
  assert.deepEqual(extractInboundDeposits(parsed, wallet, usdc), [
    {assetMint: usdc, symbol: "USDC", decimals: 6, amountRaw: "1000000000", supported: true},
    {assetMint: "UnknownMint", symbol: null, decimals: 0, amountRaw: "42", supported: false}
  ]);
});

test("failed transactions and non-positive deltas produce no deposit", () => {
  const failed = tx(); failed.meta.err = {InstructionError: [0, "x"]};
  assert.deepEqual(extractInboundDeposits(failed, wallet, usdc), []);
  const outgoing = tx(); outgoing.meta.postBalances[0] = 100;
  assert.deepEqual(extractInboundDeposits(outgoing, wallet, usdc), []);
});

test("raw amount formatting and confirmation finality are deterministic", () => {
  assert.equal(rawToDecimalString("1234500", 6), "1.2345");
  assert.equal(rawToDecimalString("42", 0), "42");
  assert.equal(depositStatus("confirmed"), "CONFIRMED");
  assert.equal(depositStatus("finalized"), "FINALIZED");
});
