"use client";
import {useEffect,useMemo,useState} from "react";
import {ArrowUpRight,Radio,Users,RefreshCw,Clock3} from "lucide-react";
import {apiFetch,money,plainError} from "../lib/api";
import {timeAgo} from "../lib/format";
import {useCuratedLive} from "../lib/useCuratedLive";
import {TokenAvatar} from "./TokenAvatar";

function compact(n:any){const x=Number(n);if(!Number.isFinite(x))return null;return x>=1_000_000?`${(x/1_000_000).toFixed(2)}M`:x>=1_000?`${(x/1_000).toFixed(2)}K`:x.toLocaleString(undefined,{maximumFractionDigits:4})}
function price(n:any){const x=Number(n);if(!Number.isFinite(x)||x<=0)return null;if(x<.0001)return `$${x.toExponential(3)}`;if(x<1)return `$${x.toPrecision(5)}`;return `$${x.toLocaleString(undefined,{maximumFractionDigits:4})}`}

export default function DiscoverView({openToken,setView}:{brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const live=useCuratedLive(3000),[tab,setTab]=useState("live"),[history,setHistory]=useState<any[]>([]),[historyError,setHistoryError]=useState(""),[historyLoading,setHistoryLoading]=useState(true);
 const events=live.data?.events||[],traders=live.data?.traders||[];
 const buySessions=useMemo(()=>events.filter((e:any)=>Number(e.buyCount??(e.action==="BUY"?1:0))>0&&e.state!=="EXITED"),[events]);
 async function loadHistory(){try{const x=await apiFetch<any>("/v1/curated/history?hours=24&limit=10000");setHistory(Array.isArray(x.events)?x.events:[]);setHistoryError("")}catch(e){setHistoryError(plainError(e))}finally{setHistoryLoading(false)}}
 useEffect(()=>{let stop=false;const run=()=>{if(!stop&&document.visibilityState==="visible")void loadHistory()};run();const timer=setInterval(run,10_000);const vis=()=>run();document.addEventListener("visibilitychange",vis);return()=>{stop=true;clearInterval(timer);document.removeEventListener("visibilitychange",vis)}},[]);
 const historyTab=tab==="history"||tab==="big";
 const rows=useMemo(()=>{
   if(tab==="history")return history;
   if(tab==="big")return history.filter((e:any)=>e.action==="BUY"&&Number(e.amountUsd??0)>=1000);
   if(tab==="active")return buySessions.filter((e:any)=>Number(e.swaps??1)>1&&Number(e.netUsdFlow??0)>0);
   return buySessions;
 },[buySessions,history,tab]);
 function openTrader(id:string,e:any){e.stopPropagation();try{sessionStorage.setItem("memecloud_open_trader",id)}catch{}setView("traders")}
 return <>
  <section className="app-card"><div className="card-title"><div><span>HUNT</span><h2>Tracked trader flow</h2></div><span className={`status-badge ${live.error?"watch":""}`}><Radio size={11}/> {live.error?"DELAYED":"LIVE"}</span></div><p style={{fontSize:12,color:"#8a8fa0"}}>Live shows positions being built right now. 24H History shows every verified buy and sell made by enabled Admin-listed wallets. Transfers, airdrops and random-token discovery never count as trades.</p>
   {live.error?<div className="notice" style={{marginTop:14}}><b>Hunt data unavailable — not zero</b><div style={{fontSize:11,marginTop:4}}>{live.error}</div><button className="soft-action" style={{marginTop:8}} onClick={()=>void live.refresh().catch(()=>{})}><RefreshCw size={12}/> Retry</button></div>:<div className="review-grid"><div><span>Live buy sessions</span><b>{buySessions.length}</b></div><div><span>24H trades</span><b>{history.length}</b></div><div><span>Tracked traders</span><b>{traders.length}</b></div></div>}
  </section>
  <div className="config-tabs"><button className={tab==="live"?"active":""} onClick={()=>setTab("live")}>Live now</button><button className={tab==="history"?"active":""} onClick={()=>setTab("history")}><Clock3 size={13}/> 24H history</button><button className={tab==="big"?"active":""} onClick={()=>setTab("big")}>Big buys</button><button className={tab==="active"?"active":""} onClick={()=>setTab("active")}>Accumulating</button><button onClick={()=>setView("traders")}><Users size={13}/> Traders</button></div>
  {historyError&&tab!=="live"&&tab!=="active"&&<div className="auth-error">24H history unavailable: {historyError}</div>}
  {((historyTab&&!historyError)||(!historyTab&&!live.error))&&<div className="token-list hunt-list">{rows.map((e:any)=>{
    if(tab==="history"||tab==="big"){
      const quote=e.quoteAmount&&e.quoteSymbol?`${compact(e.quoteAmount)} ${e.quoteSymbol}`:null,usd=e.amountUsd!=null?money(e.amountUsd):null,verb=e.action==="BUY"?"bought":"sold",tradePrice=price(e.executionPriceUsd);
      return <div className="token-row hunt-row" key={e.id} onClick={()=>openToken({chain:"SOLANA",mint:e.mint})}>
        <TokenAvatar symbol={e.token?.symbol||e.token?.name}/><div className="token-row-main"><b>{e.token?.symbol||e.token?.name||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b>
        <small><button className="link-button" onClick={(x)=>openTrader(e.trader?.id,x)}>{e.trader?.displayName||"Tracked trader"}</button> {verb} · {timeAgo(e.observedAt)}</small>
        <small>{quote?`${e.action==="BUY"?"Spent":"Received"} ${quote}`:""}{quote&&usd?" · ":""}{usd?`~${usd}`:""}{e.tokenAmount?` · ${compact(e.tokenAmount)} tokens`:""}</small>
        <small>{tradePrice?`${tradePrice} execution · `:""}{e.marketCapAtTrade?`${money(e.marketCapAtTrade)} MC`:"MC unavailable"} · Mint {e.mint.slice(0,6)}…{e.mint.slice(-4)}</small></div>
        <div className="token-row-side"><span className={`status-badge ${e.action==="SELL"?"watch":""}`}>{e.action}</span><ArrowUpRight size={16}/></div></div>
    }
    const churn=Number(e.swaps??1)>1,mins=Math.max(1,Math.round((e.spanMs||0)/60000)),quote=e.latestBuyQuoteAmount&&e.latestBuyQuoteSymbol?`${compact(e.latestBuyQuoteAmount)} ${e.latestBuyQuoteSymbol}`:e.quoteAmount&&e.quoteSymbol?`${compact(e.quoteAmount)} ${e.quoteSymbol}`:null,usd=e.latestBuyAmountUsd??e.amountUsd;
    return <div className="token-row hunt-row" key={e.id} onClick={()=>openToken({chain:"SOLANA",mint:e.mint})}>
      <TokenAvatar symbol={e.token?.symbol||e.token?.name}/><div className="token-row-main"><b>{e.token?.symbol||e.token?.name||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b>
      {churn?<><small><button className="link-button" onClick={(x)=>openTrader(e.trader?.id,x)}>{e.trader?.displayName}</button> · {e.swaps} verified swaps in {mins}m</small><small>{e.sessionQuoteSymbol?`Bought ${compact(e.grossQuoteBought)} ${e.sessionQuoteSymbol} · Sold ${compact(e.grossQuoteSold)} ${e.sessionQuoteSymbol} · Net ${Number(e.netQuoteFlow)>=0?"+":""}${compact(e.netQuoteFlow)} ${e.sessionQuoteSymbol}`:`Bought ${money(e.grossBoughtUsd)} · Sold ${money(e.grossSoldUsd)} · Net ${Number(e.netUsdFlow)>=0?"+":""}${money(e.netUsdFlow)}`}{e.remainingPositionPct!=null?` · Holding ${Math.round(e.remainingPositionPct)}%`:""}</small></>:<small><button className="link-button" onClick={(x)=>openTrader(e.trader?.id,x)}>{e.trader?.displayName}</button> bought{quote?` with ${quote}`:""}{usd?` · ${money(usd)}`:""} · {timeAgo(e.latestBuyAt||e.firstBuyAt||e.observedAt)}</small>}
      <small>{e.marketCapAtBuy?`${money(e.marketCapAtBuy)} MC at buy`:e.currentMarketCapUsd?`${money(e.currentMarketCapUsd)} MC`:"MC loading"} · Mint {e.mint.slice(0,6)}…{e.mint.slice(-4)}</small></div>
      <div className="token-row-side"><span className="status-badge">{churn?String(e.behaviour||"ACTIVE").replaceAll("_"," "):"BUY"}</span><ArrowUpRight size={16}/></div></div>
  })}</div>}
  {!live.error&&live.loading&&!live.data&&<section className="app-card"><h3>Loading live swaps…</h3></section>}
  {!live.error&&tab==="live"&&live.data&&!rows.length&&<section className="app-card"><h3>No verified live buy right now</h3><p style={{fontSize:12,color:"#8a8fa0"}}>That only means no wallet is actively building a position this minute. Tap <b>24H history</b> to see everything the tracked wallets bought and sold today.</p></section>}
  {!historyError&&(tab==="history"||tab==="big")&&!historyLoading&&!rows.length&&<section className="app-card"><h3>No verified trades in this view</h3><p style={{fontSize:12,color:"#8a8fa0"}}>No real Admin-wallet swap matched this filter in the last 24 hours.</p></section>}
 </>;
}
