import test from "node:test";
import assert from "node:assert/strict";
import {socialResearchEligibility,socialTtlMs} from "./policy.js";

test("random and weak-wallet activity never becomes X eligible",()=>{
  assert.equal(socialResearchEligibility({qualifiedWallets:0,provenWallets:0,eliteWallets:0,verifiedWhales:0}).eligible,false);
  assert.equal(socialResearchEligibility({qualifiedWallets:1,provenWallets:0,eliteWallets:0,verifiedWhales:0}).eligible,false);
});
test("three independent qualified wallets become X eligible",()=>{
  const r=socialResearchEligibility({qualifiedWallets:3,provenWallets:1,eliteWallets:0,verifiedWhales:0});
  assert.equal(r.eligible,true);assert.equal(r.reason,"QUALIFIED_CONVERGENCE");
});
test("curation alone never spends X quota",()=>{
  assert.equal(socialResearchEligibility({qualifiedWallets:1,provenWallets:0,eliteWallets:0,verifiedWhales:0,materialCapitalUsd:100_000}).eligible,false);
});
test("Money Rush gets a short material-change TTL, normal research gets one hour",()=>{
  assert.equal(socialTtlMs("MONEY_RUSH",true),20*60_000);
  assert.equal(socialTtlMs("MONEY_RUSH",false),60*60_000);
});
