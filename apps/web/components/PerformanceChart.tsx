"use client";
import {useEffect,useState} from "react";
import {apiFetch,money} from "../lib/api";

function PnlSvg({vals}:{vals:number[]}){const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(1e-9,max-min);const pts=vals.map((v,i)=>`${(i/Math.max(1,vals.length-1))*100},${94-((v-min)/span)*78}`).join(" ");return <div className="pnl-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Account value history"><polyline points={pts}/></svg></div>}

export function PerformanceChart({snapshots}:{snapshots:any[]}){
 const[range,setRange]=useState("7D"),[rows,setRows]=useState<any[]>(snapshots||[]),[change,setChange]=useState<number|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{if(range==="7D"&&snapshots?.length&&!rows.length)setRows(snapshots)},[snapshots]);
 async function choose(r:string){setRange(r);setBusy(true);try{const x=await apiFetch<any>(`/v1/me/performance?range=${r}`);setRows(x.points||[]);setChange(Number(x.pnlChangeUsd||0))}catch{}finally{setBusy(false)}}
 const vals=rows.slice(-240).map(x=>Number(x.accountValueUsd||0));
 const last=rows[rows.length-1];
 return <section className="app-card pnl-card"><div className="card-title"><div><span>PERFORMANCE</span><h2>Your live account history</h2></div><div className="performance-tabs">{["1D","7D","30D","ALL"].map(r=><button key={r} className={range===r?"active":""} onClick={()=>choose(r)}>{r}</button>)}</div></div>
  {!vals.length?<div className="pnl-empty">Your real account-value chart starts after the analytics worker records genuine live balance/position snapshots. Simulation results are kept separate.</div>:<><div className="performance-summary"><b className={(change??last?.netPnlUsd??0)>=0?"positive":"negative"}>{change===null?money(last?.netPnlUsd):`${change>=0?"+":""}${money(change)}`}</b><small>{change===null?"Current live net P&L":`${range} change in cumulative live P&L`}{busy?" · refreshing…":""}</small></div><PnlSvg vals={vals}/><div className="pnl-meta"><span>{rows.length} snapshot point(s)</span><span>Live P&amp;L only · simulation excluded</span></div></>}
 </section>
}
