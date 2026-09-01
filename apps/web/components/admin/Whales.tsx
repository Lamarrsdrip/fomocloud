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
const SMART_MONEY_VIEWS=["ALL","CURATED_TRADERS","MEME_WHALES","SMART_DEGENS","PROVEN","ELITE","ANALYZING","DISCOVERED","WATCHLIST","COOLING_REJECTED"] as const;
function smartMoneyViewLabel(v:string){return v.replaceAll("_"," ")}
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
 const[form,setForm]=useState<any>({chain:"SOLANA",address:"",label:"",additionType:"MANUAL_REVIEW",designation:"NORMAL_WATCH",researchSource:"",researchReason:"",researchNotes:""});
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
  if(stage==="CURATED_TRADERS")return ["MEMECLOUD_CURATED","PLATFORM_ADDED"].includes(c.source);
  if(stage==="MEME_WHALES")return c.isMemeWhale;
  if(stage==="SMART_DEGENS")return c.isSmartDegen;
  if(stage==="ELITE")return c.stage==="PROVEN"&&Number(c.skillScore)>=90&&Number(c.riskScore)<=30&&Number(c.evidenceCompleteness)>=85;
  if(stage==="ANALYZING")return c.stage==="ANALYZING"||c.stage==="PAPER_TRACKING";
  if(stage==="WATCHLIST")return Boolean(c.adminWatched);
  if(stage==="COOLING_REJECTED")return c.stage==="REJECTED"||c.stage==="PAUSED"||(c.lastActivityAt&&now-new Date(c.lastActivityAt).getTime()>=7*24*3600_000);
  return c.stage===stage;
 });
 async function decide(id:string,action:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}/decision`,{method:"POST",body:JSON.stringify({action})});reload()}catch(e){setErr(plainError(e))}}
 async function relabel(id:string,label:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}`,{method:"PATCH",body:JSON.stringify({label})});reload()}catch(e){setErr(plainError(e))}}
 async function add(e:React.FormEvent){e.preventDefault();setErr("");try{await apiFetch("/v1/admin/discovery/candidates",{method:"POST",body:JSON.stringify(form)});setOpen(false);setForm({chain:"SOLANA",address:"",label:"",additionType:"MANUAL_REVIEW",designation:"NORMAL_WATCH",researchSource:"",researchReason:"",researchNotes:""});reload()}catch(e){setErr(plainError(e))}}
 return <>
  {d.pipelineDegraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Scoring hasn't run in {d.dataFreshnessSec!=null?`${Math.round(d.dataFreshnessSec/60)} min`:"a while"} -- check scoring-worker's heartbeat under Health. Existing rows below are real, just aging.</div>}
  {admin&&<div style={{display:"flex",gap:8,marginBottom:12}}><button className="soft-action" onClick={()=>{setForm((x:any)=>({...x,additionType:"MANUAL_REVIEW",designation:"NORMAL_WATCH"}));setOpen(true)}}><Plus size={13}/> Add wallet manually</button><button className="action-primary" style={{padding:"10px 13px",borderRadius:12}} onClick={()=>{setForm((x:any)=>({...x,additionType:"PLATFORM_TRADER",designation:"MEMECLOUD_PICK"}));setOpen(true)}}><Plus size={13}/> Add platform trader</button></div>}
  {open&&<section className="app-card" style={{marginBottom:10}}><form className="form-grid" onSubmit={add}><div className="span2 notice"><b>{form.additionType==="PLATFORM_TRADER"?"Priority platform research":"Objective wallet evaluation"}</b><div style={{fontSize:10,marginTop:4}}>{form.additionType==="PLATFORM_TRADER"?"Provenance raises monitoring priority only. It cannot manufacture Proven or Elite status.":"MemeCloud reconstructs and scores this wallet. Manual submission does not imply quality."}</div></div><label className="field"><span>Chain</span><select value={form.chain} onChange={e=>setForm({...form,chain:e.target.value})}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select></label><label className="field span2"><span>Wallet address</span><input value={form.address} onChange={e=>setForm({...form,address:e.target.value})} required/></label><label className="field"><span>Label</span><input value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/></label><label className="field"><span>Monitoring designation</span><select value={form.designation} onChange={e=>setForm({...form,designation:e.target.value})}><option value="NORMAL_WATCH">Normal Watch</option><option value="MEMECLOUD_PICK">MemeCloud Pick / Curated</option><option value="PRIORITY_WATCH">Priority Watch</option><option value="ADMIN_APPROVED">Admin Approved</option></select></label>{form.additionType==="PLATFORM_TRADER"&&<><label className="field"><span>Research source</span><input value={form.researchSource} onChange={e=>setForm({...form,researchSource:e.target.value})} placeholder="Pump.fun leaderboard / analyst" required/></label><label className="field span2"><span>Research reason</span><textarea value={form.researchReason} onChange={e=>setForm({...form,researchReason:e.target.value})} required/></label><label className="field span2"><span>Research notes (optional)</span><textarea value={form.researchNotes} onChange={e=>setForm({...form,researchNotes:e.target.value})}/></label></>}{err&&<div className="auth-error span2">{err}</div>}<button className="action-primary span2" style={{height:42,borderRadius:12}}>Save for monitoring &amp; objective scoring</button></form></section>}
  <div className="config-tabs" style={{marginBottom:12}}>{SMART_MONEY_VIEWS.map(s=><button key={s} className={stage===s?"active":""} onClick={()=>setStage(s)}>{smartMoneyViewLabel(s)}</button>)}</div>
  {stage==="WATCHLIST"&&<AdminAlerts/>}
  <section className="app-card admin-table-wrap"><table className="admin-table"><thead><tr><th>Wallet / provenance</th><th>Type / stage</th><th>Skill</th><th>Capital</th><th>7D / 30D / 90D</th><th>Win / trades</th><th>Position evidence</th><th>Activity / provider</th><th>Action</th></tr></thead><tbody>{rows.map((c:any)=><React.Fragment key={c.id}><tr><td><b>{c.label||`${c.address.slice(0,6)}…${c.address.slice(-5)}`}</b><small style={{display:"block"}} title={c.address}>{c.address}</small><small>{c.source}{c.researchSource?` · ${c.researchSource}`:c.researchProvenanceStatus==="UNKNOWN_LEGACY_SOURCE"?" · source unknown (legacy)":""}</small></td><td><span className="status-badge">{String(c.walletType).replaceAll("_"," ")}</span><small style={{display:"block"}}>{c.stage.replaceAll("_"," ")}{c.adminDesignation?` · ${c.adminDesignation.replaceAll("_"," ")}`:""}</small></td><td>{Math.round(c.skillScore??c.copyabilityScore??0)}<small style={{display:"block"}}>Risk {Math.round(c.riskScore)} · evidence {Math.round(c.evidenceCompleteness??0)}%</small></td><td>{c.capitalScore??0}/100<small style={{display:"block"}}>{c.isMemeWhale?"Verified meme whale":"Capital ≠ skill"}</small></td><td><span className={c.realizedPnl7dUsd>=0?"positive":"negative"}>{c.realizedPnl7dUsd==null?"7D unknown":money(c.realizedPnl7dUsd)}</span><small style={{display:"block"}}>30D {money(c.realizedPnlUsd)} · 90D {c.performance90d?money(c.performance90d.realizedPnlUsd):"unknown"}</small></td><td>{winRatePct(c)==null?"Unknown":`${winRatePct(c)}%`}<small style={{display:"block"}}>{c.sampleTrades} closed/tracked</small></td><td>{c.typicalMemePositionUsd?money(c.typicalMemePositionUsd):"Unknown"}<small style={{display:"block"}}>Largest {c.largestMemePositionUsd?money(c.largestMemePositionUsd):"unknown"}</small></td><td>{c.lastActivityAt?timeAgo(c.lastActivityAt):"No real activity yet"}<small style={{display:"block"}}>{c.providerStatus||"Provider unverified"}</small></td><td><div className="table-actions"><button className="soft-action" onClick={()=>toggleActivity(c.id)}>{expandedId===c.id?"Hide":"Evidence"}</button>{admin&&<><button className="soft-action" onClick={()=>decide(c.id,c.adminWatched?"UNWATCH":"WATCH")}>{c.adminWatched?"Unwatch":"Watch"}</button><button className="soft-action" onClick={()=>decide(c.id,"PAUSED")}>Pause</button><button className="soft-action" onClick={()=>decide(c.id,"REJECTED")}>Reject</button></>}</div></td></tr>{expandedId===c.id&&<tr><td colSpan={9}>
   {detail[c.id]==="loading"&&<div className="loading" style={{minHeight:40}}>Loading activity…</div>}
   {detail[c.id]==="error"&&<p style={{fontSize:11,color:"#8a8fa0"}}>Could not load recent activity for this wallet.</p>}
   {detail[c.id]&&detail[c.id]!=="loading"&&detail[c.id]!=="error"&&(()=>{const dd=detail[c.id] as {recentActivity:any[];currentTokens:any[]};return <div style={{display:"grid",gap:10,padding:"8px 2px"}}>
    <div><b style={{fontSize:10,color:"#8a8fa0"}}>TOKEN RELATIONSHIPS — LATEST OBSERVED STATE</b>{dd.currentTokens.length?<div className="list" style={{marginTop:6}}>{dd.currentTokens.map((t:any,i:number)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={i}><div><b>{(t.token?.symbol||t.mint.slice(0,6))} · {(t.state||"OBSERVED").replaceAll("_"," ")}</b><small>{t.holdingVerification?.replaceAll("_"," ")||"Pending current balance verification"}</small></div><span className="status-badge">{timeAgo(t.latestActivityAt||t.lastSeenAt)}</span></div>)}</div>:<p style={{fontSize:11,color:"#8a8fa0",margin:"6px 0 0"}}>No observed token relationships.</p>}</div>
    <div><b style={{fontSize:10,color:"#8a8fa0"}}>RECENT ON-CHAIN ACTIVITY (last {dd.recentActivity.length})</b>{dd.recentActivity.length?<div className="list" style={{marginTop:6}}>{dd.recentActivity.slice(0,15).map((a:any)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={a.id}><div><b>{a.side} {a.mint.slice(0,6)}…{a.mint.slice(-4)}</b><small>{a.amountUsd!=null?money(a.amountUsd):"Amount unavailable"}</small></div><span className="status-badge">{timeAgo(a.observedAt)}</span></div>)}</div>:<p style={{fontSize:11,color:"#8a8fa0",margin:"6px 0 0"}}>No recent on-chain activity observed yet.</p>}</div>
   </div>})()}
  </td></tr>}</React.Fragment>)}{!rows.length&&<tr><td colSpan={9}>No wallets in this view yet.</td></tr>}</tbody></table></section>
 </>
}
