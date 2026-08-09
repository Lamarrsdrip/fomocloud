import test from "node:test";
import assert from "node:assert/strict";
import { calculateExitAccounting, calculatePositionMark } from "./index.js";

test("partial sell allocates cost basis and subtracts execution fees",()=>{
  const exit=calculateExitAccounting({entryTokenRaw:"1000000",remainingTokenRaw:"1000000",tokenRaw:"250000",costUsd:100,avgEntryPriceUsd:1,executionPriceUsd:2,feesUsd:1});
  assert.deepEqual(exit,{
    tokenRaw:"250000",remainingTokenRaw:"750000",allocatedCostUsd:25,grossProceedsUsd:50,feesUsd:1,netProceedsUsd:49,realizedPnlUsd:24
  });
});

test("remaining runner mark uses only its proportional cost basis",()=>{
  const mark=calculatePositionMark({entryTokenRaw:"1000000",remainingTokenRaw:"750000",costUsd:100,avgEntryPriceUsd:1,currentPriceUsd:3});
  assert.deepEqual(mark,{remainingFraction:.75,remainingCostBasisUsd:75,currentValueUsd:225,unrealizedPnlUsd:150});
});

test("multiple partials plus final close reconcile the full original amount",()=>{
  const first=calculateExitAccounting({entryTokenRaw:"1000",remainingTokenRaw:"1000",tokenRaw:"300",costUsd:100,avgEntryPriceUsd:1,executionPriceUsd:2,feesUsd:1});
  const second=calculateExitAccounting({entryTokenRaw:"1000",remainingTokenRaw:first.remainingTokenRaw,tokenRaw:"200",costUsd:100,avgEntryPriceUsd:1,executionPriceUsd:3,feesUsd:1});
  const final=calculateExitAccounting({entryTokenRaw:"1000",remainingTokenRaw:second.remainingTokenRaw,tokenRaw:"500",costUsd:100,avgEntryPriceUsd:1,executionPriceUsd:4,feesUsd:2});
  assert.equal(final.remainingTokenRaw,"0");
  assert.equal(first.allocatedCostUsd+second.allocatedCostUsd+final.allocatedCostUsd,100);
  assert.equal(first.realizedPnlUsd+second.realizedPnlUsd+final.realizedPnlUsd,216);
  assert.equal(calculatePositionMark({entryTokenRaw:"1000",remainingTokenRaw:"0",costUsd:100,avgEntryPriceUsd:1,currentPriceUsd:4}).unrealizedPnlUsd,0);
});

test("rejects oversells instead of creating negative runners",()=>{
  assert.throws(()=>calculateExitAccounting({entryTokenRaw:"1000",remainingTokenRaw:"200",tokenRaw:"201",costUsd:100,avgEntryPriceUsd:1,executionPriceUsd:2}),/INVALID_EXIT_ACCOUNTING/);
});
