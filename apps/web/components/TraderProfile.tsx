"use client";
import {useEffect,useMemo,useState} from "react";
import {ArrowLeft,Copy,ExternalLink,RefreshCw} from "lucide-react";
import {apiFetch,money,pct,plainError} from "../lib/api";
import {initials,timeAgo} from "../lib/format";
import {TokenAvatar} from "./TokenAvatar";

function qty(n:any){const x=Number(n);if(!Number.isFinite(x))return "—";if(Math.abs(x)>=1e9)return `${(x/1e9).toFixed(2)}B`;if(Math.abs(x)>=1e6)return `${(x/1e6).toFixed(2)}M`;if(Math.abs(x)>=1e3)return `${(x/1e3).toFixed(2)}K`;return x.toLocaleString(undefined,{maximumFractionDigits:5})}
function price(n:any){const x=Number(n);if(!Number.isFinite(x)||x<=0)return "—";if(x<.0001)return `$${x.toExponential(3)}`;if(x<1)return `$${x.toPrecision(5)}`;return `$${x.toLocaleString(undefined,{maximumFractionDigits:5})}`}
const muted={fontSize:11,color:"#8a8fa0",lineHeight:1.5} as const;

export default function TraderProfile({traderId,onBack,reload}:{traderId:string;onBack:()=>void;reload:()=>Promise<void>}){
 const[data,setData]=useState<any>(null),[err,setErr]=useState(""),[loading,setLoading]=useState(true),[tab,setTab]=useState("holdings"),[history,setHistory]=useState<any[]>([]),[nextBefore,setNextBefore]=useState<string|null>(null),[moreLoading,setMoreLoading]=useState(false);
 async function load(){try{setErr("");const x=await apiFetch<any>(`/v1/curated/traders/${traderId}/profile?limit=100`);setData(x);setHistory(x.history||[]);setNextBefore(x.nextBefore||null)}catch(e){setErr(plainError(e))}finally{setLoading(false)}}
 useEffect(()=>{void load();const timer=setInterval(()=>{if(document.visibilityState==="visible")void load()},30_000);return()=>clearInterval(timer)},[traderId]);
 async function changeMode(mode:string){try{await apiFetch(`/v1/me/traders/${traderId}`,{method:"PUT",body:JSON.stringify({mode})});await Promise.all([load(),reload()])}catch(e){setErr(plainError(e))}}
 async function loadMore(){if(!nextBefore||moreLoading)return;setMoreLoading(true);try{const x=await apiFetch<any>(`/v1/curated/traders/${traderId}/history?limit=100&before=${encodeURIComponent(nextBefore)}`);setHistory(h=>[...h,...(x.events||[])]);setNextBefore(x.nextBefore||null)}catch(e){setErr(plainError(e))}finally{setMoreLoading(false)}}
 if(loading&&!data)return <section className="app-card"><h3>Loading trader profile…</h3></section>;
 if(err&&!data)return <><button className="soft-action" onClick={onBack}><ArrowLeft size={14}/> Back to traders</button><div className="auth-error" style={{marginTop:12}}>{err}</div></>;
 const t=data.trader,s=data.summary,h=data.holdings||{},tokenHistory=data.tokenHistory||[],mode=data.follow?.mode;
 return <div className="trader-profile-page">
  <button className="soft-action" onClick={onBack}><ArrowLeft size={14}/> Back to traders</button>
  {err&&<div className="auth-error">{err}</div>}
  <section className="app-card trader-profile-hero">
    <div className="trader-profile-title"><div className="avatar trader-profile-avatar">{initials(t.displayName)}</div><div><span>TRACKED TRADER</span><h2>{t.displayName}</h2><small>@{t.handle} · tracked since {new Date(data.trackedSince).toLocaleDateString()}</small></div></div>
    <div className="trader-profile-actions"><button className={mode==="FOLLOW_ONLY"?"active":""} onClick={()=>changeMode("FOLLOW_ONLY")}>Follow</button><button className={mode==="WATCH_ONLY"?"active":""} onClick={()=>changeMode("WATCH_ONLY")}>Alerts</button><button className={mode==="AUTO_COPY"?"active":""} onClick={()=>changeMode("AUTO_COPY")}>Auto Copy</button></div>
    <div className="wallet-address-list">{(t.wallets||[]).map((w:any)=><div key={w.id}><span>{w.address}</span><button aria-label="Copy wallet" onClick={()=>navigator.clipboard?.writeText(w.address)}><Copy size={13}/></button><a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer"><ExternalLink size={13}/></a></div>)}</div>
  </section>

  <section className="trader-profile-stats">
    <div><span>24H TRADES</span><b>{s.day?.trades??0}</b><small>{s.day?.buys??0} buys · {s.day?.sells??0} sells</small></div>
    <div><span>TOTAL TRACKED</span><b>{s.totalTrades??0}</b><small>{s.tokensTraded??0} tokens</small></div>
    <div><span>REALIZED PNL</span><b>{money(s.realizedPnlUsd)}</b><small>{s.closedTrades??0} measured closes</small></div>
    <div><span>WIN RATE</span><b>{s.winRatePct==null?"Building":pct(s.winRatePct)}</b><small>verified swaps only</small></div>
  </section>

  <section className="app-card trader-wallet-summary">
    <div><span>ON-CHAIN HOLDINGS</span><h2>{h.status==="LIVE"?money(s.holdingsValueUsd):"Unavailable"}</h2><p style={muted}>Only tokens this wallet has verifiably bought are shown as positions. Unsolicited airdrops and random transfers are excluded.</p></div>
    <div className="wallet-balance-badges"><span>{h.nativeSol==null?"SOL —":`${qty(h.nativeSol)} SOL`}</span><span>{s.openHoldings??0} active holdings</span><button onClick={()=>void load()}><RefreshCw size={12}/> Refresh</button></div>
    {h.status!=="LIVE"&&<div className="notice"><b>Live holdings unavailable — not zero</b><div style={{fontSize:11,marginTop:4}}>{h.error||"Solana RPC did not return a current wallet snapshot."}</div></div>}
  </section>

  <div className="config-tabs trader-profile-tabs"><button className={tab==="holdings"?"active":""} onClick={()=>setTab("holdings")}>Holdings</button><button className={tab==="history"?"active":""} onClick={()=>setTab("history")}>Trade history</button><button className={tab==="tokens"?"active":""} onClick={()=>setTab("tokens")}>Token history</button></div>

  {tab==="holdings"&&<section className="app-card"><div className="card-title"><div><span>CURRENT POSITIONS</span><h2>What this wallet still holds</h2></div></div>{h.status==="LIVE"&&!(h.holdings||[]).length?<div className="pnl-empty">No verifiably-bought token is currently held.</div>:<div className="profile-holdings-list">{(h.holdings||[]).map((x:any)=><div className="profile-holding-row" key={x.mint}><TokenAvatar symbol={x.token?.symbol||x.token?.name}/><div><b>{x.token?.symbol||x.token?.name||`${x.mint.slice(0,5)}…${x.mint.slice(-4)}`}</b><small>{qty(x.amount)} tokens · {price(x.priceUsd)} current</small><small>{x.marketCapUsd?`${money(x.marketCapUsd)} MC`:"MC unavailable"} · {x.mint.slice(0,6)}…{x.mint.slice(-4)}</small></div><strong>{x.valueUsd==null?"—":money(x.valueUsd)}</strong></div>)}</div>}</section>}

  {tab==="history"&&<section className="app-card"><div className="card-title"><div><span>VERIFIED SWAP HISTORY</span><h2>Every tracked buy & sell</h2></div></div><p style={muted}>This starts when MemeCloud began tracking the wallet. Transfers never appear as trades.</p><div className="profile-trade-list">{history.map((e:any)=><div className="profile-trade-row" key={e.id}><div className={`profile-trade-side ${e.action==="SELL"?"sell":"buy"}`}>{e.action}</div><TokenAvatar symbol={e.token?.symbol||e.token?.name}/><div className="profile-trade-copy"><b>{e.token?.symbol||e.token?.name||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b><small>{timeAgo(e.observedAt)} · {new Date(e.observedAt).toLocaleString()}</small><small>{e.quoteAmount&&e.quoteSymbol?`${e.action==="BUY"?"Spent":"Received"} ${qty(e.quoteAmount)} ${e.quoteSymbol}`:""}{e.amountUsd!=null?` · ~${money(e.amountUsd)}`:""}{e.tokenAmount?` · ${qty(e.tokenAmount)} tokens`:""}</small><small>{e.executionPriceUsd?`${price(e.executionPriceUsd)} price · `:""}{e.marketCapAtTrade?`${money(e.marketCapAtTrade)} MC`:"MC unavailable"}</small></div><a className="profile-tx-link" href={`https://solscan.io/tx/${e.sourceTx}`} target="_blank" rel="noreferrer"><ExternalLink size={15}/></a></div>)}{!history.length&&<div className="pnl-empty">No verified swap history yet.</div>}</div>{nextBefore&&<button className="action-secondary profile-load-more" disabled={moreLoading} onClick={loadMore}>{moreLoading?"Loading…":"Load older trades"}</button>}</section>}

  {tab==="tokens"&&<section className="app-card"><div className="card-title"><div><span>ROUND-TRIP HISTORY</span><h2>Entry, exit & current position</h2></div></div><div className="token-history-list">{tokenHistory.map((x:any)=><div className="token-history-card" key={x.mint}><div className="token-history-head"><div><b>{x.token?.symbol||x.token?.name||`${x.mint.slice(0,5)}…${x.mint.slice(-4)}`}</b><small>{x.buys} buys · {x.sells} sells · first entry {timeAgo(x.firstEntryAt)}</small></div><span className={`status-badge ${x.status==="HOLDING"?"":"watch"}`}>{x.status==="HOLDING"?"HOLDING":x.status==="UNKNOWN"?"UNKNOWN":"EXITED / MOVED"}</span></div><div className="token-history-grid"><div><span>AVG ENTRY</span><b>{price(x.avgEntryPriceUsd)}</b></div><div><span>AVG EXIT</span><b>{price(x.avgExitPriceUsd)}</b></div><div><span>BOUGHT</span><b>{x.totalBoughtUsd==null?"—":money(x.totalBoughtUsd)}</b></div><div><span>SOLD</span><b>{x.totalSoldUsd==null?"—":money(x.totalSoldUsd)}</b></div><div><span>REALIZED PNL</span><b>{x.realizedPnlUsd==null?"—":money(x.realizedPnlUsd)}</b></div><div><span>NOW HOLDING</span><b>{x.currentAmount==null?"—":qty(x.currentAmount)}</b></div></div></div>)}</div></section>}
 </div>;
}
