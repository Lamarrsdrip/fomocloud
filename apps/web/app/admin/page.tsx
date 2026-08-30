"use client";
import {useEffect,useState} from "react";
import {apiFetch,plainError,money} from "../../lib/api";
import {timeAgo} from "../../lib/format";
import {Users,Radio,WalletCards,Settings2,Mail,Bell,Send,Activity,ShieldCheck,BarChart3,RefreshCw,Plus,KeyRound,Gauge,SlidersHorizontal,ChevronRight,Home,Wallet,Database,PlugZap,Coins,Fish,AlertTriangle,Layers} from "lucide-react";
import {BrandGlyph} from "../../components/BrandGlyph";
import {Overview} from "../../components/admin/Overview";
import {BrainAdmin} from "../../components/admin/BrainAdmin";
import {UsersView} from "../../components/admin/UsersView";
import {TradersAdmin} from "../../components/admin/TradersAdmin";
import {Signals} from "../../components/admin/Signals";
import {Trades} from "../../components/admin/Trades";
import {AdminPositions} from "../../components/admin/AdminPositions";
import {FailedTrades} from "../../components/admin/FailedTrades";
import {Tokens} from "../../components/admin/Tokens";
import {Whales} from "../../components/admin/Whales";

const sections=[
 ["overview","Control",Gauge],["brain","Global Brain",BarChart3],["tokens","Tokens",Coins],["whales","Whales",Fish],["users","Users",Users],["traders","Wallets",Radio],["signals","Decisions",Activity],
 ["trades","Live Trades",WalletCards],["positions","Positions",Layers],["failed","Failed Trades",AlertTriangle],["config","Settings",SlidersHorizontal],["broadcasts","Messages",Send],["audit","Audit",ShieldCheck],["health","Health",Activity]
] as const;
const navGroups=[
 ["OVERVIEW",["overview"]],
 ["GLOBAL BRAIN",["brain"]],
 ["DISCOVERY",["tokens","whales","traders"]],
 ["TRADING",["trades","positions","signals","failed"]],
 ["USERS",["users"]],
 ["CONFIGURATION",["config"]],
 ["SYSTEM",["broadcasts","audit","health"]]
] as const;

