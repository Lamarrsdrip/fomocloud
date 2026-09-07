import {test} from "node:test";
import assert from "node:assert/strict";
import {walletActivityContent,soldPercent} from "./walletActivity.js";

const mint="Dfh5oPMpvB1kZ8sT7QwXyZaBcDeFgHiJkLmNoPqRpump";
const base={id:"1",walletLabel:"@Rowdy",mint,chain:"SOLANA",sourceTx:"sig",observedAt:"2026-09-07T00:00:00Z"};

test("a buy names the token, the spend and the entry market cap",()=>{
  const c=walletActivityContent({...base,action:"BUY",state:"BOUGHT",amountUsd:1498.84,marketCapUsd:117000},{symbol:"PROOF"});
  assert.equal(c.title,"🟢 @Rowdy bought PROOF");
  assert.match(c.body,/Spent \$1\.5K/);
  assert.match(c.body,/\$117K MC at entry/);
  assert.match(c.body,/Mint: Dfh5…pump/);
});

test("a second buy reads as an add, not a fresh buy",()=>{
  const c=walletActivityContent({...base,action:"BUY",state:"ADDED",amountUsd:510,marketCapUsd:1_400_000},{symbol:"PIPPIN"});
  assert.equal(c.title,"🟢 @Rowdy added PIPPIN");
  assert.match(c.body,/\$1\.4M MC at entry/);
});

test("a partial sell states the exact percentage from real balances",()=>{
  const c=walletActivityContent({...base,action:"SELL",state:"TRIMMED",amountUsd:2800,marketCapUsd:2_800_000,balanceBeforeRaw:"1000",balanceAfterRaw:"500"},{symbol:"PIPPIN"});
  assert.equal(c.title,"🔴 @Rowdy sold 50% of PIPPIN");
});

test("a full exit says exited and 100% sold",()=>{
  const c=walletActivityContent({...base,action:"SELL",state:"EXITED",marketCapUsd:3_100_000,balanceBeforeRaw:"1000",balanceAfterRaw:"0"},{symbol:"PIPPIN"});
  assert.equal(c.title,"🔴 @Rowdy exited PIPPIN");
  assert.match(c.body,/100% sold/);
});

test("an unresolved token shows the real mint, never a fabricated name",()=>{
  const c=walletActivityContent({...base,action:"BUY",state:"BOUGHT",amountUsd:100});
  assert.match(c.title,/Dfh5…pump/);
  assert.doesNotMatch(c.title,/Unknown token/);
});

test("a transfer can never read as a trade",()=>{
  const c=walletActivityContent({...base,action:"TRANSFER_IN",state:"TRANSFER_IN"},{symbol:"JOHNNY"});
  assert.doesNotMatch(c.title,/bought|sold|exited/i);
  assert.match(c.body,/Not a trade/);
});

test("soldPercent is exact and never exceeds 100",()=>{
  assert.equal(soldPercent({balanceBeforeRaw:"1000",balanceAfterRaw:"750"}),25);
  assert.equal(soldPercent({balanceBeforeRaw:"1000",balanceAfterRaw:"0"}),100);
  assert.equal(soldPercent({balanceBeforeRaw:"0",balanceAfterRaw:"0"}),null);
});
