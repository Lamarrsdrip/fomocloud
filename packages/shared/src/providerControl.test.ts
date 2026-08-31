import test from "node:test";
import assert from "node:assert/strict";
import {cachedProviderRequest,reserveProviderBudget,type ProviderRedis} from "./providerControl.js";

class FakeRedis implements ProviderRedis{
  values=new Map<string,string>(); budgets=new Map<string,number>();
  async get(k:string){return this.values.get(k)??null}
  async set(k:string,v:string,...args:any[]){
    if(args.includes("NX")&&this.values.has(k))return null;
    this.values.set(k,v);return "OK";
  }
  async del(k:string){this.values.delete(k);return 1}
  async hIncrBy(){return 1} async hSet(){return 1} async hGetAll(){return {}} async expire(){return 1}
  async eval(_script:string,_numKeys:number,...args:any[]){
    const [hourKey,dayKey,hourLimit,dayLimit,rank]=args;
    const hour=this.budgets.get(hourKey)??0,day=this.budgets.get(dayKey)??0;
    const pressure=Math.max(Number(hourLimit)>0?hour/Number(hourLimit):1,Number(dayLimit)>0?day/Number(dayLimit):1);
    if(hour>=Number(hourLimit)||day>=Number(dayLimit)||(pressure>=.95&&Number(rank)>1)||(pressure>=.90&&Number(rank)>2))return [0,hour,day];
    this.budgets.set(hourKey,hour+1);this.budgets.set(dayKey,day+1);return [1,hour+1,day+1];
  }
}

const opts={provider:"BIRDEYE",endpoint:"market",service:"test",priority:"P2" as const,providerClass:"OPTIONAL" as const,ttlMs:60_000,negativeTtlMs:60_000};

test("concurrent identical enrichment is coalesced into one provider request",async()=>{
  const redis=new FakeRedis();let calls=0;
  const fetchFresh=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {price:1}};
  const values=await Promise.all(Array.from({length:6},()=>cachedProviderRequest(redis,"SOLANA:mint",opts,fetchFresh)));
  assert.equal(calls,1);assert.equal(values.length,6);
});

test("negative results are cached briefly and do not retry immediately",async()=>{
  const redis=new FakeRedis();let calls=0;
  const fail=async()=>{calls++;throw new Error("NOT_FOUND")};
  await assert.rejects(()=>cachedProviderRequest(redis,"missing",opts,fail));
  await assert.rejects(()=>cachedProviderRequest(redis,"missing",opts,fail));
  assert.equal(calls,1);
});

test("hard optional-provider budget never increments beyond its cap",async()=>{
  const redis=new FakeRedis();
  const input={provider:"X",kind:"READ",priority:"P1" as const,hourlyLimit:2,dailyLimit:2,hardLimitAllPriorities:true};
  assert.equal((await reserveProviderBudget(redis,input)).granted,true);
  assert.equal((await reserveProviderBudget(redis,input)).granted,true);
  const denied=await reserveProviderBudget(redis,input);
  assert.equal(denied.granted,false);assert.equal(denied.hour,2);assert.equal(denied.day,2);
});

test("optional budget fails closed when Redis budget enforcement is unavailable",async()=>{
  const denied=await reserveProviderBudget(undefined,{provider:"X",kind:"READ",priority:"P3",hourlyLimit:10,dailyLimit:20,hardLimitAllPriorities:true});
  assert.equal(denied.granted,false);
});
