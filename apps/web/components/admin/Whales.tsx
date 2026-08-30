"use client";
import React,{useEffect,useState} from "react";
import {Plus,RefreshCw} from "lucide-react";
import {apiFetch,plainError,money} from "../../lib/api";
import {timeAgo} from "../../lib/format";

// Real gap found by forensic audit (M-11/PC-C): the spec calls for FOUND TODAY / ACTIVE NOW /
// WATCHLIST as real sections of the Smart Money desk, distinct from the pipeline stage tabs
// (DISCOVERED/PAPER_TRACKING/PROVEN/...). These are client-side views over the same already-loaded
// candidate list -- WATCHLIST is adminWatched (fix from the prior watchlist commit), FOUND TODAY and
// ACTIVE NOW are real time-based filters, not new data.
const SMART_MONEY_VIEWS=["ALL","FOUND_TODAY","ACTIVE_NOW","WATCHLIST","DISCOVERED","PAPER_TRACKING","PROVEN","REJECTED","PAUSED"] as const;
function smartMoneyViewLabel(v:string){return v==="FOUND_TODAY"?"Found today":v==="ACTIVE_NOW"?"Active now":v==="WATCHLIST"?"Watchlist":v.replaceAll("_"," ")}
function winRatePct(c:any){return c.sampleTrades?Math.round((c.profitableTrades/c.sampleTrades)*100):null}

// Real gap found by forensic audit (M-12/PC-D): GET/POST /v1/admin/alerts and the whole
// checkWatchlist() backend (brain-worker, 10s interval) that generates "watched wallet entered
// TOKEN" alerts had zero frontend surface -- admin could WATCH a wallet and the backend would
// genuinely keep monitoring it, but there was nowhere to actually see what it found.
function AdminAlerts(){
 const[alerts,setAlerts]=useState<any[]|null>(null);
 const[err,setErr]=useState("");
 async function load(){try{const x=await apiFetch<any>("/v1/admin/alerts?unresolved=true");setAlerts(x.alerts||[])}catch(e){setErr(plainError(e))}}
 useEffect(()=>{void load()},[]);
 async function resolve(id:string){try{await apiFetch(`/v1/admin/alerts/${id}/resolve`,{method:"POST"});void load()}catch(e){setErr(plainError(e))}}
 return <section className="app-card" style={{marginTop:12}}>
  <div className="card-title"><div><span>WATCHLIST ALERTS</span><h2>What watched wallets just did</h2></div><button className="soft-action" onClick={load}><RefreshCw size={12}/> Refresh</button></div>
  {err&&<div className="auth-error">{err}</div>}
  {alerts===null?<div className="loading" style={{minHeight:80}}>Loading…</div>:alerts.length?<div className="list">{alerts.map(a=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={a.id}><div><b>{a.message}</b><small>{a.chain} · {timeAgo(a.createdAt)}</small></div><button className="soft-action" onClick={()=>resolve(a.id)}>Resolve</button></div>)}</div>:<p style={{fontSize:11,color:"#8a8fa0"}}>No unresolved alerts. Watch a wallet below and alerts appear here automatically when it buys -- monitoring runs continuously in the background, no need to keep this page open.</p>}
 </section>;
}

