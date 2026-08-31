"use client";
import {useMemo} from "react";
import {ArrowDownToLine,Zap,TrendingUp,WalletCards} from "lucide-react";
import {money} from "../lib/api";
import {timeAgo,feedLine,eventLine,whaleCount,lifecycleLabel} from "../lib/format";
import {TokenAvatar} from "./TokenAvatar";

export default function HomeView({d,activity,brain,brainDegraded,setView,openToken,onFund}:{d:any;activity:any;brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void;onFund:()=>void}){
 const s=d?.summary||{};
 const feed=useMemo(()=>{
  const brainItems=brain.slice(0,8).map(o=>({...feedLine(o),at:o.lastEvaluatedAt,mint:o.mint,chain:o.chain}));
  const eventItems=(activity?.events||[]).filter((e:any)=>{const t=`${e?.title||""} ${e?.body||""}`.toLowerCase();return !t.includes("new token radar")&&!t.includes("early/raw intelligence")}).slice(0,8).map((e:any)=>eventLine(e));
  return [...brainItems,...eventItems].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).slice(0,10);
 },[brain,activity]);
 // Real gap found by forensic audit (M-41): Home showed only trading cash + net P&L, and had no
 // "MemeCloud Pulse" / Auto Trade status at all -- both explicitly required, and both computable
 // from data this view already fetches (no new backend calls). Every count below is real evidence
 // already returned by /v1/brain/feed and /v1/me/dashboard, never invented client-side.
 const pulse=useMemo(()=>{
  const heatingUp=brain.filter(o=>o.lifecycleStatus==="HEATING_UP").length;
  const strong=brain.filter(o=>o.lifecycleStatus==="STRONG").length;
  const moneyRush=brain.filter(o=>o.lifecycleStatus==="HIGH_CONVICTION").length;
  const whaleActive=brain.filter(o=>whaleCount(o)>0).length;
  return {heatingUp,strong,moneyRush,whaleActive};
 },[brain]);
 const hotNow=useMemo(()=>[...brain].sort((a,b)=>b.score-a.score).slice(0,3),[brain]);
 const autoTradeOn=Boolean(d?.settings?.autoCopyEnabled);
 return <>
  <section className="home-hero">
   <div><span>TOTAL VALUE</span><h2>{money(s.accountValueUsd)}</h2></div>
   <div className="home-hero-pnl"><span>TODAY</span><b className={(s.todayPnlUsd||0)>=0?"positive":"negative"}>{(s.todayPnlUsd||0)>=0?"+":""}{money(s.todayPnlUsd)}</b></div>
  </section>
  <div className="review-grid" style={{marginBottom:14}}>
   <div><span>Available</span><b>{money(s.availableUsd)}</b></div>
   <div><span>In Trades</span><b>{money(s.inTradesUsd)}</b></div>
  </div>
  <div className="quick-actions-row">
   <button onClick={onFund}><ArrowDownToLine size={18}/><span>Fund</span></button>
   <button onClick={()=>setView("trade")}><Zap size={18}/><span>Trade</span></button>
   <button onClick={()=>setView("discover")}><TrendingUp size={18}/><span>Discover</span></button>
   <button onClick={()=>setView("positions")}><WalletCards size={18}/><span>Wallet</span></button>
  </div>
  <section className="app-card"><div className="card-title"><div><span>MEMECLOUD PULSE</span><h2>What's happening right now</h2></div>{brainDegraded&&<span className="status-badge watch">Degraded</span>}</div>
   {brainDegraded?<p style={{fontSize:11,color:"#8a8fa0",margin:0}}>The market data provider is rate-limited right now, so these counts aren't updating. Not a sign the market is quiet -- existing counts just aren't live.</p>:
   <div className="review-grid">
    <div><span>Smart money building</span><b>{pulse.heatingUp}</b></div>
    <div><span>Strong wallet-backed setups</span><b>{pulse.strong}</b></div>
    <div><span>Money Rush</span><b>{pulse.moneyRush}</b></div>
    <div><span>Whale activity</span><b>{pulse.whaleActive}</b></div>
   </div>}
  </section>
  <section className="app-card"><div className="card-title"><div><span>AUTO TRADE</span><h2>{autoTradeOn?"On":"Off"}</h2></div><span className="status-badge">{s.copiedTraders||0} traders copied</span></div>
   <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 10px"}}>{autoTradeOn?"Eligible opportunities are executed automatically within your own limits.":"MemeCloud keeps watching proven traders and whales even while Auto Trade is off. Turn it on only if you want Brain-approved opportunities executed automatically."}</p>
   <button className="soft-action" onClick={()=>setView("traders")}>{autoTradeOn?"Manage Auto Trade":"Set up Auto Trade"}</button>
  </section>
  {Boolean(hotNow.length)&&<section className="app-card"><div className="card-title"><div><span>HOT RIGHT NOW</span><h2>Top opportunities</h2></div><button className="soft-action" onClick={()=>setView("discover")}>See all</button></div>
   <div className="token-list">{hotNow.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"Token"}</b><small>{o.reasons?.[0]||"Building evidence"}</small></div>
    <div className="token-row-side"><span className="status-badge">{lifecycleLabel(o.lifecycleStatus)}</span></div>
   </div>)}</div>
  </section>}
  <section className="app-card live-feed"><div className="card-title"><div><span>MEMECLOUD</span><h2>Live activity</h2></div><span className="status-badge">Live</span></div>
   {feed.length?<div className="feed-list">{feed.map((f,i)=><div className={`feed-item ${f.mint?"tap":""}`} key={i} onClick={()=>f.mint&&openToken({chain:f.chain,mint:f.mint})}><span className="feed-emoji">{f.emoji}</span><div><b>{f.text}</b><small>{f.sub}</small></div><small className="feed-time">{timeAgo(f.at)}</small></div>)}</div>:<div className="pnl-empty">{brainDegraded?"Discovery activity is temporarily paused -- the market data provider is rate-limited right now. This will resume automatically once it recovers.":"MemeCloud is watching its smart-money network. Activity appears when proven traders, watched wallets or whales actually move — no random-token firehose."}</div>}
  </section>
 </>;
}
