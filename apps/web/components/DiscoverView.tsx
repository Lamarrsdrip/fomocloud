"use client";
import {useMemo,useState} from "react";
import {TrendingUp,Users,Sparkles,Flame} from "lucide-react";
import {money} from "../lib/api";
import {timeAgo,whaleCount,lifecycleLabel,qualityLabel} from "../lib/format";
import {Empty} from "./Empty";
import {TokenAvatar} from "./TokenAvatar";

const discoverFilters=[["trending","Trending now",TrendingUp],["whales","Whales buying",Users],["new","New",Sparkles],["momentum","Momentum",Flame]] as const;

export default function DiscoverView({brain,newTokenRadar,brainDegraded,setView,openToken}:{brain:any[];newTokenRadar:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const[filter,setFilter]=useState<typeof discoverFilters[number][0]>("trending");
 const rows=useMemo(()=>{
  const list=[...brain];
  if(filter==="trending")return list.sort((a,b)=>b.score-a.score);
  if(filter==="whales")return list.filter(o=>whaleCount(o)>0).sort((a,b)=>whaleCount(b)-whaleCount(a));
  if(filter==="new")return list.sort((a,b)=>new Date(b.firstSeenAt).getTime()-new Date(a.firstSeenAt).getTime());
  return list.sort((a,b)=>(b.volumeAcceleration1m||0)-(a.volumeAcceleration1m||0));
 },[brain,filter]);
 return <>
  {brainDegraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Discovery data is temporarily degraded — the market data provider is rate-limited, so new tokens aren't being scored right now. This isn't "nothing happening," it's a real provider outage; existing evidence stays honest rather than looking falsely live.</div>}
  <div className="config-tabs discover-tabs">{discoverFilters.map(([id,label,Icon])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}><Icon size={13} style={{verticalAlign:"middle",marginRight:5}}/>{label}</button>)}<button onClick={()=>setView("smart-wallets")}><Users size={13} style={{verticalAlign:"middle",marginRight:5}}/>Smart Wallets</button></div>
  {rows.length?<div className="token-list">{rows.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"New token"}</b><small>{o.chain} · {money(o.marketCapUsd||0)} MC · {money(o.inflow60sUsd||0)} / 60s · Found {timeAgo(o.firstSeenAt)}</small>{o.reasons?.[0]&&<small className="token-row-reason">{o.reasons[0]}</small>}</div>
    <div className="token-row-side"><span className={`status-badge ${o.action==="BUY_NOW"?"":o.lifecycleStatus==="STALE"||o.lifecycleStatus==="COOLING"?"watch":""}`}>{whaleCount(o)>0?`🐋 ${whaleCount(o)}`:lifecycleLabel(o.lifecycleStatus||qualityLabel(o.score))}</span><small>{o.volumeAcceleration1m?`${o.volumeAcceleration1m.toFixed(1)}x momentum`:"Watching"}</small></div>
   </div>)}</div>:<Empty icon={TrendingUp} title={brainDegraded?"Discovery is temporarily paused":"Nothing here yet"} body={brainDegraded?"The market data provider is rate-limited right now, so MemeCloud isn't scoring new tokens. This will resume automatically once the provider recovers.":"MemeCloud is scanning chain flow. Real opportunities appear here as on-chain evidence arrives — nothing is invented while it's quiet."} action="Browse traders instead" onClick={()=>setView("traders")}/>}
  {Boolean(newTokenRadar.length)&&<>
   <div className="card-title" style={{marginTop:20}}><div><span>NEW TOKEN RADAR</span><h2>Early, unqualified activity</h2></div></div>
   <div className="notice" style={{marginBottom:12}}>These tokens haven't cleared MemeCloud's evidence bar yet — early/raw intelligence, not a recommendation. They may never qualify.</div>
   <div className="token-list">{newTokenRadar.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"New token"}</b><small>{o.chain} · {money(o.marketCapUsd||0)} MC · Found {timeAgo(o.firstSeenAt)}</small></div>
    <div className="token-row-side"><span className="status-badge watch">{lifecycleLabel(o.lifecycleStatus)}</span></div>
   </div>)}</div>
  </>}
 </>
}
