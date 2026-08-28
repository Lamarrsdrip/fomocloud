"use client";
import {useEffect,useState} from "react";
import {apiFetch,plainError,money} from "../../lib/api";
import {Users,Radio,WalletCards,Settings2,Mail,Bell,Send,Activity,ShieldCheck,BarChart3,RefreshCw,Plus,KeyRound,Gauge,SlidersHorizontal,ChevronRight,Home,Wallet,Database,PlugZap,Coins,Fish,AlertTriangle,Layers} from "lucide-react";
import {BrandGlyph} from "../../components/BrandGlyph";

const sections=[
 ["overview","Control",Gauge],["brain","Global Brain",BarChart3],["tokens","Tokens",Coins],["whales","Whales",Fish],["users","Users",Users],["traders","Wallets",Radio],["signals","Decisions",Activity],
 ["trades","Live Trades",WalletCards],["positions","Positions",Layers],["failed","Failed Trades",AlertTriangle],["config","Settings",SlidersHorizontal],["broadcasts","Messages",Send],["audit","Audit",ShieldCheck],["health","Health",Activity]
] as const;
const navGroups=[
 ["OVERVIEW",["overview"]],
 ["GLOBAL BRAIN",["brain"]],
 ["DISCOVERY",["tokens","whales","traders"]],
 ["TRADING",["trades","positions","signals","failed"]],
 ["USERS",["users"]],
 ["CONFIGURATION",["config"]],
 ["SYSTEM",["broadcasts","audit","health"]]
] as const;

