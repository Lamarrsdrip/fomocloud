"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {WalletCards} from "lucide-react";
import {money,pct} from "../lib/api";
import {timeAgo,positionMath} from "../lib/format";
import {Empty} from "./Empty";
import {PerformanceChart} from "./PerformanceChart";

// Privy's SDK is large (full multi-chain support) even though only its Solana slice is used here
// -- next/dynamic keeps it out of this route's main bundle entirely, fetched only once someone
// actually opens the wallet panel. See the comment at the top of EmbeddedWalletPanel.tsx.
const EmbeddedWalletPanel=dynamic(()=>import("./EmbeddedWalletPanel"),{ssr:false,loading:()=><div className="switch-row"><div><b>MemeCloud wallet</b><small>Loading…</small></div></div>});

function PositionRow({p}:{p:any}){
 const m=positionMath(p);
 const recovered=(p.profitTakenUsd||0)>=(p.costUsd||0)&&(p.costUsd||0)>0;
 return <div className="position-row"><div className="position-main"><div className="position-token"><b>{p.mint?.slice(0,8)}…</b><span className="sim-badge">{p.mode}</span><span className="status-badge">{String(p.status).replaceAll("_"," ")}</span></div><small>{p.sourceTrader?.displayName||"Source trader"} · {p.chain} · opened {timeAgo(p.openedAt)}</small>{p.status!=="CLOSED"&&<small className={recovered?"positive":""}>{recovered?"✓ Principal recovered · runner active":"Principal not recovered"}</small>}</div><div><span>Invested remaining</span><b>{money(m.remainingCost)}</b></div><div><span>Current value</span><b>{p.currentPriceUsd?money(m.currentValue):"Awaiting mark"}</b></div><div><span>Unrealized</span><b className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)} <small>({pct(m.pnlPct)})</small></b></div><div><span>Realized</span><b className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</b></div><div><span>Profit taken</span><b>{money(p.profitTakenUsd)}</b></div></div>}
export default function PositionsView({positions,degraded,d,me,reload}:{positions:any[];degraded:boolean;d:any;me:any;reload:()=>Promise<void>}){
 const[filter,setFilter]=useState("ALL");
 const shown=positions.filter(p=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");
 const s=d?.summary||{};
 const total=s.accountValueUsd??((s.tradingCashUsd||0)+(s.openPositionsValueUsd||0));
 const available=s.availableUsd??s.tradingCashUsd??0;
 const inTrades=s.inTradesUsd??s.openPositionsValueUsd??0;
 return <>
  <section className="app-card" style={{marginBottom:10}}>
   <div className="card-title"><div><span>YOUR MEMECLOUD WALLET</span><h2>One wallet. One balance.</h2></div></div>
   <EmbeddedWalletPanel me={me} reload={reload}/>
  </section>
  {degraded&&<div className="notice" style={{marginBottom:10,borderColor:"rgba(247,185,95,.3)"}}>Live pricing is temporarily delayed. MemeCloud will not invent a balance while pricing is unavailable; position values refresh automatically when the market-data pipeline recovers.</div>}
  <section className="home-hero" style={{marginBottom:10}}>
   <div><span>TOTAL BALANCE</span><h2>{money(total)}</h2></div>
   <div className="home-hero-pnl"><span>OPEN TRADES</span><b>{money(inTrades)}</b></div>
  </section>
  <div className="review-grid" style={{marginBottom:10}}>
   <div><span>Available</span><b>{money(available)}</b></div>
   <div><span>In trades</span><b>{money(inTrades)}</b></div>
  </div>
  <PerformanceChart snapshots={d?.snapshots||[]}/>
  <section className="app-card" style={{marginTop:10}}>
   <div className="card-title"><div><span>POSITIONS</span><h2>Your trades</h2></div><div className="performance-tabs">{["ALL","OPEN","CLOSED"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>
   {shown.length?<div className="positions-list">{shown.map(p=><PositionRow p={p} key={p.id}/>)}</div>:<Empty icon={WalletCards} title={positions.length?"No positions in this filter":"No positions yet"} body={positions.length?"Choose another filter.":"Your trades will appear here after MemeCloud or you execute a real position."}/>} 
  </section>
 </>;
}
