"use client";
import {useMemo,useState} from "react";
import {ArrowUpRight,Radio,Users,RefreshCw} from "lucide-react";
import {money,pct} from "../lib/api";
import {timeAgo} from "../lib/format";
import {useCuratedLive} from "../lib/useCuratedLive";
import {TokenAvatar} from "./TokenAvatar";

function compact(n:any){const x=Number(n);if(!Number.isFinite(x))return null;return x>=1_000_000?`${(x/1_000_000).toFixed(2)}M`:x>=1_000?`${(x/1_000).toFixed(2)}K`:x.toLocaleString(undefined,{maximumFractionDigits:4})}
export default function DiscoverView({openToken,setView}:{brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const live=useCuratedLive(3000),[tab,setTab]=useState("latest");
 const events=live.data?.events||[],traders=live.data?.traders||[];
 const buySessions=useMemo(()=>events.filter((e:any)=>Number(e.buyCount??(e.action==="BUY"?1:0))>0&&e.state!=="EXITED"),[events]);
 const rows=useMemo(()=>{
   if(tab==="big")return buySessions.filter((e:any)=>Number(e.grossBoughtUsd??e.amountUsd??0)>=1000);
   if(tab==="active")return buySessions.filter((e:any)=>Number(e.swaps??1)>1&&Number(e.netUsdFlow??0)>0);
   return buySessions;
 },[buySessions,tab]);
 return <>
  <section className="app-card"><div className="card-title"><div><span>LIVE HUNT</span><h2>What tracked traders are buying now</h2></div><span className={`status-badge ${live.error?"watch":""}`}><Radio size={11}/> {live.error?"DELAYED":"LIVE"}</span></div><p style={{fontSize:12,color:"#8a8fa0"}}>Only verified economic swaps from enabled Admin-listed wallets appear here. Airdrops, transfers, old wallet history and random-token discovery are excluded.</p>
   {live.error?<div className="notice" style={{marginTop:14}}><b>Hunt data unavailable — not zero</b><div style={{fontSize:11,marginTop:4}}>{live.error}</div><button className="soft-action" style={{marginTop:8}} onClick={()=>void live.refresh().catch(()=>{})}><RefreshCw size={12}/> Retry</button></div>:<div className="review-grid"><div><span>Live buy sessions</span><b>{buySessions.length}</b></div><div><span>Tracked traders</span><b>{traders.length}</b></div></div>}
  </section>
  <div className="config-tabs"><button className={tab==="latest"?"active":""} onClick={()=>setTab("latest")}>Latest buys</button><button className={tab==="big"?"active":""} onClick={()=>setTab("big")}>Big buys</button><button className={tab==="active"?"active":""} onClick={()=>setTab("active")}>Accumulating</button><button onClick={()=>setView("traders")}><Users size={13}/> Traders</button></div>
  {!live.error&&<div className="token-list hunt-list">{rows.map((e:any)=>{
    const churn=Number(e.swaps??1)>1,mins=Math.max(1,Math.round((e.spanMs||0)/60000));
    const quote=e.quoteAmount&&e.quoteSymbol?`${compact(e.quoteAmount)} ${e.quoteSymbol}`:null;
    const usd=e.amountUsd?money(e.amountUsd):null;
    return <div className="token-row hunt-row" key={e.id} onClick={()=>openToken({chain:"SOLANA",mint:e.mint})}>
      <TokenAvatar symbol={e.token?.symbol||e.token?.name}/><div className="token-row-main"><b>{e.token?.symbol||e.token?.name||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b>
      {churn?<><small>{e.trader?.displayName} · {e.swaps} verified swaps in {mins}m</small><small>{e.sessionQuoteSymbol?`Bought ${compact(e.grossQuoteBought)} ${e.sessionQuoteSymbol} · Sold ${compact(e.grossQuoteSold)} ${e.sessionQuoteSymbol} · Net ${Number(e.netQuoteFlow)>=0?"+":""}${compact(e.netQuoteFlow)} ${e.sessionQuoteSymbol}`:`Bought ${money(e.grossBoughtUsd)} · Sold ${money(e.grossSoldUsd)} · Net ${Number(e.netUsdFlow)>=0?"+":""}${money(e.netUsdFlow)}`}{e.remainingPositionPct!=null?` · Holding ${Math.round(e.remainingPositionPct)}%`:""}</small></>:<small>{e.trader?.displayName} bought{quote?` with ${quote}`:""}{usd?` · ${usd}`:""} · {timeAgo(e.latestBuyAt||e.firstBuyAt||e.observedAt)}</small>}
      <small>{e.marketCapAtBuy?`${money(e.marketCapAtBuy)} MC at buy`:e.currentMarketCapUsd?`${money(e.currentMarketCapUsd)} MC`:"MC loading"} · Mint {e.mint.slice(0,6)}…{e.mint.slice(-4)}</small></div>
      <div className="token-row-side"><span className="status-badge">{churn?String(e.behaviour||"ACTIVE").replaceAll("_"," "):"BUY"}</span><ArrowUpRight size={16}/></div></div>
  })}</div>}
  {!live.error&&live.loading&&!live.data&&<section className="app-card"><h3>Loading live swaps…</h3></section>}
  {!live.error&&live.data&&!rows.length&&<section className="app-card"><h3>No verified live buy right now</h3><p style={{fontSize:12,color:"#8a8fa0"}}>MemeCloud has a healthy tracked-trader list, but no Admin-tracked wallet has a still-live verified buy session. The next real swap appears here automatically.</p></section>}
  {!live.error&&live.data&&<section className="app-card"><div className="card-title"><div><span>TRADER LEADERBOARD</span><h2>Observed verified-swap performance</h2></div></div>{traders.slice().sort((a:any,b:any)=>(b.performance?.d30?.returnPct??-1e9)-(a.performance?.d30?.returnPct??-1e9)).slice(0,5).map((t:any)=><div className="control-list" key={t.id}><div><span>{t.displayName}<small style={{display:"block"}}>@{t.handle} · {t.performance?.d30?.closed??0} measured closes</small></span><b>{pct(t.performance?.d30?.returnPct)}</b></div></div>)}{!traders.length&&<div className="pnl-empty">No Admin-tracked traders are enabled yet.</div>}</section>}
 </>;
}
