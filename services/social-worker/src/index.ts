import crypto from "node:crypto";
import {Worker} from "bullmq";
import {Redis} from "ioredis";
import {db,type Chain} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {classifyPulse} from "@memecloud/social";
import {cachedProviderRequest,reserveProviderBudget,type ProviderPriority} from "@memecloud/shared";
import {computePulseMetrics} from "./metrics.js";
import {socialResearchEligibility,socialTtlMs} from "./policy.js";

const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
let received=0,researched=0,cacheHits=0,budgetDenied=0,errors=0,rateLimited=0,lastResearchAt:string|null=null;
type Job={chain:Chain;mint:string;state?:string;materialStateChange?:boolean};
function queryFor(o:any){return [o.symbol?`$${o.symbol}`:null,o.mint,o.name?`"${o.name}"`:null].filter(Boolean).join(" OR ");}

async function pulse(o:any,bearer:string,ttlMs:number,priority:ProviderPriority){
  const query=queryFor(o),queryHash=crypto.createHash("sha256").update(query).digest("hex");
  const key=`x-read:${o.chain}:${o.mint}:${queryHash}`;
  if(await redis.get(`provider-cache:${key}`))cacheHits++;
  return cachedProviderRequest(redis,key,{provider:"X_READ",endpoint:"recent-search",service:"social-worker",priority,providerClass:"OPTIONAL",ttlMs,negativeTtlMs:60_000},async()=>{
    if(await redis.get("x-read:circuit"))throw Object.assign(new Error("X_CIRCUIT_OPEN"),{code:"X_CIRCUIT_OPEN"});
    const cfg=await getConfig<any>("social");
    const hourly=Math.max(0,Number(cfg?.xMaxReadsPerHour??process.env.X_MAX_READS_PER_HOUR??24));
    const daily=Math.max(0,Number(cfg?.xMaxReadsPerDay??process.env.X_MAX_READS_PER_DAY??120));
    const budget=await reserveProviderBudget(redis,{provider:"X",kind:"READ",priority,hourlyLimit:hourly,dailyLimit:daily,providerClass:"OPTIONAL",hardLimitAllPriorities:true});
    if(!budget.granted){budgetDenied++;throw Object.assign(new Error("X_BUDGET_EXHAUSTED"),{code:"X_BUDGET_EXHAUSTED"});}
    const start=new Date(Date.now()-15*60_000),url=new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query",`(${query}) -is:retweet`);url.searchParams.set("start_time",start.toISOString());url.searchParams.set("max_results","100");url.searchParams.set("tweet.fields","created_at,author_id,public_metrics");
    const response=await fetch(url,{headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(7000)});
    if(response.status===429){rateLimited++;const retry=Math.max(60,Number(response.headers.get("retry-after")??60));await redis.set("x-read:circuit","1","EX",Math.min(retry,3600));const e:any=new Error("X_RATE_LIMITED");e.status=429;throw e;}
    if(!response.ok){const e:any=new Error(`X_HTTP_${response.status}`);e.status=response.status;throw e;}
    const body:any=await response.json(),base=computePulseMetrics(o,body.data??[],Date.now());
    return {pulse:{...base,trend:classifyPulse(base)},queryHash,observedAt:new Date().toISOString()};
  });
}

async function processSocialJob(job:Job){
  received++;
  const o=await db.globalBrainOpportunity.findUnique({where:{chain_mint:{chain:job.chain,mint:job.mint}}});
  if(!o||o.state==="SCANNING")return;
  const ev=(o.evidence??{}) as any;
  const eligible=socialResearchEligibility({qualifiedWallets:Number(ev.convergentCount??0),provenWallets:Number(ev.provenConvergentCount??0),eliteWallets:Number(ev.eliteConvergentCount??0),verifiedWhales:Number(o.whaleBuyers60s??0)+Number(o.knownWhaleBuyers60s??0),state:o.state,action:o.action,materialCapitalUsd:Number(o.smartMoneyNetFlow5mUsd??0)});
  if(!eligible.eligible)return;
  const cfg=await getConfig<any>("social");
  // Posting credentials are intentionally never read here.
  const bearer=cfg?.xIntelligenceBearerToken||process.env.X_INTELLIGENCE_BEARER_TOKEN||cfg?.xBearerToken||process.env.X_BEARER_TOKEN;
  if(!bearer)return;
  try{
    const priority=`P${eligible.priority}` as ProviderPriority;
    const x=await pulse(o,bearer,socialTtlMs(o.state,Boolean(job.materialStateChange)),priority);
    const latest=await db.memeMarketSnapshot.findFirst({where:{chain:o.chain,mint:o.mint},orderBy:{observedAt:"desc"}});
    if(latest)await db.memeMarketSnapshot.update({where:{id:latest.id},data:{socialMentions5m:x.pulse.mentions5m,socialUniqueAuthors5m:x.pulse.uniqueAuthors5m,socialVelocity:x.pulse.velocity,socialSpamRatio:x.pulse.spamRatio,provenance:{...(latest.provenance as any||{}),x:{provider:"X_RECENT_SEARCH",queryHash:x.queryHash,lastXResearchAt:x.observedAt,result:x.pulse,status:"AVAILABLE"}} as any}});
    researched++;lastResearchAt=new Date().toISOString();
  }catch(e:any){
    errors++;const latest=await db.memeMarketSnapshot.findFirst({where:{chain:o.chain,mint:o.mint},orderBy:{observedAt:"desc"}});
    if(latest)await db.memeMarketSnapshot.update({where:{id:latest.id},data:{provenance:{...(latest.provenance as any||{}),x:{provider:"X_RECENT_SEARCH",status:e?.code??"UNAVAILABLE",observedAt:new Date().toISOString()}} as any}}).catch(()=>{});
  }
}

new Worker<Job>("social-intelligence",async job=>processSocialJob(job.data),{connection:redis,concurrency:2});
startHeartbeat("social-hype",()=>({mode:"EVENT_DRIVEN",optional:true,received,researched,cacheHits,budgetDenied,errors,rateLimited,lastResearchAt,xReadRequests:researched,xWriteRequests:0,message:"No periodic X search or X health probe; only qualified queue events may use intelligence quota."}));
console.log("[social-worker] event-driven X intelligence online; periodic token searches remain disabled");
