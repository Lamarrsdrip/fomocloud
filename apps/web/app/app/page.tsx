"use client";
import {useEffect,useMemo,useState} from "react";
import {
  Home,Users,Activity,WalletCards,UserRound,Bell,Power,Plus,Search,Settings2,
  ShieldCheck,LogOut,ArrowUpRight,Eye,Copy,Pause,Play,ChevronRight,Link2,RefreshCw
} from "lucide-react";
import {apiFetch,logout,money,pct,plainError} from "../../lib/api";

type View="home"|"traders"|"community"|"activity"|"positions"|"profile";
const nav:[View,string,any][]=[["home","Home",Home],["traders","Traders",Users],["community","Community",UserRound],["activity","Activity",Activity],["positions","Positions",WalletCards],["profile","Profile",Settings2]];

function initialView():View{
  if(typeof window==="undefined") return "home";
  const q=new URLSearchParams(location.search).get("view") as View|null;
  return nav.some(x=>x[0]===q)?q!:"home";
}
function initials(name?:string|null){return (name||"U").split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()}
function timeAgo(v:string){
  const s=Math.max(1,Math.floor((Date.now()-new Date(v).getTime())/1000));
  if(s<60)return `${s}s ago`; if(s<3600)return `${Math.floor(s/60)}m ago`; if(s<86400)return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`;
}
function toBase64(bytes:Uint8Array){let s="";bytes.forEach(b=>s+=String.fromCharCode(b));return btoa(s)}
function urlB64ToBytes(s:string){const pad="=".repeat((4-s.length%4)%4);const raw=atob((s+pad).replace(/-/g,"+").replace(/_/g,"/"));return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}

export default function AppPage(){
  const[view,setViewState]=useState<View>("home");
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState("");
  const[me,setMe]=useState<any>(null);
  const[dashboard,setDashboard]=useState<any>(null);
  const[platform,setPlatform]=useState<any[]>([]);
  const[follows,setFollows]=useState<any[]>([]);
  const[activity,setActivity]=useState<any>({events:[],decisions:[]});
  const[positions,setPositions]=useState<any[]>([]);
  const[trades,setTrades]=useState<any[]>([]);
  const[sessions,setSessions]=useState<any[]>([]);
  const[settings,setSettings]=useState<any>(null);
  const[notifications,setNotifications]=useState<any[]>([]);
  const[customOpen,setCustomOpen]=useState(false);

  function setView(v:View){setViewState(v);history.replaceState(null,"",`/app/?view=${v}`)}
  async function load(){
    setLoading(true);setError("");
    try{
      const [m,d,p,f,a,pos,t,s,n,ss]=await Promise.all([
        apiFetch("/v1/me"),apiFetch("/v1/me/dashboard"),apiFetch("/v1/traders"),apiFetch("/v1/me/traders"),
        apiFetch("/v1/me/activity"),apiFetch("/v1/me/positions"),apiFetch("/v1/me/trades"),apiFetch("/v1/me/settings"),apiFetch("/v1/me/notifications"),apiFetch("/v1/me/sessions")
      ]);
      setMe(m.user);setDashboard(d);setPlatform(p.traders||[]);setFollows(f.follows||[]);setActivity(a);setPositions(pos.positions||[]);setTrades(t.orders||[]);setSettings(s);setNotifications(n.notifications||[]);setSessions(ss.sessions||[]);
    }catch(e:any){
      if(e?.status===401){location.href="/login/";return}
      setError(plainError(e));
    }finally{setLoading(false)}
  }
  useEffect(()=>{setViewState(initialView());void load()},[]);
  useEffect(()=>{
    let stopped=false;
    const refreshLive=async()=>{
      if(stopped||document.visibilityState!=="visible")return;
      try{
        const[d,a,pos,t,n]=await Promise.all([apiFetch("/v1/me/dashboard"),apiFetch("/v1/me/activity"),apiFetch("/v1/me/positions"),apiFetch("/v1/me/trades"),apiFetch("/v1/me/notifications")]);
        if(!stopped){setDashboard(d);setActivity(a);setPositions(pos.positions||[]);setTrades(t.orders||[]);setNotifications(n.notifications||[])}
      }catch(e:any){if(e?.status===401&&!stopped)location.href="/login/"}
    };
    const timer=setInterval(()=>void refreshLive(),8000);
    const onVisible=()=>{if(document.visibilityState==="visible")void refreshLive()};
    document.addEventListener("visibilitychange",onVisible);
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener("visibilitychange",onVisible)};
  },[]);

  const followMap=useMemo(()=>new Map(follows.map(f=>[f.traderId,f])),[follows]);
  const unread=notifications.filter(n=>!n.readAt).length;
  const autoOn=Boolean(settings?.trading?.autoCopyEnabled);

  async function toggleAuto(){
    try{
      const r=await apiFetch("/v1/me/settings/trading",{method:"PATCH",body:JSON.stringify({autoCopyEnabled:!autoOn})});
      setSettings((x:any)=>({...x,trading:r.trading})); setDashboard((x:any)=>({...x,settings:r.trading}));
    }catch(e){setError(plainError(e))}
  }
  async function setTraderMode(id:string,mode:string){
    try{
      await apiFetch(`/v1/me/traders/${id}`,{method:"PUT",body:JSON.stringify({mode})}); await load();
    }catch(e){setError(plainError(e))}
  }
  async function signOut(){await logout();location.href="/login/"}

  if(loading&&!me)return <main className="app-page"><div className="loading"><div><div className="spinner"/>Loading your account…</div></div></main>;

  return <main className="app-page">
    <div className="app-layout">
      <aside className="app-sidebar">
        <a className="brand" href="/"><span className="brandmark small">K</span><b>KAIRO</b></a>
        <nav className="app-nav">{nav.map(([id,label,Icon])=><button key={id} onClick={()=>setView(id)} className={view===id?"active":""}><Icon size={16}/>{label}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="mode-pill"><span>Execution</span><b>{String(dashboard?.executionMode||"simulation").toUpperCase()}</b></div>
          <div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||me?.wallets?.[0]?.address?.slice(0,10)||"Wallet account"}</small></div></div>
        </div>
      </aside>

      <section className="app-main">
        <div className="app-top">
          <div><small>PRIVATE ACCOUNT</small><h1>{view==="home"?"Your dashboard":view[0].toUpperCase()+view.slice(1)}</h1></div>
          <div className="app-top-actions">
            <button className={`auto-toggle ${autoOn?"":"off"}`} onClick={toggleAuto}>{autoOn?<Play size={14}/>:<Pause size={14}/>} Auto Copy {autoOn?"On":"Off"}</button>
            <button className="icon-btn notification-button" onClick={()=>setView("profile")} aria-label={`${unread} unread notifications`}><Bell size={17}/>{unread>0&&<span className="notification-count">{unread>99?"99+":unread}</span>}</button>
          </div>
        </div>
        {error&&<div className="auth-error" style={{marginBottom:12}}>{error}</div>}
        {dashboard?.executionMode==="simulation"&&<div className="notice"><b>Simulation is active.</b> Market monitoring and account data can be real, but automatic orders shown as SIMULATION do not move live funds.</div>}

        {view==="home"&&<HomeView d={dashboard} activity={activity} follows={follows} setView={setView}/>}
        {view==="traders"&&<TradersView platform={platform} follows={follows} followMap={followMap} setMode={setTraderMode} customOpen={customOpen} setCustomOpen={setCustomOpen} reload={load}/>}
        {view==="community"&&<CommunityView/>}
        {view==="activity"&&<ActivityView activity={activity} trades={trades}/>}
        {view==="positions"&&<PositionsView positions={positions}/>}
        {view==="profile"&&<ProfileView me={me} setMe={setMe} settings={settings} notifications={notifications} sessions={sessions} setSettings={setSettings} reload={load} signOut={signOut}/>}
      </section>
    </div>
    <nav className="mobile-app-nav">{nav.map(([id,label,Icon])=><button key={id} onClick={()=>setView(id)} className={view===id?"active":""}><Icon size={19}/>{label}</button>)}</nav>
  </main>
}


function PerformanceChart({snapshots}:{snapshots:any[]}){
 const[range,setRange]=useState("7D"),[rows,setRows]=useState<any[]>(snapshots||[]),[change,setChange]=useState<number|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{if(range==="7D"&&snapshots?.length&&!rows.length)setRows(snapshots)},[snapshots]);
 async function choose(r:string){setRange(r);setBusy(true);try{const x=await apiFetch<any>(`/v1/me/performance?range=${r}`);setRows(x.points||[]);setChange(Number(x.pnlChangeUsd||0))}catch{}finally{setBusy(false)}}
 const vals=rows.slice(-240).map(x=>Number(x.accountValueUsd||0));
 const last=rows[rows.length-1];
 return <section className="app-card pnl-card"><div className="card-title"><div><span>PERFORMANCE</span><h2>Your live account history</h2></div><div className="performance-tabs">{["1D","7D","30D","ALL"].map(r=><button key={r} className={range===r?"active":""} onClick={()=>choose(r)}>{r}</button>)}</div></div>
  {!vals.length?<div className="pnl-empty">Your real account-value chart starts after the analytics worker records genuine live balance/position snapshots. Simulation results are kept separate.</div>:<><div className="performance-summary"><b className={(change??last?.netPnlUsd??0)>=0?"positive":"negative"}>{change===null?money(last?.netPnlUsd):`${change>=0?"+":""}${money(change)}`}</b><small>{change===null?"Current live net P&L":`${range} change in cumulative live P&L`}{busy?" · refreshing…":""}</small></div><PnlSvg vals={vals}/><div className="pnl-meta"><span>{rows.length} snapshot point(s)</span><span>Live P&amp;L only · simulation excluded</span></div></>}
 </section>
}
function PnlSvg({vals}:{vals:number[]}){const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(1e-9,max-min);const pts=vals.map((v,i)=>`${(i/Math.max(1,vals.length-1))*100},${94-((v-min)/span)*78}`).join(" ");return <div className="pnl-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Account value history"><polyline points={pts}/></svg></div>}

function HomeView({d,activity,follows,setView}:{d:any;activity:any;follows:any[];setView:(v:View)=>void}){
 const s=d?.summary||{};const sim=d?.simulation||{};
 return <>
  <div className="app-grid-4">
    <div className="stat-card"><span>Trading Cash</span><b>{money(s.tradingCashUsd)}</b><small>{s.tradingCashUsd?"Real synced USDC allocations":"No cash synced yet"}</small></div>
    <div className="stat-card"><span>Net P&amp;L</span><b className={(s.netPnlUsd||0)>=0?"positive":"negative"}>{money(s.netPnlUsd)}</b><small>Realized + unrealized live positions</small></div>
    <div className="stat-card"><span>Open positions</span><b>{s.openPositions??0}</b><small>{sim.openPositions?`${sim.openPositions} simulation position(s) separate`:"Live positions only"}</small></div>
    <div className="stat-card"><span>Auto Copy traders</span><b>{s.copiedTraders??0}</b><small>{s.winRate==null?"Win rate appears after closed live trades":`${s.winRate.toFixed(1)}% live win rate`}</small></div>
  </div>
  {String(d?.executionMode||"").toLowerCase()==="simulation"&&<section className="app-card simulation-summary"><div className="card-title"><div><span>SIMULATION WORKSPACE</span><h2>Test decisions without moving live funds</h2></div><span className="sim-badge">SIMULATION</span></div><div className="simulation-stats"><div><span>Open simulated positions</span><b>{sim.openPositions??0}</b></div><div><span>Simulated realized P&amp;L</span><b className={(sim.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(sim.realizedPnlUsd)}</b></div><div><span>Simulated unrealized P&amp;L</span><b className={(sim.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(sim.unrealizedPnlUsd)}</b></div></div><p>Simulation uses the real source-signal and market-data pipeline where configured, but it never presents these numbers as live account money.</p></section>}
  <PerformanceChart snapshots={d?.snapshots||[]} />
  <section className="app-card cash-breakdown"><div className="card-title"><div><span>TRADING CASH BY CHAIN</span><h2>Where your USDC is actually available</h2></div></div>
    {d?.allocations?.length?<div className="chain-cash-grid">{d.allocations.map((a:any)=><div className="chain-cash" key={a.id}><span>{a.chain}</span><b>{money(a.availableUsd+a.inTradesUsd)}</b><small>{money(a.availableUsd)} available · {money(a.inTradesUsd)} in live trades</small><em>{a.lastSyncedAt?`Synced ${timeAgo(a.lastSyncedAt)}`:"Awaiting wallet sync"}</em></div>)}</div>:<div className="pnl-empty">Connect a supported wallet to sync genuine chain-specific USDC. One chain's USDC is never silently treated as spendable on another chain.</div>}
  </section>
  <div className="app-two">
    <section className="app-card"><div className="card-title"><div><span>RECENT ACTIVITY</span><h2>What KAIRO did for you</h2></div><button onClick={()=>setView("activity")}>See all <ChevronRight size={12}/></button></div>
      {activity?.events?.length?<div className="list">{activity.events.slice(0,6).map((e:any)=><div className="list-row" key={e.id}><div><b>{e.title}</b><small>{e.body||e.type}</small></div><span>{e.status||e.type.replaceAll("_"," ")}</span><span>{timeAgo(e.createdAt)}</span><strong>›</strong></div>)}</div>:<Empty icon={Activity} title="No activity yet" body="Choose traders and enable Auto Copy or Watch mode. Your real account activity will appear here." action="Choose traders" onClick={()=>setView("traders")}/>}
    </section>
    <section className="app-card"><div className="card-title"><div><span>YOUR TRADERS</span><h2>Copy setup</h2></div></div>
      {follows.length?<div className="list">{follows.slice(0,5).map((f:any)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={f.id}><div><b>{f.trader.displayName}</b><small>@{f.trader.handle}</small></div><span className={`status-badge ${f.mode==="WATCH_ONLY"?"watch":f.mode==="FOLLOW_ONLY"?"follow":""}`}>{f.mode.replaceAll("_"," ")}</span></div>)}</div>:<Empty icon={Users} title="Your list is empty" body="Follow platform traders or add a public wallet you already trust." action="Find traders" onClick={()=>setView("traders")}/>}
    </section>
  </div>
  <div className="app-two">
    <section className="app-card"><div className="card-title"><div><span>OPEN POSITIONS</span><h2>Your positions</h2></div><button onClick={()=>setView("positions")}>Open positions <ChevronRight size={12}/></button></div>
      {d?.positions?.length?<div className="list">{d.positions.slice(0,6).map((p:any)=><PositionRow p={p} key={p.id}/>)}</div>:<Empty icon={WalletCards} title="No positions yet" body="Your account starts clean. Positions appear only after a genuine decision and execution/simulation event."/>}
    </section>
    <section className="app-card"><div className="card-title"><div><span>ACCOUNT STATUS</span><h2>Ready check</h2></div></div>
      <div className="list">
        <StatusLine label="Backend" value="Connected" ok/>
        <StatusLine label="Trading Cash" value={s.tradingCashUsd>0?"Synced":"Needs wallet/cash"} ok={s.tradingCashUsd>0}/>
        <StatusLine label="Auto Copy" value={d?.settings?.autoCopyEnabled?"On":"Off"} ok={Boolean(d?.settings?.autoCopyEnabled)}/>
        <StatusLine label="Execution" value={String(d?.executionMode||"simulation").toUpperCase()} ok={false}/>
      </div>
    </section>
  </div>
 </>;
}
function StatusLine({label,value,ok}:{label:string;value:string;ok:boolean}){return <div className="list-row" style={{gridTemplateColumns:"1fr auto"}}><div><b>{label}</b></div><span className={`status-badge ${ok?"":"watch"}`}>{value}</span></div>}

function TradersView({platform,follows,followMap,setMode,customOpen,setCustomOpen,reload}:{platform:any[];follows:any[];followMap:Map<string,any>;setMode:(id:string,m:string)=>void;customOpen:boolean;setCustomOpen:(v:boolean)=>void;reload:()=>Promise<void>}){
 const [search,setSearch]=useState(""); const[detail,setDetail]=useState<string|null>(null); const filtered=platform.filter(t=>`${t.displayName} ${t.handle} ${t.category||""}`.toLowerCase().includes(search.toLowerCase()));
 return <>
  {detail&&<TraderDetail traderId={detail} close={()=>setDetail(null)}/>}
  <div style={{display:"flex",gap:8,marginBottom:12}}><label className="field" style={{flex:1}}><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search platform traders"/></label><button className="soft-action" onClick={()=>setCustomOpen(!customOpen)}><Plus size={14}/> Add my own trader</button></div>
  {customOpen&&<CustomTrader reload={reload} close={()=>setCustomOpen(false)}/>}
  <div className="card-title"><div><span>PLATFORM TRADERS</span><h2>Choose who you want to follow</h2></div></div>
  <div className="trader-grid">
    {filtered.map((t:any)=>{const f=followMap.get(t.id);const trackable=t.wallets?.some((w:any)=>w.verified&&w.chain==="SOLANA");return <article className="trader-card" key={t.id}>
      <div className="trader-head"><div className="avatar">{initials(t.displayName)}</div><div><b>{t.displayName}</b><small>@{t.handle} · {t.category||t.trackingStatus}</small></div></div>
      <div className="trader-meta"><div><span>TRACKED WALLETS</span><b>{t.wallets?.length??0}</b></div><div><span>HISTORY</span><b>{t._count?.signals?`${t._count.signals} signals`:"Tracking"}</b></div></div>
      <button className="trader-profile-link" onClick={()=>setDetail(t.id)}>View tracked profile</button>
      <div className="trader-actions">
        <button className={f?.mode==="FOLLOW_ONLY"?"active":""} onClick={()=>setMode(t.id,"FOLLOW_ONLY")}>Follow</button>
        <button disabled={!trackable} title={trackable?"Track this trader":"Source listener for this trader's chain is not live yet"} className={f?.mode==="WATCH_ONLY"?"active":""} onClick={()=>setMode(t.id,"WATCH_ONLY")}>Watch</button>
        <button disabled={!trackable} title={trackable?"Evaluate eligible buys automatically":"Source listener for this trader's chain is not live yet"} className={f?.mode==="AUTO_COPY"?"active":""} onClick={()=>setMode(t.id,"AUTO_COPY")}>Auto Copy</button>
      </div>
    </article>})}
    <div className="add-trader"><div><Plus size={22}/><h3>Add a public trader wallet</h3><p style={{fontSize:9}}>You can track your own favorite trader even if they are not in the platform list.</p><button onClick={()=>setCustomOpen(true)}>Add trader</button></div></div>
  </div>
  <div className="card-title" style={{marginTop:28}}><div><span>MY LIST</span><h2>Your independent copy settings</h2></div></div>
  {follows.length?<div className="trader-settings-list">{follows.map((f:any)=><TraderSettingsRow key={f.id} f={f} reload={reload}/>)}</div>:<Empty icon={Users} title="No traders selected" body="Use Follow, Watch or Auto Copy above. Each user can keep a completely different list."/>}
 </>;
}


function TraderDetail({traderId,close}:{traderId:string;close:()=>void}){
 const[data,setData]=useState<any>(null),[err,setErr]=useState("");
 useEffect(()=>{let live=true;apiFetch<any>(`/v1/traders/${traderId}`).then(x=>{if(live)setData(x)}).catch(e=>{if(live)setErr(plainError(e))});return()=>{live=false}},[traderId]);
 const t=data?.trader;
 return <section className="app-card trader-detail"><div className="card-title"><div><span>TRACKED TRADER PROFILE</span><h2>{t?.displayName||"Loading trader…"}</h2></div><button className="soft-action" onClick={close}>Close</button></div>{err&&<div className="auth-error">{err}</div>}{t&&<><div className="trader-detail-head"><div className="avatar">{initials(t.displayName)}</div><div><b>{t.displayName}</b><small>{t.xHandle?`@${t.xHandle}`:`@${t.handle}`} · {t.verification.replaceAll("_"," ")}</small></div><span className="status-badge">{t.trackingStatus}</span></div><div className="trader-detail-metrics"><div><span>Source wallets</span><b>{t.wallets?.length||0}</b></div><div><span>Tracked signals</span><b>{t._count?.signals||t.signals?.length||0}</b></div><div><span>Your relationship</span><b>{data.follow?.mode?.replaceAll("_"," ")||"Not following"}</b></div><div><span>Performance</span><b>Tracking</b><small>No fabricated return %</small></div></div><div className="wallet-public-list">{(t.wallets||[]).map((w:any)=><div key={w.id}><b>{w.chain}</b><span>{w.address}</span><small>{w.verified?"Verified public source":"Unverified source"}</small></div>)}</div><div className="card-title compact"><div><span>RECENT REAL SOURCE SIGNALS</span><h3>Wallet activity</h3></div></div>{t.signals?.length?<div className="list">{t.signals.map((sig:any)=><div className="list-row" key={sig.id}><div><b>{sig.action} · {(sig.action==="BUY"?sig.outputMint:sig.inputMint).slice(0,8)}…</b><small>{sig.chain} · source tx {sig.sourceTx.slice(0,9)}…</small></div><span>{sig.sourcePriceUsd?money(sig.sourcePriceUsd):"Price enrichment pending"}</span><span>{timeAgo(sig.observedAt)}</span><strong>›</strong></div>)}</div>:<div className="pnl-empty">No source signals have been recorded yet. Performance stays marked as Tracking until genuine history exists.</div>}</>}</section>
}


function TraderSettingsRow({f,reload}:{f:any;reload:()=>Promise<void>}){
 const[open,setOpen]=useState(false),[mode,setMode]=useState(f.mode),[amount,setAmount]=useState(f.fixedAmountUsd||100),[chase,setChase]=useState(f.maxChasePct||40),[tp,setTp]=useState(Number(f.takeProfitPct||100)),[additional,setAdditional]=useState(f.copyAdditionalBuys!==false),[reentry,setReentry]=useState(f.copyReentries!==false),[msg,setMsg]=useState("");
 const[walletAddress,setWalletAddress]=useState(""),[walletChain,setWalletChain]=useState("SOLANA"); const hasWallet=Boolean(f.trader.wallets?.length); const trackable=Boolean(f.trader.wallets?.some((w:any)=>w.verified&&w.chain==="SOLANA"));
 async function save(){setMsg("");try{await apiFetch(`/v1/me/traders/${f.traderId}`,{method:"PUT",body:JSON.stringify({mode,fixedAmountUsd:Number(amount),maxChasePct:Number(chase),takeProfitPct:Number(tp),copyAdditionalBuys:additional,copyReentries:reentry})});setMsg("Saved");await reload()}catch(e){setMsg(plainError(e))}}
 async function addWallet(){setMsg("");try{await apiFetch(`/v1/me/traders/${f.traderId}/wallet`,{method:"POST",body:JSON.stringify({chain:walletChain,address:walletAddress})});setMsg("Wallet added. Tracking can start once the listener refreshes.");await reload()}catch(e){setMsg(plainError(e))}}
 async function remove(){if(!confirm(`Remove ${f.trader.displayName} from your list?`))return;await apiFetch(`/v1/me/traders/${f.traderId}`,{method:"DELETE"});await reload()}
 return <section className="app-card trader-setting-card"><div className="trader-setting-summary"><div className="user-mini"><div className="avatar">{initials(f.trader.displayName)}</div><div><b>{f.trader.displayName}</b><small>{f.trader.wallets?.[0]?.chain||"Wallet needed"} · {f.mode.replaceAll("_"," ")} · {f.trader._count?.signals??0} tracked signals</small></div></div><div className="trader-setting-quick"><span>{money(f.fixedAmountUsd)} / copy</span><span>{trackable?`Wallet chase ≤ ${f.maxChasePct}%`:hasWallet?"Wallet saved · chain adapter not live":"X favorite · wallet needed"}</span><button className="soft-action" onClick={()=>setOpen(!open)}>{open?"Close":"Settings"}</button></div></div>{open&&<div className="trader-setting-editor">
  <label className="field"><span>Relationship</span><select value={mode} onChange={e=>setMode(e.target.value)}><option value="FOLLOW_ONLY">Follow only</option><option value="WATCH_ONLY" disabled={!trackable}>Watch trades</option><option value="AUTO_COPY" disabled={!trackable}>Auto Copy</option><option value="PAUSED">Paused</option></select></label>
  <label className="field"><span>Amount per eligible copy</span><input type="number" min="1" value={amount} onChange={e=>setAmount(Number(e.target.value))}/></label><label className="field"><span>Personal max wallet chase %</span><input type="number" min="0" max="55" value={chase} onChange={e=>setChase(Number(e.target.value))}/></label>
  <label className="field"><span>Profit style</span><select value={tp} onChange={e=>setTp(Number(e.target.value))}><option value={100}>Fresh meme · +100 / +150 / +200 then runner</option><option value={50}>Established · +50 / +100 then runner</option></select></label><div className="notice">Targets take partial simulated profit only. There is no final profit cap; the remaining runner stays open. Adaptive trailing waits for genuine flow/volume/liquidity evidence rather than inventing it.</div>
  {!hasWallet&&<div className="pending-wallet span2"><div><b>Add the real public trading wallet</b><small>An X username can be saved as a favorite, but Auto Copy cannot start until a public wallet is mapped.</small></div><select value={walletChain} onChange={e=>setWalletChain(e.target.value)}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select><input value={walletAddress} onChange={e=>setWalletAddress(e.target.value)} placeholder="Public wallet address"/><button className="soft-action" disabled={!walletAddress} onClick={addWallet}>Add wallet</button></div>}
  <div className="switch-row"><div><b>Copy additional buys</b><small>Allow this trader's later scale-ins to be evaluated.</small></div><button className={`switch ${additional?"on":""}`} onClick={()=>setAdditional(!additional)}><i/></button></div><div className="switch-row"><div><b>Copy re-entry</b><small>Allow a later re-entry after the trader exited.</small></div><button className={`switch ${reentry?"on":""}`} onClick={()=>setReentry(!reentry)}><i/></button></div><div className="trader-editor-actions"><button className="action-primary" onClick={save}>Save trader settings</button><button className="soft-action" onClick={remove}>Remove</button>{msg&&<span>{msg}</span>}</div></div>}</section>
}

function CustomTrader({reload,close}:{reload:()=>Promise<void>;close:()=>void}){
 const[name,setName]=useState("");const[address,setAddress]=useState("");const[chain,setChain]=useState("SOLANA");const[x,setX]=useState("");const[err,setErr]=useState("");const[busy,setBusy]=useState(false);
 async function add(e:React.FormEvent){e.preventDefault();setBusy(true);setErr("");try{await apiFetch("/v1/me/traders/custom",{method:"POST",body:JSON.stringify({displayName:name,address,chain,xHandle:x})});await reload();close()}catch(e){setErr(plainError(e))}finally{setBusy(false)}}
 return <section className="app-card" style={{marginBottom:14}}><div className="card-title"><div><span>ADD MY OWN TRADER</span><h2>Save a favorite — then map the real wallet</h2></div><button onClick={close}>Close</button></div><form className="form-grid" onSubmit={add}>
  <label className="field"><span>Your label for this trader</span><input value={name} onChange={e=>setName(e.target.value)} placeholder="Example: My favorite trader" required/></label>
  <label className="field"><span>Chain</span><select value={chain} onChange={e=>setChain(e.target.value)}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select></label>
  <label className="field span2"><span>Public trading wallet (optional now)</span><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Public wallet address — required before Watch / Auto Copy"/></label>
  <label className="field"><span>X username (optional)</span><input value={x} onChange={e=>setX(e.target.value)} placeholder="@username"/></label>
  <div style={{alignSelf:"end"}}><button className="action-primary" style={{width:"100%",height:42,borderRadius:12}} disabled={busy}>{busy?"Adding…":"Add to my watchlist"}</button></div>
  {err&&<div className="auth-error span2">{err}</div>}
 </form><div className="notice" style={{marginTop:12,marginBottom:0}}>You can save an X favorite without a wallet. It stays FOLLOW ONLY / NEEDS WALLET until you add the genuine public trading wallet. The platform never invents wallet mappings.</div></section>
}


function CommunityView(){
 const[q,setQ]=useState("");const[users,setUsers]=useState<any[]>([]);const[following,setFollowing]=useState<any[]>([]);const[err,setErr]=useState("");const[loading,setLoading]=useState(true);
 async function load(search=""){setLoading(true);setErr("");try{const [u,f]=await Promise.all([apiFetch<any>(`/v1/social/users?q=${encodeURIComponent(search)}`),apiFetch<any>("/v1/me/social/following")]);setUsers(u.users||[]);setFollowing(f.following||[])}catch(e){setErr(plainError(e))}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 async function toggle(u:any){try{await apiFetch(`/v1/social/users/${u.id}/follow`,{method:u.isFollowing?"DELETE":"POST"});await load(q)}catch(e){setErr(plainError(e))}}
 return <>
  {err&&<div className="auth-error">{err}</div>}
  <div className="app-two">
   <section className="app-card"><div className="card-title"><div><span>COMMUNITY</span><h2>Find people on the platform</h2></div></div><div className="search-line"><Search size={14}/><input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void load(q)}} placeholder="Search username or display name"/><button onClick={()=>load(q)}>Search</button></div>
    {loading?<div className="loading" style={{minHeight:180}}>Loading…</div>:users.length?<div className="list">{users.map(u=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={u.id}><div className="user-mini"><div className="avatar">{initials(u.displayName||u.username)}</div><div><b>{u.displayName||u.username||"Platform user"}</b><small>{u.username?`@${u.username}`:"No public username"} · {u._count?.followers||0} followers</small></div></div><button className="soft-action" onClick={()=>toggle(u)}>{u.isFollowing?"Following":"Follow"}</button></div>)}</div>:<Empty icon={Users} title="No users found" body="Users need a public username before they are useful to discover. Private financial data is never exposed here."/>}
   </section>
   <section className="app-card"><div className="card-title"><div><span>YOUR SOCIAL LIST</span><h2>Following</h2></div></div>{following.length?<div className="list">{following.map(u=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={u.id}><div><b>{u.displayName||u.username}</b><small>{u.username?`@${u.username}`:"Platform user"}</small></div><span className="status-badge">Following</span></div>)}</div>:<Empty icon={UserRound} title="You aren't following anyone yet" body="This social layer is separate from trader Auto Copy. Following a person never authorizes a trade."/>}</section>
  </div><div className="notice" style={{marginTop:10}}>Community profiles are intentionally privacy-light: no wallet balance, private watchlist, exact portfolio or trading authorization details are exposed.</div>
 </>;
}

function ActivityView({activity,trades}:{activity:any;trades:any[]}){
 const items=[...(activity?.events||[])]; const decisions=activity?.decisions||[];
 return <>
 <div className="app-two">
  <section className="app-card"><div className="card-title"><div><span>YOUR ACCOUNT ONLY</span><h2>Activity history</h2></div></div>
   {items.length?<div className="list">{items.map((e:any)=><div className="list-row" key={e.id}><div><b>{e.title}</b><small>{e.body||e.type}</small></div><span>{e.type.replaceAll("_"," ")}</span><span>{timeAgo(e.createdAt)}</span><strong>›</strong></div>)}</div>:<Empty icon={Activity} title="Nothing has happened yet" body="Source signals, copies, skips, pullback waits and profit events will appear here for this account only."/>}
  </section>
  <section className="app-card"><div className="card-title"><div><span>DECISION HISTORY</span><h2>Why we copied or waited</h2></div></div>
   {decisions.length?<div className="list">{decisions.map((d:any)=><div className="decision-history" key={d.id}><div><b>{d.signal?.trader?.displayName||"Trader signal"} · {d.signal?.action}</b><small>{d.explanation||d.plainReason||d.reason||"Decision recorded"}</small></div><div className="decision-facts"><span>{d.action}</span>{d.walletChasePct!=null&&<span>Wallet chase {Number(d.walletChasePct).toFixed(1)}%</span>}<span>{timeAgo(d.createdAt)}</span></div></div>)}</div>:<Empty icon={ShieldCheck} title="No decisions yet" body="Every source signal creates a decision for your account only after your own settings are applied."/>}
  </section>
 </div>
 <section className="app-card" style={{marginTop:12}}><div className="card-title"><div><span>TRADE HISTORY</span><h2>Your orders and confirmations</h2></div></div>
  {trades.length?<div className="list">{trades.map((o:any)=><div className="trade-history-row" key={o.id}><div><b>{o.decision?.signal?.trader?.displayName||"Copied trade"} · {o.side}</b><small>{o.chain} · {o.venue||"Route pending"} · {o.mode}</small></div><span className="sim-badge">{o.status}</span><span>{o.txHash?`${o.txHash.slice(0,8)}…`:o.mode==="SIMULATION"?"No live tx":"Awaiting tx"}</span><span>{timeAgo(o.createdAt)}</span></div>)}</div>:<Empty icon={WalletCards} title="No trade history yet" body="Confirmed live orders and clearly labeled simulations for this account appear here. A quote alone never counts as a completed live trade."/>}
 </section>
 </>
}

function positionMath(p:any){try{const original=BigInt(p.entryTokenRaw||"0"),remaining=BigInt(p.remainingTokenRaw||"0");const fraction=original>BigInt(0)?Number((remaining*BigInt(1000000))/original)/1_000_000:0;const remainingCost=Number(p.costUsd||0)*fraction;const currentValue=remainingCost+Number(p.unrealizedPnlUsd||0);const pnlPct=remainingCost>0?Number(p.unrealizedPnlUsd||0)/remainingCost*100:0;return{fraction,remainingCost,currentValue,pnlPct}}catch{return{fraction:0,remainingCost:0,currentValue:Number(p.unrealizedPnlUsd||0),pnlPct:0}}}
function PositionRow({p}:{p:any}){const m=positionMath(p);return <div className="position-row"><div className="position-main"><div className="position-token"><b>{p.mint?.slice(0,8)}…</b><span className="sim-badge">{p.mode}</span><span className="status-badge">{String(p.status).replaceAll("_"," ")}</span></div><small>{p.sourceTrader?.displayName||"Source trader"} · {p.chain} · opened {timeAgo(p.openedAt)}</small></div><div><span>Invested remaining</span><b>{money(m.remainingCost)}</b></div><div><span>Current value</span><b>{p.currentPriceUsd?money(m.currentValue):"Awaiting mark"}</b></div><div><span>Unrealized</span><b className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)} <small>({pct(m.pnlPct)})</small></b></div><div><span>Realized</span><b className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</b></div><div><span>Profit taken</span><b>{money(p.profitTakenUsd)}</b></div></div>}
function PositionsView({positions}:{positions:any[]}){const[filter,setFilter]=useState("ALL");const shown=positions.filter(p=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");return <section className="app-card"><div className="card-title"><div><span>PERSONAL POSITIONS</span><h2>Open &amp; closed positions</h2></div><div className="performance-tabs">{["ALL","OPEN","CLOSED"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>{shown.length?<div className="positions-list">{shown.map(p=><PositionRow p={p} key={p.id}/>)}</div>:<Empty icon={WalletCards} title={positions.length?"No positions in this filter":"No positions yet"} body={positions.length?"Choose another filter.":"There is no shared demo portfolio here. Your positions appear only after your own account gets a real decision."}/>}</section>}

function ProfileView({me,setMe,settings,notifications,sessions,setSettings,reload,signOut}:{me:any;setMe:any;settings:any;notifications:any[];sessions:any[];setSettings:any;reload:()=>Promise<void>;signOut:()=>void}){
 const[err,setErr]=useState(""); const[name,setName]=useState(me?.displayName||""); const[username,setUsername]=useState(me?.username||""); const[closeValue,setCloseValue]=useState("");
 const trading=settings?.trading||{}; const prefs=settings?.notifications||{};
 async function patchTrading(body:any){try{const r=await apiFetch("/v1/me/settings/trading",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,trading:r.trading}))}catch(e){setErr(plainError(e))}}
 async function patchNotifications(body:any){try{const r=await apiFetch("/v1/me/settings/notifications",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,notifications:r.notifications}))}catch(e){setErr(plainError(e))}}
 async function saveProfile(){try{const r=await apiFetch("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username})});setMe((x:any)=>({...x,...r.user}));setErr("")}catch(e){setErr(plainError(e))}}
 async function linkWallet(){
  setErr("");try{
   const provider=(window as any).solana;if(!provider?.connect)throw new Error("No supported Solana wallet found.");
   const c0=await provider.connect();const address=c0.publicKey.toString();
   const c=await apiFetch<any>("/v1/me/wallets/challenge",{method:"POST",body:JSON.stringify({chain:"SOLANA",address})});
   const signed=await provider.signMessage(new TextEncoder().encode(c.message),"utf8");
   await apiFetch("/v1/me/wallets/verify",{method:"POST",body:JSON.stringify({challengeId:c.challengeId,signature:`base64:${toBase64(signed.signature)}`})});await reload();
  }catch(e){setErr(plainError(e))}
 }
 async function enablePush(){
  setErr("");try{
   if(!("serviceWorker"in navigator)||!("PushManager"in window))throw new Error("Push is not supported in this browser.");
   const cfg=await apiFetch<any>("/v1/public/config",{},false);if(!cfg.pushPublicKey)throw new Error("Push has not been configured by the administrator yet.");
   const reg=await navigator.serviceWorker.register("/sw.js");const perm=await Notification.requestPermission();if(perm!=="granted")throw new Error("Notification permission was not granted.");
   const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToBytes(cfg.pushPublicKey)});
   await apiFetch("/v1/push/subscribe",{method:"POST",body:JSON.stringify(sub.toJSON())});await reload();
  }catch(e){setErr(plainError(e))}
 }
 async function linkX(){try{const r=await apiFetch<any>("/v1/me/social/x/start");location.href=r.url}catch(e){setErr(plainError(e))}}
 async function unlinkWallet(id:string){if(!confirm("Unlink this wallet from your account? Any active delegated trading permission must be revoked first."))return;try{await apiFetch(`/v1/me/wallets/${id}`,{method:"DELETE"});await reload()}catch(e){setErr(plainError(e))}}
 async function revokeSession(id:string){try{await apiFetch(`/v1/me/sessions/${id}`,{method:"DELETE"});await reload()}catch(e){setErr(plainError(e))}}
 async function markNotificationsRead(){try{await apiFetch("/v1/me/notifications/read",{method:"POST",body:JSON.stringify({})});await reload()}catch(e){setErr(plainError(e))}}
 async function resendVerification(){try{await apiFetch("/auth/resend-verification",{method:"POST"});setErr("Verification email requested. Check your inbox if SMTP is configured.")}catch(e){setErr(plainError(e))}}
 async function closeAccount(){
  const expected=me?.hasPassword?"your password":"CLOSE MY ACCOUNT";
  if(!closeValue){setErr(`Enter ${expected} to close this account.`);return}
  if(!confirm("Close this account? Auto Copy will be disabled, sessions revoked, and the account will no longer be usable. Financial/audit records are retained as required for integrity."))return;
  try{await apiFetch("/v1/me/account/close",{method:"POST",body:JSON.stringify(me?.hasPassword?{password:closeValue}:{confirmation:closeValue})});await signOut()}catch(e){setErr(plainError(e))}
 }
 return <>
  {err&&<div className="auth-error">{err}</div>}
  <div className="settings-grid">
   <section className="settings-block"><h3>Account</h3><div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||"Wallet-created account"}</small></div></div>
    <label className="field"><span>Display name</span><input value={name} onChange={e=>setName(e.target.value)} /></label><label className="field"><span>Public username</span><input value={username} onChange={e=>setUsername(e.target.value.toLowerCase())} placeholder="username" /></label><div className="switch-row"><div><b>Public community profile</b><small>Off by default. Financial details always stay private.</small></div><button className={`switch ${me?.publicProfileEnabled?"on":""}`} onClick={async()=>{try{const r=await apiFetch<any>("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username,publicProfileEnabled:!me?.publicProfileEnabled})});setMe((x:any)=>({...x,...r.user}))}catch(e){setErr(plainError(e))}}}><i/></button></div><button className="soft-action" onClick={saveProfile}>Save profile</button>
    <div className="switch-row"><div><b>Email</b><small>{me?.email?me.emailVerified?"Verified":"Not verified yet":"Wallet-only account"}</small></div>{me?.email?(me.emailVerified?<span className="status-badge">Verified</span>:<button className="soft-action" onClick={resendVerification}>Resend verification</button>):<span className="status-badge">Optional</span>}</div>
    <div className="switch-row"><div><b>Linked wallets</b><small>{me?.wallets?.length||0} wallet(s)</small></div><button className="soft-action" onClick={linkWallet}><Link2 size={12}/> Add wallet</button></div>
    {me?.wallets?.map((w:any)=><div className="wallet-line" key={w.id}><div><b>{w.chain} · {w.address.slice(0,7)}…{w.address.slice(-5)}</b><small>{w.isPrimary?"Primary · ":""}{w.tradingEnabled?"Trading permission active":"No unattended trading permission"}</small></div><button className="soft-action" disabled={w.tradingEnabled||Boolean(w.permissionRef)} onClick={()=>unlinkWallet(w.id)}>Unlink</button></div>)}
    <div className="switch-row"><div><b>X account</b><small>{me?.linkedSocialAccounts?.find((x:any)=>x.provider==="X")?.username?`@${me.linkedSocialAccounts.find((x:any)=>x.provider==="X").username}`:"Optional"}</small></div><button className="soft-action" onClick={linkX}>Link X</button></div>
    {me?.role==="OWNER"&&<div className="switch-row"><div><b>Admin Command Center</b><small>Owner platform controls</small></div><a className="soft-action" href="/admin/">Open Admin</a></div>}
   </section>
   <section className="settings-block"><h3>Trading defaults</h3>
    <label className="field"><span>Default amount per copy</span><input type="number" value={trading.defaultAmountUsd??100} onChange={e=>patchTrading({defaultAmountUsd:Number(e.target.value)})}/></label>
    <label className="field"><span>Maximum per trade</span><input type="number" value={trading.maxAmountPerTradeUsd??500} onChange={e=>patchTrading({maxAmountPerTradeUsd:Number(e.target.value)})}/></label>
    <label className="field"><span>Maximum total exposure</span><input type="number" value={trading.maxTotalExposureUsd??2500} onChange={e=>patchTrading({maxTotalExposureUsd:Number(e.target.value)})}/></label>
    <div className="switch-row"><div><b>Adaptive chase</b><small>Uses source-wallet entry, never the 24h move</small></div><button className={`switch ${trading.adaptiveChase?"on":""}`} onClick={()=>patchTrading({adaptiveChase:!trading.adaptiveChase})}><i/></button></div>
    <div className="switch-row"><div><b>Runner mode</b><small>Do not cap exceptional winners just because profit is large</small></div><button className={`switch ${trading.runnerMode?"on":""}`} onClick={()=>patchTrading({runnerMode:!trading.runnerMode})}><i/></button></div>
   </section>
   <section className="settings-block"><h3>Notifications</h3>
    <div className="switch-row"><div><b>Web Push</b><small>Register this browser/device</small></div><button className="soft-action" onClick={enablePush}>Enable Push</button></div>
    {[['traderBought','Trader bought'],['tradeCopied','Trade copied'],['skippedTrade','Skipped / pullback'],['profitTaken','Profit taken'],['positionClosed','Position closed'],['platformBroadcast','Platform announcements']].map(([k,label])=><div className="switch-row" key={k}><div><b>{label}</b><small>Personal notification preference</small></div><button className={`switch ${prefs?.[k]!==false?"on":""}`} onClick={()=>patchNotifications({[k]:prefs?.[k]===false})}><i/></button></div>)}
    <div className="switch-row"><div><b>Unread notifications</b><small>Personal to this account</small></div><div style={{display:"flex",gap:6,alignItems:"center"}}><span className="status-badge">{notifications.filter(x=>!x.readAt).length}</span>{notifications.some(x=>!x.readAt)&&<button className="soft-action" onClick={markNotificationsRead}>Mark read</button>}</div></div>
    <div className="notification-inbox">{notifications.slice(0,8).map((n:any)=><div className={`notification-row ${n.readAt?"":"unread"}`} key={n.id}><i/><div><b>{n.title}</b><small>{n.body}</small></div><span>{timeAgo(n.createdAt)}</span></div>)}{!notifications.length&&<small>No notifications yet.</small>}</div>
   </section>
   <section className="settings-block"><h3>Security &amp; permission</h3>
    <div className="notice green">Account login and wallet connection are separate from unattended trading authorization. Live automatic execution remains off until a reviewed delegated/session signer is configured.</div>
    <div className="switch-row"><div><b>Auto Copy</b><small>Controls new automatic entries</small></div><button className={`switch ${trading.autoCopyEnabled?"on":""}`} onClick={()=>patchTrading({autoCopyEnabled:!trading.autoCopyEnabled})}><i/></button></div>
    <div className="session-list"><b>Signed-in sessions</b>{sessions?.length?sessions.map((s:any)=><div className="wallet-line" key={s.id}><div><small>{s.userAgent?.slice(0,70)||"Unknown device"}</small><small>Last used {timeAgo(s.lastUsedAt)} · expires {new Date(s.expiresAt).toLocaleDateString()}</small></div><button className="soft-action" onClick={()=>revokeSession(s.id)}>Revoke</button></div>):<small>No active refresh sessions listed.</small>}</div>
    <button className="soft-action" style={{width:"100%",marginTop:12}} onClick={signOut}><LogOut size={13}/> Sign out</button>
    <div className="danger-zone"><b>Close account</b><small>This disables Auto Copy and revokes signed-in sessions. Trading/audit records are preserved for financial integrity.</small><input type={me?.hasPassword?"password":"text"} value={closeValue} onChange={e=>setCloseValue(e.target.value)} placeholder={me?.hasPassword?"Enter your password":"Type CLOSE MY ACCOUNT"}/><button className="danger-action" onClick={closeAccount}>Close my account</button></div>
   </section>
  </div>
 </>;
}
function Empty({icon:Icon,title,body,action,onClick}:{icon:any;title:string;body:string;action?:string;onClick?:()=>void}){return <div className="empty"><Icon size={21}/><b>{title}</b><p>{body}</p>{action&&<button onClick={onClick}>{action}</button>}</div>}
