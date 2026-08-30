import { getConfig, fingerprintOf, type ProviderRecord } from "@memecloud/config";

// A single raw test attempt, before a config fingerprint is attached (see withFingerprints below).
// `state` is the honest classification of WHY a check failed -- HTTP 429 must never be reported
// the same way as an actually-invalid key. `ok` remains for backward compat (ok === state==="CONNECTED").
export type ProviderState="CONNECTED"|"RATE_LIMITED"|"INVALID_CREDENTIALS"|"PROVIDER_UNAVAILABLE"|"NETWORK_ERROR"|"TIMEOUT"|"NOT_CONFIGURED"|"UNKNOWN";
export type TestResult = { ok: boolean; state: ProviderState; httpStatus?: number; latencyMs?: number; message: string; checkedAt: string };

// Which fields feed each provider's connectivity, per config key — this is what a "verified"
// result is pinned to. Changing any of these fields for a provider invalidates ONLY that
// provider's standing verification, not its siblings (e.g. rotating the Birdeye key never
// invalidates an already-verified Helius key in the same marketData section).
export const PROVIDER_FINGERPRINT_FIELDS:Record<string,Record<string,string[]>>={
  execution:{jupiter:["jupiterBaseUrl","jupiterApiKey"],zeroX:["zeroXApiKey"]},
  marketData:{rpc:["solanaRpc","heliusRpc","fallbackRpc"],helius:["heliusApiKey"],birdeye:["birdeyeApiKey"]},
  signer:{privy:["privyAppId","privyAppSecret","privyAuthorizationPrivateKey","privySignerId","privyPolicyId"]},
  social:{x:["xBearerToken"]},
  brain:{bnb:["bnbWs"],eth:["ethWs"]},
  push:{push:["vapidPublicKey","vapidPrivateKey","subject"]},
  email:{smtp:["host","port","secure","user","pass","from"]}
};

