import {money} from "../../lib/api";
import {Fish,Coins,PlugZap,Wallet,ChevronRight} from "lucide-react";
import {Metric} from "./Metric";

export function Overview({d}:{d:any}){const m=d.metrics||{},u=m.users||{},t=m.trading||{},s=m.smartTraders||{},x=m.discovery||{},e=m.engine||{},lr=d.liveReadiness||{requestedMode:"SIMULATION",actualRuntimeMode:"SIMULATION",status:"SIMULATION",blockers:[],openLivePositions:0};return <>
 <section className="owner-hero"><div><span>OWNER HOME</span><h2>Everything important, without digging.</h2><p>Real users, trading, discovery and engine activity. Use the controls below to change how MemeCloud operates.</p></div>
  <div className={`owner-mode ${lr.status==="LIVE"?"live":lr.status==="SIMULATION"?"safe":"watch"}`}>
   <small>Actual execution</small><b>{lr.actualRuntimeMode||"SIMULATION"}</b>
   <span>Requested: {lr.requestedMode||"SIMULATION"}</span>
   <span>Status: {String(lr.status||"SIMULATION").replaceAll("_"," ")}</span>
   <span>Qualified signal: {String(lr.nextQualifiedSignalAction||"SIMULATION").replaceAll("_"," ")}</span>
   {lr.blockers?.[0]&&<span style={{marginTop:4}}>Blocked by: {lr.blockers[0].message}</span>}
   {lr.openLivePositions>0&&<span style={{marginTop:4}}>{lr.openLivePositions} real open position{lr.openLivePositions===1?"":"s"} — always exited for real regardless of this switch.</span>}
  </div>
 </section>
 <section className="admin-quick-grid">
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="whales"]')?.click()}><Fish/><div><b>Whales</b><small>Discovered wallets awaiting review</small></div><ChevronRight/></button>
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="tokens"]')?.click()}><Coins/><div><b>Tokens</b><small>What Discovery has seen</small></div><ChevronRight/></button>
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="config"]')?.click()}><PlugZap/><div><b>APIs & providers</b><small>RPC, Birdeye, Jupiter, Privy</small></div><ChevronRight/></button>
  <a href="/app/"><Wallet/><div><b>Open user app</b><small>See MemeCloud exactly as users do</small></div><ChevronRight/></a>
 </section>
 <section className="admin-kpi-row"><Metric label="Users" value={u.registered} note={`${u.active??0} active`}/><Metric label="Wallets connected" value={u.walletConnected} note={`${u.autoCopyEnabled??0} Auto Copy`}/><Metric label="Open positions" value={t.openPositions} note={`${t.ordersToday??0} orders today`}/><Metric label="Platform traders" value={s.platform} note={`${s.candidates??0} candidates`}/></section>
 <div className="admin-section-grid" style={{marginTop:12}}><section className="app-card"><div className="card-title"><div><span>DISCOVERY</span><h2>What MemeCloud is seeing</h2></div></div><div className="control-list"><div><span>Watched tokens</span><b>{x.watchedTokens??0}</b></div><div><span>New tokens today</span><b>{x.newTokensToday??0}</b></div><div><span>Qualified opportunities now</span><b>{x.qualifiedOpportunitiesNow??0}</b></div><div><span>Signals today</span><b>{e.signalsToday??0}</b></div><div><span>BUY decisions</span><b>{e.buyDecisions??0}</b></div><div><span>WAIT / SKIP</span><b>{e.waitDecisions??0} / {e.skipDecisions??0}</b></div></div></section>
 <section className="app-card"><div className="card-title"><div><span>TRADING</span><h2>Real execution activity</h2></div></div><div className="control-list"><div><span>Allocated cash</span><b>{money(t.allocatedCashUsd??0)}</b></div><div><span>Orders today</span><b>{t.ordersToday??0}</b></div><div><span>Buys / sells</span><b>{t.buysToday??0} / {t.sellsToday??0}</b></div><div><span>Live P&amp;L</span><b>{t.realizedPnlUsd==null&&t.unrealizedPnlUsd==null?"—":money((t.realizedPnlUsd??0)+(t.unrealizedPnlUsd??0))}</b></div></div></section></div>
 <section className="app-card owner-next" style={{marginTop:12}}><div><span>START HERE</span><h2>Configure the platform</h2><p>Set APIs, trading fees, wallet signer, discovery rules, email and push notifications from Settings. Nothing is hard-coded into this screen.</p></div><button className="action-primary" onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="config"]')?.click()}>Open Settings <ChevronRight size={15}/></button></section>
 </>}
