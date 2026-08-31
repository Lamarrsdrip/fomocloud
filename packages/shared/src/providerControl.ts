/**
 * Cross-worker provider accounting and cache primitives.  These are deliberately
 * dependency-free so every worker can pass its existing ioredis connection.  The
 * cache is Redis-backed (not merely a process Map), and its short-lived lock
 * prevents a thundering herd when several workers need the same provider datum.
 */
export type ProviderPriority = "P0"|"P1"|"P2"|"P3"|"P4"|"P5";
export type ProviderClass = "CRITICAL"|"OPTIONAL";

export interface ProviderRedis {
  get(key:string):Promise<string|null>;
  set(key:string,value:string,...args:any[]):Promise<unknown>;
  del?(key:string):Promise<unknown>;
  incr?(key:string):Promise<number>;
  expire?(key:string,seconds:number):Promise<unknown>;
  hIncrBy?(key:string,field:string,increment:number):Promise<unknown>;
  hSet?(key:string,...args:any[]):Promise<unknown>;
  hGetAll?(key:string):Promise<Record<string,string>>;
  eval?(script:string,numKeys:number,...args:any[]):Promise<unknown>;
}

export type ProviderMetric = {
  provider:string; endpoint:string; service:string; priority:ProviderPriority;
  providerClass:ProviderClass; event:"cache_hit"|"cache_miss"|"request"|"success"|"error"|"rate_limit"|"budget_denied";
  latencyMs?:number;
};

const localInflight=new Map<string,Promise<unknown>>();
const isoHour=()=>new Date().toISOString().slice(0,13).replace(/[-:T]/g,"");
const isoDay=()=>new Date().toISOString().slice(0,10).replace(/-/g,"");
const isoMonth=()=>new Date().toISOString().slice(0,7).replace(/-/g,"");
const metricKey=(period:string,provider:string)=>`provider-metrics:${period}:${provider}`;

export async function recordProviderMetric(redis:ProviderRedis|undefined,m:ProviderMetric){
  if(!redis?.hIncrBy)return;
  const fields=[m.event,`endpoint:${m.endpoint}:${m.event}`,`service:${m.service}:${m.event}`,`priority:${m.priority}:${m.event}`];
  if(m.event==="cache_hit")fields.push("requests_saved");
  if(m.event==="request")fields.push("actual_requests");
  if(m.event==="error"||m.event==="rate_limit")fields.push("errors");
  if(m.event==="rate_limit")fields.push("rate_limits");
  for(const period of [`hour:${isoHour()}`,`day:${isoDay()}`,`month:${isoMonth()}`]){
    const key=metricKey(period,m.provider);
    await Promise.all(fields.map(f=>redis.hIncrBy!(key,f,1).catch(()=>{})));
    await redis.hSet?.(key,"class",m.providerClass).catch(()=>{});
    await redis.expire?.(key,period.startsWith("hour:")?3*24*3600:period.startsWith("day:")?90*24*3600:400*24*3600).catch(()=>{});
  }
}

export async function readProviderMetrics(redis:ProviderRedis|undefined,providers:string[]){
  const periods={hour:`hour:${isoHour()}`,day:`day:${isoDay()}`,month:`month:${isoMonth()}`};
  const out:any[]=[];
  for(const provider of providers){
    const [hour,day,month]=await Promise.all(Object.values(periods).map(p=>redis?.hGetAll?.(metricKey(p,provider)).catch(()=>({}))??Promise.resolve({})));
    out.push({provider,hour,day,month});
  }
  return out;
}

/** Atomically reserves a bounded logical budget. P0/P1 are intentionally never blocked. */
export async function reserveProviderBudget(redis:ProviderRedis|undefined,opts:{provider:string;kind:string;priority:ProviderPriority;hourlyLimit:number;dailyLimit:number;providerClass?:ProviderClass;hardLimitAllPriorities?:boolean}){
  if(!opts.hardLimitAllPriorities&&(opts.priority==="P0"||opts.priority==="P1"))return {granted:true,reason:"CRITICAL_PRIORITY" as const};
  // Optional providers fail closed if the central budget store is unavailable;
  // this prevents an outage from silently removing the hard quota.
  if(!redis?.eval)return {granted:false,reason:"BUDGET_STORE_UNAVAILABLE" as const};
  const hourKey=`provider-budget:${opts.provider}:${opts.kind}:hour:${isoHour()}`;
  const dayKey=`provider-budget:${opts.provider}:${opts.kind}:day:${isoDay()}`;
  const script=`
    local h=tonumber(redis.call('GET',KEYS[1]) or '0')
    local d=tonumber(redis.call('GET',KEYS[2]) or '0')
    local hl=tonumber(ARGV[1]); local dl=tonumber(ARGV[2]); local rank=tonumber(ARGV[3])
    local hp=(hl > 0) and (h/hl) or 1; local dp=(dl > 0) and (d/dl) or 1; local p=math.max(hp,dp)
    if h>=hl or d>=dl or (p>=0.95 and rank>1) or (p>=0.90 and rank>2) then return {0,h,d} end
    h=redis.call('INCR',KEYS[1]); d=redis.call('INCR',KEYS[2])
    redis.call('EXPIRE',KEYS[1],7200); redis.call('EXPIRE',KEYS[2],172800)
    return {1,h,d}
  `;
  const rank=Number(opts.priority.slice(1));
  const result=await redis.eval(script,2,hourKey,dayKey,Math.max(0,opts.hourlyLimit),Math.max(0,opts.dailyLimit),rank) as any[];
  const granted=Number(result?.[0])===1,hour=Number(result?.[1]??0),day=Number(result?.[2]??0);
  if(!granted)await recordProviderMetric(redis,{provider:opts.provider,endpoint:opts.kind,service:"budget",priority:opts.priority,providerClass:opts.providerClass??"OPTIONAL",event:"budget_denied"});
  return {granted,hour,day,reason:granted?"WITHIN_LIMIT" as const:"HARD_LIMIT" as const};
}

