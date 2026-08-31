import { money } from "./api";

export function initials(name?:string|null){return (name||"U").split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()}

export function timeAgo(v:string){
  const s=Math.max(1,Math.floor((Date.now()-new Date(v).getTime())/1000));
  if(s<60)return `${s}s ago`; if(s<3600)return `${Math.floor(s/60)}m ago`; if(s<86400)return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`;
}

export function urlB64ToBytes(s:string){const pad="=".repeat((4-s.length%4)%4);const raw=atob((s+pad).replace(/-/g,"+").replace(/_/g,"/"));return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}

export function pushEnv(){
 const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
 const isStandalone=window.matchMedia("(display-mode: standalone)").matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;
 const supported="serviceWorker"in navigator&&"PushManager"in window&&"Notification"in window;
 return{isIOS,isStandalone,supported};
}

export function whaleCount(o:any){return (o.whaleBuyers60s||0)+(o.knownWhaleBuyers60s||0)}
export function copyText(t:string){try{navigator.clipboard.writeText(t)}catch{}}

export function feedLine(o:any){
 const whales=whaleCount(o);
 if(o.state==="MONEY_RUSH")return {emoji:"🐋",text:`${whales||o.buyers60s||0} wallets bought ${o.symbol||"a token"}`,sub:`${money(o.inflow60sUsd||0)} entered in 60s`};
 if((o.volumeAcceleration1m||0)>=1.5)return {emoji:"🚀",text:`Momentum increasing on ${o.symbol||"a token"}`,sub:`Volume up ${(o.volumeAcceleration1m*100-100).toFixed(0)}%`};
 if(o.action==="BUY_NOW")return {emoji:"🧠",text:`MemeCloud is watching ${o.symbol||"a token"}`,sub:o.reasons?.[0]||"Strong setup detected"};
 return {emoji:"👀",text:`Watching ${o.symbol||o.name||"a new token"}`,sub:`${o.chain} · score ${Math.round(o.score)}`};
}
export function eventLine(e:any){
 const map:Record<string,string>={TRADE_COPIED:"💰",PROFIT_TAKEN:"💰",POSITION_CLOSED:"✅",TRADE_SKIPPED:"⏸️",WAIT_PULLBACK:"⏳",GLOBAL_BRAIN:"🧠"};
 return {emoji:map[e.type]||"📣",text:e.title,sub:e.body,at:e.createdAt};
}

export function qualityLabel(score:number){return score>=76?"Strong setup":score>=56?"Building evidence":score>=40?"Early — thin evidence":"Just watching"}

// Backend-computed from real evidence (see classifyLifecycle in the API) -- never client-guessed.
// Discovery visibility and auto-trade qualification are deliberately different bars: FOUND/WATCHING
// tokens are real, just below the BUY_NOW/WATCH trading threshold.
export const LIFECYCLE_LABELS:Record<string,string>={FOUND:"Found",WATCHING:"Watching",INTERESTING:"Interesting",HEATING_UP:"Heating up",STRONG:"Strong",HIGH_CONVICTION:"High conviction",COOLING:"Cooling",STALE:"Stale"};
export function lifecycleLabel(status:string){return LIFECYCLE_LABELS[status]||status}

export const STAGE_LABELS:Record<string,string>={DISCOVERED:"Discovered",ANALYZING:"Analyzing",PAPER_TRACKING:"Being Verified",PROVEN:"Proven Smart Wallet",PAUSED:"Paused"};

// Real gap found by forensic audit (C-21): CopyDecision.action codes were rendered raw in the
// decision history ("WAIT_PULLBACK", "WAIT_ROUTE", ...) -- exactly the internal-code leakage the
// spec calls out by name ("WAIT_PULLBACK -> Waiting for a Better Entry"). Keep raw codes available
// in Advanced Details/admin only; this is the plain-language translation for normal users.
export const DECISION_ACTION_LABELS:Record<string,string>={
 BUY:"Bought",WAIT:"Waiting",SKIP:"Skipped",WATCH:"Watching",
 WAIT_PULLBACK:"Waiting for a Better Entry",
 WAIT_SIGNER:"Waiting on Wallet Setup",
 WAIT_SOURCE_EXIT_CONTEXT:"Waiting to Verify Exit",
 WAIT_MARKET_DATA:"Waiting for Fresh Price Data",
 WAIT_ROUTE:"No Executable Route Yet",
 WAIT_DATA:"Waiting for Data",
 WAIT_RECONCILIATION:"Reconciling Previous Attempt",
 SOURCE_SELL_MIRROR:"Mirrored Trader's Sell",
};
export function decisionActionLabel(action:string){return DECISION_ACTION_LABELS[action]||action.replaceAll("_"," ")}

// Real gap found by forensic audit (M-43/PC-C): the spec calls for Smart Money as first-class
// navigation with HOT NOW/PROVEN/NEWLY FOUND/WATCHING/MY FOLLOWING sections -- this had only
// All/Whales/Proven. Hot Now and Newly Found are added here from data already returned by
// /v1/smart-wallets (lastActivityAt, firstDiscoveredAt); no new backend needed for those two. "My
// Following" is deliberately NOT added -- it would need a genuine user-level wallet-follow
// relationship that doesn't exist yet (distinct from Trader follows), a real backend feature, not
// a client-side filter over data that isn't there. Flagged as remaining work, not faked here.
export const SMART_MONEY_FILTERS=["all","hot","picks","elite","proven","copyable","platform","whales","new","verifying","cooling"] as const;
export function smartMoneyFilterLabel(f:string){return f==="hot"?"Hot Now":f==="picks"?"MemeCloud Picks":f==="elite"?"Elite":f==="proven"?"Proven":f==="copyable"?"Copyable":f==="platform"?"Platform Added":f==="whales"?"Whales":f==="new"?"Newly Discovered":f==="verifying"?"Being Verified":f==="cooling"?"Cooling":"All"}

export function positionMath(p:any){try{const original=BigInt(p.entryTokenRaw||"0"),remaining=BigInt(p.remainingTokenRaw||"0");const fraction=original>BigInt(0)?Number((remaining*BigInt(1000000))/original)/1_000_000:0;const remainingCost=Number(p.costUsd||0)*fraction;const currentValue=remainingCost+Number(p.unrealizedPnlUsd||0);const pnlPct=remainingCost>0?Number(p.unrealizedPnlUsd||0)/remainingCost*100:0;return{fraction,remainingCost,currentValue,pnlPct}}catch{return{fraction:0,remainingCost:0,currentValue:Number(p.unrealizedPnlUsd||0),pnlPct:0}}}

// Best-effort, human-readable device/browser label from a raw User-Agent string. Never claims more
// precision than UA parsing actually has -- unrecognized browsers fall back to "Browser" rather
// than guessing, and the device family (iPhone/iPad/Android/Mac/Windows) is the part UA parsing
// genuinely is reliable for.
export function deviceLabel(ua?:string|null){
 if(!ua) return "Unknown device";
 const device=/iPad/.test(ua)?"iPad":/iPhone|iPod/.test(ua)?"iPhone":/Android/.test(ua)?"Android":/Macintosh/.test(ua)?"Mac":/Windows/.test(ua)?"Windows":"Device";
 const browser=/Phantom/i.test(ua)?"Phantom":/EdgiOS|Edg\//i.test(ua)?"Edge":/OPR\//i.test(ua)?"Opera":/FxiOS|Firefox/i.test(ua)?"Firefox":/CriOS|Chrome/i.test(ua)?"Chrome":/Safari/i.test(ua)?"Safari":"Browser";
 return `${device} · ${browser}`;
}
