import test from "node:test";
import assert from "node:assert/strict";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { planSignatureReplay } from "./replay.js";

function signature(value:string,slot:number):ConfirmedSignatureInfo{
  return {signature:value,slot,err:null,memo:null,blockTime:slot,confirmationStatus:"confirmed"};
}

function paged(items:ConfirmedSignatureInfo[]){
  return async (before:string|undefined,limit:number)=>{
    const start=before?items.findIndex(item=>item.signature===before)+1:0;
    return items.slice(start,start+limit);
  };
}

test("baselines a newly verified wallet without copying historical activity",async()=>{
  const plan=await planSignatureReplay(paged([signature("newest",3),signature("older",2)]),undefined);
  assert.equal(plan.baseline?.signature,"newest");
  assert.deepEqual(plan.signatures,[]);
  assert.equal(plan.complete,true);
});

test("replays missed signatures oldest first after reconnect",async()=>{
  const plan=await planSignatureReplay(paged([signature("s4",4),signature("s3",3),signature("s2",2),signature("s1",1)]),"s1");
  assert.deepEqual(plan.signatures.map(item=>item.signature),["s2","s3","s4"]);
  assert.equal(plan.complete,true);
});

test("fails closed when the prior cursor cannot be found",async()=>{
  const plan=await planSignatureReplay(paged([signature("s4",4),signature("s3",3)]),"missing");
  assert.deepEqual(plan.signatures,[]);
  assert.equal(plan.complete,false);
});

test("fails closed rather than skipping an unbounded replay gap",async()=>{
  const items=Array.from({length:600},(_,index)=>signature(`s${600-index}`,600-index));
  const plan=await planSignatureReplay(paged(items),"s0",500);
  assert.deepEqual(plan.signatures,[]);
  assert.equal(plan.complete,false);
});