type CacheOptions={provider:string;endpoint:string;service:string;priority:ProviderPriority;providerClass:ProviderClass;ttlMs:number;negativeTtlMs?:number;lockMs?:number};
type Stored={ok:true;value:unknown;cachedAt:string}|{ok:false;message:string;cachedAt:string};

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/**
 * Cache successful and brief negative responses, coalesce in-process callers and
 * serialize cross-process refreshes with a Redis NX lock. A waiter reads the
 * value written by the owning process instead of making another provider call.
 */
export async function cachedProviderRequest<T>(redis:ProviderRedis|undefined,key:string,opts:CacheOptions,fetchFresh:()=>Promise<T>):Promise<T>{
  const cacheKey=`provider-cache:${key}`;
  const lockKey=`provider-lock:${key}`;
  const fromCache=async()=>{
    const raw=await redis?.get(cacheKey).catch(()=>null);
    if(!raw)return null;
    try{return JSON.parse(raw) as Stored}catch{return null}
  };
  const cached=await fromCache();
  if(cached){
    await recordProviderMetric(redis,{...opts,event:"cache_hit"});
    if(!cached.ok)throw Object.assign(new Error(cached.message),{code:"CACHED_PROVIDER_NEGATIVE"});
    return cached.value as T;
  }
  await recordProviderMetric(redis,{...opts,event:"cache_miss"});
  const local=localInflight.get(cacheKey) as Promise<T>|undefined;
  if(local)return local;
  const work=(async()=>{
    let locked=false;
    try{
      // ioredis SET key value PX ms NX returns OK when this process owns refresh.
      const lock=await redis?.set(lockKey,"1","PX",opts.lockMs??10_000,"NX").catch(()=>null);
      locked=lock==="OK"||lock===true||lock==="1";
      if(!locked&&redis){
        const attempts=Math.max(1,Math.ceil((opts.lockMs??10_000)/100));
        for(let i=0;i<attempts;i++){
          await pause(100);
          const winner=await fromCache();
          if(winner){
            await recordProviderMetric(redis,{...opts,event:"cache_hit"});
            if(!winner.ok)throw Object.assign(new Error(winner.message),{code:"CACHED_PROVIDER_NEGATIVE"});
            return winner.value as T;
          }
        }
        const retry=await redis.set(lockKey,"1","PX",opts.lockMs??10_000,"NX").catch(()=>null);
        locked=retry==="OK"||retry===true||retry==="1";
        if(!locked)throw Object.assign(new Error("PROVIDER_COALESCE_TIMEOUT"),{code:"PROVIDER_COALESCE_TIMEOUT"});
      }
      const started=Date.now();
      await recordProviderMetric(redis,{...opts,event:"request"});
      try{
        const value=await fetchFresh();
        await redis?.set(cacheKey,JSON.stringify({ok:true,value,cachedAt:new Date().toISOString()} satisfies Stored),"PX",opts.ttlMs).catch(()=>{});
        await recordProviderMetric(redis,{...opts,event:"success",latencyMs:Date.now()-started});
        return value;
      }catch(error:any){
        const message=String(error?.message??error).slice(0,300);
        const rate=Number(error?.status)===429||/RATE_LIMIT|HTTP_429/i.test(message);
        await redis?.set(cacheKey,JSON.stringify({ok:false,message,cachedAt:new Date().toISOString()} satisfies Stored),"PX",opts.negativeTtlMs??30_000).catch(()=>{});
        await recordProviderMetric(redis,{...opts,event:rate?"rate_limit":"error",latencyMs:Date.now()-started});
        throw error;
      }
    }finally{
      if(locked)await redis?.del?.(lockKey).catch(()=>{});
    }
  })();
  localInflight.set(cacheKey,work);
  try{return await work}finally{localInflight.delete(cacheKey)}
}
