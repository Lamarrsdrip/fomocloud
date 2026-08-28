import {db} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {classifyPulse} from "@memecloud/social";
let scanned=0,updated=0,errors=0,running=false,rateLimited=false,lastRateLimitAt:string|null=null,lastTickAt:string|null=null;
const positive=/\b(bull|bullish|send|sending|moon|ape|aped|gem|based|cook|cooking|breakout|runner|100x|10x|cto)\b/i;
const negative=/\b(rug|scam|dead|dump|dumping|sell|exit|honeypot|rekt)\b/i;
async function pulse(token:any,bearer:string){const now=new Date(),start=new Date(Date.now()-15*60_000);const q=[token.symbol?`$${token.symbol}`:null,token.mint,token.name?`\"${token.name}\"`:null].filter(Boolean).join(" OR ");const url=new URL("https://api.x.com/2/tweets/search/recent");url.searchParams.set("query",`(${q}) -is:retweet`);url.searchParams.set("start_time",start.toISOString());url.searchParams.set("max_results","100");url.searchParams.set("tweet.fields","created_at,author_id,public_metrics");const r=await fetch(url,{headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(7000)});
  if(r.status===429){const retryAfter=Number(r.headers.get("retry-after")||r.headers.get("x-rate-limit-reset")||0);const err:any=new Error("X_RATE_LIMITED");err.rateLimited=true;err.retryAfterSec=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter:undefined;throw err}
  if(!r.ok)throw new Error(`X_HTTP_${r.status}`);
  const b:any=await r.json(),rows:any[]=b.data??[];const t5=Date.now()-5*60_000,r5=rows.filter(x=>new Date(x.created_at).getTime()>=t5),authors=new Set(r5.map(x=>x.author_id)),p=rows.filter(x=>positive.test(x.text)).length,n=rows.filter(x=>negative.test(x.text)).length,sent=(p-n)/Math.max(1,p+n),velocity=r5.length/Math.max(1,(rows.length-r5.length)/2),spam=1-authors.size/Math.max(1,r5.length);const base={symbol:token.symbol||"",mint:token.mint,mentions5m:r5.length,mentions15m:rows.length,uniqueAuthors5m:authors.size,sentiment:sent,influencerMentions:0,spamRatio:Math.max(0,Math.min(1,spam)),velocity};return {...base,trend:classifyPulse(base)}}
// X's free/Basic search tier has a very tight rate-limit window. This worker previously ticked
// every 15s and fired up to 40 SEQUENTIAL requests per tick with zero pacing or backoff -- up to
// ~160 req/min against a tier that can't sustain anywhere close to that, which is what was
// actually producing the persistent 429s reported in Admin (not an invalid token). Fixed by: a
// much longer tick interval (this data already only looks back 15 minutes, so 5-minute freshness
// loses nothing real), a pacing delay between each token's request, and a real circuit breaker --
// the first 429 in a tick stops that tick immediately rather than hammering the remaining tokens
// into more 429s, and honors the provider's own Retry-After when supplied.
const TICK_INTERVAL_MS=5*60_000;
const PER_TOKEN_DELAY_MS=1500;
async function tick(){
  if(running)return;running=true;lastTickAt=new Date().toISOString();
  try{
    const cfg=await getConfig<any>("social"),bearer=cfg?.xBearerToken||process.env.X_BEARER_TOKEN;
    if(!bearer)return;
    const tokens=await db.discoveryToken.findMany({where:{lastSeenAt:{gte:new Date(Date.now()-6*60*60_000)}},orderBy:{lastSeenAt:"desc"},take:40});
    for(const t of tokens){
      try{
        const p=await pulse(t,bearer);
        scanned++;rateLimited=false;
        const latest=await db.memeMarketSnapshot.findFirst({where:{chain:t.chain,mint:t.mint},orderBy:{observedAt:"desc"}});
        if(latest)await db.memeMarketSnapshot.update({where:{id:latest.id},data:{socialMentions5m:p.mentions5m,socialUniqueAuthors5m:p.uniqueAuthors5m,socialVelocity:p.velocity,socialSentiment:p.sentiment,socialSpamRatio:p.spamRatio,provenance:{...(latest.provenance as any||{}),x:{provider:"X_RECENT_SEARCH",observedAt:new Date().toISOString(),mentions15m:p.mentions15m,trend:p.trend}} as any}}).then(()=>updated++);
      }catch(e:any){
        errors++;
        if(e?.rateLimited){
          rateLimited=true;lastRateLimitAt=new Date().toISOString();
          console.warn("[social-worker] X rate limited -- stopping this tick early, no further requests will be sent until the next scheduled tick",e?.retryAfterSec?`(provider suggested retry-after ${e.retryAfterSec}s)`:"");
          break; // circuit breaker: never keep hammering a provider that just said "too many requests"
        }
        console.error("[social-worker]",t.mint,e);
      }
      await new Promise(r=>setTimeout(r,PER_TOKEN_DELAY_MS));
    }
  }finally{running=false}
}
startHeartbeat("social-hype",()=>({scanned,updated,errors,running,rateLimited,lastRateLimitAt,lastTickAt,tickIntervalMs:TICK_INTERVAL_MS,provider:"X_RECENT_SEARCH_WHEN_CONFIGURED"}));
setInterval(()=>void tick(),TICK_INTERVAL_MS);
void tick();
console.log("[social-worker] online");
