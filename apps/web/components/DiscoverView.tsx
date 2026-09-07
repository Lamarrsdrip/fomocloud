"use client";
import {useEffect,useMemo,useState} from "react";
import {ArrowUpRight,Radio,Users} from "lucide-react";
import {apiFetch,money,pct} from "../lib/api";
import {timeAgo} from "../lib/format";
import {TokenAvatar} from "./TokenAvatar";

function compact(n:any){const x=Number(n);if(!Number.isFinite(x))return null;return x>=1_000_000?`${(x/1_000_000).toFixed(2)}M`:x>=1_000?`${(x/1_000).toFixed(2)}K`:x.toLocaleString(undefined,{maximumFractionDigits:4})}
export default function DiscoverView({openToken,setView}:{brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const[events,setEvents]=useState<any[]>([]),[traders,setTraders]=useState<any[]>([]),[tab,setTab]=useState("latest");
 async function load(){const [f,t]=await Promise.all([apiFetch<any>("/v1/curated/flow"),apiFetch<any>("/v1/curated/traders")]);setEvents(f.events||[]);setTraders(t.traders||[])}
 useEffect(()=>{void load();const x=setInterval(()=>void load(),3000);return()=>clearInterval(x)},[]);
 const buySessions=useMemo(()=>events.filter(e=>Number(e.buyCount??(e.action==="BUY"?1:0))>0 && e.state!=="EXITED"),[events]);
 const rows=useMemo(()=>{
   if(tab==="big")return buySessions.filter(e=>Number(e.grossBoughtUsd??e.amountUsd??0)>=1000);
   if(tab==="active")return buySessions.filter(e=>Number(e.swaps??1)>1);
   return buySessions;
 },[buySessions,tab]);
 return <>
  <section className="app-card"><div className="card-title"><div><span>LIVE HUNT</span><h2>What tracked traders are buying now</h2></div><span className="status-badge"><Radio size={11}/> LIVE</span></div><p style={{fontSize:12,color:"#8a8fa0"}}>Only verified economic swaps from enabled Admin-listed wallets appear here. Airdrops, transfers, old wallet history and random-token discovery are excluded.</p><div className="review-grid"><div><span>Live buy sessions</span><b>{buySessions.length}</b></div><div><span>Tracked traders</span><b>{traders.length}</b></div></div></section>
  <div className="config-tabs"><button className={tab==="latest"?"active":""} onClick={()=>setTab("latest")}>Latest buys</button><button className={tab==="big"?"active":""} onClick={()=>setTab("big")}>Big buys</button><button className={tab==="active"?"active":""} onClick={()=>setTab("active")}>Active accumulation</button><button onClick={()=>setView("traders")}><Users size={13}/> Traders</button></div>
  <div className="token-list hunt-list">{rows.map(e=>{
    const churn=Number(e.swaps??1)>1,mins=Math.max(1,Math.round((e.spanMs||0)/60000));
    const quote=e.quoteAmount&&e.quoteSymbol?`${compact(e.quoteAmount)} ${e.quoteSymbol}`:null;
    const usd=e.amountUsd?money(e.amountUsd):null;
    return <div className="token-row hunt-row" key={e.id} onClick={()=>openToken({chain:"SOLANA",mint:e.mint})}>
      <TokenAvatar symbol={e.token?.symbol||e.token?.name}/><div className="token-row-main"><b>{e.token?.symbol||e.token?.name||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b>
      {churn?<><small>{e.trader?.displayName} · {e.swaps} verified swaps in {mins}m</small><small>Bought {money(e.grossBoughtUsd)} · Sold {money(e.grossSoldUsd)} · Net {e.netUsdFlow>=0?"+":""}{money(e.netUsdFlow)}{e.remainingPositionPct!=null?` · Holding ${Math.round(e.remainingPositionPct)}%`:""}</small></>:<small>{e.trader?.displayName} bought{quote?` with ${quote}`:""}{usd?` · ${usd}`:""} · {timeAgo(e.observedAt)}</small>}
      <small>{e.marketCapAtBuy?`${money(e.marketCapAtBuy)} MC at buy`:e.currentMarketCapUsd?`${money(e.currentMarketCapUsd)} MC`:"MC loading"} · Mint {e.mint.slice(0,6)}…{e.mint.slice(-4)}</small></div>
      <div className="token-row-side"><span className="status-badge">{churn?e.behaviour.replaceAll("_"," "):"BUY"}</span><ArrowUpRight size={16}/></div></div>
  })}</div>
  {!rows.length&&<section className="app-card"><h3>No verified live buy yet</h3><p style={{fontSize:12,color:"#8a8fa0"}}>MemeCloud is waiting for a new on-chain swap from an Admin-tracked trader. It will not fill this page with old tokens or transfers.</p></section>}
  <section className="app-card"><div className="card-title"><div><span>TRADER LEADERBOARD</span><h2>Observed verified-swap performance</h2></div></div>{traders.slice().sort((a,b)=>(b.performance?.d30?.returnPct??-1e9)-(a.performance?.d30?.returnPct??-1e9)).slice(0,5).map(t=><div className="control-list" key={t.id}><div><span>{t.displayName}<small style={{display:"block"}}>@{t.handle} · {t.performance.d30.closed} measured closes</small></span><b>{pct(t.performance.d30.returnPct)}</b></div></div>)}</section>
 </>;
}