// Every sub-test below hits the saved backend config (getConfig — never req.body/frontend state)
// with a genuine, harmless provider request, and returns a typed, timed, non-secret result.
const withTimeout=(p:Promise<any>,ms=8000)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("Timed out")),ms))]);
type FetchResponse=Awaited<ReturnType<typeof fetch>>;
async function timedFetch(url:string,init:RequestInit={}):Promise<{r:FetchResponse|null;latencyMs:number;error?:Error}>{
  const started=Date.now();
  try{
    const r=await withTimeout(fetch(url,init)) as FetchResponse;
    return {r,latencyMs:Date.now()-started};
  }catch(e:any){
    return {r:null,latencyMs:Date.now()-started,error:e};
  }
}
// How recent a background health check must be to count for the strict "ready for live trading"
// claim (see /v1/admin/live-readiness) — this is intentionally NOT used for the general admin
// "Connected" badge, which is fingerprint-based and does not decay with time on its own.
export const HEALTH_CHECK_MAX_AGE_MS=60*60_000;
// HTTP 429 means rate limiting, not an invalid key -- it must never be reported or treated the
// same as a genuine credential rejection. This is the single place every provider test classifies
// a response, so "check your token" only ever appears when a provider actually said the
// credential itself was rejected (401/403).
function classifyHttp(status:number):ProviderState{
  if(status===429) return "RATE_LIMITED";
  if(status===401||status===403) return "INVALID_CREDENTIALS";
  if(status>=500) return "PROVIDER_UNAVAILABLE";
  if(status>=200&&status<300) return "CONNECTED";
  return "UNKNOWN";
}
function classifyError(e:Error):ProviderState{
  return /timed out/i.test(e?.message||"")?"TIMEOUT":"NETWORK_ERROR";
}
function stateMessage(state:ProviderState,provider:string,httpStatus?:number,detail?:string):string{
  switch(state){
    case "RATE_LIMITED":return `${provider} rate limited MemeCloud (HTTP 429). This is a temporary quota limit, not an invalid credential -- the last verified connection remains trusted.`;
    case "INVALID_CREDENTIALS":return `${provider} rejected the credential (HTTP ${httpStatus}).${detail?` ${detail}`:""}`;
    case "PROVIDER_UNAVAILABLE":return `${provider} returned a server error (HTTP ${httpStatus}) -- this looks like a provider-side outage, not a configuration problem.`;
    case "TIMEOUT":return `${provider} did not respond before the request timed out.`;
    case "NETWORK_ERROR":return `Could not reach ${provider}: ${detail||"network error"}.`;
    case "UNKNOWN":return `${provider} responded with HTTP ${httpStatus}.${detail?` ${detail}`:""}`;
    default:return `${provider} is not configured yet.`;
  }
}
function result(state:ProviderState,message:string,extra:{httpStatus?:number;latencyMs?:number}={}):TestResult{
  return {ok:state==="CONNECTED",state,message,httpStatus:extra.httpStatus,latencyMs:extra.latencyMs,checkedAt:new Date().toISOString()};
}
async function testJupiter(cfg:any):Promise<TestResult>{
  const base=(cfg?.jupiterBaseUrl||"https://api.jup.ag").replace(/\/$/,"");
  const usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",wsol="So11111111111111111111111111111111111111112";
  // Same path/headers as the live JupiterExecution class (packages/execution) — this must test
  // the exact route real trades use, not a stale/guessed one.
  const url=`${base}/swap/v1/quote?inputMint=${wsol}&outputMint=${usdc}&amount=10000000&slippageBps=100`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:cfg?.jupiterApiKey?{"x-api-key":cfg.jupiterApiKey}:{}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Jupiter",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","Jupiter returned a real executable quote.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Jupiter",r!.status),{httpStatus:r!.status,latencyMs});
}
async function testZeroX(cfg:any):Promise<TestResult>{
  if(!cfg?.zeroXApiKey) return result("NOT_CONFIGURED","No 0x API key is saved yet.");
  const weth="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const url=`https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${weth}&buyToken=${usdc}&sellAmount=1000000000000000`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:{"0x-api-key":cfg.zeroXApiKey,"0x-version":"v2"}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"0x",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","0x returned a real price quote.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"0x",r!.status,state==="INVALID_CREDENTIALS"?"Check the API key.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testSolanaRpc(cfg:any):Promise<TestResult>{
  const rpc=cfg?.solanaRpc||cfg?.heliusRpc;
  if(!rpc) return result("NOT_CONFIGURED","No Solana RPC URL is saved yet.");
  const {r,latencyMs,error}=await timedFetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Solana RPC",undefined,error.message),{latencyMs});
  if(r!.status===429) return result("RATE_LIMITED",stateMessage("RATE_LIMITED","Solana RPC"),{httpStatus:r!.status,latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result("CONNECTED","Solana RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Solana RPC",r!.status,body?.error?.message),{httpStatus:r!.status,latencyMs});
}
async function testBirdeye(cfg:any):Promise<TestResult>{
  if(!cfg?.birdeyeApiKey) return result("NOT_CONFIGURED","No Birdeye API key is saved yet.");
  const {r,latencyMs,error}=await timedFetch(`https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`,{headers:{"accept":"application/json","X-API-KEY":cfg.birdeyeApiKey,"x-chain":"solana"}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Birdeye",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","Birdeye accepted the API key.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Birdeye",r!.status,state==="INVALID_CREDENTIALS"?"Check the API key.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testHelius(cfg:any):Promise<TestResult>{
  if(!cfg?.heliusApiKey) return result("NOT_CONFIGURED","No Helius API key is saved yet.");
  // Tests the key directly against Helius's real RPC, independent of whatever ended up in
  // heliusRpc — this is what actually validates the saved key, not just a URL string.
  const url=`https://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;
  const {r,latencyMs,error}=await timedFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Helius",undefined,error.message),{latencyMs});
  if(r!.status===429) return result("RATE_LIMITED",stateMessage("RATE_LIMITED","Helius"),{httpStatus:r!.status,latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result("CONNECTED","Helius RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Helius",r!.status),{httpStatus:r!.status,latencyMs});
}
async function testX(cfg:any):Promise<TestResult>{
  if(!cfg?.xBearerToken) return result("NOT_CONFIGURED","No X bearer token is saved yet.");
  const {r,latencyMs,error}=await timedFetch("https://api.x.com/2/tweets/search/recent?query=test&max_results=10",{headers:{authorization:`Bearer ${cfg.xBearerToken}`}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"X API",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","X API accepted the bearer token.",{httpStatus:r!.status,latencyMs});
  // X's free/basic search tier has an extremely tight rate limit -- 429 here is routine and must
  // never be read as "the token is bad." Only 401/403 actually proves the token itself is rejected.
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"X API",r!.status,state==="INVALID_CREDENTIALS"?"Check the bearer token.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testPrivy(cfg:any):Promise<TestResult>{
  if(!cfg?.privyAppId||!cfg?.privyAppSecret) return result("NOT_CONFIGURED","Privy App ID and App Secret are both required.");
  const auth=Buffer.from(`${cfg.privyAppId}:${cfg.privyAppSecret}`).toString("base64");
  // Privy rejects every request with HTTP 400 unless privy-app-id is ALSO set as its own header,
  // in addition to the Basic-auth credentials — Basic auth alone is not sufficient. This mirrors
  // the header packages/providers already sends for the real signing calls (transactionByReferenceId);
  // this test endpoint was the one place that omitted it, which is what actually produced the 400,
  // not invalid App ID/Secret.
  const {r,latencyMs,error}=await timedFetch(`https://api.privy.io/v1/apps/${cfg.privyAppId}`,{headers:{authorization:`Basic ${auth}`,"privy-app-id":cfg.privyAppId}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Privy",undefined,error.message),{latencyMs});
  if(r!.ok){
    const missing=["privyAuthorizationPrivateKey","privySignerId","privyPolicyId"].filter(f=>!cfg?.[f]);
    const note=missing.length?` Delegated signing also needs ${missing.join(", ")} — the signer ID and policy ID can only be fully verified once a real user connects a wallet and grants them, not from this app-level check.`:" Authorization key, signer ID, and policy ID are saved but can only be fully verified once a real user connects a wallet and grants them (they're scoped per-wallet, not per-app).";
    return result("CONNECTED",`Privy accepted the App ID and Secret.${note}`,{httpStatus:r!.status,latencyMs});
  }
  // Surface Privy's own sanitized reason instead of guessing "check App ID/Secret" for every 400 —
  // Privy's error body describes what's actually wrong with the request (e.g. a missing header,
  // a malformed key), which is frequently not a credential problem at all.
  const body=await r!.json().catch(()=>null);
  const reason=body?.error||body?.message||`HTTP ${r!.status}`;
  const state=classifyHttp(r!.status);
  return result(state,state==="RATE_LIMITED"?stateMessage(state,"Privy"):`Privy rejected the request: ${reason}`,{httpStatus:r!.status,latencyMs});
}
const EXPECTED_CHAIN_ID:Record<string,string>={BNB:"0x38",Ethereum:"0x1"};
async function testWebSocket(url:string,label:string):Promise<TestResult>{
  if(!url) return result("NOT_CONFIGURED",`No ${label} WebSocket URL is saved yet.`);
  const started=Date.now();
  const expected=EXPECTED_CHAIN_ID[label];
  return new Promise<TestResult>((resolve)=>{
    let done=false,ws:WebSocket;
    const finish=(r:TestResult)=>{if(done)return;done=true;clearTimeout(timer);try{ws?.close()}catch{}resolve(r)};
    const timer=setTimeout(()=>finish(result("TIMEOUT",`${label} WebSocket timed out.`,{latencyMs:Date.now()-started})),8000);
    try{ws=new WebSocket(url)}catch(e:any){clearTimeout(timer);return resolve(result("NETWORK_ERROR",e?.message||`${label} WebSocket failed to connect.`))}
    // A socket that merely opens proves reachability, not the right chain — confirm via a real
    // eth_chainId JSON-RPC call so a reachable-but-wrong-network endpoint fails verification.
    ws.onopen=()=>{try{ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}))}catch(e:any){finish(result("NETWORK_ERROR",`${label} WebSocket connected but the chain ID request failed to send.`,{latencyMs:Date.now()-started}))}};
    ws.onmessage=(ev:any)=>{
      const latencyMs=Date.now()-started;
      try{
        const chainId=JSON.parse(String(ev.data))?.result;
        if(!chainId) return finish(result("UNKNOWN",`${label} WebSocket connected but returned no chain ID.`,{latencyMs}));
        if(expected && String(chainId).toLowerCase()!==expected) return finish(result("UNKNOWN",`${label} WebSocket connected but reports chain ID ${chainId} (expected ${expected} for ${label}) — wrong network.`,{latencyMs}));
        finish(result("CONNECTED",`${label} WebSocket connected — chain ID ${chainId} confirmed.`,{httpStatus:200,latencyMs}));
      }catch{
        finish(result("UNKNOWN",`${label} WebSocket connected but sent an unparseable response.`,{latencyMs}));
      }
    };
    ws.onerror=()=>finish(result("NETWORK_ERROR",`${label} WebSocket connection failed.`,{latencyMs:Date.now()-started}));
  });
}
// Shared by both the manual "Test connection" button and the automatic post-save verification —
// one code path, so a save and a manual test can never disagree about what "real" means.
// Attaches each provider's config fingerprint to its raw test outcome — this is what lets a
// later save/read decide whether a past PASS still applies (fingerprint unchanged) or needs a
// fresh test (fingerprint changed), instead of an arbitrary time-based staleness window.
function withFingerprints(key:string,cfg:any,raw:Record<string,TestResult>):Record<string,ProviderRecord>{
  const fields=PROVIDER_FINGERPRINT_FIELDS[key]??{};
  const out:Record<string,ProviderRecord>={};
  for(const [provider,r] of Object.entries(raw)) out[provider]={...r,fingerprint:fingerprintOf(cfg,fields[provider]??[])};
  return out;
}
export async function runProviderTests(key:string):Promise<Record<string,ProviderRecord>|null>{
  if(key==="marketData"){
    const cfg=await getConfig<any>("marketData");
    return withFingerprints(key,cfg,{rpc:await testSolanaRpc(cfg),helius:await testHelius(cfg),birdeye:await testBirdeye(cfg)});
  }
  if(key==="execution"){
    const cfg=await getConfig<any>("execution");
    return withFingerprints(key,cfg,{jupiter:await testJupiter(cfg),zeroX:await testZeroX(cfg)});
  }
  if(key==="social"){
    const cfg=await getConfig<any>("social");
    return withFingerprints(key,cfg,{x:await testX(cfg)});
  }
  if(key==="signer"){
    const cfg=await getConfig<any>("signer");
    return withFingerprints(key,cfg,{privy:await testPrivy(cfg)});
  }
  if(key==="brain"){
    const cfg=await getConfig<any>("brain");
    return withFingerprints(key,cfg,{bnb:await testWebSocket(cfg?.bnbWs,"BNB"),eth:await testWebSocket(cfg?.ethWs,"Ethereum")});
  }
  return null;
}
