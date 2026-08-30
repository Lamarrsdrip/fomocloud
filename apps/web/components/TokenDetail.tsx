"use client";
import {useEffect,useState} from "react";
import {ArrowLeft,Copy} from "lucide-react";
import {apiFetch,money,plainError} from "../lib/api";
import {timeAgo,lifecycleLabel,whaleCount,copyText} from "../lib/format";
import {TokenAvatar} from "./TokenAvatar";

export default function TokenDetail({sel,opp,me,close,onTraded}:{sel:{chain:string;mint:string};opp:any;me:any;close:()=>void;onTraded:()=>void}){
 const[data,setData]=useState<any>(null);
 const[amount,setAmount]=useState(25);
 const[busy,setBusy]=useState(false);
 const[msg,setMsg]=useState("");
 const[refused,setRefused]=useState<{message:string}|null>(null);
 const[liveExecutionEnabled,setLiveExecutionEnabled]=useState(false);
 const o=data?.opportunity||opp;
 useEffect(()=>{let live=true;apiFetch<any>(`/v1/brain/token/${sel.chain}/${sel.mint}`).then(x=>{if(live)setData(x)}).catch(()=>{});return()=>{live=false}},[sel.chain,sel.mint]);
 useEffect(()=>{let live=true;apiFetch<any>("/v1/public/config",{},false).then(x=>{if(live)setLiveExecutionEnabled(Boolean(x?.liveExecutionEnabled))}).catch(()=>{});return()=>{live=false}},[]);
 const walletEligible=Boolean((me?.wallets||[]).some((w:any)=>w.chain==="SOLANA"&&w.tradingEnabled&&w.permissionRef&&(!w.permissionExpiry||new Date(w.permissionExpiry)>new Date())));
 const canTradeLive=liveExecutionEnabled&&walletEligible;
 // clientRequestId is generated once per tap and reused across a retry of THIS SAME attempt (e.g.
 // after a transient network error) so the backend's idempotency key stays stable — a genuinely
 // new buy (new amount, or pressing Buy again later) always gets a fresh one.
 async function buy(forceSimulation=false){
  setBusy(true);setMsg("");setRefused(null);
  const clientRequestId=(crypto as any).randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try{
   const r=await apiFetch<any>("/v1/me/trade/manual",{method:"POST",body:JSON.stringify({chain:sel.chain,mint:sel.mint,amountUsd:amount,clientRequestId,...(forceSimulation?{mode:"SIMULATION"}:{})})});
   setMsg(r.mode==="LIVE"?`Live buy confirmed: ${money(amount)} at ${money(r.position.avgEntryPriceUsd)}/token on-chain.`:`Simulated ${money(amount)} at ${money(r.position.avgEntryPriceUsd)}/token. No live funds moved.`);
   onTraded();
  }catch(e:any){
   if(e?.body?.simulationAvailable)setRefused({message:e.body.message||plainError(e)});
   else setMsg(plainError(e));
  }finally{setBusy(false)}
 }
 return <div className="token-detail">
  <button className="soft-action" onClick={close}><ArrowLeft size={13}/> Back</button>
  <div className="token-detail-head"><TokenAvatar symbol={o?.symbol||o?.name} size={48}/><div><h2>{o?.symbol||o?.name||"Token"}</h2><small>{sel.chain}{o?.firstSeenAt?` · Found ${timeAgo(o.firstSeenAt)}`:""}</small></div>{o?.lifecycleStatus&&<span className="status-badge" style={{marginLeft:"auto"}}>{lifecycleLabel(o.lifecycleStatus)}</span>}</div>
  {/* evidenceObservedAt is when the underlying chain snapshot was actually captured, distinct from
      lastEvaluatedAt (which only proves the Brain loop ran, not that it had fresh data). Surfacing
      this is what stops a stale score from silently looking live. */}
  {o?.evidenceObservedAt&&<p style={{fontSize:10,color:"#7b8190",margin:"-8px 0 12px"}}>Evidence captured {timeAgo(o.evidenceObservedAt)}{o.lastEvaluatedAt?` · scored ${timeAgo(o.lastEvaluatedAt)}`:""}</p>}
  <div className="review-grid">
   <div><span>Market cap</span><b>{o?.marketCapUsd?money(o.marketCapUsd):"Unknown"}</b></div>
   <div><span>Liquidity</span><b>{o?.liquidityUsd?money(o.liquidityUsd):"Unknown"}</b></div>
   <div><span>Money in last 60s</span><b>{money(o?.inflow60sUsd||0)}</b></div>
   <div><span>Unique buyers (60s)</span><b>{o?.buyers60s??0}</b></div>
   <div><span>Whales buying</span><b>{o?whaleCount(o):0}</b></div>
   <div><span>Smart wallets entered</span><b>{o?.evidence?.convergentCount??0}</b></div>
   <div><span>Volume acceleration</span><b>{o?.volumeAcceleration1m?`${o.volumeAcceleration1m.toFixed(1)}x`:"Unknown"}</b></div>
   <div><span>MemeCloud confidence</span><b>{o?.score!=null?`${Math.round(o.score)}%`:"Unknown"}</b></div>
  </div>
  {/* MemeCloud Verdict: the same evidence as "MemeCloud confidence" above, broken into named
      dimensions instead of one opaque number -- computed by packages/brain's evaluateOpportunity,
      never client-guessed. Purely explanatory; it cannot itself change any trading decision. */}
  {o?.evidence?.breakdown&&<section className="app-card"><div className="card-title"><div><span>MEMECLOUD VERDICT</span><h2>Why the confidence score is what it is</h2></div></div>
   <div className="review-grid">
    <div><span>Momentum</span><b>{o.evidence.breakdown.momentum}</b></div>
    <div><span>Smart money</span><b>{o.evidence.breakdown.smartMoney}</b></div>
    <div><span>Execution quality</span><b>{o.evidence.breakdown.executionQuality}</b></div>
    <div><span>Risk</span><b>{o.evidence.breakdown.risk}</b></div>
    <div><span>Evidence completeness</span><b>{o.evidence.breakdown.evidenceCompleteness}%</b></div>
   </div>
  </section>}
  {!!(o?.reasons?.length)&&<section className="app-card"><div className="card-title"><div><span>BRAIN INSIGHT</span><h2>Why MemeCloud found this</h2></div></div><ul className="reason-list">{o.reasons.map((r:string,i:number)=><li key={i}>{r}</li>)}</ul></section>}
  <section className="app-card"><div className="card-title"><div><span>BUY</span><h2>Manual trade{canTradeLive?"":" — simulation"}</h2></div></div>
   <div className="pct-row">{[10,25,50,75,100].map(p=><button key={p} className={amount===p?"active":""} onClick={()=>setAmount(p)}>{p===100?"Max $100":`$${p}`}</button>)}</div>
   <button className="action-primary" style={{width:"100%",marginTop:10}} disabled={busy} onClick={()=>buy(!canTradeLive)}>{busy?"Buying…":canTradeLive?`Buy ${money(amount)} (live)`:`Buy ${money(amount)} (simulation)`}</button>
   {msg&&<div className="notice" style={{marginTop:10}}>{msg}</div>}
   {refused&&<div className="notice" style={{marginTop:10,borderColor:"rgba(247,185,95,.25)"}}>
    <div>{refused.message}</div>
    <button className="soft-action" style={{marginTop:8}} disabled={busy} onClick={()=>buy(true)}>Run as simulation instead</button>
   </div>}
   <div className="notice" style={{marginTop:10}}>{canTradeLive?"Live Solana trading is on and this wallet has an active delegated permission — this button submits a real on-chain transaction.":"Uses a real executable quote. Runs in simulation until live trading is on and a wallet has active delegated permission — no live funds move."}</div>
  </section>
  <section className="app-card"><div className="card-title"><div><span>ON-CHAIN</span><h2>Recent wallet activity</h2></div></div>
   {data?.flows?.length?<div className="list">{data.flows.slice(0,10).map((f:any)=><div className="list-row" key={f.id}><div><b>{f.side} · {f.walletTier||"FLOW"}</b><small>{f.walletAddress.slice(0,6)}…{f.walletAddress.slice(-4)}</small></div><span>{money(f.amountUsd||0)}</span><span>{timeAgo(f.observedAt)}</span></div>)}</div>:<div className="pnl-empty">No recorded wallet activity yet for this token.</div>}
  </section>
  <div className="list-row" style={{gridTemplateColumns:"1fr auto"}}><div><small className="contract-line">{sel.mint}</small></div><button className="soft-action" onClick={()=>copyText(sel.mint)}><Copy size={12}/> Copy contract</button></div>
 </div>
}
