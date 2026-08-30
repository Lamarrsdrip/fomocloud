"use client";
import {useEffect,useMemo,useState} from "react";
import {Users,Wallet,X} from "lucide-react";
import {apiFetch,money} from "../lib/api";
import {timeAgo,STAGE_LABELS,SMART_MONEY_FILTERS,smartMoneyFilterLabel} from "../lib/format";
import {Empty} from "./Empty";
import {TokenAvatar} from "./TokenAvatar";

export default function SmartWalletsView(){
 const[wallets,setWallets]=useState<any[]|null>(null);
 const[degraded,setDegraded]=useState(false);
 const[filter,setFilter]=useState<typeof SMART_MONEY_FILTERS[number]>("all");
 const[detail,setDetail]=useState<any|null>(null);
 const[detailBusy,setDetailBusy]=useState(false);
 useEffect(()=>{let live=true;apiFetch<any>("/v1/smart-wallets",{},false).then(x=>{if(live){setWallets(x.wallets||[]);setDegraded(Boolean(x.pipelineDegraded))}}).catch(()=>{if(live)setWallets([])});return()=>{live=false}},[]);
 const rows=useMemo(()=>{
  const list=wallets||[];
  const now=Date.now();
  if(filter==="whales")return list.filter(w=>w.isWhale);
  if(filter==="proven")return list.filter(w=>w.stage==="PROVEN");
  if(filter==="new")return list.filter(w=>now-new Date(w.firstDiscoveredAt).getTime()<24*3600_000).sort((a,b)=>new Date(b.firstDiscoveredAt).getTime()-new Date(a.firstDiscoveredAt).getTime());
  if(filter==="hot")return list.filter(w=>now-new Date(w.lastActivityAt).getTime()<3600_000&&w.copyabilityScore>=60).sort((a,b)=>b.copyabilityScore-a.copyabilityScore);
  return list;
 },[wallets,filter]);
 async function open(id:string){
  setDetailBusy(true);
  try{const x=await apiFetch<any>(`/v1/smart-wallets/${id}`,{},false);setDetail(x)}catch{}finally{setDetailBusy(false)}
 }
 return <>
  <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 12px"}}>Wallets MemeCloud discovered from real on-chain meme activity — not manually entered. Ratings require a meaningful sample size, never one lucky trade.</p>
  {degraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Scoring is temporarily degraded — the market data provider is rate-limited, so ratings below aren't updating right now. Existing scores stay visible but may be stale.</div>}
  <div className="config-tabs discover-tabs">
   {SMART_MONEY_FILTERS.map(f=><button key={f} className={filter===f?"active":""} onClick={()=>setFilter(f)}>{f==="whales"&&<Wallet size={13} style={{verticalAlign:"middle",marginRight:5}}/>}{smartMoneyFilterLabel(f)}</button>)}
  </div>
  {wallets===null?<div className="loading" style={{minHeight:180}}>Loading…</div>:rows.length?<div className="token-list">{rows.map(w=>
   <div className="token-row" key={w.id} onClick={()=>open(w.id)}>
    <TokenAvatar symbol={w.address.slice(0,2)}/>
    <div className="token-row-main"><b>{w.address.slice(0,6)}…{w.address.slice(-5)}</b><small>{w.chain} · {STAGE_LABELS[w.stage]||w.stage} · {w.sampleTrades} trade(s) observed{w.isWhale?` · 🐋 ${w.whaleTier?.replace("WHALE_","")}`:""}</small></div>
    <div className="token-row-side"><span className="status-badge">{w.winRatePct!==null?`${w.winRatePct}% win`:"Not enough data"}</span><small>{w.realizedPnl7dUsd!=null?`7D ${money(w.realizedPnl7dUsd)}`:`Score ${Math.round(w.copyabilityScore)}`}</small></div>
   </div>
  )}</div>:<Empty icon={Users} title={degraded?"Scoring is temporarily degraded":"No smart wallets discovered yet"} body={degraded?"The market data provider is rate-limited right now, so wallet scoring isn't updating. This will resume automatically once the provider recovers.":"MemeCloud saves a candidate once it observes genuine meme-trading activity from a wallet. This list fills in as real chain data arrives."} />}
  {(detail||detailBusy)&&<div className="wallet-chooser-wrap" onClick={()=>setDetail(null)}>
   <div className="wallet-chooser-sheet" onClick={e=>e.stopPropagation()}>
    <div className="wallet-chooser-handle"/>
    <div className="wallet-chooser-head"><b>{detailBusy&&!detail?"Loading…":`${detail?.wallet.address.slice(0,8)}…${detail?.wallet.address.slice(-6)}`}</b><button type="button" className="wallet-chooser-close" onClick={()=>setDetail(null)} aria-label="Close"><X size={16}/></button></div>
    {detail&&<>
     <p>{STAGE_LABELS[detail.wallet.stage]||detail.wallet.stage} · Discovered {timeAgo(detail.wallet.firstDiscoveredAt)} · Last active {detail.wallet.lastActivityAt?timeAgo(detail.wallet.lastActivityAt):"unknown"}{detail.wallet.isWhale?` · 🐋 Whale tier ${detail.wallet.whaleTier?.replace("WHALE_","")}`:""}</p>
     <div className="app-grid-4" style={{marginBottom:14}}>
      <div className="stat-card"><span>Win rate</span><b>{detail.wallet.winRatePct!==null?`${detail.wallet.winRatePct}%`:"Unknown"}</b></div>
      <div className="stat-card"><span>Trades observed</span><b>{detail.wallet.sampleTrades}</b></div>
      <div className="stat-card"><span>Copyability</span><b>{Math.round(detail.wallet.copyabilityScore)}</b></div>
      <div className="stat-card"><span>Risk</span><b>{Math.round(detail.wallet.riskScore)}</b></div>
     </div>
     <div className="control-list" style={{marginBottom:14}}>
      <div><span>7D realized P&amp;L</span><b className={detail.wallet.realizedPnl7dUsd==null?"":(detail.wallet.realizedPnl7dUsd>=0?"positive":"negative")}>{detail.wallet.realizedPnl7dUsd==null?"Unknown":money(detail.wallet.realizedPnl7dUsd)}</b></div>
      <div><span>30D realized P&amp;L</span><b className={detail.wallet.realizedPnlUsd>=0?"positive":"negative"}>{money(detail.wallet.realizedPnlUsd)}</b></div>
      <div><span>Volume observed</span><b>{money(detail.wallet.volumeUsd)}</b></div>
      <div><span>Rug exposure</span><b>{detail.wallet.rugExposurePct!==null?`${detail.wallet.rugExposurePct.toFixed(0)}%`:"Unknown"}</b></div>
      <div><span>Insider risk</span><b>{detail.wallet.insiderRiskPct!==null?`${detail.wallet.insiderRiskPct.toFixed(0)}%`:"Unknown"}</b></div>
     </div>
     {detail.currentTokens?.length>0&&<><b style={{fontSize:11}}>Recently tracked tokens</b><div className="list" style={{margin:"8px 0 14px"}}>{detail.currentTokens.map((t:any,i:number)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={i}><div><b>{t.mint.slice(0,10)}…</b><small>{t.side} · {timeAgo(t.lastSeenAt)}</small></div></div>)}</div></>}
    </>}
   </div>
  </div>}
 </>;
}
