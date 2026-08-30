"use client";
import {useMemo} from "react";
import {TrendingUp} from "lucide-react";
import {timeAgo} from "../lib/format";

export default function TradeView({settings,trades,patchTrading,setView}:{settings:any;trades:any[];patchTrading:(b:any)=>Promise<void>;setView:(v:any)=>void}){
 const trading=settings?.trading||{};
 const autoTradeOn=trading.globalBrainEnabled!==false&&Boolean(trading.autoCopyEnabled);
 // Real gap found by forensic audit (M-45): this switch had a title but no explanatory copy in
 // either state, and no visibility into what Auto Trade actually did today -- both explicitly
 // required by the spec, with the OFF-state copy given almost verbatim. Trades today / last action
 // are computed from `trades` (already fetched at the top level for the Trade History view), not a
 // new backend call.
 const todayStart=useMemo(()=>{const d=new Date();d.setHours(0,0,0,0);return d},[]);
 const tradesToday=useMemo(()=>trades.filter(t=>new Date(t.createdAt)>=todayStart),[trades,todayStart]);
 const lastTrade=trades[0];
 return <>
  <section className="app-card"><div className="card-title"><div><span>AUTO TRADE</span><h2>Let MemeCloud trade for you</h2></div><button className={`switch ${autoTradeOn?"on":""}`} onClick={()=>patchTrading({autoCopyEnabled:!trading.autoCopyEnabled,globalBrainEnabled:true})}><i/></button></div>
   <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 12px"}}>{autoTradeOn?"Eligible opportunities are executed automatically within the limits below.":"MemeCloud continues scanning and alerting you. Turn Auto Trade on only if you want eligible opportunities executed automatically."}</p>
   {autoTradeOn&&<div className="review-grid" style={{marginBottom:12}}>
    <div><span>Allocation</span><b>{trading.percentBalance??2}% / entry</b></div>
    <div><span>Trades today</span><b>{tradesToday.length}</b></div>
    <div><span>Last action</span><b style={{fontSize:11}}>{lastTrade?`${lastTrade.side} · ${timeAgo(lastTrade.createdAt)}`:"None yet"}</b></div>
   </div>}
   <label className="field"><span>Use this % of my available trading cash per entry</span><input type="number" min="0.01" max="100" step="0.1" value={trading.percentBalance??2} onChange={e=>patchTrading({sizingMode:"PERCENT",percentBalance:Number(e.target.value)})}/></label>
   <div className="switch-row"><div><b>Recover original capital</b><small>Sell only enough to recover your original money, then let the rest ride.</small></div><button className={`switch ${trading.capitalRecoveryEnabled!==false?"on":""}`} onClick={()=>patchTrading({capitalRecoveryEnabled:trading.capitalRecoveryEnabled===false})}><i/></button></div>
   {trading.capitalRecoveryEnabled!==false&&<label className="field"><span>Recover capital at</span><input type="number" min="1.01" step="0.1" value={trading.capitalRecoveryMultiple??3} onChange={e=>patchTrading({capitalRecoveryMultiple:Number(e.target.value)})}/></label>}
   <div className="switch-row"><div><b>Runner mode</b><small>Let exceptional memes keep running while evidence stays strong.</small></div><button className={`switch ${trading.runnerMode?"on":""}`} onClick={()=>patchTrading({runnerMode:!trading.runnerMode})}><i/></button></div>
  </section>
  <section className="app-card"><div className="card-title"><div><span>CHAINS</span><h2>Chains</h2></div></div>
   {/* Only Solana has a real delegated signer (Privy) and execution path anywhere in the
       codebase. BNB/Ethereum have a discovery scanner but no signer -- labeling them under "where
       MemeCloud can trade" was a real, user-facing false claim of multi-chain live execution. */}
   <div className="chain-config">{["SOLANA","BNB","ETHEREUM"].map(c=><label key={c} className="check-line"><input type="checkbox" checked={(trading.allowedChains||["SOLANA"]).includes(c)} onChange={()=>{const cur=trading.allowedChains||["SOLANA"];patchTrading({allowedChains:cur.includes(c)?cur.filter((x:string)=>x!==c):[...cur,c]})}}/><span>{c==="SOLANA"?"Solana — trading":c==="BNB"?"BNB — discovery only, trading not yet available":"Ethereum — discovery only, trading not yet available"}</span></label>)}</div>
  </section>
  <section className="app-card"><div className="card-title"><div><span>MANUAL</span><h2>Buy a specific token</h2></div></div>
   <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 10px"}}>Pick a token from Discover to buy an exact amount right now.</p>
   <button className="action-primary" onClick={()=>setView("discover")}><TrendingUp size={15}/> Browse Discover</button>
  </section>
  <section className="app-card"><div className="card-title"><div><span>ADVANCED</span><h2>Copy specific traders</h2></div></div>
   <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 10px"}}>Follow individual wallets instead of — or alongside — the Global Brain.</p>
   <button className="soft-action" onClick={()=>setView("community")}>Manage copy trading</button>
  </section>
 </>
}
