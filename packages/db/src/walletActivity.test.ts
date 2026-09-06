import {test} from "node:test";
import assert from "node:assert/strict";
import {walletActivityContent,walletEventKey} from "./walletActivity.js";
const mint="Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk";
const event={id:"id",walletLabel:"@Rowdy",action:"BUY",state:"BOUGHT",mint,observedAt:"2026-09-01T00:00:00Z",amountUsd:5000.284905,sourceTx:"signature",chain:"SOLANA"};
test("missing metadata always retains full mint",()=>{
 const c=walletActivityContent(event);assert.match(c.title,/Unknown token/);assert.ok(c.body.includes(mint));assert.equal(c.data.mint,mint);
});
test("metadata backfill immediately changes content without a new event",()=>{
 const c=walletActivityContent(event,{symbol:"USELESS",name:"USELESS COIN"});assert.equal(c.title,"@Rowdy bought USELESS");assert.ok(c.body.includes("$5,000.28"));assert.equal(c.id,event.id);
});
test("dedup key includes wallet, mint and action",()=>{
 const key=walletEventKey("SOLANA","sig","wallet",mint,"BUY");assert.equal(key,walletEventKey("SOLANA","sig","wallet",mint,"BUY"));
 for(const args of [["SOLANA","sig","wallet2",mint,"BUY"],["SOLANA","sig","wallet",mint,"SELL"],["SOLANA","sig","wallet","other","BUY"]])assert.notEqual(key,walletEventKey(...args as [string,string,string,string,string]));
});
