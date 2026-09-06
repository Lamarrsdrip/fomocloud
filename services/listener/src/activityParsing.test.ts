import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {walletTokenActivity} from "./activityParsing.js";
const fixtures=JSON.parse(readFileSync(new URL("../fixtures/production-wallet-buys.json",import.meta.url),"utf8"));
for(const f of fixtures)test(`production buy ${f.signature}`,()=>{
  const events=walletTokenActivity(f.transaction,f.wallet);
  const event=events.find(e=>e.mint===f.mint);
  assert.ok(event);assert.equal(event.action,"BUY");assert.equal(event.amountRaw,f.outputRaw);
  assert.ok(!events.some(e=>e.mint===f.inputMint));
  if(f.inputMint.startsWith("EPj"))assert.equal(event.amountUsd,Number(f.inputRaw)/1e6);
});
test("failed transaction emits nothing",()=>{
  const f=structuredClone(fixtures[0]);f.transaction.meta.err={InstructionError:[0,"Failed"]};
  assert.deepEqual(walletTokenActivity(f.transaction,f.wallet),[]);
});
test("every acquired mint is retained, without allocating the same funding to both",()=>{
  const f=structuredClone(fixtures[1]), other=fixtures.find((r:any)=>r.mint!==f.mint);
  f.transaction.meta.postTokenBalances.push({owner:f.wallet,mint:other.mint,uiTokenAmount:{amount:"100",decimals:6}});
  const events=walletTokenActivity(f.transaction,f.wallet);
  assert.ok(events.some(e=>e.mint===f.mint));assert.ok(events.some(e=>e.mint===other.mint));
  assert.ok(events.filter(e=>e.action==="BUY").every(e=>e.amountUsd===undefined));
});
test("balance decreases retain full-exit state and exact remaining balance",()=>{
  const f=structuredClone(fixtures[1]);
  [f.transaction.meta.preTokenBalances,f.transaction.meta.postTokenBalances]=[f.transaction.meta.postTokenBalances,f.transaction.meta.preTokenBalances];
  const event=walletTokenActivity(f.transaction,f.wallet).find(e=>e.mint===f.mint)!;
  assert.equal(event.action,"SELL");assert.equal(event.amountRaw,f.outputRaw);
  assert.equal(event.state,event.balanceAfterRaw==="0"?"EXITED":BigInt(event.balanceAfterRaw)*10n<=BigInt(event.balanceBeforeRaw)?"MOSTLY_EXITED":"TRIMMED");
});
