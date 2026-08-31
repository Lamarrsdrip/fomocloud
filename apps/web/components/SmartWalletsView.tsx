"use client";
import {useEffect,useMemo,useState} from "react";
import {Users,Wallet,X,Eye,Zap,Activity,TrendingUp} from "lucide-react";
import {apiFetch,money,plainError} from "../lib/api";
import {timeAgo,STAGE_LABELS,SMART_MONEY_FILTERS,smartMoneyFilterLabel} from "../lib/format";
import {Empty} from "./Empty";
import {TokenAvatar} from "./TokenAvatar";

function n(v:any,d=0){const x=Number(v);return Number.isFinite(x)?x:d}
function evidenceLabel(w:any){
 if(w.intelligenceTier==="ELITE") return "Elite proven wallet";
 if(w.stage==="PROVEN") return "Proven edge";
 if(w.stage==="PAPER_TRACKING") return "Being verified";
 return n(w.sampleTrades)>0?"Building track record":"Newly discovered";
}
function activityLabel(w:any){
 if(!w.lastActivityAt)return "Activity not verified yet";
 const h=(Date.now()-new Date(w.lastActivityAt).getTime())/3600000;
 return h<1?"Active now":h<24?"Active today":h<168?"Active this week":"Cooling";
}

export default function SmartWalletsView(){
 const[wallets,setWallets]=useState<any[]|null>(null);
 const[degraded,setDegraded]=useState(false);
 const[filter,setFilter]=useState<typeof SMART_MONEY_FILTERS[number]>("all");
 const[detail,setDetail]=useState<any|null>(null);
 const[detailBusy,setDetailBusy]=useState(false);
 const[actionBusy,setActionBusy]=useState("");
 const[actionMsg,setActionMsg]=useState("");
 useEffect(()=>{let live=true;apiFetch<any>("/v1/smart-wallets",{},false).then(x=>{if(live){setWallets(x.wallets||[]);setDegraded(Boolean(x.pipelineDegraded))}}).catch(()=>{if(live)setWallets([])});return()=>{live=false}},[]);
 const ranked=useMemo(()=>[...(wallets||[])].sort((a,b)=>{
  const stage=(x:any)=>x.stage==="PROVEN"?4:x.stage==="PAPER_TRACKING"?3:x.stage==="ANALYZING"?2:1;
  const rec=(x:any)=>x.lastActivityAt?Math.max(0,72-(Date.now()-new Date(x.lastActivityAt).getTime())/3600000):0;
  return (stage(b)*1000+n(b.skillScore)*5+n(b.currentFormScore)*3+n(b.copyabilityScore)*2+rec(b))-(stage(a)*1000+n(a.skillScore)*5+n(a.currentFormScore)*3+n(a.copyabilityScore)*2+rec(a));
 }),[wallets]);
 const rows=useMemo(()=>{
  const now=Date.now();
  if(filter==="whales")return ranked.filter(w=>w.isWhale);
  if(filter==="picks")return ranked.filter(w=>w.source==="MEMECLOUD_CURATED"||w.sourceLabel==="MemeCloud Pick");
  if(filter==="elite")return ranked.filter(w=>w.intelligenceTier==="ELITE");
  if(filter==="proven")return ranked.filter(w=>w.stage==="PROVEN");
  if(filter==="copyable")return ranked.filter(w=>w.copyEligible);
  if(filter==="platform")return ranked.filter(w=>w.source==="PLATFORM_ADDED"||w.sourceLabel==="Platform Added");
  if(filter==="verifying")return ranked.filter(w=>w.stage==="PAPER_TRACKING"||w.stage==="ANALYZING");
  if(filter==="cooling")return ranked.filter(w=>w.lastActivityAt&&now-new Date(w.lastActivityAt).getTime()>=7*24*3600_000);
  if(filter==="new")return ranked.filter(w=>now-new Date(w.firstDiscoveredAt).getTime()<24*3600_000);
  if(filter==="hot")return ranked.filter(w=>w.lastActivityAt&&now-new Date(w.lastActivityAt).getTime()<24*3600_000&&(n(w.currentFormScore)>=55||n(w.copyabilityScore)>=65));
  return ranked;
 },[ranked,filter]);
 async function open(id:string){setDetailBusy(true);setActionMsg("");try{setDetail(await apiFetch<any>(`/v1/smart-wallets/${id}`,{},false))}catch(e){setActionMsg(plainError(e))}finally{setDetailBusy(false)}}
 async function setMode(mode:"WATCH_ONLY"|"AUTO_COPY"){
  const traderId=detail?.wallet?.traderId;
  if(!traderId){setActionMsg(mode==="AUTO_COPY"?"This wallet is still being verified. Auto Copy unlocks only after MemeCloud proves its edge.":"Watch is not available for this wallet yet.");return}
  setActionBusy(mode);setActionMsg("");
  try{await apiFetch(`/v1/me/traders/${traderId}`,{method:"PUT",body:JSON.stringify({mode})});setActionMsg(mode==="AUTO_COPY"?"Auto Copy enabled for future eligible trades.":"Wallet added to your watchlist.")}catch(e){setActionMsg(plainError(e))}finally{setActionBusy("")}
 }
 return <>
  <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 12px"}}>MemeCloud hunts wallets with repeat meme-trading edge — not merely large balances. Proven wallets are ranked by realized results, current form, activity, entry quality and copyability. Whale size is shown separately from skill.</p>
  {degraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Wallet intelligence is temporarily delayed. Existing evidence stays visible, but MemeCloud will not pretend stale scoring is live.</div>}
  <div className="config-tabs discover-tabs">{SMART_MONEY_FILTERS.map(f=><button key={f} className={filter===f?"active":""} onClick={()=>setFilter(f)}>{f==="whales"&&<Wallet size={13} style={{verticalAlign:"middle",marginRight:5}}/>}{smartMoneyFilterLabel(f)}</button>)}</div>
  {wallets===null?<div className="loading" style={{minHeight:180}}>Loading…</div>:rows.length?<div className="token-list">{rows.map(w=>
   <div className="token-row" key={w.id} onClick={()=>open(w.id)}>
    <TokenAvatar symbol={w.address.slice(0,2)}/>
    <div className="token-row-main"><b style={{wordBreak:"break-all"}}>{w.address}</b><small>{w.sourceLabel||"Platform Tracked"} · {evidenceLabel(w)} · {activityLabel(w)}{w.isWhale?` · 🐋 ${w.whaleTier?.replace("WHALE_","")||"Whale"}`:""}</small><small>{n(w.sampleTrades)} trades · {n(w.distinctTokens30d)} tokens tracked{w.realizedPnl7dUsd!=null?` · 7D ${money(w.realizedPnl7dUsd)}`:""}</small></div>
    <div className="token-row-side"><span className={`status-badge ${w.stage==="PROVEN"?"":"watch"}`}>{w.winRatePct!=null?`${Math.round(w.winRatePct)}% win`:evidenceLabel(w)}</span><small>{w.stage==="PROVEN"?`Skill ${Math.round(n(w.skillScore,w.copyabilityScore))}`:`Evidence ${Math.round(n(w.evidenceCompleteness))}%`}</small></div>
   </div>)}</div>:<Empty icon={Users} title={degraded?"Wallet intelligence is delayed":"No qualified smart wallets yet"} body={degraded?"Scoring will resume automatically when providers recover.":"MemeCloud is hunting repeat profitable meme traders and whales from real chain activity. It does not manufacture a smart-wallet list from one lucky trade."}/>} 
  {(detail||detailBusy)&&<div className="wallet-chooser-wrap" onClick={()=>setDetail(null)}><div className="wallet-chooser-sheet" onClick={e=>e.stopPropagation()}>
   <div className="wallet-chooser-handle"/><div className="wallet-chooser-head"><b style={{wordBreak:"break-all",fontSize:11}}>{detailBusy&&!detail?"Loading…":detail?.wallet.address}</b><button type="button" className="wallet-chooser-close" onClick={()=>setDetail(null)} aria-label="Close"><X size={16}/></button></div>
   {detail&&<>
    <p style={{fontSize:12,color:"#9a9fb0"}}>{evidenceLabel(detail.wallet)} · {activityLabel(detail.wallet)} · discovered {timeAgo(detail.wallet.firstDiscoveredAt)}{detail.wallet.isWhale?` · 🐋 ${detail.wallet.whaleTier?.replace("WHALE_","")||"Whale"}`:""}</p>
    {detail.wallet.chain==="SOLANA"&&<a className="soft-action" style={{display:"inline-flex",margin:"0 0 12px",textDecoration:"none"}} href={`https://solscan.io/account/${detail.wallet.address}`} target="_blank" rel="noreferrer">Verify full wallet on-chain</a>}
    <div className="review-grid" style={{marginBottom:12}}>
     <div><span>30D realized</span><b className={n(detail.wallet.realizedPnlUsd)>=0?"positive":"negative"}>{money(detail.wallet.realizedPnlUsd)}</b></div>
     <div><span>7D realized</span><b className={detail.wallet.realizedPnl7dUsd==null?"":n(detail.wallet.realizedPnl7dUsd)>=0?"positive":"negative"}>{detail.wallet.realizedPnl7dUsd==null?"Collecting data":money(detail.wallet.realizedPnl7dUsd)}</b></div>
     <div><span>Win rate</span><b>{detail.wallet.winRatePct!=null?`${Math.round(detail.wallet.winRatePct)}%`:"Collecting data"}</b></div>
     <div><span>Current form</span><b>{Math.round(n(detail.wallet.currentFormScore))}/100</b></div>
     <div><span>90D realized</span><b className={detail.wallet.performance90d?"":""}>{detail.wallet.performance90d?money(detail.wallet.performance90d.realizedPnlUsd):"Not enough 90D history"}</b></div>
    </div>
    <div className="control-list" style={{marginBottom:12}}>
     <div><span><TrendingUp size={13}/> Skill score</span><b>{Math.round(n(detail.wallet.skillScore,detail.wallet.copyabilityScore))}/100</b></div>
     <div><span><Activity size={13}/> Trades observed</span><b>{n(detail.wallet.sampleTrades)}</b></div>
     <div><span>Distinct tokens (30D)</span><b>{n(detail.wallet.distinctTokens30d)}</b></div>
     <div><span>Volume observed</span><b>{money(detail.wallet.volumeUsd)}</b></div>
     {detail.wallet.isWhale&&<div><span>Observed wallet size</span><b>{detail.wallet.walletBalanceUsd!=null?money(detail.wallet.walletBalanceUsd):detail.wallet.whaleTier?.replace("WHALE_","")||"Whale"}</b></div>}
     <div><span>Forward hit rate</span><b>{detail.wallet.forwardHitRatePct!=null?`${Math.round(detail.wallet.forwardHitRatePct)}%`:"Collecting data"}</b></div>
     <div><span>Average copy chase</span><b>{detail.wallet.averageChasePct!=null?`${Number(detail.wallet.averageChasePct).toFixed(1)}%`:"Collecting data"}</b></div>
     <div><span>Evidence completeness</span><b>{Math.round(n(detail.wallet.evidenceCompleteness))}%</b></div>
     <div><span>Risk evidence</span><b>{Math.round(n(detail.wallet.riskEvidenceCompleteness))}%</b></div>
    </div>
    {detail.wallet.discoveryReason&&<div className="notice" style={{marginBottom:12}}><b>Why MemeCloud found this wallet</b><div style={{fontSize:11,marginTop:5}}>{detail.wallet.discoveryReason}</div></div>}
    {detail.relationships?.length>0&&<><b style={{fontSize:11}}>Wallet-token relationships</b><div className="list" style={{margin:"8px 0 14px"}}>{detail.relationships.slice(0,8).map((t:any,i:number)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={i}><div><b>{t.token?.symbol||t.token?.name||`${t.mint.slice(0,8)}…`}</b><small>{t.state.replaceAll("_"," ")} · {t.netFlowUsd?money(t.netFlowUsd):"amount pending"} · {timeAgo(t.latestActivityAt)}</small><small>{t.holdingVerification==="LAST_OBSERVED_TRANSACTION_BALANCE"?`Last observed balance at ${timeAgo(t.balanceObservedAt)}`:"Current holding verification pending"}</small></div><div style={{textAlign:"right"}}><small>{t.remainingPct!=null?`${t.remainingPct.toFixed(0)}% after last sell`:""}</small><small>{t.token?.liquidityUsd?`Liq ${money(t.token.liquidityUsd)}`:""}</small></div></div>)}</div></>}
    <div style={{display:"flex",gap:8,marginTop:8}}>
     <button className="soft-action" style={{flex:1}} disabled={Boolean(actionBusy)} onClick={()=>setMode("WATCH_ONLY")}><Eye size={14}/> {actionBusy==="WATCH_ONLY"?"Adding…":"Watch"}</button>
     <button className="action-primary" style={{flex:1}} disabled={Boolean(actionBusy)||!detail.wallet.copyEligible} onClick={()=>setMode("AUTO_COPY")}><Zap size={14}/> {detail.wallet.copyEligible?(actionBusy==="AUTO_COPY"?"Enabling…":"Auto Copy"):"Copy after proven"}</button>
    </div>
    {actionMsg&&<div className="notice" style={{marginTop:10}}>{actionMsg}</div>}
   </>}
  </div></div>}
 </>;
}
