import { test } from "node:test";
import assert from "node:assert/strict";
import { pushAllowed, emailWorthSending } from "./decisions.js";

test("MemeCloud uses one master notification switch", () => {
  for(const type of ["TRADER_SIGNAL","TRADE_COPIED","TRADE_SKIPPED","WAIT_PULLBACK","PROFIT_TAKEN","POSITION_CLOSED","SECURITY_ALERT","GLOBAL_BRAIN","WATCHED_WALLET_TRADE"]){
    assert.equal(pushAllowed(type,{pushEnabled:true}),true,type);
    assert.equal(pushAllowed(type,{pushEnabled:false}),false,type);
  }
});

test("legacy granular preferences cannot silently suppress alerts while master is on",()=>{
  assert.equal(pushAllowed("TRADER_SIGNAL",{pushEnabled:true,traderBought:false}),true);
  assert.equal(pushAllowed("PROFIT_TAKEN",{pushEnabled:true,profitTaken:false}),true);
  assert.equal(pushAllowed("SECURITY_ALERT",{pushEnabled:true,securityAlerts:false}),true);
});

test("no preference row defaults to enabled until the user explicitly turns alerts off",()=>{
  assert.equal(pushAllowed("WATCHED_WALLET_TRADE",undefined),true);
  assert.equal(pushAllowed("SOME_FUTURE_TYPE",null),true);
});

test("emailWorthSending only includes important account/trade email types", () => {
  assert.equal(emailWorthSending("TRADE_COPIED"), true);
  assert.equal(emailWorthSending("PROFIT_TAKEN"), true);
  assert.equal(emailWorthSending("POSITION_CLOSED"), true);
  assert.equal(emailWorthSending("SECURITY_ALERT"), true);
  assert.equal(emailWorthSending("TRADER_SIGNAL"), false);
});