export default function Admin(){
 const[tab,setTab]=useState("overview");const[me,setMe]=useState<any>(null);const[data,setData]=useState<any>({});const[err,setErr]=useState("");const[loading,setLoading]=useState(true);
 // background:true is used for a reload triggered BY an action already inside a tab (Save, Test
 // connection, promote/demote, ...) — it must never flip the full-page loading spinner, because
 // that unmounts the active tab component entirely and resets its local navigation state (e.g.
 // Settings falling back to its home screen on every single Save). It also must never hard-redirect
 // on auth failure: that would silently blow away whatever the user was mid-edit on.
 async function load(which=tab,opts:{background?:boolean}={}){
  if(!opts.background) setLoading(true);
  setErr("");
  try{
  const m=me||((await apiFetch("/v1/me")).user);if(!me)setMe(m);if(m.role!=="OWNER"&&m.role!=="ADMIN"&&m.role!=="SUPPORT")throw Object.assign(new Error("ADMIN_FORBIDDEN"),{status:403});
  let r:any={};
  if(which==="overview")r=await apiFetch("/v1/admin/overview");
  if(which==="brain")r=await apiFetch("/v1/admin/brain");
  if(which==="users")r=await apiFetch("/v1/admin/users");
  if(which==="traders")r=await apiFetch("/v1/admin/traders");
  if(which==="signals")r=await apiFetch("/v1/admin/signals");
  if(which==="trades")r=await apiFetch("/v1/admin/trades");
  if(which==="positions")r=await apiFetch("/v1/admin/positions");
  if(which==="failed")r=await apiFetch("/v1/admin/risk-incidents");
  if(which==="tokens")r=await apiFetch("/v1/admin/discovery/tokens");
  if(which==="whales")r=await apiFetch("/v1/admin/discovery/candidates");
  if(which==="config")r=await apiFetch("/v1/admin/config");
  if(which==="broadcasts")r=await apiFetch("/v1/admin/broadcasts");
  if(which==="audit")r=await apiFetch("/v1/admin/audit");
  if(which==="health")r=await apiFetch("/v1/admin/health");
  setData(r);
 }catch(e:any){
  if(e?.status===401){if(opts.background){setErr(plainError(e))}else{window.location.replace("/login/")};return}
  if(e?.status===403){if(opts.background){setErr(plainError(e))}else{window.location.replace("/app/")};return}
  setErr(plainError(e));
 }finally{if(!opts.background) setLoading(false)}}
 useEffect(()=>{void load("overview")},[]);
 function change(t:string){setTab(t);void load(t)}
 return <main className="admin-layout">
  <aside className="admin-side"><a className="brand" href="/app/"><span className="brandmark small"><BrandGlyph size={18}/></span><span><b>MemeCloud</b><small>Owner controls</small></span></a><nav>{navGroups.map(([label,ids])=><div className="admin-nav-group" key={label}><small>{label}</small>{ids.map(id=>{const s=sections.find(x=>x[0]===id);if(!s)return null;const[,name,Icon]=s;return <button key={id} data-admin-target={id} className={tab===id?"active":""} onClick={()=>change(id)}><Icon size={15}/><span>{name}</span></button>})}</div>)}</nav><div className="admin-side-foot"><div className="owner-chip"><ShieldCheck size={15}/><div><b>{me?.displayName||"Platform owner"}</b><small>{me?.email||"Full control"}</small></div></div><a className="soft-action" href="/app/"><Home size={13}/> Back to MemeCloud</a></div></aside>
  <section className="admin-main"><div className="admin-head"><div><small>MemeCloud · OWNER CONTROL</small><h1>{sections.find(x=>x[0]===tab)?.[1]}</h1><p>{tab==="overview"?"Run the platform from one place.":tab==="config"?"APIs, fees, email, push, discovery and trading rules.":"Real platform data and controls."}</p></div><button className="soft-action" onClick={()=>load()}><RefreshCw size={12}/> Refresh</button></div>
   {err&&<div className="auth-error">{err}</div>}{loading&&!err?<div className="loading"><div><div className="spinner"/>Loading admin data…</div></div>:<>
    {tab==="overview"&&<Overview d={data}/>}
    {tab==="brain"&&<BrainAdmin d={data}/>}
    {tab==="users"&&<UsersView d={data} reload={()=>load("users",{background:true})}/>}
    {tab==="traders"&&<TradersAdmin d={data} reload={()=>load("traders",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="signals"&&<Signals d={data}/>}
    {tab==="trades"&&<Trades d={data}/>}
    {tab==="positions"&&<AdminPositions d={data}/>}
    {tab==="failed"&&<FailedTrades d={data}/>}
    {tab==="tokens"&&<Tokens d={data}/>}
    {tab==="whales"&&<Whales d={data} reload={()=>load("whales",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="config"&&<Config d={data} reload={()=>load("config",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="broadcasts"&&<Broadcasts d={data} reload={()=>load("broadcasts",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="audit"&&<Audit d={data}/>}
    {tab==="health"&&<Health d={data}/>}
   </>}
  </section>
  <nav className="admin-mobile-nav">{sections.slice(0,6).map(([id,label,Icon])=><button key={id} className={tab===id?"active":""} onClick={()=>change(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
 </main>
}

const CFG_LABELS:Record<string,string>={brain:"Global Brain",marketData:"Market data",execution:"Trade routing",signer:"Delegated signer",discovery:"Discovery tuning",risk:"Risk defaults",fees:"Platform fee",email:"Email",push:"Push notifications",social:"X (social)",chains:"Chains",branding:"Branding"};
// Some keys have safe, intentional defaults (0 fee, generous risk limits, Solana-only chains) —
// "never saved" there means "using defaults," not "broken," per the no-conventional-caps philosophy.
const CFG_DEFAULTS_OK=new Set(["risk","fees","chains","branding","discovery"]);
// These already run against public/default providers baked into the workers, so absence in
// AppConfig doesn't mean the feature is down — it means no dedicated key has been added yet.
// NOTE: this only means "won't hard-fail" — it must never be shown as "Connected" without a real test.
const CFG_WORKS_WITHOUT_KEY=new Set(["marketData","execution"]);
const CFG_OPTIONAL=new Set(["social","signer"]);
// Sections backed by an external provider MemeCloud can actually probe. "Connected" is only ever
// shown here, and only once a real test (persisted server-side in testResults) has passed.
const LIVE_TESTABLE=new Set(["marketData","execution","signer","social","brain","push","email"]);
// Must mirror apps/api/src/server.ts SECRET_FIELDS exactly — these are the fields that get
// masked "Saved securely ••••" display + Replace/Remove, never a plain always-empty password box.
const SECRET_FIELDS_FRONTEND:Record<string,string[]>={
 execution:["jupiterApiKey","zeroXApiKey"],
 signer:["privyAppSecret","privyAuthorizationPrivateKey"],
 social:["xBearerToken","xOAuthClientSecret"],
 // RPC URLs are secret-masked too — a paid RPC URL commonly embeds the provider's API key as a
 // query param, so displaying it in the clear leaks that key right back out. Must mirror
 // apps/api/src/server.ts SECRET_FIELDS.marketData exactly.
 marketData:["heliusApiKey","birdeyeApiKey","solanaRpc","heliusRpc","fallbackRpc"],
 email:["pass"]
};
// Named sub-items shown as a persistent, truthful per-provider breakdown. testKey, when present,
// ties the item to a real testResults entry — that's the ONLY way an item can ever reach
// "Connected". neverConnected caps an item at "Saved — not verified": X account-linking (OAuth)
// has no server-to-server health check, so it must never claim to be genuinely "Connected" the
// way a bearer-token API call can prove.
const ITEM_SUMMARY:Record<string,{name:string;secretField?:string;valueField?:string;disabledValue?:string;testKey?:string;neverConnected?:boolean}[]>={
 execution:[{name:"Jupiter",secretField:"jupiterApiKey",testKey:"jupiter"},{name:"0x",secretField:"zeroXApiKey",testKey:"zeroX"}],
 marketData:[{name:"Solana RPC (yours)",valueField:"solanaRpc",testKey:"rpc"},{name:"Helius",secretField:"heliusApiKey",testKey:"helius"},{name:"Birdeye",secretField:"birdeyeApiKey",testKey:"birdeye"}],
 social:[{name:"X bearer token (API)",secretField:"xBearerToken",testKey:"x"},{name:"X OAuth (account linking)",secretField:"xOAuthClientSecret",neverConnected:true}],
 signer:[{name:"Privy credentials",secretField:"privyAppSecret",testKey:"privy"}],
 brain:[{name:"BNB RPC",valueField:"bnbWs",testKey:"bnb"},{name:"Ethereum RPC",valueField:"ethWs",testKey:"eth"}]
};
// The real, honest status of one named sub-item — never "Connected" without a fresh passing test.
// A provider's persisted state from the server is now {verified, health}, not a single flat
// attempt — verified is the last genuine PASS, pinned to a config fingerprint, and never erased
// by a later failure; health is the single most recent attempt. `verified.stale` (computed
// server-side, since only the server can see the real secret values a fingerprint is built from)
// means the saved config has changed since that pass and it no longer applies.
type ProviderState="connected"|"unreachable"|"changed"|"neverPassed"|"untested";
// health.stale/verified.stale mean "this record's fingerprint no longer matches what's saved
// now" — computed server-side, the only place that can see the real values a fingerprint covers.
// A fresh (non-stale) health record is always the most direct evidence, since it reflects an
// attempt against the CURRENTLY saved config specifically — trust it first. Only fall back to a
// standing verification, or to "changed", when there's no fresh attempt to go on yet.
function classifyProvider(status:any):ProviderState{
 const v=status?.verified,h=status?.health;
 const vFresh=v&&!v.stale,hFresh=h&&!h.stale;
 if(hFresh&&h.ok)return"connected";
 if(hFresh&&!h.ok)return vFresh?"unreachable":"neverPassed";
 if(vFresh)return"connected";
 if(v)return"changed";
 return"untested";
}
function itemStatus(item:{secretField?:string;valueField?:string;disabledValue?:string;testKey?:string;neverConnected?:boolean},current:any,liveForm:any):{label:string;tone:"good"|"watch"|"follow"}{
 const hasValue=item.secretField?Boolean((current?.secretHints as any)?.[item.secretField]):(item.valueField?Boolean(liveForm?.[item.valueField])&&liveForm[item.valueField]!==item.disabledValue:false);
 if(item.testKey){
  const status=(current?.testResults as any)?.[item.testKey];
  const kind=classifyProvider(status);
  if(kind==="connected")return{label:"Connected",tone:"good"};
  if(kind==="unreachable")return{label:"Connection issue — previously verified",tone:"watch"};
  if(kind==="changed")return{label:"Configuration changed — verify again",tone:"follow"};
  if(kind==="neverPassed")return{label:"Connection failed",tone:"watch"};
 }
 if(!hasValue)return{label:"Not set up",tone:item.neverConnected?"follow":"watch"};
 return{label:"Saved — not verified",tone:"follow"};
}
function summarizeProviders(testResults:any):{tested:boolean;allConnected:boolean;anyConnected:boolean;anyUnreachable:boolean;anyChanged:boolean;anyNeverPassed:boolean;latestAt?:string}{
 const empty={tested:false,allConnected:false,anyConnected:false,anyUnreachable:false,anyChanged:false,anyNeverPassed:false};
 if(!testResults||typeof testResults!=="object")return empty;
 const entries=Object.values(testResults).filter((e:any)=>e&&typeof e==="object"&&("verified"in e||"health"in e)) as any[];
 if(!entries.length)return empty;
 const kinds=entries.map(classifyProvider);
 const latestAt=entries.map((e:any)=>e?.verified?.checkedAt||e?.health?.checkedAt).filter(Boolean).sort().slice(-1)[0];
 return{
  tested:true,
  allConnected:kinds.every(k=>k==="connected"),
  anyConnected:kinds.some(k=>k==="connected"),
  anyUnreachable:kinds.some(k=>k==="unreachable"),
  anyChanged:kinds.some(k=>k==="changed"),
  anyNeverPassed:kinds.some(k=>k==="neverPassed"),
  latestAt
 };
}
// Exact vocabulary requested: Not set up / Saved — not verified / Connected / Connection failed /
// Configuration changed / Connection issue — previously verified / Using public fallback /
// Restart required (its own pill, see restartPill below). "good" tone is reserved for a state
// that is ACTUALLY true right now, never for "a row exists," and — just as importantly — a
// standing verification is never downgraded just because time passed with nothing changing.
function cfgStatus(k:string,current:any):{label:string;tone:"good"|"watch"|"follow";detail:string}{
 if(LIVE_TESTABLE.has(k)){
  const s=summarizeProviders(current?.testResults);
  if(s.tested){
   if(s.anyNeverPassed)return{label:"Connection failed",tone:"watch",detail:"At least one provider in this section has never passed a real test — see the breakdown below"};
   if(s.anyChanged)return{label:"Configuration changed",tone:"follow",detail:"Saved values changed since the last passing test — press Test connection"};
   if(s.anyUnreachable)return{label:"Connection issue — previously verified",tone:"watch",detail:"A recent automatic check failed, but this genuinely passed before — see the breakdown below"};
   if(s.allConnected)return{label:"Connected",tone:"good",detail:s.latestAt?`Verified ${new Date(s.latestAt).toLocaleString()}`:"Verified"};
   return{label:"Saved — not verified",tone:"follow",detail:"Required values are saved but have not passed a real test yet — press Test connection"};
  }
  if(current)return{label:"Saved — not verified",tone:"follow",detail:"Required values are saved but have not passed a real test yet — press Test connection"};
  if(CFG_WORKS_WITHOUT_KEY.has(k))return{label:"Using public fallback",tone:"follow",detail:"No key saved — running on MemeCloud's shared public default, not your own"};
  if(CFG_OPTIONAL.has(k))return{label:"Not set up",tone:"follow",detail:"Optional — MemeCloud runs without this"};
  return{label:"Not set up",tone:"watch",detail:"Required configuration/credentials are missing"};
 }
 if(current)return{label:"Configured",tone:"good",detail:`Updated ${new Date(current.updatedAt).toLocaleDateString()}`};
 if(CFG_DEFAULTS_OK.has(k))return{label:"Using defaults",tone:"good",detail:"Sensible defaults active — nothing required"};
 return{label:"Not set up",tone:"watch",detail:"Not configured yet"};
}
function restartPill(current:any):{label:string;show:boolean}{
 return {show:Boolean(current?.restartPending),label:"Restart required"};
}
// Worst-of aggregation: a whole section can only ever be as trustworthy as its weakest real
// dependency — "Ready" requires every sub-item to be genuinely Connected, not merely saved.
function categoryStatus(keys:string[],configArr:any[]):{label:string;tone:"good"|"watch"|"follow"}{
 const relevant=keys.filter(k=>!CFG_OPTIONAL.has(k));
 const statuses=relevant.map(k=>cfgStatus(k,(configArr||[]).find((x:any)=>x.key===k)));
 const restartPending=relevant.some(k=>(configArr||[]).find((x:any)=>x.key===k)?.restartPending);
 if(statuses.some(s=>s.tone==="watch"))return{label:"Needs setup",tone:"watch"};
 if(restartPending)return{label:"Restart required",tone:"follow"};
 if(statuses.some(s=>s.tone==="follow"))return{label:"Setup incomplete",tone:"follow"};
 return{label:"Ready",tone:"good"};
}
const SETTINGS_CATEGORIES=[
 {id:"trading",label:"Trading preferences",blurb:"Fees and platform-wide risk defaults.",keys:["fees","risk"]},
 {id:"networks",label:"Networks",blurb:"Where MemeCloud watches and trades.",keys:["chains","marketData","brain"]},
 {id:"intelligence",label:"Market intelligence",blurb:"Global Brain, discovery and social evidence.",keys:["brain","discovery","social"]},
 {id:"wallets",label:"Wallets & execution",blurb:"Trade routing and delegated live signing.",keys:["execution","signer"]},
 {id:"integrations",label:"Integrations",blurb:"Every external provider MemeCloud can use.",keys:["marketData","execution","social","email","push"]},
 {id:"notifications",label:"Notifications",blurb:"Email and push delivery.",keys:["email","push"]},
 {id:"branding",label:"Branding",blurb:"Public app name and support contact.",keys:["branding"]},
] as const;
function Config({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){
 const[screen,setScreen]=useState<"home"|"category"|"detail">("home");
 const[activeCat,setActiveCat]=useState<string>("");
 const[key,setKey]=useState("email"),[form,setForm]=useState<any>({}),[msg,setMsg]=useState(""),[testEmail,setTestEmail]=useState(""),[testing,setTesting]=useState(false);
 const[sessionExpired,setSessionExpired]=useState(false);
 const[saving,setSaving]=useState(false);
 // A 401 here means the token died mid-edit. Never silently redirect: that would wipe an
 // unsaved secret with no warning. Show it inline, keep the typed value on screen, and let the
 // operator choose when to leave for /login — nothing was saved, and this says so explicitly.
 function reportError(e:any,isSave=false){
  if(e?.status===401){setSessionExpired(true);setMsg("Your session ended before this could be saved — nothing was saved. Your typed values are still here; sign in again in another tab, or use the button below, then retry.")}
  else setMsg((isSave?"Save failed — configuration was not stored. ":"")+plainError(e));
 }
 const[secretMode,setSecretMode]=useState<Record<string,"view"|"edit">>({});
 const[removedFields,setRemovedFields]=useState<Set<string>>(new Set());
 function setFieldMode(name:string,mode:"view"|"edit"){setSecretMode(x=>({...x,[name]:mode}))}
 function toggleRemove(name:string,removed:boolean){setRemovedFields(prev=>{const n=new Set(prev);if(removed)n.add(name);else n.delete(name);return n});if(removed)field(name,"")}
 function openCategory(id:string){const cat=SETTINGS_CATEGORIES.find(c=>c.id===id);if(!cat)return;setActiveCat(id);if(cat.keys.length===1){setKey(cat.keys[0]);setScreen("detail")}else setScreen("category")}
 function openKey(k:string){setKey(k);setScreen("detail")}
 function backToHome(){setScreen("home");setMsg("")}
 function backToCategory(){setScreen("category");setMsg("")}
 const providerInfo:Record<string,{purpose:string;links:{label:string;url:string}[]}>={
  marketData:{purpose:"Watches Solana transactions and prices in real time.",links:[{label:"Get a Solana RPC",url:"https://solana.com/rpc"},{label:"Get Helius RPC",url:"https://www.helius.dev/"},{label:"Get Birdeye key",url:"https://docs.birdeye.so/docs/authentication-api-keys"}]},
  execution:{purpose:"Gets executable Solana swap quotes and routes for real buys/sells.",links:[{label:"Jupiter docs",url:"https://dev.jup.ag/"},{label:"0x API key",url:"https://dashboard.0x.org/"}]},
  signer:{purpose:"Allows authorized unattended (delegated) live trading. Keep live mode off until this is verified.",links:[{label:"Get Privy credentials",url:"https://docs.privy.io/"}]},
  social:{purpose:"Tracks meme hype and mention velocity on X.",links:[{label:"Get X API access",url:"https://developer.x.com/en/portal/dashboard"}]},
  brain:{purpose:"BNB/Ethereum WebSocket RPCs let the Global Brain watch meme trades on those chains.",links:[{label:"BNB RPC providers",url:"https://www.bnbchain.org/en/developers"},{label:"Ethereum RPC providers",url:"https://ethereum.org/en/developers/docs/nodes-and-clients/nodes-as-a-service/"}]},
  email:{purpose:"Sends account emails: verification, password reset, alerts.",links:[]},
  push:{purpose:"Sends browser push notifications to users.",links:[]},
  discovery:{purpose:"Tunes which tokens the discovery/scoring workers pay attention to.",links:[]},
  risk:{purpose:"Platform-wide safety defaults. 0 disables a cap.",links:[]},
  fees:{purpose:"Platform trading fee, disclosed to users.",links:[]},
  chains:{purpose:"Which chains are enabled for Auto Copy.",links:[]},
  branding:{purpose:"Public app name and support contact shown to users.",links:[]}
 };
 const testableKeys=["marketData","execution","signer","social","brain"];
 // Test results are read from current.testResults (server-persisted, refetched via reload()) —
 // never local-only state — so the breakdown shown is always the real, currently-saved outcome.
 async function testConnection(){setTesting(true);setMsg("");setSessionExpired(false);try{await apiFetch<any>(`/v1/admin/config/${key}/test`,{method:"POST"});reload()}catch(e){reportError(e)}finally{setTesting(false)}}
 async function ackRestart(){try{await apiFetch(`/v1/admin/config/${key}/ack-restart`,{method:"POST"});reload()}catch(e){reportError(e)}}
 const current=(d.config||[]).find((c:any)=>c.key===key);
 const templates:any={
  brain:{autoEntryScore:76,notifyScore:65,snapshotMaxAgeMs:45000,solanaChainWideEnabled:true,solanaFlowConcurrency:12,profileTradeUsd:5000,bnbWs:"",ethWs:"",bnbUsd:0,ethUsd:0},
  email:{host:"",port:587,secure:false,user:"",pass:"",from:""},
  push:{subject:""},
  marketData:{solanaRpc:"",heliusRpc:"",heliusRpcAutoManaged:false,heliusApiKey:"",birdeyeApiKey:"",fallbackRpc:""},
  execution:{jupiterBaseUrl:"https://api.jup.ag",jupiterApiKey:"",zeroXApiKey:"",signerProvider:"disabled"},
  signer:{privyAppId:"",privyAppSecret:"",privyAuthorizationPrivateKey:"",privySignerId:"",privyPolicyId:"",sponsorGas:false},
  discovery:{minLiquidityUsd:20000,minMarketCapUsd:75000,maxMarketCapUsd:25000000,tokenScanLimit:40,topTradersPerToken:20,paperMinScore:68,provenMinScore:78,provenMinForwardSamples:20,provenMinForwardMeanPct:5},
  social:{xBearerToken:"",xOAuthClientId:"",xOAuthClientSecret:"",xOAuthCallbackUrl:""},
  chains:{enabled:["SOLANA"]},
  fees:{platformFeeBps:0},
  risk:{emergencyNewEntriesPaused:false,freshMemeBaseChasePct:40,hyperMaxChasePct:55,maxExecutablePriceImpactPct:35},
  branding:{appName:"MemeCloud",supportEmail:"",publicUrl:""}
 };
 useEffect(()=>{
  // The backend already strips only the listed secret fields (server.ts SECRET_FIELDS) from
  // current.value — every other field (jupiterBaseUrl, solanaRpc, signerProvider, ...) is real and
  // must populate the form, even for an isSecret-flagged section. Secret fields land here as
  // undefined and are handled separately via secretProps()/SecretField.
  const visible=current?.value&&typeof current.value==="object"?current.value:{};
  setForm({...templates[key],...visible});setMsg("");setSecretMode({});setRemovedFields(new Set());
 // current changes when Admin data reloads; key is the operator-selected section.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,current?.updatedAt]);
 function field(name:string,value:any){setForm((x:any)=>({...x,[name]:value}))}
 function secretProps(name:string){
  const hint=(current?.secretHints as any)?.[name]??null;
  return {
   value:form[name],hint,removed:removedFields.has(name),mode:(secretMode[name]??"view") as "view"|"edit",
   onChange:(v:string)=>field(name,v),
   onReplace:()=>setFieldMode(name,"edit"),
   onCancel:()=>{setFieldMode(name,"view");field(name,"")},
   onRemove:()=>toggleRemove(name,true),
   onUndo:()=>toggleRemove(name,false)
  };
 }
 async function save(){
  setMsg("Saving…");setSessionExpired(false);setSaving(true);
  try{
   const secretFields=SECRET_FIELDS_FRONTEND[key]??[];
   const payload:any={...form};
   for(const f of secretFields){
    if(removedFields.has(f)){payload[f]=null;continue}
    // form[f] only ever holds a real value when the user actually typed one — secret fields
    // always start blank (see the useEffect below) whether never-saved or saved-and-masked, so
    // checking secretMode==="edit" here was wrong: that mode is only reachable via "Replace key",
    // which never appears for a field with no prior hint. That silently dropped every first-time
    // secret entry from the save payload — the exact bug that made Helius/Birdeye look unsaved.
    if(!form[f]){delete payload[f];continue} // nothing typed -> omit, preserve whatever's already saved
   }
   const r=await apiFetch<any>(`/v1/admin/config/${key}`,{method:"PUT",body:JSON.stringify(payload)});
   const items=ITEM_SUMMARY[key];
   const summary=items?" — "+items.map(it=>`${it.name}: ${itemStatus(it,r.config,payload).label}`).join(", "):"";
   setMsg(`Saved successfully. ${CFG_LABELS[key]||key} persisted.`+(r.restartRequired?" Restart the affected VPS worker(s) to apply this change.":"")+summary);
   reload(); // background:true — refetches the real persisted record without unmounting this screen
  }catch(e){reportError(e,true)}finally{setSaving(false)}
 }
 async function vapid(){setSessionExpired(false);try{if(form.subject)await apiFetch("/v1/admin/config/push",{method:"PUT",body:JSON.stringify({subject:form.subject})});const r=await apiFetch<any>("/v1/admin/push/generate",{method:"POST"});setMsg(`VAPID ready. Public key ${r.publicKey.slice(0,18)}…`);reload()}catch(e){reportError(e)}}
 async function testPush(){setSessionExpired(false);try{const r=await apiFetch<any>("/v1/admin/test-push",{method:"POST"});setMsg(r.result?.sent>0?`✓ Test push sent (${r.result.sent} sent, ${r.result.failed||0} failed).`:`✗ Test push failed to send (0 sent, ${r.result?.failed||0} failed).`);reload()}catch(e){reportError(e)}}
 async function emailTest(){setSessionExpired(false);try{if(!testEmail)throw new Error("Enter a test email address.");await apiFetch("/v1/admin/test-email",{method:"POST",body:JSON.stringify({to:testEmail})});setMsg("✓ SMTP provider accepted the test email.");reload()}catch(e){if((e as any)?.status===401)reportError(e);else setMsg(`✗ ${plainError(e)}`)}}
 const toggleChain=(c:string)=>field("enabled",(form.enabled||[]).includes(c)?(form.enabled||[]).filter((x:string)=>x!==c):[...(form.enabled||[]),c]);
 const[liveReadiness,setLiveReadiness]=useState<any>(null);
 async function loadLiveReadiness(){try{setLiveReadiness(await apiFetch<any>("/v1/admin/live-readiness"))}catch{}}
 useEffect(()=>{void loadLiveReadiness()},[]);
 const[liveTradingBusy,setLiveTradingBusy]=useState(false);
 const[liveTradingMsg,setLiveTradingMsg]=useState("");
 async function enableLiveTrading(){
  setLiveTradingBusy(true);setLiveTradingMsg("");
  try{await apiFetch("/v1/admin/live-trading/enable",{method:"POST"});setLiveTradingMsg("Live Solana trading is ON.");await loadLiveReadiness()}
  catch(e:any){setLiveTradingMsg(e?.body?.reasons?Array.isArray(e.body.reasons)?e.body.reasons.join(" "):plainError(e):plainError(e))}
  finally{setLiveTradingBusy(false)}
 }
 async function disableLiveTrading(){
  setLiveTradingBusy(true);setLiveTradingMsg("");
  try{await apiFetch("/v1/admin/live-trading/disable",{method:"POST"});setLiveTradingMsg("Live Solana trading is OFF.");await loadLiveReadiness()}
  catch(e:any){setLiveTradingMsg(plainError(e))}
  finally{setLiveTradingBusy(false)}
 }
 const REQUIRED_SUMMARY:[string,string][]=[["marketData","Blockchain data"],["execution","Trade routing"],["discovery","Discovery"],["push","Notifications"],["email","Email"]];
 const readyCount=REQUIRED_SUMMARY.filter(([k])=>cfgStatus(k,(d.config||[]).find((x:any)=>x.key===k)).tone==="good").length;
 const activeCatDef=SETTINGS_CATEGORIES.find(c=>c.id===activeCat);
 const badgeClass=(tone:"good"|"watch"|"follow")=>`status-badge ${tone==="good"?"":tone}`;
 return <div className="settings-shell">
  {sessionExpired&&<section className="app-card" style={{borderColor:"#c0392b"}}>
   <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
    <span>{msg||"Your session ended. Nothing was lost — copy anything you were typing, then sign in again."}</span>
    <a className="soft-action" href="/login/">Sign in again</a>
   </div>
  </section>}
  {screen==="home"&&<>
   <section className="app-card settings-home-head">
    <h2>Settings</h2><p>Manage how MemeCloud trades, connects and communicates.</p>
    <div className="settings-summary">
     <span>SYSTEM SETUP</span><b>{readyCount} of {REQUIRED_SUMMARY.length} ready</b>
     <div className="settings-summary-rows">{REQUIRED_SUMMARY.map(([k,label])=>{const st=cfgStatus(k,(d.config||[]).find((x:any)=>x.key===k));return <div key={k}><span>{label}</span><em className={badgeClass(st.tone)}>{st.label}</em></div>})}</div>
    </div>
   </section>
   <section className="app-card">
    <div className="card-title"><div><span>OWNER ONLY · AUTHORITATIVE RUNTIME STATE</span><h2>Solana execution</h2></div>
     <span className={badgeClass(liveReadiness?.status==="LIVE"?"good":liveReadiness?.status==="SIMULATION"?"follow":"watch")}>{liveReadiness?String(liveReadiness.status).replaceAll("_"," "):"Checking…"}</span>
    </div>
    {liveReadiness&&<>
     <div className="settings-summary-rows">
      <div><span>Requested mode (DB)</span><em className={badgeClass(liveReadiness.requestedMode==="LIVE"?"good":"follow")}>{liveReadiness.requestedMode}</em></div>
      <div><span>Executor safety gate (VPS)</span><em className={badgeClass(liveReadiness.environmentMode==="LIVE"?"good":"watch")}>{liveReadiness.environmentMode}</em></div>
      <div><span>Actual runtime mode</span><em className={badgeClass(liveReadiness.actualRuntimeMode==="LIVE"?"good":"follow")}>{liveReadiness.actualRuntimeMode}</em></div>
      <div><span>Executor release</span><em className={badgeClass(liveReadiness.runtimeEvidence?.executorRelease?"good":"watch")}>{liveReadiness.runtimeEvidence?.executorRelease||"Not reported"}</em></div>
      <div><span>Readiness</span><em className={badgeClass(liveReadiness.readiness==="READY"?"good":"watch")}>{liveReadiness.readiness}</em></div>
      <div><span>Qualified signal branch</span><em className={badgeClass(liveReadiness.nextQualifiedSignalAction==="LIVE_TRANSACTION"?"good":liveReadiness.nextQualifiedSignalAction==="SIMULATION"?"follow":"watch")}>{String(liveReadiness.nextQualifiedSignalAction).replaceAll("_"," ")}</em></div>
      <div><span>Solana execution RPC</span><em className={badgeClass(liveReadiness.dependencies.rpc?"good":"watch")}>{liveReadiness.dependencies.rpc?"Operational":liveReadiness.dependencies.rpcState||"Degraded"}</em></div>
      <div><span>Scanner progress</span><em className={badgeClass(!liveReadiness.dependencies.scannerDegraded&&liveReadiness.dependencies.chainDataFresh?"good":"watch")}>{!liveReadiness.dependencies.scannerDegraded&&liveReadiness.dependencies.chainDataFresh?"Fresh":"Degraded"}</em></div>
      <div><span>Jupiter</span><em className={badgeClass(liveReadiness.dependencies.jupiter?"good":"watch")}>{liveReadiness.dependencies.jupiter?"Operational":"Unavailable"}</em></div>
      <div><span>Signer runtime / Privy</span><em className={badgeClass(liveReadiness.dependencies.signerConfigured&&liveReadiness.dependencies.signerCredentialsConnected?"good":"watch")}>{liveReadiness.dependencies.signerConfigured&&liveReadiness.dependencies.signerCredentialsConnected?"Ready":"Unavailable"}</em></div>
      <div><span>Wallets with active delegated permission</span><em className={badgeClass(liveReadiness.dependencies.walletsWithActivePermission>0?"good":"watch")}>{liveReadiness.dependencies.walletsWithActivePermission}</em></div>
     </div>
     <div className="settings-summary-rows">
      {liveReadiness.workers.map((w:any)=><div key={w.name}><span>{w.name}</span><em className={badgeClass(w.running?"good":"watch")}>{w.running?"Running":"Not running"}</em></div>)}
     </div>
     {liveReadiness.blockers?.length>0&&<div className="notice"><b style={{display:"block",marginBottom:5}}>Live blockers</b>{liveReadiness.blockers.map((b:any)=><div key={b.code}><b>{b.code.replaceAll("_"," ")}:</b> {b.message}</div>)}</div>}
     <div className="notice">{liveReadiness.note}</div>
     <button type="button" className="soft-action" onClick={loadLiveReadiness}>Refresh</button>
     <div className="card-title" style={{marginTop:16}}><div><span>MASTER SWITCH · NEW LIVE ENTRIES</span><h2>Live Solana trading</h2></div>
      <span className={badgeClass(liveReadiness.status==="LIVE"?"good":liveReadiness.requestedMode==="LIVE"?"watch":"follow")}>{liveTradingBusy?"Working…":liveReadiness.status==="LIVE"?"LIVE":liveReadiness.requestedMode==="LIVE"?"REQUESTED · BLOCKED":"OFF"}</span>
     </div>
     <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span>{liveReadiness.nextQualifiedSignalAction==="LIVE_TRANSACTION"?"A qualified new entry will enter the construct → sign → submit path.":liveReadiness.nextQualifiedSignalAction==="SIMULATION"?"A qualified new entry will use the simulation path. No transaction will be constructed.":"Qualified new entries are blocked. No live transaction will be constructed."}</span>
      {admin&&(liveReadiness.liveTradingEnabled
       ?<button type="button" className="action-primary" style={{background:"#c0392b"}} disabled={liveTradingBusy} onClick={disableLiveTrading}>Turn OFF</button>
       :<button type="button" className="action-primary" disabled={liveTradingBusy||!liveReadiness.ready} onClick={enableLiveTrading} title={!liveReadiness.ready?liveReadiness.reasons.join(" "):""}>{liveReadiness.ready?"Turn ON":"Not ready yet"}</button>)}
     </div>
     <div className="notice">{liveReadiness.openLivePositions>0?`${liveReadiness.openLivePositions} real open position(s) exist right now. Stop-loss/take-profit exits and source-sell mirrors keep managing these for real regardless of this switch — closing a real position always requires a real sell.`:"No real open positions exist right now — nothing is being live-managed regardless of this switch's state."}</div>
     {/* A disabled button with only a hover title explains nothing on a touch device — this is
         the same information as the reasons list above, repeated right next to the control it
         actually blocks, since that's the one place an owner will look when "Turn ON" doesn't
         seem to do anything. */}
     {!liveReadiness.liveTradingEnabled&&!liveReadiness.ready&&liveReadiness.reasons.length>0&&
      <div className="notice" style={{borderColor:"rgba(247,185,95,.25)"}}>
       <b style={{display:"block",marginBottom:4,fontSize:11}}>Turn ON is disabled until these are resolved:</b>
       {liveReadiness.reasons.map((r:string)=><div key={r}>{r}</div>)}
      </div>}
     {liveTradingMsg&&<div className="notice">{liveTradingMsg}</div>}
    </>}
   </section>
   <section className="app-card"><div className="settings-cat-list">
    {SETTINGS_CATEGORIES.map(cat=>{const st=categoryStatus(cat.keys as unknown as string[],d.config||[]);return <button key={cat.id} className="settings-cat-row" onClick={()=>openCategory(cat.id)}>
     <div><b>{cat.label}</b><small>{cat.blurb}</small></div>
     <span className={badgeClass(st.tone)}>{st.label}</span>
     <ChevronRight size={16}/>
    </button>})}
   </div></section>
  </>}
  {screen==="category"&&activeCatDef&&<section className="app-card">
   <button className="back-link" onClick={backToHome}>← Settings</button>
   <h2 style={{margin:"6px 0 2px"}}>{activeCatDef.label}</h2><p style={{margin:"0 0 14px",fontSize:11,color:"#8a8fa0"}}>{activeCatDef.blurb}</p>
   <div className="settings-cat-list">{Array.from(new Set(activeCatDef.keys)).map(k=>{const c=(d.config||[]).find((x:any)=>x.key===k);const st=cfgStatus(k,c);return <button key={k} className="settings-cat-row" onClick={()=>openKey(k)}>
    <div><b>{CFG_LABELS[k]||k}</b><small>{providerInfo[k]?.purpose||st.detail}</small></div>
    <span className={badgeClass(st.tone)}>{st.label}</span>
    <ChevronRight size={16}/>
   </button>})}</div>
  </section>}
  {screen==="detail"&&<section className="app-card">
   <button className="back-link" onClick={activeCatDef&&activeCatDef.keys.length>1?backToCategory:backToHome}>← {activeCatDef&&activeCatDef.keys.length>1?activeCatDef.label:"Settings"}</button>
   <div className="card-title" style={{marginTop:8}}><div><span>{activeCatDef?.label.toUpperCase()||"SETTINGS"}</span><h2>{CFG_LABELS[key]||key}</h2></div><span style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span className={badgeClass(cfgStatus(key,current).tone)}>{cfgStatus(key,current).label}</span>{restartPill(current).show&&<span className={badgeClass("follow")}>Restart required</span>}</span></div>
   {restartPill(current).show&&<div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
    <span>This was saved, but the running MemeCloud VPS worker(s) still have the old value in memory until restarted.</span>
    <button type="button" className="soft-action" onClick={ackRestart}>I restarted it</button>
   </div>}
   {providerInfo[key]&&<div className="notice" style={{display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between"}}>
    <span>{providerInfo[key].purpose}</span>
    <span style={{display:"flex",gap:8,flexWrap:"wrap"}}>
     {testableKeys.includes(key)&&<button type="button" className="soft-action" disabled={testing} onClick={testConnection}>{testing?"Testing…":"Test connection"}</button>}
     {providerInfo[key].links.map(l=><a key={l.url} className="soft-action" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
    </span>
   </div>}
   {ITEM_SUMMARY[key]&&<div className="settings-summary-rows" style={{margin:"0 0 14px"}}>
    {ITEM_SUMMARY[key].map(it=>{const st=itemStatus(it,current,form);return <div key={it.name}><span>{it.name}</span><em className={badgeClass(st.tone)}>{st.label}</em></div>})}
   </div>}
   {current?.testResults&&Object.keys(current.testResults).length>0&&<div className="app-card" style={{padding:12,marginBottom:14}}>
    <div style={{fontSize:11,color:"#8a8fa0",marginBottom:6}}>VERIFICATION STATUS</div>
    {Object.entries(current.testResults as Record<string,any>).map(([name,status])=>{
     const kind=classifyProvider(status);
     const v=(status as any)?.verified,h=(status as any)?.health;
     const label=kind==="connected"?"Connected":kind==="unreachable"?"Connection issue — previously verified":kind==="changed"?"Configuration changed — verify again":kind==="neverPassed"?"Connection failed":"Not tested yet";
     const cls=kind==="connected"?"positive":kind==="unreachable"||kind==="changed"?"":"negative";
     const shownAt=v?.checkedAt;
     const noteMsg=kind==="unreachable"?h?.message:(h?.message||v?.message);
     return <div key={name}>
      <div style={{display:"flex",justifyContent:"space-between",gap:10,fontSize:12,padding:"4px 0",borderTop:"1px solid var(--line)"}}>
       <span style={{textTransform:"capitalize"}}>{name}</span>
       <span className={cls}>{label}{h?.httpStatus?` · HTTP ${h.httpStatus}`:""}{typeof h?.latencyMs==="number"?` · ${h.latencyMs}ms`:""}</span>
       <span style={{color:"#8a8fa0"}}>{shownAt?`Verified ${new Date(shownAt).toLocaleDateString()}`:""}</span>
      </div>
      {kind!=="connected"&&noteMsg&&<div className="notice" style={{marginTop:2,marginBottom:6}}>{name}: {noteMsg}</div>}
     </div>;
    })}
   </div>}
   <div className="admin-form">
    {key==="brain"&&<><div className="form-grid"><Cfg label="Auto-entry score (1-100)" type="number" value={form.autoEntryScore} on={v=>field("autoEntryScore",Math.max(1,Math.min(100,Number(v))))}/><Cfg label="Notify score (1-100)" type="number" value={form.notifyScore} on={v=>field("notifyScore",Math.max(1,Math.min(100,Number(v))))}/><Cfg label="Max market snapshot age ms" type="number" value={form.snapshotMaxAgeMs} on={v=>field("snapshotMaxAgeMs",Math.max(5000,Number(v)))}/><Cfg label="Large-wallet profiling starts at trade USD" type="number" value={form.profileTradeUsd} on={v=>field("profileTradeUsd",Math.max(0,Number(v)))}/><Cfg label="Solana scan concurrency" type="number" value={form.solanaFlowConcurrency} on={v=>field("solanaFlowConcurrency",Math.max(2,Number(v)))}/><Cfg label="BNB WebSocket RPC" value={form.bnbWs} placeholder="wss://..." on={v=>field("bnbWs",v)}/><Cfg label="Ethereum WebSocket RPC" value={form.ethWs} placeholder="wss://..." on={v=>field("ethWs",v)}/><Cfg label="BNB USD reference (optional)" type="number" value={form.bnbUsd} on={v=>field("bnbUsd",Number(v))}/><Cfg label="ETH USD reference (optional)" type="number" value={form.ethUsd} on={v=>field("ethUsd",Number(v))}/></div><label className="check-line"><input type="checkbox" checked={Boolean(form.solanaChainWideEnabled)} onChange={e=>field("solanaChainWideEnabled",e.target.checked)}/><span>Scan chain-wide Solana swap flow</span></label><div className="notice">0 caps in user trading settings mean unlimited by MemeCloud. The brain scores what money is doing now; it does not reject a meme simply because it already pumped hard or survived a deep dip. Leave BNB/Ethereum RPC blank to keep those chains in "prepared, not scanning" state.</div></>}
    {key==="email"&&<><Cfg label="SMTP host" value={form.host} on={v=>field("host",v)}/><div className="form-grid"><Cfg label="Port" type="number" value={form.port} on={v=>field("port",Number(v))}/><label className="field"><span>TLS / secure</span><select value={String(Boolean(form.secure))} onChange={e=>field("secure",e.target.value==="true")}><option value="false">STARTTLS / port 587</option><option value="true">TLS / port 465</option></select></label></div><Cfg label="SMTP username" value={form.user} on={v=>field("user",v)}/><SecretField label="SMTP password" {...secretProps("pass")}/><Cfg label="From" placeholder="MemeCloud <hello@example.com>" value={form.from} on={v=>field("from",v)}/></>}
    {key==="push"&&<><Cfg label="VAPID subject" value={form.subject} placeholder="mailto:admin@example.com" on={v=>field("subject",v)}/><div className="notice">Use Generate VAPID below. The private key stays encrypted server-side; users receive only the public key.</div></>}
    {key==="marketData"&&<><SecretField label="Solana RPC (primary — a paid RPC URL usually embeds your API key, so it's masked like any other credential)" {...secretProps("solanaRpc")}/><SecretField label="Helius RPC (advanced — leave unset to auto-derive from the API key below)" {...secretProps("heliusRpc")}/><SecretField label="Helius API key" {...secretProps("heliusApiKey")}/><SecretField label="Birdeye API key" {...secretProps("birdeyeApiKey")}/><SecretField label="Fallback RPC" {...secretProps("fallbackRpc")}/><div className="notice">Every MemeCloud worker uses Solana RPC in this order: your dedicated RPC above, then Helius (auto-built from the API key if you don't set your own Helius RPC), then MemeCloud's public default. Saving a Helius API key here actually feeds the real scanning/execution path — it's not just stored.</div></>}
    {key==="execution"&&<><Cfg label="Jupiter base URL" value={form.jupiterBaseUrl} on={v=>field("jupiterBaseUrl",v)}/><SecretField label="Jupiter API key" {...secretProps("jupiterApiKey")}/><SecretField label="0x API key" {...secretProps("zeroXApiKey")}/><label className="field"><span>Signer provider</span><select value={form.signerProvider||"disabled"} onChange={e=>field("signerProvider",e.target.value)}><option value="disabled">Disabled — simulation only</option><option value="delegated">Delegated signer adapter (only after implemented)</option></select></label></>}
    {key==="signer"&&<><Cfg label="Privy App ID" value={form.privyAppId} on={v=>field("privyAppId",v)}/><SecretField label="Privy App Secret" {...secretProps("privyAppSecret")}/><SecretField label="Privy authorization private key" {...secretProps("privyAuthorizationPrivateKey")}/><Cfg label="Privy signer ID" value={form.privySignerId} placeholder="Restricted signer ID" on={v=>field("privySignerId",v)}/><Cfg label="Privy policy ID" value={form.privyPolicyId} placeholder="Required wallet policy ID" on={v=>field("privyPolicyId",v)}/><label className="check-line"><input type="checkbox" checked={Boolean(form.sponsorGas)} onChange={e=>field("sponsorGas",e.target.checked)}/><span>Sponsor network fees</span></label><div className="notice">Optional — only required for delegated live execution. Signer credentials control delegated live execution. Keep live trading disabled until wallet permissions and execution tests pass.</div></>}
    {key==="discovery"&&<><div className="form-grid"><Cfg label="Minimum liquidity USD" type="number" value={form.minLiquidityUsd} on={v=>field("minLiquidityUsd",Number(v))}/><Cfg label="Minimum market cap USD" type="number" value={form.minMarketCapUsd} on={v=>field("minMarketCapUsd",Number(v))}/><Cfg label="Maximum market cap USD" type="number" value={form.maxMarketCapUsd} on={v=>field("maxMarketCapUsd",Number(v))}/><Cfg label="Tokens per scan" type="number" value={form.tokenScanLimit} on={v=>field("tokenScanLimit",Number(v))}/><Cfg label="Top traders per token" type="number" value={form.topTradersPerToken} on={v=>field("topTradersPerToken",Number(v))}/><Cfg label="Paper-track minimum score" type="number" value={form.paperMinScore} on={v=>field("paperMinScore",Number(v))}/><Cfg label="Proven minimum score" type="number" value={form.provenMinScore} on={v=>field("provenMinScore",Number(v))}/><Cfg label="Minimum forward samples" type="number" value={form.provenMinForwardSamples} on={v=>field("provenMinForwardSamples",Number(v))}/><Cfg label="Minimum forward mean %" type="number" value={form.provenMinForwardMeanPct} on={v=>field("provenMinForwardMeanPct",Number(v))}/></div><div className="notice">These values feed the real on-chain discovery/scoring workers. MemeCloud never fabricates candidates when providers are missing.</div></>}
    {key==="social"&&<><SecretField label="X bearer token" {...secretProps("xBearerToken")}/><Cfg label="X OAuth client ID" value={form.xOAuthClientId} on={v=>field("xOAuthClientId",v)}/><SecretField label="X OAuth client secret" {...secretProps("xOAuthClientSecret")}/><Cfg label="X OAuth callback URL" value={form.xOAuthCallbackUrl} placeholder="https://meme-api.xaucloud.io/auth/x/callback" on={v=>field("xOAuthCallbackUrl",v)}/><div className="notice">Optional — MemeCloud operates without X. Connecting it adds social evidence to the Global Brain.</div></>}
    {key==="chains"&&<div className="chain-config"><div className="notice">Solana chain-wide flow scanning is built in and running. BNB and Ethereum flow scanning activate once their WebSocket RPCs are set under Networks → Global Brain. Live execution still requires a verified execution adapter for each chain.</div>{["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].map(c=><label key={c} className="check-line"><input type="checkbox" checked={(form.enabled||[]).includes(c)} onChange={()=>toggleChain(c)}/><span>{c}</span><small>{c==="SOLANA"?"Listener + chain-wide flow · running":c==="BNB"||c==="ETHEREUM"?"Flow scanner ready · RPC + execution adapter required":"Prepared"}</small></label>)}</div>}
    {key==="fees"&&<><Cfg label="Platform fee (basis points)" type="number" value={form.platformFeeBps} on={v=>field("platformFeeBps",Math.max(0,Math.min(10000,Number(v))))}/><div className="notice">0 by default during testing. Any production fee must be disclosed before authorization and on receipts.</div></>}
    {key==="risk"&&<><label className="check-line"><input type="checkbox" checked={Boolean(form.emergencyNewEntriesPaused)} onChange={e=>field("emergencyNewEntriesPaused",e.target.checked)}/><span>Emergency pause new entries</span></label><Cfg label="Fresh meme base wallet chase %" type="number" value={form.freshMemeBaseChasePct} on={v=>field("freshMemeBaseChasePct",Math.max(0,Number(v)))}/><Cfg label="Hyper maximum wallet chase %" type="number" value={form.hyperMaxChasePct} on={v=>field("hyperMaxChasePct",Math.max(0,Number(v)))}/><Cfg label="Hard max executable price impact %" type="number" value={form.maxExecutablePriceImpactPct} on={v=>field("maxExecutablePriceImpactPct",Math.max(1,Math.min(75,Number(v))))}/><div className="notice">Sensible defaults are active. Chase is measured from the followed wallet's actual execution to each user's actual-size executable quote. The token's 24h move is never used as the chase value.</div></> }
    {key==="branding"&&<><Cfg label="App name" value={form.appName} on={v=>field("appName",v)}/><Cfg label="Support email" value={form.supportEmail} on={v=>field("supportEmail",v)}/><Cfg label="Public URL" value={form.publicUrl} on={v=>field("publicUrl",v)}/></>}
    {msg&&<div className="notice">{msg}</div>}
    <button className="action-primary" disabled={!admin||saving} onClick={save} style={{height:42,borderRadius:12}}>{saving?"Saving…":`Save ${CFG_LABELS[key]||key}`}</button>
    {admin&&key==="push"&&<div className="test-inline"><button className="soft-action" onClick={vapid}><Bell size={12}/> Generate VAPID if missing</button><button className="soft-action" onClick={testPush}><Bell size={12}/> Push test to my devices</button></div>}
    {admin&&key==="email"&&<div className="test-inline"><input value={testEmail} onChange={e=>setTestEmail(e.target.value)} type="email" placeholder="Test email recipient"/><button className="soft-action" onClick={emailTest}><Mail size={12}/> Send SMTP test</button></div>}
   </div>
  </section>}
 </div>
}
function Cfg({label,value,on,type="text",placeholder=""}:{label:string;value:any;on:(v:string)=>void;type?:string;placeholder?:string}){return <label className="field"><span>{label}</span><input type={type} value={value??""} placeholder={placeholder} onChange={e=>on(e.target.value)}/></label>}
// A secret field is never a plain always-blank password box: it shows a real "Saved securely"
// masked state driven by the server's non-secret hint, with explicit Replace/Remove actions.
// Leaving it in the masked "view" state and saving never touches the stored value.
function SecretField({label,value,hint,removed,mode,onChange,onReplace,onCancel,onRemove,onUndo}:{
 label:string;value:string;hint:string|null;removed:boolean;mode:"view"|"edit";
 onChange:(v:string)=>void;onReplace:()=>void;onCancel:()=>void;onRemove:()=>void;onUndo:()=>void;
}){
 if(removed)return <label className="field"><span>{label}</span>
  <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
   <span>Will be removed on save</span><button type="button" className="soft-action" onClick={onUndo}>Undo</button>
  </div></label>;
 if(hint&&mode!=="edit")return <label className="field"><span>{label}</span>
  <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
   <span>Saved securely {hint}</span>
   <span style={{display:"flex",gap:6}}><button type="button" className="soft-action" onClick={onReplace}>Replace key</button><button type="button" className="soft-action" onClick={onRemove}>Remove key</button></span>
  </div></label>;
 return <label className="field"><span>{label}</span>
  <input type="password" value={value??""} placeholder={hint?"Enter a new value to replace the saved key":"Not saved yet"} onChange={e=>onChange(e.target.value)}/>
  {hint&&<button type="button" className="soft-action" style={{marginTop:4,alignSelf:"flex-start"}} onClick={onCancel}>Cancel</button>}
 </label>;
}
function Broadcasts({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){const[title,setTitle]=useState("");const[body,setBody]=useState("");const[channel,setChannel]=useState("PUSH");const[audience,setAudience]=useState("ALL");const[msg,setMsg]=useState("");
 async function send(){try{await apiFetch("/v1/admin/broadcast",{method:"POST",body:JSON.stringify({title,body,channel,audience})});setTitle("");setBody("");setMsg("Broadcast queued.");reload()}catch(e){setMsg(plainError(e))}}
 return <div className="admin-section-grid"><section className="app-card"><div className="card-title"><div><span>NEW BROADCAST</span><h2>Message users</h2></div></div><div className="admin-form"><label className="field"><span>Title</span><input value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field"><span>Message</span><textarea value={body} onChange={e=>setBody(e.target.value)}/></label><label className="field"><span>Channel</span><select value={channel} onChange={e=>setChannel(e.target.value)}><option>PUSH</option><option>EMAIL</option><option>BOTH</option></select></label><label className="field"><span>Audience</span><select value={audience} onChange={e=>setAudience(e.target.value)}><option>ALL</option><option>AUTO_COPY</option></select></label>{msg&&<div className="notice">{msg}</div>}<button className="action-primary" disabled={!admin||!title||!body} onClick={send} style={{height:42,borderRadius:12}}>Queue broadcast</button></div></section>
 <section className="app-card"><div className="card-title"><div><span>HISTORY</span><h2>Delivery progress</h2></div></div><div className="list">{(d.broadcasts||[]).map((b:any)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={b.id}><div><b>{b.title}</b><small>{b.channel} · {b.audience} · {b.sentCount}/{b.targetCount||"?"} sent · {b.failedCount} failed · {b.skippedCount||0} skipped</small></div><span className={`status-badge ${b.status==="FAILED"?"watch":""}`}>{b.status}</span></div>)}</div></section></div>}
function Audit({d}:{d:any}){return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>IMMUTABLE EVENT HISTORY</span><h2>Administrative audit log</h2></div></div><table className="admin-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Context</th></tr></thead><tbody>{(d.logs||[]).map((log:any)=><tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.user?.displayName||log.user?.email||log.actor}</td><td><b>{log.action}</b></td><td>{log.target||"—"}</td><td>{log.hasMetadata?"Recorded":"—"}</td></tr>)}{!(d.logs||[]).length&&<tr><td colSpan={5}>No audit events recorded.</td></tr>}</tbody></table></section>}
// Every field here already exists in the real heartbeat.detail written by each worker this
// session (flow-worker, balance-worker, social-worker) -- this only surfaces what's already true,
// nothing new is computed or estimated. No historical time-series exists (that would need its own
// metrics pipeline, not built) -- this is real-time current state, which is what actually would
// have surfaced the 1M-credit Helius burn while it was happening instead of only after.
const RPC_WORKERS=["solana-flow-scanner","solana-listener","market-worker","balance-worker","social-hype"];
function RpcUsage({services}:{services:any[]}){
 const rows=services.filter(s=>RPC_WORKERS.includes(s.name));
 if(!rows.length)return null;
 return <section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>RPC / PROVIDER USAGE</span><h2>Real-time request state by worker</h2></div></div>
  <table className="admin-table"><thead><tr><th>Worker</th><th>State</th><th>Rate limited</th><th>Errors / Dropped</th><th>Request budget</th><th>Shared account budget</th><th>Last event</th></tr></thead><tbody>
   {rows.map(s=>{const dt=s.detail||{};const rateLimited=Boolean(dt.rateLimited);const lastRl=dt.lastRateLimitAgoSec??dt.lastRateLimitAt;
    return <tr key={s.name}>
     <td><b>{s.name}</b></td>
     <td><span className={`status-badge ${s.healthy?"":"watch"}`}>{s.healthy?"Process healthy":"Process stale"}</span></td>
     <td>{rateLimited?<span className="status-badge watch">Rate limited now</span>:lastRl!=null?<small>Clear · last 429 {typeof lastRl==="number"?`${lastRl}s ago`:"recorded"}</small>:<small>No 429s recorded</small>}</td>
     <td>{dt.errors??0}{dt.dropped!=null?` / ${dt.dropped} dropped`:""}{dt.fallbackSkippedForRateLimit?` (${dt.fallbackSkippedForRateLimit} fallback skipped)`:""}</td>
     <td>{dt.maxRequestsPerSec?`${dt.maxRequestsPerSec}/sec cap`:dt.tickIntervalMs?`1 batch / ${Math.round(dt.tickIntervalMs/1000)}s`:"—"}</td>
     <td>{dt.sharedRpcBudgetPriority?<small>{dt.sharedRpcBudgetPriority} · {dt.sharedRpcBudgetDenied??0} denied{dt.lastSharedRpcBudgetDenyAgoSec!=null?` · last ${dt.lastSharedRpcBudgetDenyAgoSec}s ago`:""}</small>:<small>Not wired in</small>}</td>
     <td><small>{dt.lastSuccessfulRpcAgoSec!=null?`RPC OK ${dt.lastSuccessfulRpcAgoSec}s ago`:dt.lastDbWriteAgoSec!=null?`Last write ${dt.lastDbWriteAgoSec}s ago`:"—"}</small></td>
    </tr>;})}
  </tbody></table>
  <p style={{fontSize:10,color:"#7b8190",margin:"10px 2px 0"}}>No historical requests/min/hour/day graph exists yet -- this table is live current state only, refreshed on demand. "Shared account budget" is a cross-process Redis-backed token bucket (P0=highest priority, P5=lowest) protecting the account-wide Helius/Solana RPC limit -- background/bulk consumers back off first when it gets scarce.</p>
 </section>;
}
// Real gap found by forensic audit (M-47/48): every worker's real work metrics (scans,
// candidates, errors, backlog, reconnects, watchlist alerts, etc.) have always been stored in
// WorkerHeartbeat.detail and returned by this same API response -- "a heartbeat alone does not
// mean a system is healthy" was already true here, just never rendered. A worker reporting
// healthy=true while its own detail shows e.g. 0 candidates for hours looked identical to one
// doing real work. Surfacing the raw detail fields (compact, since each worker's shape differs)
// is what actually lets an operator catch "alive but useless."
function healthDetailLine(detail:any){
 if(!detail||typeof detail!=="object")return null;
 const skip=new Set(["running"]);
 const entries=Object.entries(detail).filter(([k])=>!skip.has(k)).slice(0,6);
 if(!entries.length)return null;
 return entries.map(([k,v])=>`${k}: ${typeof v==="object"?JSON.stringify(v):String(v)}`).join(" · ");
}
function Health({d}:{d:any}){return <><div className="app-grid-4"><div className="stat-card"><span>Database</span><b>{d.database||"—"}</b><small>MongoDB</small></div><div className="stat-card"><span>Redis</span><b>{d.redis||"—"}</b><small>Queue/cache</small></div><div className="stat-card"><span>Actual execution</span><b>{d.executionState?.actualRuntimeMode||String(d.executionMode||"—").toUpperCase()}</b><small>{d.executionState?.status?String(d.executionState.status).replaceAll("_"," "):"Resolved backend mode"}</small></div><div className="stat-card"><span>Broadcast queue</span><b>{d.queue?.broadcasts?.waiting??0}</b><small>Waiting jobs</small></div></div><section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>REAL HEARTBEATS</span><h2>Backend workers</h2></div></div><div className="health-grid">{(d.services||[]).map((h:any)=><div className="health-item" key={h.id}><span>{h.name}</span><b className={h.healthy?"positive":"negative"}>{h.healthy?"Healthy":"Stale"}</b><small>Last beat {new Date(h.lastBeatAt).toLocaleTimeString()}</small>{healthDetailLine(h.detail)&&<small style={{display:"block",marginTop:2,color:"#8a8fa0",fontSize:10}}>{healthDetailLine(h.detail)}</small>}</div>)}</div></section><RpcUsage services={d.services||[]}/></>}
