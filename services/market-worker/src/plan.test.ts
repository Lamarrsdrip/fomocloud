import test from "node:test";
import assert from "node:assert/strict";
import {shouldRefreshMarketMint} from "./plan.js";

test("a quiet cached research token causes zero refresh/provider work",()=>{
  assert.equal(shouldRefreshMarketMint(false,true),false);
});
test("a wallet event cache miss makes research due",()=>{
  assert.equal(shouldRefreshMarketMint(false,false),true);
});
test("an open position always refreshes for exit safety",()=>{
  assert.equal(shouldRefreshMarketMint(true,true),true);
});
