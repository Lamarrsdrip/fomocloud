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
 const thesis=String(p.thesisState||"");
 const thesisTone=thesis.includes("STRENGTHENING")?"positive":thesis==="DISTRIBUTION"||thesis==="BROKEN"?"negative":"";
 const thesisLabel=thesis?thesis.replace("THESIS_","").replaceAll("_"," "):p.entryThesis?"EVALUATING":"THESIS PENDING";
 return <div className="position-row"><div className="position-main"><div className="position-token"><b>{p.mint?.slice(0,8)}…</b><span className="sim-badge">{p.mode}</span><span className="status-badge">{String(p.status).replaceAll("_"," ")}</span></div><small>{p.sourceTrader?.displayName||"Source trader"} · {p.chain} · opened {timeAgo(p.openedAt)}</small>{p.status!=="CLOSED"&&<small className={recovered?"positive":""}>{recovered?"✓ Principal recovered · runner active":"Principal not recovered"}</small>}<small className={thesisTone}>Thesis: {thesisLabel}{p.thesisReasons?.[0]?` · ${p.thesisReasons[0]}`:""}</small></div><div><span>Invested remaining</span><b>{money(m.remainingCost)}</b></div><div><span>Current value</span><b>{p.currentPriceUsd?money(m.currentValue):"Awaiting mark"}</b></div><div><span>Unrealized</span><b className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)} <small>({pct(m.pnlPct)})</small></b></div><div><span>Realized</span><b className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</b></div><div><span>Profit taken</span><b>{money(p.profitTakenUsd)}</b></div></div>}
export default function PositionsView({positions,degraded,d,me,reload}:{positions:any[];degraded:boolean;d:any;me:any;reload:()=>Promise<void>}){const[filter,setFilter]=useState("ALL");const shown=positions.filter(p=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");const s=d?.summary||{};return <>
 {/* User-reported UX gap: wallet creation was only reachable buried in Account settings. This is
     the primary Portfolio surface, where a wallet is actually most relevant, so it's shown here
     first now -- Account keeps its own copy too (harmless, matches where people also expect it). */}
 <section className="app-card" style={{marginBottom:10}}><div className="card-title"><div><span>YOUR WALLET</span><h2>Solana wallet</h2></div></div><EmbeddedWalletPanel me={me} reload={reload}/></section>
 {degraded&&<div className="notice" style={{marginBottom:10,borderColor:"rgba(247,185,95,.3)"}}>Live pricing is temporarily degraded -- open positions haven't been marked to market recently. Values below may be stale; this isn't a real P&amp;L swing, and will resume automatically once the pricing pipeline recovers.</div>}
 {/* Real bug found by audit: this card labeled tradingCashUsd (cash only, excludes every open
     position's current value) as "Portfolio value" -- a user with cash mostly deployed into open
     positions saw a number far below what they actually hold. accountValueUsd (cash + current
     open-position value) already exists on the API response; it just wasn't used here. */}
 <div className="app-grid-4" style={{marginBottom:10}}>
  <div className="stat-card"><span>Total account value</span><b>{money(s.accountValueUsd??((s.tradingCashUsd||0)+(s.openPositionsValueUsd||0)))}</b></div>
  <div className="stat-card"><span>Available cash</span><b>{money(s.availableUsd??s.tradingCashUsd)}</b></div>
  <div className="stat-card"><span>In open positions</span><b>{money(s.inTradesUsd??0)}</b></div>
  <div className="stat-card"><span>Total P&amp;L</span><b className={(s.netPnlUsd||0)>=0?"positive":"negative"}>{money(s.netPnlUsd)}</b></div>
 </div>
 <div className="app-grid-4" style={{marginBottom:10}}>
  <div className="stat-card"><span>Realized P&amp;L</span><b className={(s.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(s.realizedPnlUsd)}</b></div>
  <div className="stat-card"><span>Unrealized P&amp;L</span><b className={(s.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(s.unrealizedPnlUsd)}</b></div>
 </div>
 <PerformanceChart snapshots={d?.snapshots||[]}/>
 <section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>PERSONAL POSITIONS</span><h2>Open &amp; closed positions</h2></div><div className="performance-tabs">{["ALL","OPEN","CLOSED"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>{shown.length?<div className="positions-list">{shown.map(p=><PositionRow p={p} key={p.id}/>)}</div>:<Empty icon={WalletCards} title={positions.length?"No positions in this filter":"No positions yet"} body={positions.length?"Choose another filter.":"There is no shared demo portfolio here. Your positions appear only after your own account gets a real decision."}/>}</section>
</>}
