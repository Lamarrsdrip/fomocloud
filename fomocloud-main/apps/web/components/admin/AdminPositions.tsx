"use client";
import {useState} from "react";
import {money} from "../../lib/api";

export function AdminPositions({d}:{d:any}){
 const[filter,setFilter]=useState("ALL");
 const rows=(d.positions||[]).filter((p:any)=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");
 return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>ALL USERS</span><h2>Open &amp; closed positions</h2></div><div className="performance-tabs">{["ALL","OPEN","CLOSED"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>
  <table className="admin-table"><thead><tr><th>User</th><th>Token</th><th>Chain</th><th>Mode</th><th>Status</th><th>Cost</th><th>Unrealized</th><th>Realized</th><th>Recovery</th><th>Opened</th></tr></thead><tbody>{rows.map((p:any)=>{const recovered=(p.profitTakenUsd||0)>=(p.costUsd||0)&&(p.costUsd||0)>0;return <tr key={p.id}><td>{p.user?.email||p.user?.displayName||p.userId.slice(-6)}</td><td><small>{p.mint.slice(0,8)}…</small></td><td>{p.chain}</td><td>{p.mode}</td><td>{String(p.status).replaceAll("_"," ")}</td><td>{money(p.costUsd)}</td><td className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)}</td><td className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</td><td>{p.status!=="CLOSED"?(recovered?"✓ Recovered":"Not yet"):"—"}</td><td>{new Date(p.openedAt).toLocaleString()}</td></tr>})}{!rows.length&&<tr><td colSpan={10}>No positions in this filter.</td></tr>}</tbody></table>
 </section>
}
