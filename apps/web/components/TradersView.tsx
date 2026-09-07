"use client";
import {useEffect,useState} from "react";
import {apiFetch,money,pct,plainError} from "../lib/api";
import {initials} from "../lib/format";

const hint={fontSize:12,color:"#8a8fa0",lineHeight:1.5} as const;
const grid={display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))",gap:10} as const;
export default function TradersView({reload}:{platform:any[];follows:any[];followMap:Map<string,any>;setMode:(id:string,m:string)=>void;customOpen:boolean;setCustomOpen:(v:boolean)=>void;reload:()=>Promise<void>}){
 const[rows,setRows]=useState<any[]>([]),[err,setErr]=useState(""),[open,setOpen]=useState<string|null>(null),[draft,setDraft]=useState<any>({});
 async function load(){try{const r=await apiFetch<any>("/v1/curated/traders");setRows(r.traders||[])}catch(e){setErr(plainError(e))}}
 useEffect(()=>{void load()},[]);
 async function update(t:any,payload:any){try{setErr("");await apiFetch(`/v1/me/traders/${t.id}`,{method:"PUT",body:JSON.stringify(payload)});await Promise.all([load(),reload()])}catch(e){setErr(plainError(e))}}
 async function mode(t:any,m:string){await update(t,{mode:m})}
 function edit(t:any){setOpen(open===t.id?null:t.id);setDraft({...t.follow,useCustomSettings:t.follow?.useCustomSettings??false,sizingMode:t.follow?.sizingMode??"PERCENT",percentBalance:t.follow?.percentBalance??2,fixedAmountUsd:t.follow?.fixedAmountUsd??100,takeProfitMode:t.follow?.takeProfitMode??"SIMPLE",simpleTakeProfitPct:t.follow?.simpleTakeProfitPct??100,simpleSellPct:t.follow?.simpleSellPct??100,tp1Pct:t.follow?.tp1Pct??50,tp1SellPct:t.follow?.tp1SellPct??25,tp2Pct:t.follow?.tp2Pct??100,tp2SellPct:t.follow?.tp2SellPct??25,tp3Pct:t.follow?.tp3Pct??200,tp3SellPct:t.follow?.tp3SellPct??25,runnerPct:t.follow?.runnerPct??25,capitalRecoveryEnabled:t.follow?.capitalRecoveryEnabled??true,capitalRecoveryTriggerPct:t.follow?.capitalRecoveryTriggerPct??100,trailingEnabled:t.follow?.trailingEnabled??false,trailingActivationPct:t.follow?.trailingActivationPct??80,trailingGivebackPct:t.follow?.trailingGivebackPct??20,sourceSellBehavior:t.follow?.sourceSellBehavior??"BRAIN_DECIDES",scalperCopyEnabled:t.follow?.scalperCopyEnabled??false,maxSlippageBps:t.follow?.maxSlippageBps??1500,maxConcurrentFromTrader:t.follow?.maxConcurrentFromTrader??0})}
 const set=(k:string,v:any)=>setDraft((d:any)=>({...d,[k]:v}));
 const n=(k:string,label:string,min=0)=><label className="field"><span>{label}</span><input type="number" min={min} step="0.1" value={draft[k]??""} onChange={e=>set(k,Number(e.target.value))}/></label>;
 return <>{err&&<div className="auth-error">{err}</div>}
 <section className="app-card"><div className="card-title"><div><span>TRADERS</span><h2>Choose who you trust</h2></div></div><p style={hint}>Only traders and wallets added by MemeCloud Admin appear here. Performance uses verified economic swaps only; transfers and airdrops do not count.</p></section>
 <div className="trader-grid">{rows.map(t=><article className="trader-card" key={t.id}>
  <div className="trader-head"><div className="avatar">{initials(t.displayName)}</div><div><b>{t.displayName}</b><small>@{t.handle}</small></div></div>
  <div className="trader-meta"><div><span>30D RETURN</span><b>{pct(t.performance.d30.returnPct)}</b></div><div><span>WIN RATE</span><b>{t.performance.d30.closed?`${Math.round(t.performance.d30.wins/t.performance.d30.closed*100)}%`:"Building"}</b></div><div><span>30D PNL</span><b>{money(t.performance.d30.pnlUsd)}</b></div><div><span>VERIFIED TRADES</span><b>{t.performance.d30.trades}</b></div></div>
  <small style={{overflowWrap:"anywhere"}}>{t.wallets[0]?.address}</small>
  <div className="trader-actions"><button className={t.follow?.mode==="FOLLOW_ONLY"?"active":""} onClick={()=>mode(t,"FOLLOW_ONLY")}>Follow</button><button className={t.follow?.mode==="WATCH_ONLY"?"active":""} onClick={()=>mode(t,"WATCH_ONLY")}>Alerts</button><button className={t.follow?.mode==="AUTO_COPY"?"active":""} onClick={()=>mode(t,"AUTO_COPY")}>Auto Copy</button></div>
  {t.follow?.mode==="AUTO_COPY"&&<button className="action-secondary" onClick={()=>edit(t)}>{open===t.id?"Close settings":"Customize copy"}</button>}
  {open===t.id&&<div className="app-card" style={{marginTop:12}}>
    <div className="card-title"><div><span>THIS TRADER</span><h3>Copy settings</h3></div><button className={`switch ${draft.useCustomSettings?"on":""}`} onClick={()=>set("useCustomSettings",!draft.useCustomSettings)}><i/></button></div>
    {!draft.useCustomSettings?<p style={hint}>This trader inherits your Global Brain trading settings exactly.</p>:<>
      <div className="config-tabs"><button className={draft.sizingMode!=="FIXED"?"active":""} onClick={()=>set("sizingMode","PERCENT")}>% balance</button><button className={draft.sizingMode==="FIXED"?"active":""} onClick={()=>set("sizingMode","FIXED")}>Fixed $</button></div>
      <div style={grid}>{draft.sizingMode==="FIXED"?n("fixedAmountUsd","Trade amount ($)",1):n("percentBalance","Balance per entry (%)",.01)}{n("maxConcurrentFromTrader","Max open from trader",0)}{n("maxSlippageBps","Max slippage (bps)",1)}</div>
      <label className="field"><span>Profit mode</span><select value={draft.takeProfitMode} onChange={e=>set("takeProfitMode",e.target.value)}><option value="SIMPLE">Simple target</option><option value="ADVANCED">TP1 / TP2 / TP3</option></select></label>
      {draft.takeProfitMode==="ADVANCED"?<div style={grid}>{n("tp1Pct","TP1 +%",.01)}{n("tp1SellPct","TP1 sell %",.01)}{n("tp2Pct","TP2 +%",.01)}{n("tp2SellPct","TP2 sell %",.01)}{n("tp3Pct","TP3 +%",.01)}{n("tp3SellPct","TP3 sell %",.01)}{n("runnerPct","Runner %",0)}</div>:<div style={grid}>{n("simpleTakeProfitPct","Take profit +%",.01)}{n("simpleSellPct","Sell %",.01)}</div>}
      <div className="control-list"><div><span>Recover capital</span><button className={`switch ${draft.capitalRecoveryEnabled?"on":""}`} onClick={()=>set("capitalRecoveryEnabled",!draft.capitalRecoveryEnabled)}><i/></button></div>{draft.capitalRecoveryEnabled&&<div>{n("capitalRecoveryTriggerPct","Trigger +%",.01)}</div>}<div><span>Trailing profit</span><button className={`switch ${draft.trailingEnabled?"on":""}`} onClick={()=>set("trailingEnabled",!draft.trailingEnabled)}><i/></button></div>{draft.trailingEnabled&&<div style={grid}>{n("trailingActivationPct","Activate +%",.01)}{n("trailingGivebackPct","Giveback %",.1)}</div>}</div>
      <label className="field"><span>When this trader sells</span><select value={draft.sourceSellBehavior} onChange={e=>set("sourceSellBehavior",e.target.value)}><option value="BRAIN_DECIDES">Brain decides</option><option value="PROPORTIONAL">Follow proportionally</option><option value="FULL_EXIT_ONLY">Only full exit</option><option value="IGNORE">Ignore source sells</option></select></label>
      <div className="card-title"><div><b>Scalper Copy</b><small style={{display:"block"}}>Advanced opt-in for rapid round-trips. Fees, latency and slippage can differ materially.</small></div><button className={`switch ${draft.scalperCopyEnabled?"on":""}`} onClick={()=>set("scalperCopyEnabled",!draft.scalperCopyEnabled)}><i/></button></div>
    </>}
    <button className="action-primary" onClick={()=>update(t,{...draft,mode:"AUTO_COPY"})}>Save trader settings</button>
  </div>}
 </article>)}</div>
 {!rows.length&&<section className="app-card"><h3>No Admin traders yet</h3><p style={hint}>Once Admin adds and enables a verified Solana trader wallet, it appears here automatically.</p></section>}
 </>;
}