export function Whales({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){
 const[stage,setStage]=useState<typeof SMART_MONEY_VIEWS[number]>("ALL");
 const[open,setOpen]=useState(false);
 const[form,setForm]=useState<any>({chain:"SOLANA",address:"",label:""});
 const[err,setErr]=useState("");
 const[expandedId,setExpandedId]=useState<string|null>(null);
 const[detail,setDetail]=useState<Record<string,{recentActivity:any[];currentTokens:any[]}|"loading"|"error">>({});
 const now=Date.now();
 async function toggleActivity(id:string){
  if(expandedId===id){setExpandedId(null);return}
  setExpandedId(id);
  if(detail[id]&&detail[id]!=="error")return;
  setDetail(x=>({...x,[id]:"loading"}));
  try{
   const r=await apiFetch<any>(`/v1/smart-wallets/${id}`);
   setDetail(x=>({...x,[id]:{recentActivity:r.recentActivity||[],currentTokens:r.currentTokens||[]}}));
  }catch{
   setDetail(x=>({...x,[id]:"error"}));
  }
 }
 const rows=(d.candidates||[]).filter((c:any)=>{
  if(stage==="ALL")return true;
  if(stage==="FOUND_TODAY")return now-new Date(c.createdAt).getTime()<24*3600_000;
  if(stage==="ACTIVE_NOW")return c.lastScoredAt&&now-new Date(c.lastScoredAt).getTime()<3600_000;
  if(stage==="WATCHLIST")return Boolean(c.adminWatched);
  return c.stage===stage;
 });
 async function decide(id:string,action:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}/decision`,{method:"POST",body:JSON.stringify({action})});reload()}catch(e){setErr(plainError(e))}}
 async function relabel(id:string,label:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}`,{method:"PATCH",body:JSON.stringify({label})});reload()}catch(e){setErr(plainError(e))}}
 async function add(e:React.FormEvent){e.preventDefault();setErr("");try{await apiFetch("/v1/admin/discovery/candidates",{method:"POST",body:JSON.stringify(form)});setOpen(false);setForm({chain:"SOLANA",address:"",label:""});reload()}catch(e){setErr(plainError(e))}}
 return <>
  {admin&&<button className="action-primary" style={{padding:"10px 13px",borderRadius:12,marginBottom:12}} onClick={()=>setOpen(!open)}><Plus size={13}/> Add wallet manually</button>}
  {open&&<section className="app-card" style={{marginBottom:10}}><form className="form-grid" onSubmit={add}><label className="field"><span>Chain</span><select value={form.chain} onChange={e=>setForm({...form,chain:e.target.value})}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select></label><label className="field span2"><span>Wallet address</span><input value={form.address} onChange={e=>setForm({...form,address:e.target.value})} required/></label><label className="field"><span>Label (e.g. KOL name)</span><input value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/></label>{err&&<div className="auth-error span2">{err}</div>}<button className="action-primary span2" style={{height:42,borderRadius:12}}>Track wallet</button></form></section>}
  <div className="config-tabs" style={{marginBottom:12}}>{SMART_MONEY_VIEWS.map(s=><button key={s} className={stage===s?"active":""} onClick={()=>setStage(s)}>{smartMoneyViewLabel(s)}</button>)}</div>
  {stage==="WATCHLIST"&&<AdminAlerts/>}
  <section className="app-card admin-table-wrap"><table className="admin-table"><thead><tr><th>Wallet</th><th>Chain</th><th>Label</th><th>Stage</th><th>Copyability</th><th>Win rate</th><th>Risk</th><th>7D P&amp;L</th><th>30D P&amp;L</th><th>Source</th><th>Action</th></tr></thead><tbody>{rows.map((c:any)=><React.Fragment key={c.id}><tr><td><small>{c.address.slice(0,6)}…{c.address.slice(-5)}</small></td><td>{c.chain}</td><td><input defaultValue={c.label||""} placeholder="Add label" disabled={!admin} onBlur={e=>{if(e.target.value!==(c.label||""))relabel(c.id,e.target.value)}} style={{background:"transparent",border:"1px solid var(--line)",borderRadius:8,padding:"4px 7px",color:"inherit",width:110,fontSize:9}}/></td><td><span className="status-badge">{c.stage.replaceAll("_"," ")}</span>{c.adminWatched&&<span className="status-badge" style={{marginLeft:4}}>Watched</span>}</td><td>{Math.round(c.copyabilityScore)}</td><td>{winRatePct(c)==null?"Unknown":`${winRatePct(c)}%`}</td><td>{Math.round(c.riskScore)}</td><td className={c.realizedPnl7dUsd==null?"":(c.realizedPnl7dUsd>=0?"positive":"negative")}>{c.realizedPnl7dUsd==null?"Unknown":money(c.realizedPnl7dUsd)}</td><td className={(c.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(c.realizedPnlUsd)}</td><td>{c.source}</td><td><div className="table-actions"><button className="soft-action" onClick={()=>toggleActivity(c.id)}>{expandedId===c.id?"Hide activity":"View activity"}</button>{admin&&<><button className="soft-action" onClick={()=>decide(c.id,c.adminWatched?"UNWATCH":"WATCH")}>{c.adminWatched?"Unwatch":"Watch"}</button><button className="soft-action" onClick={()=>decide(c.id,"PROVEN")}>Prove</button><button className="soft-action" onClick={()=>decide(c.id,"PAUSED")}>Pause</button><button className="soft-action" onClick={()=>decide(c.id,"REJECTED")}>Reject</button></>}</div></td></tr>{expandedId===c.id&&<tr><td colSpan={11}>
   {detail[c.id]==="loading"&&<div className="loading" style={{minHeight:40}}>Loading activity…</div>}
   {detail[c.id]==="error"&&<p style={{fontSize:11,color:"#8a8fa0"}}>Could not load recent activity for this wallet.</p>}
   {detail[c.id]&&detail[c.id]!=="loading"&&detail[c.id]!=="error"&&(()=>{const dd=detail[c.id] as {recentActivity:any[];currentTokens:any[]};return <div style={{display:"grid",gap:10,padding:"8px 2px"}}>
    <div><b style={{fontSize:10,color:"#8a8fa0"}}>CURRENTLY TRACKED TOKENS</b>{dd.currentTokens.length?<div className="list" style={{marginTop:6}}>{dd.currentTokens.map((t:any,i:number)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={i}><div><b>{t.mint.slice(0,6)}…{t.mint.slice(-4)}</b></div><span className="status-badge">{t.side} · {timeAgo(t.lastSeenAt)}</span></div>)}</div>:<p style={{fontSize:11,color:"#8a8fa0",margin:"6px 0 0"}}>No currently-tracked tokens.</p>}</div>
    <div><b style={{fontSize:10,color:"#8a8fa0"}}>RECENT ON-CHAIN ACTIVITY (last {dd.recentActivity.length})</b>{dd.recentActivity.length?<div className="list" style={{marginTop:6}}>{dd.recentActivity.slice(0,15).map((a:any)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={a.id}><div><b>{a.side} {a.mint.slice(0,6)}…{a.mint.slice(-4)}</b><small>{a.amountUsd!=null?money(a.amountUsd):"Amount unavailable"}</small></div><span className="status-badge">{timeAgo(a.observedAt)}</span></div>)}</div>:<p style={{fontSize:11,color:"#8a8fa0",margin:"6px 0 0"}}>No recent on-chain activity observed yet.</p>}</div>
   </div>})()}
  </td></tr>}</React.Fragment>)}{!rows.length&&<tr><td colSpan={11}>No wallets in this view yet.</td></tr>}</tbody></table></section>
 </>
}
