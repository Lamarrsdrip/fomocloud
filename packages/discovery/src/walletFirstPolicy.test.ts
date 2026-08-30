import test from "node:test";
import assert from "node:assert/strict";

function shouldDeepResearch(input:{openPosition?:boolean;provenBuys?:number;paperBuys?:number;adminWatchedBuys?:number}){
  return Boolean(input.openPosition||(input.provenBuys??0)>0||(input.paperBuys??0)>0||(input.adminWatchedBuys??0)>0);
}
function notificationTier(input:{proven:number;paper:number;elite:number}){
  if(input.elite>0)return "ELITE_ENTRY";
  if(input.proven>=5)return "MONEY_RUSH";
  if(input.proven+input.paper>=5)return "CONVERGENCE";
  if(input.proven>0)return "PROVEN_ENTRY";
  return "NONE";
}

test("random new token never enters deep research by existence alone",()=>{assert.equal(shouldDeepResearch({}),false)});
test("one proven-wallet buy is enough to research the token",()=>{assert.equal(shouldDeepResearch({provenBuys:1}),true)});
test("open positions always stay researched for risk management",()=>{assert.equal(shouldDeepResearch({openPosition:true}),true)});
test("elite wallet entry is the highest single-wallet alert",()=>{assert.equal(notificationTier({elite:1,proven:0,paper:0}),"ELITE_ENTRY")});
test("five proven wallets converging escalates to Money Rush",()=>{assert.equal(notificationTier({elite:0,proven:5,paper:0}),"MONEY_RUSH")});
test("five quality wallets can form convergence without pretending they are all proven",()=>{assert.equal(notificationTier({elite:0,proven:2,paper:3}),"CONVERGENCE")});
