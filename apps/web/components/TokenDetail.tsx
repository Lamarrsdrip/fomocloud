"use client";
import {useEffect,useState} from "react";
import {ArrowLeft,Copy} from "lucide-react";
import {apiFetch,money,plainError} from "../lib/api";
import {timeAgo,lifecycleLabel,copyText} from "../lib/format";
import {TokenAvatar} from "./TokenAvatar";

export default function TokenDetail({sel,opp,me,close,onTraded}:{sel:{chain:string;mint:string};opp:any;me:any;close:()=>void;onTraded:()=>void}){
 const[data,setData]=useState<any>(null),[detailError,setDetailError]=useState("");
 const[amount,setAmount]=useState(25),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
 const[refused,setRefused]=useState<{message:string}|null>(null),[liveExecutionEnabled,setLiveExecutionEnabled]=useState(false);
 const o=data?.opportunity||opp,tracked=data?.trackedMoney||data?.smartMoney;
 useEffect(()=>{let live=true;setDetailError("");apiFetch<any>(`/v1/brain/token/${sel.chain}/${sel.mint}`).then(x=>{if(live)setData(x)}).catch(e=>{if(live)setDetailError(plainError(e))});return()=>{live=false}},[sel.chain,sel.mint]);
 useEffect(()=>{let live=true;apiFetch<any>("/v1/public/config",{},false).then(x=>{if(live)setLiveExecutionEnabled(Boolean(x?.liveExecutionEnabled))}).catch(()=>{});return()=>{live=false}},[]);
 const walletEligible=Boolean((me?.wallets||[]).some((w:any)=>w.chain==="SOLANA"&&w.tradingEnabled&&w.permissionRef&&(!w.permissionExpiry||new Date(w.permissionExpiry)>new Date())));
 const canTradeLive=liveExecutionEnabled&&walletEligible;
 async function buy(forceSimulation=false){
  setBusy(true);setMsg("");setRefused(null);
  const clientRequestId=(crypto as any).randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try{
   const r=await apiFetch<any>("/v1/me/trade/manual",{method:"POST",body:JSON.stringify({chain:sel.chain,mint:sel.mint,amountUsd:amount,clientRequestId,...(forceSimulation?{mode:"SIMULATION"}:{})})});
   setMsg(r.mode==="LIVE"?`Live buy confirmed: ${money(amount)} at ${money(r.position.avgEntryPriceUsd)}/token on-chain.`:`Simulated ${money(amount)} at ${money(r.position.avgEntryPriceUsd)}/token. No live funds moved.`);onTraded();
  }catch(e:any){if(e?.body?.simulationAvailable)setRefused({message:e.body.message||plainError(e)});else setMsg(plainError(e));}finally{setBusy(false)}
 }
 return <div className="token-detail">
  <button className="soft-action" onClick={close}><ArrowLeft size={13}/> Back</button>
  <div className="token-detail-head"><TokenAvatar symbol={o?.symbol||o?.name||data?.token?.symbol||data?.token?.name} size={48}/><div><h2>{o?.symbol||o?.name||data?.token?.symbol||data?.token?.name||"Token"}</h2><small>{sel.chain}{o?.firstSeenAt?` · Found ${timeAgo(o.firstSeenAt)}`:""}</small></div>{o?.lifecycleStatus&&<span className="status-badge" style={{marginLeft:"auto"}}>{lifecycleLabel(o.lifecycleStatus)}</span>}</div>
  {detailError&&<div className="notice" style={{marginBottom:12}}>Token intelligence is temporarily unavailable: {detailError}</div>}
  {o?.evidenceObservedAt&&<p style={{fontSize:10,color:"#7b8190",margin:"-8px 0 12px"}}>Evidence captured {timeAgo(o.evidenceObservedAt)}{o.lastEvaluatedAt?` · scored ${timeAgo(o.lastEvaluatedAt)}`:""}</p>}
  {data?.token?.metadata?.tokenProvenance&&<div className="notice" style={{marginBottom:12}}><b>{data.token.metadata.tokenProvenance.origin.replaceAll("_"," ")}</b><div style={{fontSize:11,marginTop:4}}>{data.token.metadata.tokenProvenance.launchpad?`${data.token.metadata.tokenProvenance.launchpad.replaceAll("_"," ")} · provenance confidence ${data.token.metadata.tokenProvenance.confidence}%`:"Origin is not verified yet."}</div><small style={{display:"block",marginTop:4}}>Launchpad provenance is context, not a safety guarantee.</small></div>}
  <div className="review-grid">
   <div><span>Market cap</span><b>{o?.marketCapUsd?money(o.marketCapUsd):data?.token?.marketCapUsd?money(data.token.marketCapUsd):"Collecting data"}</b></div>
   <div><span>Liquidity</span><b>{o?.liquidityUsd?money(o.liquidityUsd):data?.token?.liquidityUsd?money(data.token.liquidityUsd):"Collecting data"}</b></div>
   <div><span>Money in last 60s</span><b>{money(o?.inflow60sUsd||0)}</b></div>
   <div><span>Unique buyers (60s)</span><b>{o?.buyers60s??0}</b></div>
   <div><span>Tracked traders</span><b>{tracked?.summary?.distinctTrackedTraders??tracked?.summary?.distinctTrackedWallets??0}</b></div>
   <div><span>Tracked net flow</span><b>{money(tracked?.summary?.netTrackedInflowUsd??0)}</b></div>
   <div><span>Volume acceleration</span><b>{o?.volumeAcceleration1m?`${o.volumeAcceleration1m.toFixed(1)}x`:"Collecting data"}</b></div>
   <div><span>Opportunity quality</span><b>{o?.score!=null?`${Math.round(o.score)}/100`:"Collecting data"}</b></div>
   <div><span>Current decision</span><b>{o?.action?.replaceAll("_"," ")||"WATCH"}</b></div>
  </div>
  {o?.evidence?.breakdown&&<section className="app-card verdict-card"><div className="card-title"><div><span>MEMECLOUD VERDICT</span><h2>Why this opportunity matters</h2></div><span className="status-badge">{o?.action?.replaceAll("_"," ")||"WATCH"}</span></div><div className="review-grid"><div><span>Momentum</span><b>{o.evidence.breakdown.momentum}</b></div><div><span>Tracked money</span><b>{o.evidence.breakdown.smartMoney}</b></div><div><span>Execution quality</span><b>{o.evidence.breakdown.executionQuality}</b></div><div><span>Risk</span><b>{o.evidence.breakdown.risk}</b></div><div><span>Evidence completeness</span><b>{o.evidence.breakdown.evidenceCompleteness}%</b></div></div></section>}
  {!!(o?.reasons?.length)&&<section className="app-card"><div className="card-title"><div><span>BRAIN INSIGHT</span><h2>Why MemeCloud found this</h2></div></div><ul className="reason-list">{o.reasons.map((r:string,i:number)=><li key={i}>{r.replaceAll("smart wallet","tracked trader").replaceAll("smart-wallet","tracked-trader")}</li>)}</ul></section>}
  {!!(o?.evidence?.warnings?.length)&&<section className="app-card"><div className="card-title"><div><span>WHAT COULD GO WRONG</span><h2>Risk evidence</h2></div></div><ul className="reason-list">{o.evidence.warnings.map((r:string,i:number)=><li key={i}>{r}</li>)}</ul></section>}
  <section className="app-card"><div className="card-title"><div><span>TRACKED TRADER FLOW</span><h2>Verified Admin-wallet activity</h2></div><span className="status-badge">{tracked?.summary?.distinctTrackedTraders??tracked?.summary?.distinctTrackedWallets??0} traders</span></div>
   {tracked?.relationships?.length?<><div className="review-grid"><div><span>Tracked buy flow</span><b>{money(tracked.summary?.trackedBuyFlowUsd)}</b></div><div><span>Tracked sell flow</span><b>{money(tracked.summary?.trackedSellFlowUsd)}</b></div><div><span>Net tracked flow</span><b>{money(tracked.summary?.netTrackedInflowUsd)}</b></div><div><span>Active wallets</span><b>{tracked.summary?.activeWallets??0}</b></div></div><div className="list">{tracked.relationships.slice(0,20).map((r:any)=><div className="list-row" key={`${r.traderId||"t"}:${r.walletAddress}:${r.mint}`}><div><b>{r.traderName||r.label||`${r.walletAddress.slice(0,6)}…${r.walletAddress.slice(-4)}`} · {String(r.state||"OBSERVED").replaceAll("_"," ")}</b><small>{r.handle?`@${r.handle} · `:""}Admin tracked{r.holdingVerification?` · ${String(r.holdingVerification).replaceAll("_"," ")}`:""}</small></div><span>{money(r.netFlowUsd)}</span><span>{timeAgo(r.latestActivityAt)}</span></div>)}</div></>:<div className="pnl-empty">No verified Admin-trader swap has been observed for this token in the current evidence window.</div>}
   <div className="notice" style={{marginTop:10}}>Holding labels describe the latest observed transaction balance only. MemeCloud does not claim a trader still holds a token without newer on-chain evidence.</div>
  </section>
  <section className="app-card"><div className="card-title"><div><span>BUY</span><h2>Manual trade{canTradeLive?"":" — simulation"}</h2></div></div><div className="pct-row">{[10,25,50,75,100].map(p=><button key={p} className={amount===p?"active":""} onClick={()=>setAmount(p)}>{p===100?"Max $100":`$${p}`}</button>)}</div><button className="action-primary" style={{width:"100%",marginTop:10}} disabled={busy} onClick={()=>buy(!canTradeLive)}>{busy?"Buying…":canTradeLive?`Buy ${money(amount)} (live)`:`Buy ${money(amount)} (simulation)`}</button>{msg&&<div className="notice" style={{marginTop:10}}>{msg}</div>}{refused&&<div className="notice" style={{marginTop:10,borderColor:"rgba(247,185,95,.25)"}}><div>{refused.message}</div><button className="soft-action" style={{marginTop:8}} disabled={busy} onClick={()=>buy(true)}>Run as simulation instead</button></div>}<div className="notice" style={{marginTop:10}}>{canTradeLive?"Live Solana trading is on and this wallet has an active delegated permission — this button submits a real on-chain transaction.":"Uses a real executable quote. Runs in simulation until live trading is on and a wallet has active delegated permission — no live funds move."}</div></section>
  <section className="app-card"><div className="card-title"><div><span>ON-CHAIN</span><h2>Recent verified flow</h2></div></div>{data?.flows?.length?<div className="list">{data.flows.slice(0,10).map((f:any)=><div className="list-row" key={f.id}><div><b>{f.side}</b><small>{f.walletAddress.slice(0,6)}…{f.walletAddress.slice(-4)}</small></div><span>{money(f.amountUsd||0)}</span><span>{timeAgo(f.observedAt)}</span></div>)}</div>:<div className="pnl-empty">No recorded verified flow yet for this token.</div>}</section>
  <div className="list-row" style={{gridTemplateColumns:"1fr auto"}}><div><small className="contract-line">{sel.mint}</small></div><button className="soft-action" onClick={()=>copyText(sel.mint)}><Copy size={12}/> Copy contract</button></div>
 </div>;
}
