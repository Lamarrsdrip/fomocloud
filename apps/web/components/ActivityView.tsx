import {Activity,ShieldCheck,WalletCards} from "lucide-react";
import {timeAgo,decisionActionLabel} from "../lib/format";
import {Empty} from "./Empty";

export default function ActivityView({activity,trades}:{activity:any;trades:any[]}){
 const items=[...(activity?.events||[])]; const decisions=activity?.decisions||[];
 return <>
 <div className="app-two">
  <section className="app-card"><div className="card-title"><div><span>YOUR ACCOUNT ONLY</span><h2>Activity history</h2></div></div>
   {items.length?<div className="list">{items.map((e:any)=><div className="list-row" key={e.id}><div><b>{e.title}</b><small>{e.body||e.type}</small></div><span>{e.type.replaceAll("_"," ")}</span><span>{timeAgo(e.createdAt)}</span><strong>›</strong></div>)}</div>:<Empty icon={Activity} title="Nothing has happened yet" body="Source signals, copies, skips, pullback waits and profit events will appear here for this account only."/>}
  </section>
  <section className="app-card"><div className="card-title"><div><span>DECISION HISTORY</span><h2>Why we copied or waited</h2></div></div>
   {decisions.length?<div className="list">{decisions.map((d:any)=><div className="decision-history" key={d.id}><div><b>{d.signal?.trader?.displayName||"Trader signal"} · {d.signal?.action}</b><small>{d.explanation||d.plainReason||d.reason||"Decision recorded"}</small></div><div className="decision-facts"><span>{decisionActionLabel(d.action)}</span>{d.walletChasePct!=null&&<span>Wallet chase {Number(d.walletChasePct).toFixed(1)}%</span>}<span>{timeAgo(d.createdAt)}</span></div></div>)}</div>:<Empty icon={ShieldCheck} title="No decisions yet" body="Every source signal creates a decision for your account only after your own settings are applied."/>}
  </section>
 </div>
 <section className="app-card" style={{marginTop:12}}><div className="card-title"><div><span>TRADE HISTORY</span><h2>Your orders and confirmations</h2></div></div>
  {trades.length?<div className="list">{trades.map((o:any)=><div className="trade-history-row" key={o.id}><div><b>{o.decision?.signal?.trader?.displayName||"Copied trade"} · {o.side}</b><small>{o.chain} · {o.venue||"Route pending"} · {o.mode}</small></div><span className="sim-badge">{o.status}</span><span>{o.txHash?`${o.txHash.slice(0,8)}…`:o.mode==="SIMULATION"?"No live tx":"Awaiting tx"}</span><span>{timeAgo(o.createdAt)}</span></div>)}</div>:<Empty icon={WalletCards} title="No trade history yet" body="Confirmed live orders and clearly labeled simulations for this account appear here. A quote alone never counts as a completed live trade."/>}
 </section>
 </>
}