export default function Admin(){
 const[tab,setTab]=useState("overview");const[me,setMe]=useState<any>(null);const[data,setData]=useState<any>({});const[err,setErr]=useState("");const[loading,setLoading]=useState(true);
 // background:true is used for a reload triggered BY an action already inside a tab (Save, Test
 // connection, promote/demote, ...) — it must never flip the full-page loading spinner, because
 // that unmounts the active tab component entirely and resets its local navigation state (e.g.
 // Settings falling back to its home screen on every single Save). It also must never hard-redirect
 // on auth failure: that would silently blow away whatever the user was mid-edit on.
 async function load(which=tab,opts:{background?:boolean}={}){
  if(!opts.background) setLoading(true);
  setErr("");
  try{
  const m=me||((await apiFetch("/v1/me")).user);if(!me)setMe(m);if(m.role!=="OWNER"&&m.role!=="ADMIN"&&m.role!=="SUPPORT")throw Object.assign(new Error("ADMIN_FORBIDDEN"),{status:403});
  let r:any={};
  if(which==="overview")r=await apiFetch("/v1/admin/overview");
  if(which==="brain")r=await apiFetch("/v1/admin/brain");
  if(which==="users")r=await apiFetch("/v1/admin/users");
  if(which==="traders")r=await apiFetch("/v1/admin/traders");
  if(which==="signals")r=await apiFetch("/v1/admin/signals");
  if(which==="trades")r=await apiFetch("/v1/admin/trades");
  if(which==="positions")r=await apiFetch("/v1/admin/positions");
  if(which==="failed")r=await apiFetch("/v1/admin/risk-incidents");
  if(which==="tokens")r=await apiFetch("/v1/admin/discovery/tokens");
  if(which==="whales")r=await apiFetch("/v1/admin/discovery/candidates");
  if(which==="config")r=await apiFetch("/v1/admin/config");
  if(which==="broadcasts")r=await apiFetch("/v1/admin/broadcasts");
  if(which==="audit")r=await apiFetch("/v1/admin/audit");
  if(which==="health")r=await apiFetch("/v1/admin/health");
  setData(r);
 }catch(e:any){
  if(e?.status===401){if(opts.background){setErr(plainError(e))}else{window.location.replace("/login/")};return}
  if(e?.status===403){if(opts.background){setErr(plainError(e))}else{window.location.replace("/app/")};return}
  setErr(plainError(e));
 }finally{if(!opts.background) setLoading(false)}}
 useEffect(()=>{void load("overview")},[]);
 function change(t:string){setTab(t);void load(t)}
 return <main className="admin-layout">
  <aside className="admin-side"><a className="brand" href="/app/"><span className="brandmark small"><BrandGlyph size={18}/></span><span><b>MemeCloud</b><small>Owner controls</small></span></a><nav>{navGroups.map(([label,ids])=><div className="admin-nav-group" key={label}><small>{label}</small>{ids.map(id=>{const s=sections.find(x=>x[0]===id);if(!s)return null;const[,name,Icon]=s;return <button key={id} data-admin-target={id} className={tab===id?"active":""} onClick={()=>change(id)}><Icon size={15}/><span>{name}</span></button>})}</div>)}</nav><div className="admin-side-foot"><div className="owner-chip"><ShieldCheck size={15}/><div><b>{me?.displayName||"Platform owner"}</b><small>{me?.email||"Full control"}</small></div></div><a className="soft-action" href="/app/"><Home size={13}/> Back to MemeCloud</a></div></aside>
  <section className="admin-main"><div className="admin-head"><div><small>MemeCloud · OWNER CONTROL</small><h1>{sections.find(x=>x[0]===tab)?.[1]}</h1><p>{tab==="overview"?"Run the platform from one place.":tab==="config"?"APIs, fees, email, push, discovery and trading rules.":"Real platform data and controls."}</p></div><button className="soft-action" onClick={()=>load()}><RefreshCw size={12}/> Refresh</button></div>
   {err&&<div className="auth-error">{err}</div>}{loading&&!err?<div className="loading"><div><div className="spinner"/>Loading admin data…</div></div>:<>
    {tab==="overview"&&<Overview d={data}/>}
    {tab==="brain"&&<BrainAdmin d={data}/>}
    {tab==="users"&&<UsersView d={data} reload={()=>load("users",{background:true})}/>}
    {tab==="traders"&&<TradersAdmin d={data} reload={()=>load("traders",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="signals"&&<Signals d={data}/>}
    {tab==="trades"&&<Trades d={data}/>}
    {tab==="positions"&&<AdminPositions d={data}/>}
    {tab==="failed"&&<FailedTrades d={data}/>}
    {tab==="tokens"&&<Tokens d={data}/>}
    {tab==="whales"&&<Whales d={data} reload={()=>load("whales",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="config"&&<Config d={data} reload={()=>load("config",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="broadcasts"&&<Broadcasts d={data} reload={()=>load("broadcasts",{background:true})} admin={me?.role==="OWNER"}/>}
    {tab==="audit"&&<Audit d={data}/>}
    {tab==="health"&&<Health d={data}/>}
   </>}
  </section>
  <nav className="admin-mobile-nav">{sections.slice(0,6).map(([id,label,Icon])=><button key={id} className={tab===id?"active":""} onClick={()=>change(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
 </main>
}

function Metric({label,value,note,moneyValue=false}:{label:string;value:any;note:string;moneyValue?:boolean}){const shown=value===null||value===undefined?"—":moneyValue?money(value):value;return <div className="stat-card"><span>{label}</span><b>{shown}</b><small>{note}</small></div>}
function Overview({d}:{d:any}){const m=d.metrics||{},u=m.users||{},t=m.trading||{},s=m.smartTraders||{},x=m.discovery||{},e=m.engine||{};return <>
 <section className="owner-hero"><div><span>OWNER HOME</span><h2>Everything important, without digging.</h2><p>Real users, trading, discovery and engine activity. Use the controls below to change how MemeCloud operates.</p></div><div className={`owner-mode ${d.liveExecutionEnabled?"live":"safe"}`}><small>Execution</small><b>{String(d.executionMode||"simulation").toUpperCase()}</b><span>{d.liveExecutionEnabled?"Live trading enabled":"Live funds protected"}</span></div></section>
 <section className="admin-quick-grid">
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="whales"]')?.click()}><Fish/><div><b>Whales</b><small>Discovered wallets awaiting review</small></div><ChevronRight/></button>
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="tokens"]')?.click()}><Coins/><div><b>Tokens</b><small>What Discovery has seen</small></div><ChevronRight/></button>
  <button onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="config"]')?.click()}><PlugZap/><div><b>APIs & providers</b><small>RPC, Birdeye, Jupiter, Privy</small></div><ChevronRight/></button>
  <a href="/app/"><Wallet/><div><b>Open user app</b><small>See MemeCloud exactly as users do</small></div><ChevronRight/></a>
 </section>
 <section className="admin-kpi-row"><Metric label="Users" value={u.registered} note={`${u.active??0} active`}/><Metric label="Wallets connected" value={u.walletConnected} note={`${u.autoCopyEnabled??0} Auto Copy`}/><Metric label="Open positions" value={t.openPositions} note={`${t.ordersToday??0} orders today`}/><Metric label="Platform traders" value={s.platform} note={`${s.candidates??0} candidates`}/></section>
 <div className="admin-section-grid" style={{marginTop:12}}><section className="app-card"><div className="card-title"><div><span>DISCOVERY</span><h2>What MemeCloud is seeing</h2></div></div><div className="control-list"><div><span>Watched tokens</span><b>{x.watchedTokens??0}</b></div><div><span>Opportunities today</span><b>{x.opportunitiesToday??0}</b></div><div><span>Signals today</span><b>{e.signalsToday??0}</b></div><div><span>BUY decisions</span><b>{e.buyDecisions??0}</b></div><div><span>WAIT / SKIP</span><b>{e.waitDecisions??0} / {e.skipDecisions??0}</b></div></div></section>
 <section className="app-card"><div className="card-title"><div><span>TRADING</span><h2>Real execution activity</h2></div></div><div className="control-list"><div><span>Allocated cash</span><b>{money(t.allocatedCashUsd??0)}</b></div><div><span>Orders today</span><b>{t.ordersToday??0}</b></div><div><span>Buys / sells</span><b>{t.buysToday??0} / {t.sellsToday??0}</b></div><div><span>Live P&amp;L</span><b>{t.realizedPnlUsd==null&&t.unrealizedPnlUsd==null?"—":money((t.realizedPnlUsd??0)+(t.unrealizedPnlUsd??0))}</b></div></div></section></div>
 <section className="app-card owner-next" style={{marginTop:12}}><div><span>START HERE</span><h2>Configure the platform</h2><p>Set APIs, trading fees, wallet signer, discovery rules, email and push notifications from Settings. Nothing is hard-coded into this screen.</p></div><button className="action-primary" onClick={()=>document.querySelector<HTMLButtonElement>('button[data-admin-target="config"]')?.click()}>Open Settings <ChevronRight size={15}/></button></section>
 </>}

function BrainAdmin({d}:{d:any}){const rows=d.opportunities||[],flows=d.flows||[];return <><section className="owner-hero"><div><span>GLOBAL TRADE BRAIN</span><h2>MemeCloud is watching money move.</h2><p>Chain-wide flow, known whales, newly discovered wallets, market momentum and social acceleration are combined here. Big historical pumps or deep dips are context, not automatic rejection.</p></div><div className="owner-mode live"><small>Scanner</small><b>ACTIVE</b><span>{rows.length} recent opportunities</span></div></section><div className="app-grid-4"><Metric label="Money-rush tokens" value={rows.filter((x:any)=>x.state==="MONEY_RUSH").length} note="Highest live flow state"/><Metric label="Buy now" value={rows.filter((x:any)=>x.action==="BUY_NOW").length} note="Brain-qualified now"/><Metric label="Whale flow" value={flows.filter((x:any)=>String(x.walletTier||"").startsWith("WHALE_")).length} note="Recent $50K+ wallet observations"/><Metric label="Flow events" value={flows.length} note="Recent on-chain swaps stored"/></div><section className="app-card admin-table-wrap" style={{marginTop:10}}><div className="card-title"><div><span>LIVE DISCOVERY</span><h2>What the brain is seeing</h2></div></div><table className="admin-table"><thead><tr><th>Token</th><th>Chain</th><th>State</th><th>Score</th><th>10s buyers</th><th>60s whales</th><th>60s inflow</th><th>Action</th><th>Contract</th></tr></thead><tbody>{rows.map((x:any)=><tr key={x.id}><td><b>{x.symbol||x.name||"Token"}</b></td><td>{x.chain}</td><td>{x.state}</td><td>{Math.round(x.score)}</td><td>{x.buyers10s}</td><td>{(x.whaleBuyers60s||0)+(x.knownWhaleBuyers60s||0)}</td><td>{money(x.inflow60sUsd||0)}</td><td><span className={`status-badge ${x.action==="BUY_NOW"?"":"watch"}`}>{x.action.replaceAll("_"," ")}</span></td><td><small>{x.mint}</small></td></tr>)}{!rows.length&&<tr><td colSpan={9}>The brain has not stored an opportunity yet. Check flow-scanner and market-worker health.</td></tr>}</tbody></table></section></>}
function UsersView({d,reload}:{d:any;reload:()=>void}){
 const[detail,setDetail]=useState<any>(null),[detailErr,setDetailErr]=useState("");
 async function status(id:string,s:string){await apiFetch(`/v1/admin/users/${id}`,{method:"PATCH",body:JSON.stringify({status:s})});reload();if(detail?.user?.id===id)await view(id)}
 async function view(id:string){setDetailErr("");try{setDetail(await apiFetch(`/v1/admin/users/${id}`))}catch(e){setDetailErr(plainError(e))}}
 return <>
  <section className="app-card admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Status</th><th>Auto Copy</th><th>Wallets</th><th>Traders</th><th>Positions</th><th>Last login</th><th>Action</th></tr></thead><tbody>{(d.users||[]).map((u:any)=><tr key={u.id}><td><b>{u.displayName||u.email||u.id.slice(-6)}</b><br/><small>{u.email||"wallet account"}</small></td><td>{u.status}</td><td>{u.tradingSettings?.autoCopyEnabled?"ON":"OFF"}</td><td>{u._count?.wallets??0}</td><td>{u._count?.follows??0}</td><td>{u._count?.positions??0}</td><td>{u.lastLoginAt?new Date(u.lastLoginAt).toLocaleString():"—"}</td><td><div className="table-actions"><button className="soft-action" onClick={()=>view(u.id)}>View</button><select value={u.status} onChange={e=>status(u.id,e.target.value)}><option>ACTIVE</option><option>SUSPENDED</option><option>CLOSED</option></select></div></td></tr>)}</tbody></table></section>
  {detailErr&&<div className="auth-error" style={{marginTop:10}}>{detailErr}</div>}
  {detail&&<section className="app-card admin-user-detail" style={{marginTop:10}}><div className="card-title"><div><span>USER DETAIL</span><h2>{detail.user.displayName||detail.user.email||detail.user.id}</h2></div><button className="soft-action" onClick={()=>setDetail(null)}>Close</button></div>
   <div className="app-grid-4"><div className="stat-card"><span>Trading Cash</span><b>{money(detail.summary.tradingCashUsd)}</b><small>{money(detail.summary.availableUsd)} available</small></div><div className="stat-card"><span>Live P&amp;L</span><b className={(detail.summary.realizedPnlUsd+detail.summary.unrealizedPnlUsd)>=0?"positive":"negative"}>{money(detail.summary.realizedPnlUsd+detail.summary.unrealizedPnlUsd)}</b><small>Realized + unrealized</small></div><div className="stat-card"><span>Live positions</span><b>{detail.summary.openLivePositions}</b><small>Simulation {detail.summary.simulationPositions}</small></div><div className="stat-card"><span>Auto Copy</span><b>{detail.user.tradingSettings?.autoCopyEnabled?"ON":"OFF"}</b><small>{detail.user.status}</small></div></div>
   <div className="admin-detail-grid"><div><h3>Wallets</h3>{detail.user.wallets.length?detail.user.wallets.map((w:any)=><div className="wallet-line" key={w.id}><div><b>{w.chain} · {w.address.slice(0,8)}…{w.address.slice(-6)}</b><small>{w.isPrimary?"Primary · ":""}{w.tradingEnabled?"Trading permission active":"No live trading permission"}</small></div></div>):<small>No linked wallets.</small>}</div><div><h3>Copied / watched traders</h3>{detail.user.follows.length?detail.user.follows.slice(0,12).map((f:any)=><div className="wallet-line" key={f.id}><div><b>{f.trader.displayName}</b><small>{f.mode} · {money(f.fixedAmountUsd)} per copy</small></div></div>):<small>No traders followed.</small>}</div></div>
  </section>}
 </>}
function TradersAdmin({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){const[open,setOpen]=useState(false);const[form,setForm]=useState<any>({displayName:"",handle:"",xHandle:"",category:"",wallet:"",chain:"SOLANA"});const[err,setErr]=useState("");
 async function add(e:React.FormEvent){e.preventDefault();setErr("");try{await apiFetch("/v1/admin/traders",{method:"POST",body:JSON.stringify({displayName:form.displayName,handle:form.handle,xHandle:form.xHandle,category:form.category,recommended:true,wallets:form.wallet?[{chain:form.chain,address:form.wallet,verified:true}]:[]})});setOpen(false);reload()}catch(e){setErr(plainError(e))}}
 async function patch(id:string,body:any){await apiFetch(`/v1/admin/traders/${id}`,{method:"PATCH",body:JSON.stringify(body)});reload()}
 return <>
  {admin&&<button className="action-primary" style={{padding:"10px 13px",borderRadius:12,marginBottom:12}} onClick={()=>setOpen(!open)}><Plus size={13}/> Add platform trader</button>}
  {open&&<section className="app-card" style={{marginBottom:10}}><form className="form-grid" onSubmit={add}><label className="field"><span>Name</span><input value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})} required/></label><label className="field"><span>Handle</span><input value={form.handle} onChange={e=>setForm({...form,handle:e.target.value})} required/></label><label className="field"><span>X handle</span><input value={form.xHandle} onChange={e=>setForm({...form,xHandle:e.target.value})}/></label><label className="field"><span>Category</span><input value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/></label><label className="field"><span>Chain</span><select value={form.chain} onChange={e=>setForm({...form,chain:e.target.value})}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option></select></label><label className="field"><span>Verified public wallet</span><input value={form.wallet} onChange={e=>setForm({...form,wallet:e.target.value})}/></label>{err&&<div className="auth-error span2">{err}</div>}<button className="action-primary span2" style={{height:42,borderRadius:12}}>Create trader</button></form></section>}
  <section className="app-card admin-table-wrap"><table className="admin-table trader-admin-table"><thead><tr><th>Trader</th><th>Source wallets</th><th>Followers</th><th>Signals</th><th>Featured</th><th>Recommended</th><th>Default</th><th>Enabled</th></tr></thead><tbody>{(d.traders||[]).map((t:any)=><tr key={t.id}><td><b>{t.displayName}</b><br/><small>@{t.handle}</small>{t.xHandle&&<><br/><small>X @{t.xHandle}</small></>}</td><td><TraderWalletControls trader={t} admin={admin} reload={reload}/></td><td>{t._count?.follows||0}</td><td>{t._count?.signals||0}</td><td><input type="checkbox" checked={t.featured} disabled={!admin} onChange={e=>patch(t.id,{featured:e.target.checked})}/></td><td><input type="checkbox" checked={t.recommended} disabled={!admin} onChange={e=>patch(t.id,{recommended:e.target.checked})}/></td><td><input type="checkbox" checked={t.defaultSelected} disabled={!admin} onChange={e=>patch(t.id,{defaultSelected:e.target.checked})}/></td><td><input type="checkbox" checked={t.enabled} disabled={!admin} onChange={e=>patch(t.id,{enabled:e.target.checked})}/></td></tr>)}</tbody></table></section>
 </>}
function TraderWalletControls({trader,admin,reload}:{trader:any;admin:boolean;reload:()=>void}){
 const[adding,setAdding]=useState(false),[chain,setChain]=useState("SOLANA"),[address,setAddress]=useState(""),[msg,setMsg]=useState("");
 async function add(){setMsg("");try{await apiFetch(`/v1/admin/traders/${trader.id}/wallets`,{method:"POST",body:JSON.stringify({chain,address,verified:true})});setAddress("");setAdding(false);reload()}catch(e){setMsg(plainError(e))}}
 async function remove(id:string){if(!confirm("Remove this public source wallet from the trader? Auto-copy monitoring for this mapping will stop."))return;setMsg("");try{await apiFetch(`/v1/admin/trader-wallets/${id}`,{method:"DELETE"});reload()}catch(e){setMsg(plainError(e))}}
 return <div className="trader-wallets-admin">
  {(trader.wallets||[]).length===0&&<small>No wallet mapped — tracking unavailable.</small>}
  {(trader.wallets||[]).map((w:any)=><div className="trader-wallet-chip" key={w.id}><span><b>{w.chain}</b><small>{String(w.address).slice(0,6)}…{String(w.address).slice(-5)} · {w.verified?"verified":"unverified"}</small></span>{admin&&<button title="Remove wallet" onClick={()=>remove(w.id)}>×</button>}</div>)}
  {admin&&!adding&&<button className="wallet-add-mini" onClick={()=>setAdding(true)}>+ Add source wallet</button>}
  {admin&&adding&&<div className="wallet-add-box"><select value={chain} onChange={e=>setChain(e.target.value)}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Public wallet address"/><div><button disabled={!address.trim()} onClick={add}>Save</button><button onClick={()=>{setAdding(false);setAddress("");setMsg("")}}>Cancel</button></div>{chain!=="SOLANA"&&<small>Adapter-ready only: this wallet can be registered, but Auto Copy stays unavailable until that chain listener is implemented.</small>}</div>}
  {msg&&<small className="negative">{msg}</small>}
 </div>
}
function Signals({d}:{d:any}){return <section className="app-card"><table className="admin-table"><thead><tr><th>Trader</th><th>Chain</th><th>Action</th><th>Token</th><th>Source price</th><th>Copies</th><th>Detected</th></tr></thead><tbody>{(d.signals||[]).map((s:any)=><tr key={s.id}><td>{s.trader?.displayName}</td><td>{s.chain}</td><td>{s.action}</td><td>{s.action==="BUY"?s.outputMint.slice(0,10):s.inputMint.slice(0,10)}…</td><td>{s.sourcePriceUsd?money(s.sourcePriceUsd):"Awaiting enrichment"}</td><td>{s._count?.copyDecisions||0}</td><td>{new Date(s.observedAt).toLocaleString()}</td></tr>)}</tbody></table></section>}
function Trades({d}:{d:any}){return <section className="app-card"><table className="admin-table"><thead><tr><th>User</th><th>Trader</th><th>Mode</th><th>Chain</th><th>Status</th><th>Venue</th><th>Created</th></tr></thead><tbody>{(d.orders||[]).map((o:any)=><tr key={o.id}><td>{o.user?.email||o.user?.displayName||o.userId.slice(-6)}</td><td>{o.decision?.signal?.trader?.displayName||"—"}</td><td>{o.mode}</td><td>{o.chain}</td><td>{o.status}</td><td>{o.venue||"—"}</td><td>{new Date(o.createdAt).toLocaleString()}</td></tr>)}{!(d.orders||[]).length&&<tr><td colSpan={7}>No trades recorded yet.</td></tr>}</tbody></table></section>}
function AdminPositions({d}:{d:any}){
 const[filter,setFilter]=useState("ALL");
 const rows=(d.positions||[]).filter((p:any)=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");
 return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>ALL USERS</span><h2>Open &amp; closed positions</h2></div><div className="performance-tabs">{["ALL","OPEN","CLOSED"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>
  <table className="admin-table"><thead><tr><th>User</th><th>Token</th><th>Chain</th><th>Mode</th><th>Status</th><th>Cost</th><th>Unrealized</th><th>Realized</th><th>Recovery</th><th>Opened</th></tr></thead><tbody>{rows.map((p:any)=>{const recovered=(p.profitTakenUsd||0)>=(p.costUsd||0)&&(p.costUsd||0)>0;return <tr key={p.id}><td>{p.user?.email||p.user?.displayName||p.userId.slice(-6)}</td><td><small>{p.mint.slice(0,8)}…</small></td><td>{p.chain}</td><td>{p.mode}</td><td>{String(p.status).replaceAll("_"," ")}</td><td>{money(p.costUsd)}</td><td className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)}</td><td className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</td><td>{p.status!=="CLOSED"?(recovered?"✓ Recovered":"Not yet"):"—"}</td><td>{new Date(p.openedAt).toLocaleString()}</td></tr>})}{!rows.length&&<tr><td colSpan={10}>No positions in this filter.</td></tr>}</tbody></table>
 </section>
}
function FailedTrades({d}:{d:any}){return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>EXECUTION SAFETY</span><h2>Failed / risk incidents</h2></div></div><table className="admin-table"><thead><tr><th>Severity</th><th>Scope</th><th>Chain</th><th>Token</th><th>Code</th><th>When</th></tr></thead><tbody>{(d.incidents||[]).map((i:any)=><tr key={i.id}><td><span className={`status-badge ${i.severity==="CRITICAL"?"watch":""}`}>{i.severity}</span></td><td>{i.scope}</td><td>{i.chain||"—"}</td><td>{i.mint?<small>{i.mint.slice(0,8)}…</small>:"—"}</td><td>{i.code}</td><td>{new Date(i.createdAt).toLocaleString()}</td></tr>)}{!(d.incidents||[]).length&&<tr><td colSpan={6}>No failed or risky executions recorded. Good sign.</td></tr>}</tbody></table></section>}
function Tokens({d}:{d:any}){return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>DISCOVERY</span><h2>Tokens MemeCloud has seen</h2></div></div><table className="admin-table"><thead><tr><th>Chain</th><th>Mint</th><th>Market cap</th><th>Liquidity</th><th>Holders</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>{(d.tokens||[]).map((t:any)=><tr key={t.id}><td>{t.chain}</td><td><small>{t.mint.slice(0,10)}…</small></td><td>{t.marketCapUsd?money(t.marketCapUsd):"—"}</td><td>{t.liquidityUsd?money(t.liquidityUsd):"—"}</td><td>{t.holders??"—"}</td><td>{t.discoveredAt?new Date(t.discoveredAt).toLocaleDateString():"—"}</td><td>{t.lastSeenAt?new Date(t.lastSeenAt).toLocaleString():"—"}</td></tr>)}{!(d.tokens||[]).length&&<tr><td colSpan={7}>No tokens discovered yet — needs a configured Solana RPC.</td></tr>}</tbody></table></section>}
function Whales({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){
 const[stage,setStage]=useState("ALL");
 const[open,setOpen]=useState(false);
 const[form,setForm]=useState<any>({chain:"SOLANA",address:"",label:""});
 const[err,setErr]=useState("");
 const rows=(d.candidates||[]).filter((c:any)=>stage==="ALL"?true:c.stage===stage);
 async function decide(id:string,action:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}/decision`,{method:"POST",body:JSON.stringify({action})});reload()}catch(e){setErr(plainError(e))}}
 async function relabel(id:string,label:string){try{await apiFetch(`/v1/admin/discovery/candidates/${id}`,{method:"PATCH",body:JSON.stringify({label})});reload()}catch(e){setErr(plainError(e))}}
 async function add(e:React.FormEvent){e.preventDefault();setErr("");try{await apiFetch("/v1/admin/discovery/candidates",{method:"POST",body:JSON.stringify(form)});setOpen(false);setForm({chain:"SOLANA",address:"",label:""});reload()}catch(e){setErr(plainError(e))}}
 return <>
  {admin&&<button className="action-primary" style={{padding:"10px 13px",borderRadius:12,marginBottom:12}} onClick={()=>setOpen(!open)}><Plus size={13}/> Add wallet manually</button>}
  {open&&<section className="app-card" style={{marginBottom:10}}><form className="form-grid" onSubmit={add}><label className="field"><span>Chain</span><select value={form.chain} onChange={e=>setForm({...form,chain:e.target.value})}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select></label><label className="field span2"><span>Wallet address</span><input value={form.address} onChange={e=>setForm({...form,address:e.target.value})} required/></label><label className="field"><span>Label (e.g. KOL name)</span><input value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/></label>{err&&<div className="auth-error span2">{err}</div>}<button className="action-primary span2" style={{height:42,borderRadius:12}}>Track wallet</button></form></section>}
  <div className="config-tabs" style={{marginBottom:12}}>{["ALL","DISCOVERED","PAPER_TRACKING","PROVEN","REJECTED","PAUSED"].map(s=><button key={s} className={stage===s?"active":""} onClick={()=>setStage(s)}>{s.replaceAll("_"," ")}</button>)}</div>
  <section className="app-card admin-table-wrap"><table className="admin-table"><thead><tr><th>Wallet</th><th>Chain</th><th>Label</th><th>Stage</th><th>Copyability</th><th>Realized P&amp;L</th><th>Source</th><th>Action</th></tr></thead><tbody>{rows.map((c:any)=><tr key={c.id}><td><small>{c.address.slice(0,6)}…{c.address.slice(-5)}</small></td><td>{c.chain}</td><td><input defaultValue={c.label||""} placeholder="Add label" disabled={!admin} onBlur={e=>{if(e.target.value!==(c.label||""))relabel(c.id,e.target.value)}} style={{background:"transparent",border:"1px solid var(--line)",borderRadius:8,padding:"4px 7px",color:"inherit",width:110,fontSize:9}}/></td><td><span className="status-badge">{c.stage.replaceAll("_"," ")}</span></td><td>{Math.round(c.copyabilityScore)}</td><td className={(c.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(c.realizedPnlUsd)}</td><td>{c.source}</td><td>{admin&&<div className="table-actions"><button className="soft-action" onClick={()=>decide(c.id,"PROVEN")}>Prove</button><button className="soft-action" onClick={()=>decide(c.id,"PAUSED")}>Pause</button><button className="soft-action" onClick={()=>decide(c.id,"REJECTED")}>Reject</button></div>}</td></tr>)}{!rows.length&&<tr><td colSpan={8}>No wallets in this stage yet.</td></tr>}</tbody></table></section>
 </>
}
const CFG_LABELS:Record<string,string>={brain:"Global Brain",marketData:"Market data",execution:"Trade routing",signer:"Delegated signer",discovery:"Discovery tuning",risk:"Risk defaults",fees:"Platform fee",email:"Email",push:"Push notifications",social:"X (social)",chains:"Chains",branding:"Branding"};
// Some keys have safe, intentional defaults (0 fee, generous risk limits, Solana-only chains) —
// "never saved" there means "using defaults," not "broken," per the no-conventional-caps philosophy.
const CFG_DEFAULTS_OK=new Set(["risk","fees","chains","branding","discovery"]);
// These already run against public/default providers baked into the workers, so absence in
// AppConfig doesn't mean the feature is down — it means no dedicated key has been added yet.
// NOTE: this only means "won't hard-fail" — it must never be shown as "Connected" without a real test.
const CFG_WORKS_WITHOUT_KEY=new Set(["marketData","execution"]);
const CFG_OPTIONAL=new Set(["social","signer"]);
// Sections backed by an external provider MemeCloud can actually probe. "Connected" is only ever
// shown here, and only once a real test (persisted server-side in testResults) has passed.
const LIVE_TESTABLE=new Set(["marketData","execution","signer","social","brain","push","email"]);
// Must mirror apps/api/src/server.ts SECRET_FIELDS exactly — these are the fields that get
// masked "Saved securely ••••" display + Replace/Remove, never a plain always-empty password box.
const SECRET_FIELDS_FRONTEND:Record<string,string[]>={
 execution:["jupiterApiKey","zeroXApiKey"],
 signer:["privyAppSecret","privyAuthorizationPrivateKey"],
 social:["xBearerToken","xOAuthClientSecret"],
 // RPC URLs are secret-masked too — a paid RPC URL commonly embeds the provider's API key as a
 // query param, so displaying it in the clear leaks that key right back out. Must mirror
 // apps/api/src/server.ts SECRET_FIELDS.marketData exactly.
 marketData:["heliusApiKey","birdeyeApiKey","solanaRpc","heliusRpc","fallbackRpc"],
 email:["pass"]
};
// Named sub-items shown as a persistent, truthful per-provider breakdown. testKey, when present,
// ties the item to a real testResults entry — that's the ONLY way an item can ever reach
// "Connected". neverConnected caps an item at "Saved — not verified": X account-linking (OAuth)
// has no server-to-server health check, so it must never claim to be genuinely "Connected" the
// way a bearer-token API call can prove.
const ITEM_SUMMARY:Record<string,{name:string;secretField?:string;valueField?:string;disabledValue?:string;testKey?:string;neverConnected?:boolean}[]>={
 execution:[{name:"Jupiter",secretField:"jupiterApiKey",testKey:"jupiter"},{name:"0x",secretField:"zeroXApiKey",testKey:"zeroX"}],
 marketData:[{name:"Solana RPC (yours)",valueField:"solanaRpc",testKey:"rpc"},{name:"Helius",secretField:"heliusApiKey",testKey:"helius"},{name:"Birdeye",secretField:"birdeyeApiKey",testKey:"birdeye"}],
 social:[{name:"X bearer token (API)",secretField:"xBearerToken",testKey:"x"},{name:"X OAuth (account linking)",secretField:"xOAuthClientSecret",neverConnected:true}],
 signer:[{name:"Privy credentials",secretField:"privyAppSecret",testKey:"privy"}],
 brain:[{name:"BNB RPC",valueField:"bnbWs",testKey:"bnb"},{name:"Ethereum RPC",valueField:"ethWs",testKey:"eth"}]
};
// The real, honest status of one named sub-item — never "Connected" without a fresh passing test.
// A provider's persisted state from the server is now {verified, health}, not a single flat
// attempt — verified is the last genuine PASS, pinned to a config fingerprint, and never erased
// by a later failure; health is the single most recent attempt. `verified.stale` (computed
// server-side, since only the server can see the real secret values a fingerprint is built from)
// means the saved config has changed since that pass and it no longer applies.
type ProviderState="connected"|"unreachable"|"changed"|"neverPassed"|"untested";
// health.stale/verified.stale mean "this record's fingerprint no longer matches what's saved
// now" — computed server-side, the only place that can see the real values a fingerprint covers.
// A fresh (non-stale) health record is always the most direct evidence, since it reflects an
// attempt against the CURRENTLY saved config specifically — trust it first. Only fall back to a
// standing verification, or to "changed", when there's no fresh attempt to go on yet.
function classifyProvider(status:any):ProviderState{
 const v=status?.verified,h=status?.health;
 const vFresh=v&&!v.stale,hFresh=h&&!h.stale;
 if(hFresh&&h.ok)return"connected";
 if(hFresh&&!h.ok)return vFresh?"unreachable":"neverPassed";
 if(vFresh)return"connected";
 if(v)return"changed";
 return"untested";
}
function itemStatus(item:{secretField?:string;valueField?:string;disabledValue?:string;testKey?:string;neverConnected?:boolean},current:any,liveForm:any):{label:string;tone:"good"|"watch"|"follow"}{
 const hasValue=item.secretField?Boolean((current?.secretHints as any)?.[item.secretField]):(item.valueField?Boolean(liveForm?.[item.valueField])&&liveForm[item.valueField]!==item.disabledValue:false);
 if(item.testKey){
  const status=(current?.testResults as any)?.[item.testKey];
  const kind=classifyProvider(status);
  if(kind==="connected")return{label:"Connected",tone:"good"};
  if(kind==="unreachable")return{label:"Connection issue — previously verified",tone:"watch"};
  if(kind==="changed")return{label:"Configuration changed — verify again",tone:"follow"};
  if(kind==="neverPassed")return{label:"Connection failed",tone:"watch"};
 }
 if(!hasValue)return{label:"Not set up",tone:item.neverConnected?"follow":"watch"};
 return{label:"Saved — not verified",tone:"follow"};
}
function summarizeProviders(testResults:any):{tested:boolean;allConnected:boolean;anyConnected:boolean;anyUnreachable:boolean;anyChanged:boolean;anyNeverPassed:boolean;latestAt?:string}{
 const empty={tested:false,allConnected:false,anyConnected:false,anyUnreachable:false,anyChanged:false,anyNeverPassed:false};
 if(!testResults||typeof testResults!=="object")return empty;
 const entries=Object.values(testResults).filter((e:any)=>e&&typeof e==="object"&&("verified"in e||"health"in e)) as any[];
 if(!entries.length)return empty;
 const kinds=entries.map(classifyProvider);
 const latestAt=entries.map((e:any)=>e?.verified?.checkedAt||e?.health?.checkedAt).filter(Boolean).sort().slice(-1)[0];
 return{
  tested:true,
  allConnected:kinds.every(k=>k==="connected"),
  anyConnected:kinds.some(k=>k==="connected"),
  anyUnreachable:kinds.some(k=>k==="unreachable"),
  anyChanged:kinds.some(k=>k==="changed"),
  anyNeverPassed:kinds.some(k=>k==="neverPassed"),
  latestAt
 };
}
// Exact vocabulary requested: Not set up / Saved — not verified / Connected / Connection failed /
// Configuration changed / Connection issue — previously verified / Using public fallback /
// Restart required (its own pill, see restartPill below). "good" tone is reserved for a state
// that is ACTUALLY true right now, never for "a row exists," and — just as importantly — a
// standing verification is never downgraded just because time passed with nothing changing.
function cfgStatus(k:string,current:any):{label:string;tone:"good"|"watch"|"follow";detail:string}{
 if(LIVE_TESTABLE.has(k)){
  const s=summarizeProviders(current?.testResults);
  if(s.tested){
   if(s.anyNeverPassed)return{label:"Connection failed",tone:"watch",detail:"At least one provider in this section has never passed a real test — see the breakdown below"};
   if(s.anyChanged)return{label:"Configuration changed",tone:"follow",detail:"Saved values changed since the last passing test — press Test connection"};
   if(s.anyUnreachable)return{label:"Connection issue — previously verified",tone:"watch",detail:"A recent automatic check failed, but this genuinely passed before — see the breakdown below"};
   if(s.allConnected)return{label:"Connected",tone:"good",detail:s.latestAt?`Verified ${new Date(s.latestAt).toLocaleString()}`:"Verified"};
   return{label:"Saved — not verified",tone:"follow",detail:"Required values are saved but have not passed a real test yet — press Test connection"};
  }
  if(current)return{label:"Saved — not verified",tone:"follow",detail:"Required values are saved but have not passed a real test yet — press Test connection"};
  if(CFG_WORKS_WITHOUT_KEY.has(k))return{label:"Using public fallback",tone:"follow",detail:"No key saved — running on MemeCloud's shared public default, not your own"};
  if(CFG_OPTIONAL.has(k))return{label:"Not set up",tone:"follow",detail:"Optional — MemeCloud runs without this"};
  return{label:"Not set up",tone:"watch",detail:"Required configuration/credentials are missing"};
 }
 if(current)return{label:"Configured",tone:"good",detail:`Updated ${new Date(current.updatedAt).toLocaleDateString()}`};
 if(CFG_DEFAULTS_OK.has(k))return{label:"Using defaults",tone:"good",detail:"Sensible defaults active — nothing required"};
 return{label:"Not set up",tone:"watch",detail:"Not configured yet"};
}
function restartPill(current:any):{label:string;show:boolean}{
 return {show:Boolean(current?.restartPending),label:"Restart required"};
}
// Worst-of aggregation: a whole section can only ever be as trustworthy as its weakest real
// dependency — "Ready" requires every sub-item to be genuinely Connected, not merely saved.
function categoryStatus(keys:string[],configArr:any[]):{label:string;tone:"good"|"watch"|"follow"}{
 const relevant=keys.filter(k=>!CFG_OPTIONAL.has(k));
 const statuses=relevant.map(k=>cfgStatus(k,(configArr||[]).find((x:any)=>x.key===k)));
 const restartPending=relevant.some(k=>(configArr||[]).find((x:any)=>x.key===k)?.restartPending);
 if(statuses.some(s=>s.tone==="watch"))return{label:"Needs setup",tone:"watch"};
 if(restartPending)return{label:"Restart required",tone:"follow"};
 if(statuses.some(s=>s.tone==="follow"))return{label:"Setup incomplete",tone:"follow"};
 return{label:"Ready",tone:"good"};
}
const SETTINGS_CATEGORIES=[
 {id:"trading",label:"Trading preferences",blurb:"Fees and platform-wide risk defaults.",keys:["fees","risk"]},
 {id:"networks",label:"Networks",blurb:"Where MemeCloud watches and trades.",keys:["chains","marketData","brain"]},
 {id:"intelligence",label:"Market intelligence",blurb:"Global Brain, discovery and social evidence.",keys:["brain","discovery","social"]},
 {id:"wallets",label:"Wallets & execution",blurb:"Trade routing and delegated live signing.",keys:["execution","signer"]},
 {id:"integrations",label:"Integrations",blurb:"Every external provider MemeCloud can use.",keys:["marketData","execution","social","email","push"]},
 {id:"notifications",label:"Notifications",blurb:"Email and push delivery.",keys:["email","push"]},
 {id:"branding",label:"Branding",blurb:"Public app name and support contact.",keys:["branding"]},
] as const;
function Config({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){
 const[screen,setScreen]=useState<"home"|"category"|"detail">("home");
 const[activeCat,setActiveCat]=useState<string>("");
 const[key,setKey]=useState("email"),[form,setForm]=useState<any>({}),[msg,setMsg]=useState(""),[testEmail,setTestEmail]=useState(""),[testing,setTesting]=useState(false);
 const[sessionExpired,setSessionExpired]=useState(false);
 const[saving,setSaving]=useState(false);
 // A 401 here means the token died mid-edit. Never silently redirect: that would wipe an
 // unsaved secret with no warning. Show it inline, keep the typed value on screen, and let the
 // operator choose when to leave for /login — nothing was saved, and this says so explicitly.
 function reportError(e:any,isSave=false){
  if(e?.status===401){setSessionExpired(true);setMsg("Your session ended before this could be saved — nothing was saved. Your typed values are still here; sign in again in another tab, or use the button below, then retry.")}
  else setMsg((isSave?"Save failed — configuration was not stored. ":"")+plainError(e));
 }
 const[secretMode,setSecretMode]=useState<Record<string,"view"|"edit">>({});
 const[removedFields,setRemovedFields]=useState<Set<string>>(new Set());
 function setFieldMode(name:string,mode:"view"|"edit"){setSecretMode(x=>({...x,[name]:mode}))}
 function toggleRemove(name:string,removed:boolean){setRemovedFields(prev=>{const n=new Set(prev);if(removed)n.add(name);else n.delete(name);return n});if(removed)field(name,"")}
 function openCategory(id:string){const cat=SETTINGS_CATEGORIES.find(c=>c.id===id);if(!cat)return;setActiveCat(id);if(cat.keys.length===1){setKey(cat.keys[0]);setScreen("detail")}else setScreen("category")}
 function openKey(k:string){setKey(k);setScreen("detail")}
 function backToHome(){setScreen("home");setMsg("")}
 function backToCategory(){setScreen("category");setMsg("")}
 const providerInfo:Record<string,{purpose:string;links:{label:string;url:string}[]}>={
  marketData:{purpose:"Watches Solana transactions and prices in real time.",links:[{label:"Get a Solana RPC",url:"https://solana.com/rpc"},{label:"Get Helius RPC",url:"https://www.helius.dev/"},{label:"Get Birdeye key",url:"https://docs.birdeye.so/docs/authentication-api-keys"}]},
  execution:{purpose:"Gets executable Solana swap quotes and routes for real buys/sells.",links:[{label:"Jupiter docs",url:"https://dev.jup.ag/"},{label:"0x API key",url:"https://dashboard.0x.org/"}]},
  signer:{purpose:"Allows authorized unattended (delegated) live trading. Keep live mode off until this is verified.",links:[{label:"Get Privy credentials",url:"https://docs.privy.io/"}]},
  social:{purpose:"Tracks meme hype and mention velocity on X.",links:[{label:"Get X API access",url:"https://developer.x.com/en/portal/dashboard"}]},
  brain:{purpose:"BNB/Ethereum WebSocket RPCs let the Global Brain watch meme trades on those chains.",links:[{label:"BNB RPC providers",url:"https://www.bnbchain.org/en/developers"},{label:"Ethereum RPC providers",url:"https://ethereum.org/en/developers/docs/nodes-and-clients/nodes-as-a-service/"}]},
  email:{purpose:"Sends account emails: verification, password reset, alerts.",links:[]},
  push:{purpose:"Sends browser push notifications to users.",links:[]},
  discovery:{purpose:"Tunes which tokens the discovery/scoring workers pay attention to.",links:[]},
  risk:{purpose:"Platform-wide safety defaults. 0 disables a cap.",links:[]},
  fees:{purpose:"Platform trading fee, disclosed to users.",links:[]},
  chains:{purpose:"Which chains are enabled for Auto Copy.",links:[]},
  branding:{purpose:"Public app name and support contact shown to users.",links:[]}
 };
 const testableKeys=["marketData","execution","signer","social","brain"];
 // Test results are read from current.testResults (server-persisted, refetched via reload()) —
 // never local-only state — so the breakdown shown is always the real, currently-saved outcome.
 async function testConnection(){setTesting(true);setMsg("");setSessionExpired(false);try{await apiFetch<any>(`/v1/admin/config/${key}/test`,{method:"POST"});reload()}catch(e){reportError(e)}finally{setTesting(false)}}
 async function ackRestart(){try{await apiFetch(`/v1/admin/config/${key}/ack-restart`,{method:"POST"});reload()}catch(e){reportError(e)}}
 const current=(d.config||[]).find((c:any)=>c.key===key);
 const templates:any={
  brain:{autoEntryScore:76,notifyScore:65,snapshotMaxAgeMs:45000,solanaChainWideEnabled:true,solanaFlowConcurrency:12,profileTradeUsd:5000,bnbWs:"",ethWs:"",bnbUsd:0,ethUsd:0},
  email:{host:"",port:587,secure:false,user:"",pass:"",from:""},
  push:{subject:""},
  marketData:{solanaRpc:"",heliusRpc:"",heliusRpcAutoManaged:false,heliusApiKey:"",birdeyeApiKey:"",fallbackRpc:""},
  execution:{jupiterBaseUrl:"https://api.jup.ag",jupiterApiKey:"",zeroXApiKey:"",signerProvider:"disabled"},
  signer:{privyAppId:"",privyAppSecret:"",privyAuthorizationPrivateKey:"",privySignerId:"",privyPolicyId:"",sponsorGas:false},
  discovery:{minLiquidityUsd:20000,minMarketCapUsd:75000,maxMarketCapUsd:25000000,tokenScanLimit:40,topTradersPerToken:20,paperMinScore:68,provenMinScore:78,provenMinForwardSamples:20,provenMinForwardMeanPct:5},
  social:{xBearerToken:"",xOAuthClientId:"",xOAuthClientSecret:"",xOAuthCallbackUrl:""},
  chains:{enabled:["SOLANA"]},
  fees:{platformFeeBps:0},
  risk:{emergencyNewEntriesPaused:false,freshMemeBaseChasePct:40,hyperMaxChasePct:55,maxExecutablePriceImpactPct:35},
  branding:{appName:"MemeCloud",supportEmail:"",publicUrl:""}
 };
 useEffect(()=>{
  // The backend already strips only the listed secret fields (server.ts SECRET_FIELDS) from
  // current.value — every other field (jupiterBaseUrl, solanaRpc, signerProvider, ...) is real and
  // must populate the form, even for an isSecret-flagged section. Secret fields land here as
  // undefined and are handled separately via secretProps()/SecretField.
  const visible=current?.value&&typeof current.value==="object"?current.value:{};
  setForm({...templates[key],...visible});setMsg("");setSecretMode({});setRemovedFields(new Set());
 // current changes when Admin data reloads; key is the operator-selected section.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,current?.updatedAt]);
 function field(name:string,value:any){setForm((x:any)=>({...x,[name]:value}))}
 function secretProps(name:string){
  const hint=(current?.secretHints as any)?.[name]??null;
  return {
   value:form[name],hint,removed:removedFields.has(name),mode:(secretMode[name]??"view") as "view"|"edit",
   onChange:(v:string)=>field(name,v),
   onReplace:()=>setFieldMode(name,"edit"),
   onCancel:()=>{setFieldMode(name,"view");field(name,"")},
   onRemove:()=>toggleRemove(name,true),
   onUndo:()=>toggleRemove(name,false)
  };
 }
 async function save(){
  setMsg("Saving…");setSessionExpired(false);setSaving(true);
  try{
   const secretFields=SECRET_FIELDS_FRONTEND[key]??[];
   const payload:any={...form};
   for(const f of secretFields){
    if(removedFields.has(f)){payload[f]=null;continue}
    // form[f] only ever holds a real value when the user actually typed one — secret fields
    // always start blank (see the useEffect below) whether never-saved or saved-and-masked, so
    // checking secretMode==="edit" here was wrong: that mode is only reachable via "Replace key",
    // which never appears for a field with no prior hint. That silently dropped every first-time
    // secret entry from the save payload — the exact bug that made Helius/Birdeye look unsaved.
    if(!form[f]){delete payload[f];continue} // nothing typed -> omit, preserve whatever's already saved
   }
   const r=await apiFetch<any>(`/v1/admin/config/${key}`,{method:"PUT",body:JSON.stringify(payload)});
   const items=ITEM_SUMMARY[key];
   const summary=items?" — "+items.map(it=>`${it.name}: ${itemStatus(it,r.config,payload).label}`).join(", "):"";
   setMsg(`Saved successfully. ${CFG_LABELS[key]||key} persisted.`+(r.restartRequired?" Restart the affected VPS worker(s) to apply this change.":"")+summary);
   reload(); // background:true — refetches the real persisted record without unmounting this screen
  }catch(e){reportError(e,true)}finally{setSaving(false)}
 }
 async function vapid(){setSessionExpired(false);try{if(form.subject)await apiFetch("/v1/admin/config/push",{method:"PUT",body:JSON.stringify({subject:form.subject})});const r=await apiFetch<any>("/v1/admin/push/generate",{method:"POST"});setMsg(`VAPID ready. Public key ${r.publicKey.slice(0,18)}…`);reload()}catch(e){reportError(e)}}
 async function testPush(){setSessionExpired(false);try{const r=await apiFetch<any>("/v1/admin/test-push",{method:"POST"});setMsg(r.result?.sent>0?`✓ Test push sent (${r.result.sent} sent, ${r.result.failed||0} failed).`:`✗ Test push failed to send (0 sent, ${r.result?.failed||0} failed).`);reload()}catch(e){reportError(e)}}
 async function emailTest(){setSessionExpired(false);try{if(!testEmail)throw new Error("Enter a test email address.");await apiFetch("/v1/admin/test-email",{method:"POST",body:JSON.stringify({to:testEmail})});setMsg("✓ SMTP provider accepted the test email.");reload()}catch(e){if((e as any)?.status===401)reportError(e);else setMsg(`✗ ${plainError(e)}`)}}
 const toggleChain=(c:string)=>field("enabled",(form.enabled||[]).includes(c)?(form.enabled||[]).filter((x:string)=>x!==c):[...(form.enabled||[]),c]);
 const[liveReadiness,setLiveReadiness]=useState<any>(null);
 async function loadLiveReadiness(){try{setLiveReadiness(await apiFetch<any>("/v1/admin/live-readiness"))}catch{}}
 useEffect(()=>{void loadLiveReadiness()},[]);
 const[liveTradingBusy,setLiveTradingBusy]=useState(false);
 const[liveTradingMsg,setLiveTradingMsg]=useState("");
 async function enableLiveTrading(){
  setLiveTradingBusy(true);setLiveTradingMsg("");
  try{await apiFetch("/v1/admin/live-trading/enable",{method:"POST"});setLiveTradingMsg("Live Solana trading is ON.");await loadLiveReadiness()}
  catch(e:any){setLiveTradingMsg(e?.body?.reasons?Array.isArray(e.body.reasons)?e.body.reasons.join(" "):plainError(e):plainError(e))}
  finally{setLiveTradingBusy(false)}
 }
 async function disableLiveTrading(){
  setLiveTradingBusy(true);setLiveTradingMsg("");
  try{await apiFetch("/v1/admin/live-trading/disable",{method:"POST"});setLiveTradingMsg("Live Solana trading is OFF.");await loadLiveReadiness()}
  catch(e:any){setLiveTradingMsg(plainError(e))}
  finally{setLiveTradingBusy(false)}
 }
 const REQUIRED_SUMMARY:[string,string][]=[["marketData","Blockchain data"],["execution","Trade routing"],["discovery","Discovery"],["push","Notifications"],["email","Email"]];
 const readyCount=REQUIRED_SUMMARY.filter(([k])=>cfgStatus(k,(d.config||[]).find((x:any)=>x.key===k)).tone==="good").length;
 const activeCatDef=SETTINGS_CATEGORIES.find(c=>c.id===activeCat);
 const badgeClass=(tone:"good"|"watch"|"follow")=>`status-badge ${tone==="good"?"":tone}`;
 return <div className="settings-shell">
  {sessionExpired&&<section className="app-card" style={{borderColor:"#c0392b"}}>
   <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
    <span>{msg||"Your session ended. Nothing was lost — copy anything you were typing, then sign in again."}</span>
    <a className="soft-action" href="/login/">Sign in again</a>
   </div>
  </section>}
  {screen==="home"&&<>
   <section className="app-card settings-home-head">
    <h2>Settings</h2><p>Manage how MemeCloud trades, connects and communicates.</p>
    <div className="settings-summary">
     <span>SYSTEM SETUP</span><b>{readyCount} of {REQUIRED_SUMMARY.length} ready</b>
     <div className="settings-summary-rows">{REQUIRED_SUMMARY.map(([k,label])=>{const st=cfgStatus(k,(d.config||[]).find((x:any)=>x.key===k));return <div key={k}><span>{label}</span><em className={badgeClass(st.tone)}>{st.label}</em></div>})}</div>
    </div>
   </section>
   <section className="app-card">
    <div className="card-title"><div><span>OWNER ONLY</span><h2>Solana live-trading readiness</h2></div>
     <span className={badgeClass(liveReadiness?.ready?"good":"watch")}>{liveReadiness?liveReadiness.ready?"Ready for live trading":"Not ready for live trading":"Checking…"}</span>
    </div>
    {liveReadiness&&<>
     <div className="settings-summary-rows">
      <div><span>Solana RPC</span><em className={badgeClass(liveReadiness.dependencies.rpc?"good":"watch")}>{liveReadiness.dependencies.rpc?"Connected":"Not verified"}</em></div>
      <div><span>Jupiter</span><em className={badgeClass(liveReadiness.dependencies.jupiter?"good":"watch")}>{liveReadiness.dependencies.jupiter?"Connected":"Not verified"}</em></div>
      <div><span>Signer credentials (Privy)</span><em className={badgeClass(liveReadiness.dependencies.signerCredentialsConnected?"good":"watch")}>{liveReadiness.dependencies.signerCredentialsConnected?"Connected":"Not verified"}</em></div>
      <div><span>Wallets with active delegated permission</span><em className={badgeClass(liveReadiness.dependencies.walletsWithActivePermission>0?"good":"watch")}>{liveReadiness.dependencies.walletsWithActivePermission}</em></div>
     </div>
     <div className="settings-summary-rows">
      {liveReadiness.workers.map((w:any)=><div key={w.name}><span>{w.name}</span><em className={badgeClass(w.running?"good":"watch")}>{w.running?"Running":"Not running"}</em></div>)}
     </div>
     {!liveReadiness.ready&&liveReadiness.reasons.length>0&&<div className="notice">{liveReadiness.reasons.map((r:string)=><div key={r}>{r}</div>)}</div>}
     <div className="notice">{liveReadiness.note}</div>
     <button type="button" className="soft-action" onClick={loadLiveReadiness}>Refresh</button>
     <div className="card-title" style={{marginTop:16}}><div><span>MASTER SWITCH</span><h2>Live Solana trading</h2></div>
      <span className={badgeClass(liveReadiness.liveTradingEnabled?"good":"follow")}>{liveTradingBusy?"Working…":liveReadiness.liveTradingEnabled?"ON":"OFF"}</span>
     </div>
     <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span>{liveReadiness.liveTradingEnabled?"Executor and exits will sign and submit real transactions for any user with an active delegated permission.":"Executor and exits currently skip every live decision — this is the real switch, checked fresh on every trade, no VPS restart needed either way."}</span>
      {admin&&(liveReadiness.liveTradingEnabled
       ?<button type="button" className="action-primary" style={{background:"#c0392b"}} disabled={liveTradingBusy} onClick={disableLiveTrading}>Turn OFF</button>
       :<button type="button" className="action-primary" disabled={liveTradingBusy||!liveReadiness.ready} onClick={enableLiveTrading} title={!liveReadiness.ready?liveReadiness.reasons.join(" "):""}>{liveReadiness.ready?"Turn ON":"Not ready yet"}</button>)}
     </div>
     {/* A disabled button with only a hover title explains nothing on a touch device — this is
         the same information as the reasons list above, repeated right next to the control it
         actually blocks, since that's the one place an owner will look when "Turn ON" doesn't
         seem to do anything. */}
     {!liveReadiness.liveTradingEnabled&&!liveReadiness.ready&&liveReadiness.reasons.length>0&&
      <div className="notice" style={{borderColor:"rgba(247,185,95,.25)"}}>
       <b style={{display:"block",marginBottom:4,fontSize:11}}>Turn ON is disabled until these are resolved:</b>
       {liveReadiness.reasons.map((r:string)=><div key={r}>{r}</div>)}
      </div>}
     {liveTradingMsg&&<div className="notice">{liveTradingMsg}</div>}
    </>}
   </section>
   <section className="app-card"><div className="settings-cat-list">
    {SETTINGS_CATEGORIES.map(cat=>{const st=categoryStatus(cat.keys as unknown as string[],d.config||[]);return <button key={cat.id} className="settings-cat-row" onClick={()=>openCategory(cat.id)}>
     <div><b>{cat.label}</b><small>{cat.blurb}</small></div>
     <span className={badgeClass(st.tone)}>{st.label}</span>
     <ChevronRight size={16}/>
    </button>})}
   </div></section>
  </>}
  {screen==="category"&&activeCatDef&&<section className="app-card">
   <button className="back-link" onClick={backToHome}>← Settings</button>
   <h2 style={{margin:"6px 0 2px"}}>{activeCatDef.label}</h2><p style={{margin:"0 0 14px",fontSize:11,color:"#8a8fa0"}}>{activeCatDef.blurb}</p>
   <div className="settings-cat-list">{Array.from(new Set(activeCatDef.keys)).map(k=>{const c=(d.config||[]).find((x:any)=>x.key===k);const st=cfgStatus(k,c);return <button key={k} className="settings-cat-row" onClick={()=>openKey(k)}>
    <div><b>{CFG_LABELS[k]||k}</b><small>{providerInfo[k]?.purpose||st.detail}</small></div>
    <span className={badgeClass(st.tone)}>{st.label}</span>
    <ChevronRight size={16}/>
   </button>})}</div>
  </section>}
  {screen==="detail"&&<section className="app-card">
   <button className="back-link" onClick={activeCatDef&&activeCatDef.keys.length>1?backToCategory:backToHome}>← {activeCatDef&&activeCatDef.keys.length>1?activeCatDef.label:"Settings"}</button>
   <div className="card-title" style={{marginTop:8}}><div><span>{activeCatDef?.label.toUpperCase()||"SETTINGS"}</span><h2>{CFG_LABELS[key]||key}</h2></div><span style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span className={badgeClass(cfgStatus(key,current).tone)}>{cfgStatus(key,current).label}</span>{restartPill(current).show&&<span className={badgeClass("follow")}>Restart required</span>}</span></div>
   {restartPill(current).show&&<div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
    <span>This was saved, but the running MemeCloud VPS worker(s) still have the old value in memory until restarted.</span>
    <button type="button" className="soft-action" onClick={ackRestart}>I restarted it</button>
   </div>}
   {providerInfo[key]&&<div className="notice" style={{display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between"}}>
    <span>{providerInfo[key].purpose}</span>
    <span style={{display:"flex",gap:8,flexWrap:"wrap"}}>
     {testableKeys.includes(key)&&<button type="button" className="soft-action" disabled={testing} onClick={testConnection}>{testing?"Testing…":"Test connection"}</button>}
     {providerInfo[key].links.map(l=><a key={l.url} className="soft-action" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
    </span>
   </div>}
   {ITEM_SUMMARY[key]&&<div className="settings-summary-rows" style={{margin:"0 0 14px"}}>
    {ITEM_SUMMARY[key].map(it=>{const st=itemStatus(it,current,form);return <div key={it.name}><span>{it.name}</span><em className={badgeClass(st.tone)}>{st.label}</em></div>})}
   </div>}
   {current?.testResults&&Object.keys(current.testResults).length>0&&<div className="app-card" style={{padding:12,marginBottom:14}}>
    <div style={{fontSize:11,color:"#8a8fa0",marginBottom:6}}>VERIFICATION STATUS</div>
    {Object.entries(current.testResults as Record<string,any>).map(([name,status])=>{
     const kind=classifyProvider(status);
     const v=(status as any)?.verified,h=(status as any)?.health;
     const label=kind==="connected"?"Connected":kind==="unreachable"?"Connection issue — previously verified":kind==="changed"?"Configuration changed — verify again":kind==="neverPassed"?"Connection failed":"Not tested yet";
     const cls=kind==="connected"?"positive":kind==="unreachable"||kind==="changed"?"":"negative";
     const shownAt=v?.checkedAt;
     const noteMsg=kind==="unreachable"?h?.message:(h?.message||v?.message);
     return <div key={name}>
      <div style={{display:"flex",justifyContent:"space-between",gap:10,fontSize:12,padding:"4px 0",borderTop:"1px solid var(--line)"}}>
       <span style={{textTransform:"capitalize"}}>{name}</span>
       <span className={cls}>{label}{h?.httpStatus?` · HTTP ${h.httpStatus}`:""}{typeof h?.latencyMs==="number"?` · ${h.latencyMs}ms`:""}</span>
       <span style={{color:"#8a8fa0"}}>{shownAt?`Verified ${new Date(shownAt).toLocaleDateString()}`:""}</span>
      </div>
      {kind!=="connected"&&noteMsg&&<div className="notice" style={{marginTop:2,marginBottom:6}}>{name}: {noteMsg}</div>}
     </div>;
    })}
   </div>}
   <div className="admin-form">
    {key==="brain"&&<><div className="form-grid"><Cfg label="Auto-entry score (1-100)" type="number" value={form.autoEntryScore} on={v=>field("autoEntryScore",Math.max(1,Math.min(100,Number(v))))}/><Cfg label="Notify score (1-100)" type="number" value={form.notifyScore} on={v=>field("notifyScore",Math.max(1,Math.min(100,Number(v))))}/><Cfg label="Max market snapshot age ms" type="number" value={form.snapshotMaxAgeMs} on={v=>field("snapshotMaxAgeMs",Math.max(5000,Number(v)))}/><Cfg label="Large-wallet profiling starts at trade USD" type="number" value={form.profileTradeUsd} on={v=>field("profileTradeUsd",Math.max(0,Number(v)))}/><Cfg label="Solana scan concurrency" type="number" value={form.solanaFlowConcurrency} on={v=>field("solanaFlowConcurrency",Math.max(2,Number(v)))}/><Cfg label="BNB WebSocket RPC" value={form.bnbWs} placeholder="wss://..." on={v=>field("bnbWs",v)}/><Cfg label="Ethereum WebSocket RPC" value={form.ethWs} placeholder="wss://..." on={v=>field("ethWs",v)}/><Cfg label="BNB USD reference (optional)" type="number" value={form.bnbUsd} on={v=>field("bnbUsd",Number(v))}/><Cfg label="ETH USD reference (optional)" type="number" value={form.ethUsd} on={v=>field("ethUsd",Number(v))}/></div><label className="check-line"><input type="checkbox" checked={Boolean(form.solanaChainWideEnabled)} onChange={e=>field("solanaChainWideEnabled",e.target.checked)}/><span>Scan chain-wide Solana swap flow</span></label><div className="notice">0 caps in user trading settings mean unlimited by MemeCloud. The brain scores what money is doing now; it does not reject a meme simply because it already pumped hard or survived a deep dip. Leave BNB/Ethereum RPC blank to keep those chains in "prepared, not scanning" state.</div></>}
    {key==="email"&&<><Cfg label="SMTP host" value={form.host} on={v=>field("host",v)}/><div className="form-grid"><Cfg label="Port" type="number" value={form.port} on={v=>field("port",Number(v))}/><label className="field"><span>TLS / secure</span><select value={String(Boolean(form.secure))} onChange={e=>field("secure",e.target.value==="true")}><option value="false">STARTTLS / port 587</option><option value="true">TLS / port 465</option></select></label></div><Cfg label="SMTP username" value={form.user} on={v=>field("user",v)}/><SecretField label="SMTP password" {...secretProps("pass")}/><Cfg label="From" placeholder="MemeCloud <hello@example.com>" value={form.from} on={v=>field("from",v)}/></>}
    {key==="push"&&<><Cfg label="VAPID subject" value={form.subject} placeholder="mailto:admin@example.com" on={v=>field("subject",v)}/><div className="notice">Use Generate VAPID below. The private key stays encrypted server-side; users receive only the public key.</div></>}
    {key==="marketData"&&<><SecretField label="Solana RPC (primary — a paid RPC URL usually embeds your API key, so it's masked like any other credential)" {...secretProps("solanaRpc")}/><SecretField label="Helius RPC (advanced — leave unset to auto-derive from the API key below)" {...secretProps("heliusRpc")}/><SecretField label="Helius API key" {...secretProps("heliusApiKey")}/><SecretField label="Birdeye API key" {...secretProps("birdeyeApiKey")}/><SecretField label="Fallback RPC" {...secretProps("fallbackRpc")}/><div className="notice">Every MemeCloud worker uses Solana RPC in this order: your dedicated RPC above, then Helius (auto-built from the API key if you don't set your own Helius RPC), then MemeCloud's public default. Saving a Helius API key here actually feeds the real scanning/execution path — it's not just stored.</div></>}
    {key==="execution"&&<><Cfg label="Jupiter base URL" value={form.jupiterBaseUrl} on={v=>field("jupiterBaseUrl",v)}/><SecretField label="Jupiter API key" {...secretProps("jupiterApiKey")}/><SecretField label="0x API key" {...secretProps("zeroXApiKey")}/><label className="field"><span>Signer provider</span><select value={form.signerProvider||"disabled"} onChange={e=>field("signerProvider",e.target.value)}><option value="disabled">Disabled — simulation only</option><option value="delegated">Delegated signer adapter (only after implemented)</option></select></label></>}
    {key==="signer"&&<><Cfg label="Privy App ID" value={form.privyAppId} on={v=>field("privyAppId",v)}/><SecretField label="Privy App Secret" {...secretProps("privyAppSecret")}/><SecretField label="Privy authorization private key" {...secretProps("privyAuthorizationPrivateKey")}/><Cfg label="Privy signer ID" value={form.privySignerId} placeholder="Restricted signer ID" on={v=>field("privySignerId",v)}/><Cfg label="Privy policy ID" value={form.privyPolicyId} placeholder="Required wallet policy ID" on={v=>field("privyPolicyId",v)}/><label className="check-line"><input type="checkbox" checked={Boolean(form.sponsorGas)} onChange={e=>field("sponsorGas",e.target.checked)}/><span>Sponsor network fees</span></label><div className="notice">Optional — only required for delegated live execution. Signer credentials control delegated live execution. Keep live trading disabled until wallet permissions and execution tests pass.</div></>}
    {key==="discovery"&&<><div className="form-grid"><Cfg label="Minimum liquidity USD" type="number" value={form.minLiquidityUsd} on={v=>field("minLiquidityUsd",Number(v))}/><Cfg label="Minimum market cap USD" type="number" value={form.minMarketCapUsd} on={v=>field("minMarketCapUsd",Number(v))}/><Cfg label="Maximum market cap USD" type="number" value={form.maxMarketCapUsd} on={v=>field("maxMarketCapUsd",Number(v))}/><Cfg label="Tokens per scan" type="number" value={form.tokenScanLimit} on={v=>field("tokenScanLimit",Number(v))}/><Cfg label="Top traders per token" type="number" value={form.topTradersPerToken} on={v=>field("topTradersPerToken",Number(v))}/><Cfg label="Paper-track minimum score" type="number" value={form.paperMinScore} on={v=>field("paperMinScore",Number(v))}/><Cfg label="Proven minimum score" type="number" value={form.provenMinScore} on={v=>field("provenMinScore",Number(v))}/><Cfg label="Minimum forward samples" type="number" value={form.provenMinForwardSamples} on={v=>field("provenMinForwardSamples",Number(v))}/><Cfg label="Minimum forward mean %" type="number" value={form.provenMinForwardMeanPct} on={v=>field("provenMinForwardMeanPct",Number(v))}/></div><div className="notice">These values feed the real on-chain discovery/scoring workers. MemeCloud never fabricates candidates when providers are missing.</div></>}
    {key==="social"&&<><SecretField label="X bearer token" {...secretProps("xBearerToken")}/><Cfg label="X OAuth client ID" value={form.xOAuthClientId} on={v=>field("xOAuthClientId",v)}/><SecretField label="X OAuth client secret" {...secretProps("xOAuthClientSecret")}/><Cfg label="X OAuth callback URL" value={form.xOAuthCallbackUrl} placeholder="https://meme-api.xaucloud.io/auth/x/callback" on={v=>field("xOAuthCallbackUrl",v)}/><div className="notice">Optional — MemeCloud operates without X. Connecting it adds social evidence to the Global Brain.</div></>}
    {key==="chains"&&<div className="chain-config"><div className="notice">Solana chain-wide flow scanning is built in and running. BNB and Ethereum flow scanning activate once their WebSocket RPCs are set under Networks → Global Brain. Live execution still requires a verified execution adapter for each chain.</div>{["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].map(c=><label key={c} className="check-line"><input type="checkbox" checked={(form.enabled||[]).includes(c)} onChange={()=>toggleChain(c)}/><span>{c}</span><small>{c==="SOLANA"?"Listener + chain-wide flow · running":c==="BNB"||c==="ETHEREUM"?"Flow scanner ready · RPC + execution adapter required":"Prepared"}</small></label>)}</div>}
    {key==="fees"&&<><Cfg label="Platform fee (basis points)" type="number" value={form.platformFeeBps} on={v=>field("platformFeeBps",Math.max(0,Math.min(10000,Number(v))))}/><div className="notice">0 by default during testing. Any production fee must be disclosed before authorization and on receipts.</div></>}
    {key==="risk"&&<><label className="check-line"><input type="checkbox" checked={Boolean(form.emergencyNewEntriesPaused)} onChange={e=>field("emergencyNewEntriesPaused",e.target.checked)}/><span>Emergency pause new entries</span></label><Cfg label="Fresh meme base wallet chase %" type="number" value={form.freshMemeBaseChasePct} on={v=>field("freshMemeBaseChasePct",Math.max(0,Number(v)))}/><Cfg label="Hyper maximum wallet chase %" type="number" value={form.hyperMaxChasePct} on={v=>field("hyperMaxChasePct",Math.max(0,Number(v)))}/><Cfg label="Hard max executable price impact %" type="number" value={form.maxExecutablePriceImpactPct} on={v=>field("maxExecutablePriceImpactPct",Math.max(1,Math.min(75,Number(v))))}/><div className="notice">Sensible defaults are active. Chase is measured from the followed wallet's actual execution to each user's actual-size executable quote. The token's 24h move is never used as the chase value.</div></> }
    {key==="branding"&&<><Cfg label="App name" value={form.appName} on={v=>field("appName",v)}/><Cfg label="Support email" value={form.supportEmail} on={v=>field("supportEmail",v)}/><Cfg label="Public URL" value={form.publicUrl} on={v=>field("publicUrl",v)}/></>}
    {msg&&<div className="notice">{msg}</div>}
    <button className="action-primary" disabled={!admin||saving} onClick={save} style={{height:42,borderRadius:12}}>{saving?"Saving…":`Save ${CFG_LABELS[key]||key}`}</button>
    {admin&&key==="push"&&<div className="test-inline"><button className="soft-action" onClick={vapid}><Bell size={12}/> Generate VAPID if missing</button><button className="soft-action" onClick={testPush}><Bell size={12}/> Push test to my devices</button></div>}
    {admin&&key==="email"&&<div className="test-inline"><input value={testEmail} onChange={e=>setTestEmail(e.target.value)} type="email" placeholder="Test email recipient"/><button className="soft-action" onClick={emailTest}><Mail size={12}/> Send SMTP test</button></div>}
   </div>
  </section>}
 </div>
}
function Cfg({label,value,on,type="text",placeholder=""}:{label:string;value:any;on:(v:string)=>void;type?:string;placeholder?:string}){return <label className="field"><span>{label}</span><input type={type} value={value??""} placeholder={placeholder} onChange={e=>on(e.target.value)}/></label>}
// A secret field is never a plain always-blank password box: it shows a real "Saved securely"
// masked state driven by the server's non-secret hint, with explicit Replace/Remove actions.
// Leaving it in the masked "view" state and saving never touches the stored value.
function SecretField({label,value,hint,removed,mode,onChange,onReplace,onCancel,onRemove,onUndo}:{
 label:string;value:string;hint:string|null;removed:boolean;mode:"view"|"edit";
 onChange:(v:string)=>void;onReplace:()=>void;onCancel:()=>void;onRemove:()=>void;onUndo:()=>void;
}){
 if(removed)return <label className="field"><span>{label}</span>
  <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
   <span>Will be removed on save</span><button type="button" className="soft-action" onClick={onUndo}>Undo</button>
  </div></label>;
 if(hint&&mode!=="edit")return <label className="field"><span>{label}</span>
  <div className="notice" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
   <span>Saved securely {hint}</span>
   <span style={{display:"flex",gap:6}}><button type="button" className="soft-action" onClick={onReplace}>Replace key</button><button type="button" className="soft-action" onClick={onRemove}>Remove key</button></span>
  </div></label>;
 return <label className="field"><span>{label}</span>
  <input type="password" value={value??""} placeholder={hint?"Enter a new value to replace the saved key":"Not saved yet"} onChange={e=>onChange(e.target.value)}/>
  {hint&&<button type="button" className="soft-action" style={{marginTop:4,alignSelf:"flex-start"}} onClick={onCancel}>Cancel</button>}
 </label>;
}
function Broadcasts({d,reload,admin}:{d:any;reload:()=>void;admin:boolean}){const[title,setTitle]=useState("");const[body,setBody]=useState("");const[channel,setChannel]=useState("PUSH");const[audience,setAudience]=useState("ALL");const[msg,setMsg]=useState("");
 async function send(){try{await apiFetch("/v1/admin/broadcast",{method:"POST",body:JSON.stringify({title,body,channel,audience})});setTitle("");setBody("");setMsg("Broadcast queued.");reload()}catch(e){setMsg(plainError(e))}}
 return <div className="admin-section-grid"><section className="app-card"><div className="card-title"><div><span>NEW BROADCAST</span><h2>Message users</h2></div></div><div className="admin-form"><label className="field"><span>Title</span><input value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field"><span>Message</span><textarea value={body} onChange={e=>setBody(e.target.value)}/></label><label className="field"><span>Channel</span><select value={channel} onChange={e=>setChannel(e.target.value)}><option>PUSH</option><option>EMAIL</option><option>BOTH</option></select></label><label className="field"><span>Audience</span><select value={audience} onChange={e=>setAudience(e.target.value)}><option>ALL</option><option>AUTO_COPY</option></select></label>{msg&&<div className="notice">{msg}</div>}<button className="action-primary" disabled={!admin||!title||!body} onClick={send} style={{height:42,borderRadius:12}}>Queue broadcast</button></div></section>
 <section className="app-card"><div className="card-title"><div><span>HISTORY</span><h2>Delivery progress</h2></div></div><div className="list">{(d.broadcasts||[]).map((b:any)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={b.id}><div><b>{b.title}</b><small>{b.channel} · {b.audience} · {b.sentCount}/{b.targetCount||"?"} sent · {b.failedCount} failed · {b.skippedCount||0} skipped</small></div><span className={`status-badge ${b.status==="FAILED"?"watch":""}`}>{b.status}</span></div>)}</div></section></div>}
function Audit({d}:{d:any}){return <section className="app-card admin-table-wrap"><div className="card-title"><div><span>IMMUTABLE EVENT HISTORY</span><h2>Administrative audit log</h2></div></div><table className="admin-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Context</th></tr></thead><tbody>{(d.logs||[]).map((log:any)=><tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.user?.displayName||log.user?.email||log.actor}</td><td><b>{log.action}</b></td><td>{log.target||"—"}</td><td>{log.hasMetadata?"Recorded":"—"}</td></tr>)}{!(d.logs||[]).length&&<tr><td colSpan={5}>No audit events recorded.</td></tr>}</tbody></table></section>}
function Health({d}:{d:any}){return <><div className="app-grid-4"><div className="stat-card"><span>Database</span><b>{d.database||"—"}</b><small>MongoDB</small></div><div className="stat-card"><span>Redis</span><b>{d.redis||"—"}</b><small>Queue/cache</small></div><div className="stat-card"><span>Execution</span><b>{String(d.executionMode||"—").toUpperCase()}</b><small>Current backend mode</small></div><div className="stat-card"><span>Broadcast queue</span><b>{d.queue?.broadcasts?.waiting??0}</b><small>Waiting jobs</small></div></div><section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>REAL HEARTBEATS</span><h2>Backend workers</h2></div></div><div className="health-grid">{(d.services||[]).map((h:any)=><div className="health-item" key={h.id}><span>{h.name}</span><b className={h.healthy?"positive":"negative"}>{h.healthy?"Healthy":"Stale"}</b><small>Last beat {new Date(h.lastBeatAt).toLocaleTimeString()}</small></div>)}</div></section></>}
