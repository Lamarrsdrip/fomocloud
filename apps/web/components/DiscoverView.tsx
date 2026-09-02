"use client";
import {useMemo,useState} from "react";
import {TrendingUp,Users,Flame,Zap,Radio,ArrowUpRight} from "lucide-react";
import {money} from "../lib/api";
import {timeAgo,whaleCount,lifecycleLabel,qualityLabel} from "../lib/format";
import {Empty} from "./Empty";
import {TokenAvatar} from "./TokenAvatar";

const discoverFilters=[["rush","Money Rush",Zap],["trending","Top smart money",TrendingUp],["whales","Whales buying",Users],["momentum","Accelerating",Flame]] as const;

export default function DiscoverView({brain,brainDegraded,setView,openToken}:{brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const[filter,setFilter]=useState<typeof discoverFilters[number][0]>("trending");
 const rows=useMemo(()=>{
  const list=[...brain];
  if(filter==="rush")return list.filter(o=>o.state==="MONEY_RUSH"||o.action==="BUY_NOW").sort((a,b)=>b.score-a.score);
  if(filter==="trending")return list.sort((a,b)=>b.score-a.score);
  if(filter==="whales")return list.filter(o=>whaleCount(o)>0).sort((a,b)=>whaleCount(b)-whaleCount(a));
  return list.sort((a,b)=>(b.volumeAcceleration1m||0)-(a.volumeAcceleration1m||0));
 },[brain,filter]);
 const flow=useMemo(()=>({
  rush:brain.filter(o=>o.state==="MONEY_RUSH"||o.action==="BUY_NOW").length,
  smart:brain.reduce((n,o)=>n+Number(o?.evidence?.convergentCount??0),0),
  inflow:brain.reduce((n,o)=>n+Number(o.inflow60sUsd??0),0)
 }),[brain]);
 return <>
  {brainDegraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Smart-money scoring hasn't refreshed in the last few minutes, so wallet-triggered opportunities may be stale. This isn't "nothing happening" — wallet tracking keeps running; existing evidence stays honest rather than looking falsely live, and this resumes automatically once scoring catches back up.</div>}
  <section className="degen-radar-hero">
   <div className="degen-radar-copy"><span><Radio size={12}/> LIVE HUNT</span><h2>Catch flow before it becomes a crowd.</h2><p>Signals are ranked by on-chain activity, wallet evidence and execution reality—not by how serious a meme looks.</p></div>
   <div className="degen-radar-stats"><div><small>Money Rush</small><b>{flow.rush}</b></div><div><small>Smart wallets</small><b>{flow.smart}</b></div><div><small>60s flow</small><b>{money(flow.inflow)}</b></div></div>
  </section>
  <div className="config-tabs discover-tabs">{discoverFilters.map(([id,label,Icon])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}><Icon size={13} style={{verticalAlign:"middle",marginRight:5}}/>{label}</button>)}<button onClick={()=>setView("smart-wallets")}><Users size={13} style={{verticalAlign:"middle",marginRight:5}}/>Smart Wallets</button></div>
  {rows.length?<div className="token-list hunt-list">{rows.map(o=><div className="token-row hunt-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><div className="hunt-token-title"><b>{o.symbol||o.name||"New token"}</b><span>{o.chain}</span></div><small>{money(o.marketCapUsd||0)} MC · {money(o.inflow60sUsd||0)} in 60s · found {timeAgo(o.firstSeenAt)}</small>{o.reasons?.[0]&&<small className="token-row-reason">{o.reasons[0]}</small>}</div>
    <div className="hunt-metrics"><div><small>OPPORTUNITY</small><b>{Math.round(o.score||0)}</b></div><div><small>FLOW</small><b>{o.volumeAcceleration1m?`${o.volumeAcceleration1m.toFixed(1)}x`:"—"}</b></div></div>
    <div className="token-row-side"><span className={`status-badge ${o.action==="BUY_NOW"?"":o.lifecycleStatus==="STALE"||o.lifecycleStatus==="COOLING"?"watch":""}`}>{o.action==="BUY_NOW"?"Entry live":whaleCount(o)>0?`🐋 ${whaleCount(o)}`:lifecycleLabel(o.lifecycleStatus||qualityLabel(o.score))}</span><ArrowUpRight size={16}/></div>
   </div>)}</div>:<Empty icon={TrendingUp} title={brainDegraded?"Scoring is catching up":"Nothing here yet"} body={brainDegraded?"MemeCloud is still watching tracked wallets; token scoring just hasn't refreshed in the last few minutes. This resumes automatically once scoring catches back up.":"MemeCloud is watching qualified wallets. Opportunities appear here only after tracked smart money buys and the Brain verifies the token."} action="Browse traders instead" onClick={()=>setView("traders")}/>}
 </>
}
