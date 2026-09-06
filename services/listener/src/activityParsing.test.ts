import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {walletTokenActivity} from "./activityParsing.js";
import {usdcMint,PUMP_FUN_PROGRAM,JUPITER_V6_PROGRAM,RAYDIUM_AMM_V4_PROGRAM} from "./parsing.js";
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

// ==================================================================================
// Mandatory regression suite: real-trade evidence vs. transfer/airdrop (the JOHNNY case).
// A tracked wallet's public "bought" alert must never come from a balance increase alone.
// ==================================================================================
const WHALE="WHALE_TRACKED_WALLET";
const TOKEN="MEME_TOKEN_MINT_XYZ";

function row(owner:string,mint:string,amount:string,decimals=6){
  return {owner,mint,uiTokenAmount:{amount,decimals,uiAmount:null,uiAmountString:amount}};
}
function fixture(opts:{pre?:any[];post?:any[];preLamports?:number;postLamports?:number;fee?:number;program?:string}):any{
  const fee=opts.fee??5000, preLamports=opts.preLamports??1_000_000_000;
  // Realistic default: the tracked wallet is the fee payer, so lamports drop by exactly the fee
  // when nothing else moves them -- an inconsistent fixture here (pre === post) is what caused a
  // false-positive native-SOL "buy" signal on a token-to-token swap during development of this
  // suite; every test that cares about a real lamport swing overrides postLamports explicitly.
  return {
    meta:{
      err:null,
      fee,
      logMessages:opts.program?[`Program ${opts.program} invoke [1]`]:[],
      preBalances:[preLamports],
      postBalances:[opts.postLamports??preLamports-fee],
      preTokenBalances:opts.pre??[],
      postTokenBalances:opts.post??[],
    },
    transaction:{message:{accountKeys:[{pubkey:WHALE}]}},
  };
}

test("1. dev sends token directly to a whale -> TRANSFER_IN, never BUY (the JOHNNY case)",()=>{
  const t=fixture({pre:[row(WHALE,TOKEN,"0",5)],post:[row(WHALE,TOKEN,"5000000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"TRANSFER_IN");
});

test("2. whale receives an unsolicited airdrop -> TRANSFER_IN, never BUY",()=>{
  const t=fixture({pre:[row(WHALE,TOKEN,"0",5)],post:[row(WHALE,TOKEN,"1000000000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"TRANSFER_IN");
});

test("3. whale swaps native SOL for a token through a recognized program -> BUY",()=>{
  const t=fixture({preLamports:5_000_000_000,postLamports:2_999_995_000,program:JUPITER_V6_PROGRAM,pre:[row(WHALE,TOKEN,"0",5)],post:[row(WHALE,TOKEN,"5000000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"BUY");assert.equal(event.state,"BOUGHT");
});

test("4. whale swaps USDC for a token -> BUY",()=>{
  const t=fixture({pre:[row(WHALE,usdcMint,"100000000"),row(WHALE,TOKEN,"0",5)],post:[row(WHALE,usdcMint,"90000000"),row(WHALE,TOKEN,"5000000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"BUY");
});

test("5. whale buys the same token again -> ADD, not a fresh BOUGHT",()=>{
  const t=fixture({pre:[row(WHALE,usdcMint,"100000000"),row(WHALE,TOKEN,"5000000",5)],post:[row(WHALE,usdcMint,"90000000"),row(WHALE,TOKEN,"10000000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"BUY");assert.equal(event.state,"ADDED");
});

test("6. whale transfers a token to another wallet -> TRANSFER_OUT, never SELL",()=>{
  const t=fixture({pre:[row(WHALE,TOKEN,"5000000",5)],post:[row(WHALE,TOKEN,"0",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"TRANSFER_OUT");
});

test("7. whale swaps a token for USDC -> SELL/EXIT",()=>{
  const t=fixture({pre:[row(WHALE,TOKEN,"5000000",5),row(WHALE,usdcMint,"0")],post:[row(WHALE,TOKEN,"0",5),row(WHALE,usdcMint,"50000000")]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"SELL");assert.equal(event.state,"EXITED");
});

test("8. a spam/dust token sent to the whale is never counted as smart-money buy evidence",()=>{
  const t=fixture({pre:[row(WHALE,TOKEN,"0",2)],post:[row(WHALE,TOKEN,"1",2)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"TRANSFER_IN");
});

test("9/10/11. Pump.fun, Jupiter, and Raydium native-SOL swaps all resolve to BUY",()=>{
  for(const program of [PUMP_FUN_PROGRAM,JUPITER_V6_PROGRAM,RAYDIUM_AMM_V4_PROGRAM]){
    const t=fixture({preLamports:2_000_000_000,postLamports:999_995_000,program,pre:[row(WHALE,TOKEN,"0",5)],post:[row(WHALE,TOKEN,"2000000",5)]});
    const [event]=walletTokenActivity(t,WHALE);
    assert.equal(event.action,"BUY",`expected BUY via program ${program}`);
  }
});

test("12. an ambiguous token-to-token swap is never BUY/SELL in the public feed (never auto-copy)",()=>{
  const t=fixture({program:JUPITER_V6_PROGRAM,pre:[row(WHALE,TOKEN,"5000000",5)],post:[row(WHALE,TOKEN,"0",5),row(WHALE,"OTHER_TOKEN_MINT","100",8)]});
  const events=walletTokenActivity(t,WHALE);
  assert.ok(events.every(e=>e.action!=="BUY"&&e.action!=="SELL"));
});

test("fee-only lamport drift on a plain inbound transfer never fakes native-SOL buy evidence",()=>{
  const t=fixture({preLamports:1_000_000_000,postLamports:999_995_000,pre:[row(WHALE,TOKEN,"0",5)],post:[row(WHALE,TOKEN,"500000",5)]});
  const [event]=walletTokenActivity(t,WHALE);
  assert.equal(event.action,"TRANSFER_IN");
});
