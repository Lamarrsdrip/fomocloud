"use client";
import {useEffect,useMemo,useState} from "react";
import dynamic from "next/dynamic";
import {
  Home,Users,Activity,WalletCards,UserRound,Bell,Power,Plus,Search,Settings2,
  ShieldCheck,LogOut,ArrowUpRight,Eye,Copy,Pause,Play,ChevronRight,Link2,RefreshCw,
  TrendingUp,Flame,Sparkles,CheckCheck,ArrowLeft,Wallet,Zap,ArrowDownToLine,X
} from "lucide-react";
import {apiFetch,logout,money,pct,plainError} from "../../lib/api";
import {
  initials,timeAgo,urlB64ToBytes,pushEnv,whaleCount,copyText,feedLine,eventLine,
  qualityLabel,LIFECYCLE_LABELS,lifecycleLabel,STAGE_LABELS,DECISION_ACTION_LABELS,
  decisionActionLabel,SMART_MONEY_FILTERS,smartMoneyFilterLabel,positionMath,deviceLabel
} from "../../lib/format";
import {connectWallet,signWithWallet,type DetectedWallet} from "../../lib/wallet";
import {BrandGlyph} from "../../components/BrandGlyph";
import WalletChooser from "../../components/WalletChooser";
// Privy's SDK is large (full multi-chain support) even though only its Solana slice is used here
// -- next/dynamic keeps it out of this route's main bundle entirely, fetched only once someone
// actually opens the wallet panel. See the comment at the top of EmbeddedWalletPanel.tsx.
const EmbeddedWalletPanel=dynamic(()=>import("../../components/EmbeddedWalletPanel"),{ssr:false,loading:()=><div className="switch-row"><div><b>MemeCloud wallet</b><small>Loading…</small></div></div>});

type View="home"|"discover"|"trade"|"positions"|"profile"|"traders"|"community"|"activity"|"smart-wallets";
const nav:[View,string,any][]=[["home","Home",Home],["discover","Discover",TrendingUp],["trade","Trade",Zap],["positions","Portfolio",WalletCards],["profile","Account",Settings2]];
const mobileNav=nav;

function initialView():View{
  if(typeof window==="undefined") return "home";
  const q=new URLSearchParams(location.search).get("view") as View|null;
  return nav.some(x=>x[0]===q)?q!:"home";
}
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
  const[brain,setBrain]=useState<any[]>([]);
  const[brainDegraded,setBrainDegraded]=useState(false);
  // Explicitly separate from `brain` (the qualified feed) -- early/raw intelligence that hasn't
  // cleared the same evidence bar. Kept apart in state, not just filtered client-side, so the two
  // never accidentally get merged back into one undifferentiated list.
  const[newTokenRadar,setNewTokenRadar]=useState<any[]>([]);
  const[positionsDegraded,setPositionsDegraded]=useState(false);
  const[selectedMint,setSelectedMint]=useState<{chain:string;mint:string}|null>(null);

  function setView(v:View){setViewState(v);history.replaceState(null,"",`/app/?view=${v}`)}
  async function load(){
    setLoading(true);setError("");
    try{
      const [m,d,p,f,a,pos,t,s,n,ss]=await Promise.all([
        apiFetch("/v1/me"),apiFetch("/v1/me/dashboard"),apiFetch("/v1/traders"),apiFetch("/v1/me/traders"),
        apiFetch("/v1/me/activity"),apiFetch("/v1/me/positions"),apiFetch("/v1/me/trades"),apiFetch("/v1/me/settings"),apiFetch("/v1/me/notifications"),apiFetch("/v1/me/sessions")
      ]);
      setMe(m.user);setDashboard(d);setPlatform(p.traders||[]);setFollows(f.follows||[]);setActivity(a);setPositions(pos.positions||[]);setPositionsDegraded(Boolean(pos.pipelineDegraded));setTrades(t.orders||[]);setSettings(s);setNotifications(n.notifications||[]);setSessions(ss.sessions||[]);
      apiFetch<any>("/v1/brain/feed").then(x=>{setBrain(x.opportunities||[]);setNewTokenRadar(x.newTokenRadar||[]);setBrainDegraded(Boolean(x.pipelineDegraded))}).catch(()=>{});
    }catch(e:any){
      if(e?.status===401){
        // A silent bounce back to a blank login form (no explanation) is exactly the Phantom
        // in-app-browser failure mode reported in production: the access token or refresh cookie
        // didn't survive the prior navigation, so every bootstrap call 401s. Never hide that --
        // surface it on the login screen instead of pretending nothing happened.
        try{sessionStorage.setItem("memecloud_login_notice","Your session could not be established. Please sign in again.")}catch{}
        location.replace("/login/");return;
      }
      setError(plainError(e));
    }finally{setLoading(false)}
  }
  useEffect(()=>{setViewState(initialView());void load()},[]);
  useEffect(()=>{
    let stopped=false;
    const refreshLive=async()=>{
      if(stopped||document.visibilityState!=="visible")return;
      try{
        const[d,a,pos,t,n,b]=await Promise.all([apiFetch("/v1/me/dashboard"),apiFetch("/v1/me/activity"),apiFetch("/v1/me/positions"),apiFetch("/v1/me/trades"),apiFetch("/v1/me/notifications"),apiFetch<any>("/v1/brain/feed")]);
        if(!stopped){setDashboard(d);setActivity(a);setPositions(pos.positions||[]);setPositionsDegraded(Boolean(pos.pipelineDegraded));setTrades(t.orders||[]);setNotifications(n.notifications||[]);setBrain(b.opportunities||[]);setNewTokenRadar(b.newTokenRadar||[]);setBrainDegraded(Boolean(b.pipelineDegraded))}
      }catch(e:any){if(e?.status===401&&!stopped)location.replace("/login/")}
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
  async function signOut(){await logout();location.replace("/login/")}

  if(loading&&!me)return <main className="app-page"><div className="loading"><div><div className="spinner"/>Loading your account…</div></div></main>;

  return <main className="app-page">
    <div className="app-layout">
      <aside className="app-sidebar">
        <a className="brand" href="/"><span className="brandmark small"><BrandGlyph size={18}/></span><b>MemeCloud</b></a>
        <nav className="app-nav">{nav.map(([id,label,Icon])=><button key={id} onClick={()=>{setSelectedMint(null);setView(id)}} className={view===id?"active":""}><Icon size={16}/>{label}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||me?.wallets?.[0]?.address?.slice(0,10)||"Wallet account"}</small></div></div>
        </div>
      </aside>

      <section className="app-main">
        {selectedMint?<TokenDetail sel={selectedMint} opp={brain.find(o=>o.mint===selectedMint.mint)} me={me} close={()=>setSelectedMint(null)} onTraded={load}/>:<>
        <div className="app-top">
          <div><small>YOUR MemeCloud</small><h1>{view==="home"?"Home":view==="discover"?"Discover":view==="trade"?"Trade":view==="traders"?"Traders":view==="community"?"Copy":view==="activity"?"Activity":view==="positions"?"Portfolio":view==="profile"?"Account":view==="smart-wallets"?"Smart Wallets":"MemeCloud"}</h1></div>
          <div className="app-top-actions">
            <button className={`auto-toggle ${autoOn?"":"off"}`} onClick={toggleAuto}>{autoOn?<Play size={14}/>:<Pause size={14}/>} Auto Trade {autoOn?"On":"Off"}</button>
            <button className="icon-btn notification-button" onClick={()=>setView("profile")} aria-label={`${unread} unread notifications`}><Bell size={17}/>{unread>0&&<span className="notification-count">{unread>99?"99+":unread}</span>}</button>
          </div>
        </div>
        {error&&<div className="auth-error" style={{marginBottom:12}}>{error}</div>}
        {view==="home"&&<HomeView d={dashboard} activity={activity} brain={brain} brainDegraded={brainDegraded} setView={setView} openToken={setSelectedMint}/>}
        {view==="discover"&&<DiscoverView brain={brain} newTokenRadar={newTokenRadar} brainDegraded={brainDegraded} setView={setView} openToken={setSelectedMint}/>}
        {view==="smart-wallets"&&<SmartWalletsView/>}
        {view==="trade"&&<TradeView settings={settings} trades={trades} patchTrading={async(body:any)=>{try{const r=await apiFetch<any>("/v1/me/settings/trading",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,trading:r.trading}))}catch(e){setError(plainError(e))}}} setView={setView}/>}
        {view==="traders"&&<TradersView platform={platform} follows={follows} followMap={followMap} setMode={setTraderMode} customOpen={customOpen} setCustomOpen={setCustomOpen} reload={load}/>}
        {view==="community"&&<CopyView follows={follows} setMode={setTraderMode} setView={setView}/>}
        {view==="activity"&&<ActivityView activity={activity} trades={trades}/>}
        {view==="positions"&&<PositionsView positions={positions} degraded={positionsDegraded} d={dashboard} me={me} reload={load}/>}
        {view==="profile"&&<ProfileView me={me} setMe={setMe} settings={settings} notifications={notifications} sessions={sessions} setSettings={setSettings} reload={load} signOut={signOut} setView={setView}/>}
        </>}
      </section>
    </div>
    <nav className="mobile-app-nav">{mobileNav.map(([id,label,Icon])=><button key={id} onClick={()=>{setSelectedMint(null);setView(id)}} className={view===id?"active":""}><Icon size={19}/>{label}</button>)}</nav>
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

function HomeView({d,activity,brain,brainDegraded,setView,openToken}:{d:any;activity:any;brain:any[];brainDegraded:boolean;setView:(v:View)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const s=d?.summary||{};
 const feed=useMemo(()=>{
  const brainItems=brain.slice(0,8).map(o=>({...feedLine(o),at:o.lastEvaluatedAt,mint:o.mint,chain:o.chain}));
  const eventItems=(activity?.events||[]).slice(0,8).map((e:any)=>eventLine(e));
  return [...brainItems,...eventItems].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).slice(0,10);
 },[brain,activity]);
 // Real gap found by forensic audit (M-41): Home showed only trading cash + net P&L, and had no
 // "MemeCloud Pulse" / Auto Trade status at all -- both explicitly required, and both computable
 // from data this view already fetches (no new backend calls). Every count below is real evidence
 // already returned by /v1/brain/feed and /v1/me/dashboard, never invented client-side.
 const pulse=useMemo(()=>{
  const heatingUp=brain.filter(o=>o.lifecycleStatus==="HEATING_UP").length;
  const strong=brain.filter(o=>o.lifecycleStatus==="STRONG").length;
  const moneyRush=brain.filter(o=>o.lifecycleStatus==="HIGH_CONVICTION").length;
  const whaleActive=brain.filter(o=>whaleCount(o)>0).length;
  return {heatingUp,strong,moneyRush,whaleActive};
 },[brain]);
 const hotNow=useMemo(()=>[...brain].sort((a,b)=>b.score-a.score).slice(0,3),[brain]);
 const autoTradeOn=Boolean(d?.settings?.autoCopyEnabled);
 return <>
  <section className="home-hero">
   <div><span>TOTAL VALUE</span><h2>{money(s.accountValueUsd)}</h2></div>
   <div className="home-hero-pnl"><span>TODAY</span><b className={(s.todayPnlUsd||0)>=0?"positive":"negative"}>{(s.todayPnlUsd||0)>=0?"+":""}{money(s.todayPnlUsd)}</b></div>
  </section>
  <div className="review-grid" style={{marginBottom:14}}>
   <div><span>Available</span><b>{money(s.availableUsd)}</b></div>
   <div><span>In Trades</span><b>{money(s.inTradesUsd)}</b></div>
   <div><span>Total P&amp;L</span><b className={(s.netPnlUsd||0)>=0?"positive":"negative"}>{(s.netPnlUsd||0)>=0?"+":""}{money(s.netPnlUsd)}</b></div>
  </div>
  <div className="quick-actions-row">
   <button onClick={()=>setView("profile")}><ArrowDownToLine size={18}/><span>Fund</span></button>
   <button onClick={()=>setView("trade")}><Zap size={18}/><span>Trade</span></button>
   <button onClick={()=>setView("discover")}><TrendingUp size={18}/><span>Discover</span></button>
   <button onClick={()=>setView("positions")}><WalletCards size={18}/><span>Portfolio</span></button>
  </div>
  <section className="app-card"><div className="card-title"><div><span>MEMECLOUD PULSE</span><h2>What's happening right now</h2></div>{brainDegraded&&<span className="status-badge watch">Degraded</span>}</div>
   {brainDegraded?<p style={{fontSize:11,color:"#8a8fa0",margin:0}}>The market data provider is rate-limited right now, so these counts aren't updating. Not a sign the market is quiet -- existing counts just aren't live.</p>:
   <div className="review-grid">
    <div><span>Heating up</span><b>{pulse.heatingUp}</b></div>
    <div><span>Strong setups</span><b>{pulse.strong}</b></div>
    <div><span>Money Rush</span><b>{pulse.moneyRush}</b></div>
    <div><span>Whale activity</span><b>{pulse.whaleActive}</b></div>
   </div>}
  </section>
  <section className="app-card"><div className="card-title"><div><span>AUTO TRADE</span><h2>{autoTradeOn?"On":"Off"}</h2></div><span className="status-badge">{s.copiedTraders||0} traders copied</span></div>
   <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 10px"}}>{autoTradeOn?"Eligible opportunities are executed automatically within your own limits.":"MemeCloud still scans markets and alerts you. Turn Auto Trade on only if you want eligible opportunities executed automatically."}</p>
   <button className="soft-action" onClick={()=>setView("traders")}>{autoTradeOn?"Manage Auto Trade":"Set up Auto Trade"}</button>
  </section>
  {Boolean(hotNow.length)&&<section className="app-card"><div className="card-title"><div><span>HOT RIGHT NOW</span><h2>Top opportunities</h2></div><button className="soft-action" onClick={()=>setView("discover")}>See all</button></div>
   <div className="token-list">{hotNow.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"Token"}</b><small>{o.reasons?.[0]||"Building evidence"}</small></div>
    <div className="token-row-side"><span className="status-badge">{lifecycleLabel(o.lifecycleStatus)}</span></div>
   </div>)}</div>
  </section>}
  <section className="app-card live-feed"><div className="card-title"><div><span>MEMECLOUD</span><h2>Live activity</h2></div><span className="status-badge">Live</span></div>
   {feed.length?<div className="feed-list">{feed.map((f,i)=><div className={`feed-item ${f.mint?"tap":""}`} key={i} onClick={()=>f.mint&&openToken({chain:f.chain,mint:f.mint})}><span className="feed-emoji">{f.emoji}</span><div><b>{f.text}</b><small>{f.sub}</small></div><small className="feed-time">{timeAgo(f.at)}</small></div>)}</div>:<div className="pnl-empty">{brainDegraded?"Discovery activity is temporarily paused -- the market data provider is rate-limited right now. This will resume automatically once it recovers.":"MemeCloud is scanning the chain. Real activity appears here as evidence arrives — nothing is invented while it's quiet."}</div>}
  </section>
 </>;
}
function StatusLine({label,value,ok}:{label:string;value:string;ok:boolean}){return <div className="list-row" style={{gridTemplateColumns:"1fr auto"}}><div><b>{label}</b></div><span className={`status-badge ${ok?"":"watch"}`}>{value}</span></div>}

const discoverFilters=[["trending","Trending now",TrendingUp],["whales","Whales buying",Users],["new","New",Sparkles],["momentum","Momentum",Flame]] as const;
function TokenAvatar({symbol,size=38}:{symbol?:string;size?:number}){return <div className="token-avatar" style={{width:size,height:size,fontSize:size*0.4}}>{(symbol||"?").slice(0,2).toUpperCase()}</div>}
function DiscoverView({brain,newTokenRadar,brainDegraded,setView,openToken}:{brain:any[];newTokenRadar:any[];brainDegraded:boolean;setView:(v:View)=>void;openToken:(s:{chain:string;mint:string})=>void}){
 const[filter,setFilter]=useState<typeof discoverFilters[number][0]>("trending");
 const rows=useMemo(()=>{
  const list=[...brain];
  if(filter==="trending")return list.sort((a,b)=>b.score-a.score);
  if(filter==="whales")return list.filter(o=>whaleCount(o)>0).sort((a,b)=>whaleCount(b)-whaleCount(a));
  if(filter==="new")return list.sort((a,b)=>new Date(b.firstSeenAt).getTime()-new Date(a.firstSeenAt).getTime());
  return list.sort((a,b)=>(b.volumeAcceleration1m||0)-(a.volumeAcceleration1m||0));
 },[brain,filter]);
 return <>
  {brainDegraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Discovery data is temporarily degraded — the market data provider is rate-limited, so new tokens aren't being scored right now. This isn't "nothing happening," it's a real provider outage; existing evidence stays honest rather than looking falsely live.</div>}
  <div className="config-tabs discover-tabs">{discoverFilters.map(([id,label,Icon])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}><Icon size={13} style={{verticalAlign:"middle",marginRight:5}}/>{label}</button>)}<button onClick={()=>setView("smart-wallets")}><Users size={13} style={{verticalAlign:"middle",marginRight:5}}/>Smart Wallets</button></div>
  {rows.length?<div className="token-list">{rows.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"New token"}</b><small>{o.chain} · {money(o.marketCapUsd||0)} MC · {money(o.inflow60sUsd||0)} / 60s · Found {timeAgo(o.firstSeenAt)}</small>{o.reasons?.[0]&&<small className="token-row-reason">{o.reasons[0]}</small>}</div>
    <div className="token-row-side"><span className={`status-badge ${o.action==="BUY_NOW"?"":o.lifecycleStatus==="STALE"||o.lifecycleStatus==="COOLING"?"watch":""}`}>{whaleCount(o)>0?`🐋 ${whaleCount(o)}`:lifecycleLabel(o.lifecycleStatus||qualityLabel(o.score))}</span><small>{o.volumeAcceleration1m?`${o.volumeAcceleration1m.toFixed(1)}x momentum`:"Watching"}</small></div>
   </div>)}</div>:<Empty icon={TrendingUp} title={brainDegraded?"Discovery is temporarily paused":"Nothing here yet"} body={brainDegraded?"The market data provider is rate-limited right now, so MemeCloud isn't scoring new tokens. This will resume automatically once the provider recovers.":"MemeCloud is scanning chain flow. Real opportunities appear here as on-chain evidence arrives — nothing is invented while it's quiet."} action="Browse traders instead" onClick={()=>setView("traders")}/>}
  {Boolean(newTokenRadar.length)&&<>
   <div className="card-title" style={{marginTop:20}}><div><span>NEW TOKEN RADAR</span><h2>Early, unqualified activity</h2></div></div>
   <div className="notice" style={{marginBottom:12}}>These tokens haven't cleared MemeCloud's evidence bar yet — early/raw intelligence, not a recommendation. They may never qualify.</div>
   <div className="token-list">{newTokenRadar.map(o=><div className="token-row" key={o.id} onClick={()=>openToken({chain:o.chain,mint:o.mint})}>
    <TokenAvatar symbol={o.symbol||o.name}/>
    <div className="token-row-main"><b>{o.symbol||o.name||"New token"}</b><small>{o.chain} · {money(o.marketCapUsd||0)} MC · Found {timeAgo(o.firstSeenAt)}</small></div>
    <div className="token-row-side"><span className="status-badge watch">{lifecycleLabel(o.lifecycleStatus)}</span></div>
   </div>)}</div>
  </>}
 </>
}

function SmartWalletsView(){
 const[wallets,setWallets]=useState<any[]|null>(null);
 const[degraded,setDegraded]=useState(false);
 const[filter,setFilter]=useState<typeof SMART_MONEY_FILTERS[number]>("all");
 const[detail,setDetail]=useState<any|null>(null);
 const[detailBusy,setDetailBusy]=useState(false);
 useEffect(()=>{let live=true;apiFetch<any>("/v1/smart-wallets",{},false).then(x=>{if(live){setWallets(x.wallets||[]);setDegraded(Boolean(x.pipelineDegraded))}}).catch(()=>{if(live)setWallets([])});return()=>{live=false}},[]);
 const rows=useMemo(()=>{
  const list=wallets||[];
  const now=Date.now();
  if(filter==="whales")return list.filter(w=>w.isWhale);
  if(filter==="proven")return list.filter(w=>w.stage==="PROVEN");
  if(filter==="new")return list.filter(w=>now-new Date(w.firstDiscoveredAt).getTime()<24*3600_000).sort((a,b)=>new Date(b.firstDiscoveredAt).getTime()-new Date(a.firstDiscoveredAt).getTime());
  if(filter==="hot")return list.filter(w=>now-new Date(w.lastActivityAt).getTime()<3600_000&&w.copyabilityScore>=60).sort((a,b)=>b.copyabilityScore-a.copyabilityScore);
  return list;
 },[wallets,filter]);
 async function open(id:string){
  setDetailBusy(true);
  try{const x=await apiFetch<any>(`/v1/smart-wallets/${id}`,{},false);setDetail(x)}catch{}finally{setDetailBusy(false)}
 }
 return <>
  <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 12px"}}>Wallets MemeCloud discovered from real on-chain meme activity — not manually entered. Ratings require a meaningful sample size, never one lucky trade.</p>
  {degraded&&<div className="notice" style={{marginBottom:12,borderColor:"rgba(247,185,95,.3)"}}>Scoring is temporarily degraded — the market data provider is rate-limited, so ratings below aren't updating right now. Existing scores stay visible but may be stale.</div>}
  <div className="config-tabs discover-tabs">
   {SMART_MONEY_FILTERS.map(f=><button key={f} className={filter===f?"active":""} onClick={()=>setFilter(f)}>{f==="whales"&&<Wallet size={13} style={{verticalAlign:"middle",marginRight:5}}/>}{smartMoneyFilterLabel(f)}</button>)}
  </div>
  {wallets===null?<div className="loading" style={{minHeight:180}}>Loading…</div>:rows.length?<div className="token-list">{rows.map(w=>
   <div className="token-row" key={w.id} onClick={()=>open(w.id)}>
    <TokenAvatar symbol={w.address.slice(0,2)}/>
    <div className="token-row-main"><b>{w.address.slice(0,6)}…{w.address.slice(-5)}</b><small>{w.chain} · {STAGE_LABELS[w.stage]||w.stage} · {w.sampleTrades} trade(s) observed{w.isWhale?` · 🐋 ${w.whaleTier?.replace("WHALE_","")}`:""}</small></div>
    <div className="token-row-side"><span className="status-badge">{w.winRatePct!==null?`${w.winRatePct}% win`:"Not enough data"}</span><small>{w.realizedPnl7dUsd!=null?`7D ${money(w.realizedPnl7dUsd)}`:`Score ${Math.round(w.copyabilityScore)}`}</small></div>
   </div>
  )}</div>:<Empty icon={Users} title={degraded?"Scoring is temporarily degraded":"No smart wallets discovered yet"} body={degraded?"The market data provider is rate-limited right now, so wallet scoring isn't updating. This will resume automatically once the provider recovers.":"MemeCloud saves a candidate once it observes genuine meme-trading activity from a wallet. This list fills in as real chain data arrives."} />}
  {(detail||detailBusy)&&<div className="wallet-chooser-wrap" onClick={()=>setDetail(null)}>
   <div className="wallet-chooser-sheet" onClick={e=>e.stopPropagation()}>
    <div className="wallet-chooser-handle"/>
    <div className="wallet-chooser-head"><b>{detailBusy&&!detail?"Loading…":`${detail?.wallet.address.slice(0,8)}…${detail?.wallet.address.slice(-6)}`}</b><button type="button" className="wallet-chooser-close" onClick={()=>setDetail(null)} aria-label="Close"><X size={16}/></button></div>
    {detail&&<>
     <p>{STAGE_LABELS[detail.wallet.stage]||detail.wallet.stage} · Discovered {timeAgo(detail.wallet.firstDiscoveredAt)} · Last active {detail.wallet.lastActivityAt?timeAgo(detail.wallet.lastActivityAt):"unknown"}{detail.wallet.isWhale?` · 🐋 Whale tier ${detail.wallet.whaleTier?.replace("WHALE_","")}`:""}</p>
     <div className="app-grid-4" style={{marginBottom:14}}>
      <div className="stat-card"><span>Win rate</span><b>{detail.wallet.winRatePct!==null?`${detail.wallet.winRatePct}%`:"Unknown"}</b></div>
      <div className="stat-card"><span>Trades observed</span><b>{detail.wallet.sampleTrades}</b></div>
      <div className="stat-card"><span>Copyability</span><b>{Math.round(detail.wallet.copyabilityScore)}</b></div>
      <div className="stat-card"><span>Risk</span><b>{Math.round(detail.wallet.riskScore)}</b></div>
     </div>
     <div className="control-list" style={{marginBottom:14}}>
      <div><span>7D realized P&amp;L</span><b className={detail.wallet.realizedPnl7dUsd==null?"":(detail.wallet.realizedPnl7dUsd>=0?"positive":"negative")}>{detail.wallet.realizedPnl7dUsd==null?"Unknown":money(detail.wallet.realizedPnl7dUsd)}</b></div>
      <div><span>30D realized P&amp;L</span><b className={detail.wallet.realizedPnlUsd>=0?"positive":"negative"}>{money(detail.wallet.realizedPnlUsd)}</b></div>
      <div><span>Volume observed</span><b>{money(detail.wallet.volumeUsd)}</b></div>
      <div><span>Rug exposure</span><b>{detail.wallet.rugExposurePct!==null?`${detail.wallet.rugExposurePct.toFixed(0)}%`:"Unknown"}</b></div>
      <div><span>Insider risk</span><b>{detail.wallet.insiderRiskPct!==null?`${detail.wallet.insiderRiskPct.toFixed(0)}%`:"Unknown"}</b></div>
     </div>
     {detail.currentTokens?.length>0&&<><b style={{fontSize:11}}>Recently tracked tokens</b><div className="list" style={{margin:"8px 0 14px"}}>{detail.currentTokens.map((t:any,i:number)=><div className="list-row" style={{gridTemplateColumns:"1fr auto"}} key={i}><div><b>{t.mint.slice(0,10)}…</b><small>{t.side} · {timeAgo(t.lastSeenAt)}</small></div></div>)}</div></>}
    </>}
   </div>
  </div>}
 </>;
}

function TokenDetail({sel,opp,me,close,onTraded}:{sel:{chain:string;mint:string};opp:any;me:any;close:()=>void;onTraded:()=>void}){
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

function TradeView({settings,trades,patchTrading,setView}:{settings:any;trades:any[];patchTrading:(b:any)=>Promise<void>;setView:(v:View)=>void}){
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

function TradersView({platform,follows,followMap,setMode,customOpen,setCustomOpen,reload}:{platform:any[];follows:any[];followMap:Map<string,any>;setMode:(id:string,m:string)=>void;customOpen:boolean;setCustomOpen:(v:boolean)=>void;reload:()=>Promise<void>}){
 const [search,setSearch]=useState(""); const[detail,setDetail]=useState<string|null>(null); const filtered=platform.filter(t=>`${t.displayName} ${t.handle} ${t.category||""}`.toLowerCase().includes(search.toLowerCase()));
 return <>
  {detail&&<TraderDetail traderId={detail} close={()=>setDetail(null)}/>}
  <div style={{display:"flex",gap:8,marginBottom:12}}><label className="field" style={{flex:1}}><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search traders"/></label><button className="soft-action" onClick={()=>setCustomOpen(!customOpen)}><Plus size={14}/> Add trader</button></div>
  {customOpen&&<CustomTrader reload={reload} close={()=>setCustomOpen(false)}/>}
  <div className="card-title"><div><span>DISCOVER</span><h2>Traders worth watching</h2></div></div>
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


function CopyView({follows,setMode,setView}:{follows:any[];setMode:(id:string,m:string)=>void;setView:(v:View)=>void}){
 const auto=follows.filter((f:any)=>f.mode==="AUTO_COPY");
 const watching=follows.filter((f:any)=>f.mode!=="AUTO_COPY");
 return <>
  <section className="copy-hero"><div><span>AUTO COPY</span><h2>Choose who MemeCloud can follow for you.</h2><p>Pick a trader, set them to Auto Copy, and your own account rules still decide whether each trade is safe to take.</p></div><button className="action-primary" onClick={()=>setView("traders")}><Users size={15}/> Find traders</button></section>
  <div className="app-two">
   <section className="app-card"><div className="card-title"><div><span>ACTIVE</span><h2>Auto Copy</h2></div><span className="status-badge">{auto.length} active</span></div>{auto.length?<div className="list">{auto.map((f:any)=><div className="list-row copy-row" key={f.id}><div><b>{f.trader?.displayName||"Trader"}</b><small>@{f.trader?.handle||"tracked"}</small></div><span className="status-badge">Auto Copy</span><button className="soft-action" onClick={()=>setMode(f.traderId,"WATCH_ONLY")}>Pause</button></div>)}</div>:<Empty icon={Copy} title="No Auto Copy traders yet" body="Discover a trader you trust and tap Auto Copy. MemeCloud still applies your personal limits before acting." action="Discover traders" onClick={()=>setView("traders")}/>}</section>
   <section className="app-card"><div className="card-title"><div><span>WATCHLIST</span><h2>Following & watching</h2></div></div>{watching.length?<div className="list">{watching.map((f:any)=><div className="list-row copy-row" key={f.id}><div><b>{f.trader?.displayName||"Trader"}</b><small>{String(f.mode||"FOLLOW_ONLY").replaceAll("_"," ")}</small></div><button className="soft-action" onClick={()=>setMode(f.traderId,"AUTO_COPY")}>Auto Copy</button></div>)}</div>:<Empty icon={Eye} title="Nothing on your watchlist" body="Follow traders first, then decide who should be watched or copied." action="Discover" onClick={()=>setView("traders")}/>}</section>
  </div>
  <section className="app-card copy-explainer"><div className="card-title"><div><span>HOW IT WORKS</span><h2>Simple on the surface. Careful underneath.</h2></div></div><div className="simple-steps"><div><b>1</b><span>Trader buys</span><small>MemeCloud sees the tracked wallet action.</small></div><div><b>2</b><span>Your rules check it</span><small>Price, liquidity, exposure and your settings are checked.</small></div><div><b>3</b><span>Only then act</span><small>Eligible trades can execute; bad entries are skipped or waited on.</small></div></div></section>
 </>;
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
   {decisions.length?<div className="list">{decisions.map((d:any)=><div className="decision-history" key={d.id}><div><b>{d.signal?.trader?.displayName||"Trader signal"} · {d.signal?.action}</b><small>{d.explanation||d.plainReason||d.reason||"Decision recorded"}</small></div><div className="decision-facts"><span>{decisionActionLabel(d.action)}</span>{d.walletChasePct!=null&&<span>Wallet chase {Number(d.walletChasePct).toFixed(1)}%</span>}<span>{timeAgo(d.createdAt)}</span></div></div>)}</div>:<Empty icon={ShieldCheck} title="No decisions yet" body="Every source signal creates a decision for your account only after your own settings are applied."/>}
  </section>
 </div>
 <section className="app-card" style={{marginTop:12}}><div className="card-title"><div><span>TRADE HISTORY</span><h2>Your orders and confirmations</h2></div></div>
  {trades.length?<div className="list">{trades.map((o:any)=><div className="trade-history-row" key={o.id}><div><b>{o.decision?.signal?.trader?.displayName||"Copied trade"} · {o.side}</b><small>{o.chain} · {o.venue||"Route pending"} · {o.mode}</small></div><span className="sim-badge">{o.status}</span><span>{o.txHash?`${o.txHash.slice(0,8)}…`:o.mode==="SIMULATION"?"No live tx":"Awaiting tx"}</span><span>{timeAgo(o.createdAt)}</span></div>)}</div>:<Empty icon={WalletCards} title="No trade history yet" body="Confirmed live orders and clearly labeled simulations for this account appear here. A quote alone never counts as a completed live trade."/>}
 </section>
 </>
}

function PositionRow({p}:{p:any}){
 const m=positionMath(p);
 const recovered=(p.profitTakenUsd||0)>=(p.costUsd||0)&&(p.costUsd||0)>0;
 return <div className="position-row"><div className="position-main"><div className="position-token"><b>{p.mint?.slice(0,8)}…</b><span className="sim-badge">{p.mode}</span><span className="status-badge">{String(p.status).replaceAll("_"," ")}</span></div><small>{p.sourceTrader?.displayName||"Source trader"} · {p.chain} · opened {timeAgo(p.openedAt)}</small>{p.status!=="CLOSED"&&<small className={recovered?"positive":""}>{recovered?"✓ Principal recovered · runner active":"Principal not recovered"}</small>}</div><div><span>Invested remaining</span><b>{money(m.remainingCost)}</b></div><div><span>Current value</span><b>{p.currentPriceUsd?money(m.currentValue):"Awaiting mark"}</b></div><div><span>Unrealized</span><b className={(p.unrealizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.unrealizedPnlUsd)} <small>({pct(m.pnlPct)})</small></b></div><div><span>Realized</span><b className={(p.realizedPnlUsd||0)>=0?"positive":"negative"}>{money(p.realizedPnlUsd)}</b></div><div><span>Profit taken</span><b>{money(p.profitTakenUsd)}</b></div></div>}
function PositionsView({positions,degraded,d,me,reload}:{positions:any[];degraded:boolean;d:any;me:any;reload:()=>Promise<void>}){const[filter,setFilter]=useState("ALL");const shown=positions.filter(p=>filter==="ALL"?true:filter==="OPEN"?(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED"):p.status==="CLOSED");const s=d?.summary||{};return <>
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

function ProfileView({me,setMe,settings,notifications,sessions,setSettings,reload,signOut,setView}:{me:any;setMe:any;settings:any;notifications:any[];sessions:any[];setSettings:any;reload:()=>Promise<void>;signOut:()=>void;setView:(v:View)=>void}){
 const[err,setErr]=useState(""); const[note,setNote]=useState(""); const[name,setName]=useState(me?.displayName||""); const[username,setUsername]=useState(me?.username||""); const[closeValue,setCloseValue]=useState("");
 // Username save/validation state is deliberately separate from the shared `err` above -- that one
 // is used by several unrelated actions on this same page (X link, wallet unlink, session revoke,
 // trading/notification toggles), and a stale message from any of those must never be mistaken for
 // a problem with the username the user is currently looking at.
 const[usernameStatus,setUsernameStatus]=useState<"idle"|"saving"|"saved"|"error">("idle");
 const[usernameMsg,setUsernameMsg]=useState("");
 const[sessionsOpen,setSessionsOpen]=useState(false);
 // The X OAuth callback redirects here with ?x=connected or ?x=error&reason=... after it finishes
 // its own server-side work. Without reading this, a failed link (expired state, cancelled
 // authorization, token exchange failure) landed the user back on Account with zero explanation --
 // the same silent-failure pattern already fixed for login. history.replaceState strips the query
 // so a later refresh of this same page doesn't re-show a stale result.
 useEffect(()=>{
  const params=new URLSearchParams(location.search);
  const x=params.get("x");
  if(x==="connected"){setNote("X account connected.");history.replaceState(null,"","/app/?view=profile")}
  else if(x==="error"){setErr(params.get("reason")||"Unable to link X right now.");history.replaceState(null,"","/app/?view=profile")}
 },[]);
 const trading=settings?.trading||{}; const prefs=settings?.notifications||{};
 async function patchTrading(body:any){try{const r=await apiFetch("/v1/me/settings/trading",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,trading:r.trading}))}catch(e){setErr(plainError(e))}}
 async function patchNotifications(body:any){try{const r=await apiFetch("/v1/me/settings/notifications",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,notifications:r.notifications}))}catch(e){setErr(plainError(e))}}
 async function saveProfile(){
  setUsernameStatus("saving");setUsernameMsg("");
  try{
   const r=await apiFetch("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username})});
   setMe((x:any)=>({...x,...r.user}));setUsernameStatus("saved");
   setTimeout(()=>setUsernameStatus(s=>s==="saved"?"idle":s),2500);
  }catch(e){setUsernameStatus("error");setUsernameMsg(plainError(e))}
 }
 const[walletChooserOpen,setWalletChooserOpen]=useState(false);
 const[walletBusy,setWalletBusy]=useState(false);
 async function linkWallet(wallet:DetectedWallet){
  setWalletChooserOpen(false);setWalletBusy(true);setErr("");try{
   const address=await connectWallet(wallet.provider);
   // retry:false is required here — these are one-time-use signed challenges. apiFetch's default
   // retry-on-401 behavior would silently resend the exact same challenge+signature a second time
   // whenever a near-expiry access token happened to trigger a refresh, which can only ever fail
   // as "already used" on the retry even when the first attempt genuinely succeeded.
   const c=await apiFetch<any>("/v1/me/wallets/challenge",{method:"POST",body:JSON.stringify({chain:"SOLANA",address})},false);
   const signature=await signWithWallet(wallet.provider,c.message);
   await apiFetch("/v1/me/wallets/verify",{method:"POST",body:JSON.stringify({challengeId:c.challengeId,signature})},false);await reload();
  }catch(e){setErr(plainError(e))}finally{setWalletBusy(false)}
 }
 const[pushState,setPushState]=useState<"checking"|"ios-need-install"|"unsupported"|"need-permission"|"denied"|"on"|"error">("checking");
 const[pushBusy,setPushBusy]=useState(false);const[pushMsg,setPushMsg]=useState("");
 useEffect(()=>{
  (async()=>{
   const env=pushEnv();
   if(env.isIOS&&!env.isStandalone){setPushState("ios-need-install");return}
   if(!env.supported){setPushState("unsupported");return}
   if(Notification.permission==="denied"){setPushState("denied");return}
   try{
    const reg=await navigator.serviceWorker.getRegistration("/sw.js");
    const sub=reg?await reg.pushManager.getSubscription():null;
    if(sub&&Notification.permission==="granted"){setPushState("on");return}
   }catch{}
   setPushState("need-permission");
  })();
 },[]);
 async function enablePush(){
  setPushBusy(true);setPushMsg("");try{
   const env=pushEnv();
   if(env.isIOS&&!env.isStandalone){setPushState("ios-need-install");return}
   if(!env.supported){setPushState("unsupported");return}
   const cfg=await apiFetch<any>("/v1/public/config",{},false);if(!cfg.pushPublicKey)throw new Error("Push has not been configured by the administrator yet.");
   const reg=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;
   const perm=await Notification.requestPermission();
   if(perm==="denied"){setPushState("denied");return}
   if(perm!=="granted")throw new Error("Notification permission was not granted.");
   const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToBytes(cfg.pushPublicKey)});
   await apiFetch("/v1/push/subscribe",{method:"POST",body:JSON.stringify(sub.toJSON())});await reload();setPushState("on");
  }catch(e){setPushMsg(plainError(e));setPushState("error")}finally{setPushBusy(false)}
 }
 async function linkX(){try{const r=await apiFetch<any>("/v1/me/social/x/start");location.href=r.url}catch(e){setErr(plainError(e))}}
 async function unlinkWallet(id:string){if(!confirm("Unlink this wallet from your account? Any active delegated trading permission must be revoked first."))return;try{await apiFetch(`/v1/me/wallets/${id}`,{method:"DELETE"});await reload()}catch(e){setErr(plainError(e))}}
 async function revokeSession(id:string){try{await apiFetch(`/v1/me/sessions/${id}`,{method:"DELETE"});await reload()}catch(e){setErr(plainError(e))}}
 async function markNotificationsRead(){try{await apiFetch("/v1/me/notifications/read",{method:"POST",body:JSON.stringify({})});await reload()}catch(e){setErr(plainError(e))}}
 // The backend only ever resolves here after the SMTP provider has genuinely accepted the
 // message (nodemailer's sendMail throws otherwise, and the route now propagates that as a
 // real error code) — so "sent" below is backend-confirmed, not an optimistic guess.
 async function resendVerification(){setErr("");setNote("");try{const r=await apiFetch<any>("/auth/resend-verification",{method:"POST"});setNote(r?.alreadyVerified?"This email is already verified.":"Verification email sent — check your inbox (and spam folder).")}catch(e){setErr(plainError(e))}}
 async function closeAccount(){
  const expected=me?.hasPassword?"your password":"CLOSE MY ACCOUNT";
  if(!closeValue){setErr(`Enter ${expected} to close this account.`);return}
  if(!confirm("Close this account? Auto Copy will be disabled, sessions revoked, and the account will no longer be usable. Financial/audit records are retained as required for integrity."))return;
  try{await apiFetch("/v1/me/account/close",{method:"POST",body:JSON.stringify(me?.hasPassword?{password:closeValue}:{confirmation:closeValue})});await signOut()}catch(e){setErr(plainError(e))}
 }
 return <>
  {err&&<div className="auth-error">{err}</div>}
  {note&&<div className="auth-success">{note}</div>}
  <div className="settings-grid">
   <section className="settings-block"><h3>Account</h3><div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||"Wallet-created account"}</small></div></div>
    <label className="field"><span>Display name</span><input value={name} onChange={e=>setName(e.target.value)} /></label>
    <label className="field"><span>Public username</span><input value={username} onChange={e=>{setUsername(e.target.value.toLowerCase());setUsernameStatus("idle");setUsernameMsg("")}} placeholder="username" /></label>
    {usernameStatus==="error"&&<div className="auth-error" style={{margin:"0 0 8px"}}>{usernameMsg}</div>}
    <div className="switch-row"><div><b>Public community profile</b><small>Off by default. Financial details always stay private.</small></div><button className={`switch ${me?.publicProfileEnabled?"on":""}`} onClick={async()=>{setUsernameStatus("saving");setUsernameMsg("");try{const r=await apiFetch<any>("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username,publicProfileEnabled:!me?.publicProfileEnabled})});setMe((x:any)=>({...x,...r.user}));setUsernameStatus("idle")}catch(e){setUsernameStatus("error");setUsernameMsg(plainError(e))}}}><i/></button></div>
    <button className="soft-action" disabled={usernameStatus==="saving"} onClick={saveProfile}>{usernameStatus==="saving"?"Saving…":usernameStatus==="saved"?"Saved":"Save profile"}</button>
    <div className="switch-row"><div><b>Email</b><small>{me?.email?me.emailVerified?"Verified":"Not verified yet":"Wallet-only account"}</small></div>{me?.email?(me.emailVerified?<span className="status-badge">Verified</span>:<button className="soft-action" onClick={resendVerification}>Resend verification</button>):<span className="status-badge">Optional</span>}</div>
    <EmbeddedWalletPanel me={me} reload={reload}/>
    <div className="switch-row"><div><b>Linked wallets</b><small>{me?.wallets?.length||0} wallet(s)</small></div><button className="soft-action" disabled={walletBusy} onClick={()=>setWalletChooserOpen(true)}><Link2 size={12}/> Add wallet</button></div>
    <WalletChooser open={walletChooserOpen} busy={walletBusy} onClose={()=>setWalletChooserOpen(false)} onPick={linkWallet}/>
    {me?.wallets?.map((w:any)=><div className="wallet-line" key={w.id}><div><b>{w.chain} · {w.address.slice(0,7)}…{w.address.slice(-5)}</b><small>{w.isPrimary?"Primary · ":""}{w.tradingEnabled?"Trading permission active":"No unattended trading permission"}</small></div><button className="soft-action" disabled={w.tradingEnabled||Boolean(w.permissionRef)} onClick={()=>unlinkWallet(w.id)}>Unlink</button></div>)}
    <div className="switch-row"><div><b>X account</b><small>{me?.linkedSocialAccounts?.find((x:any)=>x.provider==="X")?.username?`@${me.linkedSocialAccounts.find((x:any)=>x.provider==="X").username}`:"Optional"}</small></div><button className="soft-action" onClick={linkX}>Link X</button></div>
    {me?.role==="OWNER"&&<div className="switch-row"><div><b>Admin Command Center</b><small>Owner platform controls</small></div><a className="soft-action" href="/admin/">Open Admin</a></div>}
   </section>
   <section className="settings-block"><h3>Trading settings</h3>
    <p style={{fontSize:11,color:"#8a8fa0",margin:"0 0 12px"}}>Allocation, principal recovery and chains now live on the Trade tab.</p>
    <button className="action-primary" style={{width:"100%",height:42,borderRadius:12}} onClick={()=>setView("trade")}><Zap size={15}/> Open Trade settings</button>
   </section>
   <section className="settings-block"><h3>Notifications</h3>
    <div className="switch-row"><div><b>Notifications</b><small>{
     pushState==="checking"?"Checking status…":
     pushState==="on"?"On — you'll get trade alerts on this device.":
     pushState==="ios-need-install"?"Install MemeCloud to your Home Screen to receive alerts on iPhone.":
     pushState==="denied"?"Notifications are off for this device.":
     pushState==="unsupported"?"This browser can't receive push notifications.":
     pushState==="error"?(pushMsg||"Notifications couldn't be connected."):
     "Get notified about trades, whales and platform updates."
    }</small></div>
    {pushState==="on"&&<span className="status-badge">On</span>}
    {pushState==="ios-need-install"&&<button className="soft-action" onClick={()=>setPushMsg('Tap the Share icon in Safari, then "Add to Home Screen", then "Add." Open MemeCloud from your Home Screen icon and turn on notifications there.')}>How to install</button>}
    {pushState==="unsupported"&&<span className="status-badge watch">Unavailable</span>}
    {pushState==="need-permission"&&<button className="soft-action" disabled={pushBusy} onClick={enablePush}>{pushBusy?"Enabling…":"Enable notifications"}</button>}
    {pushState==="denied"&&<button className="soft-action" onClick={()=>setPushMsg("iPhone: Settings → Notifications → MemeCloud → turn on Allow Notifications, then reopen the app. Android/desktop: allow notifications for this site in your browser's site settings.")}>How to enable</button>}
    {pushState==="error"&&<button className="soft-action" disabled={pushBusy} onClick={enablePush}>Try again</button>}
   </div>
   {(pushState==="denied"||pushState==="ios-need-install")&&pushMsg&&<div className="notice">{pushMsg}</div>}
    {[['traderBought','Trader bought'],['tradeCopied','Trade copied'],['skippedTrade','Skipped / pullback'],['profitTaken','Profit taken'],['positionClosed','Position closed'],['platformBroadcast','Platform announcements']].map(([k,label])=><div className="switch-row" key={k}><div><b>{label}</b><small>Personal notification preference</small></div><button className={`switch ${prefs?.[k]!==false?"on":""}`} onClick={()=>patchNotifications({[k]:prefs?.[k]===false})}><i/></button></div>)}
    <b style={{fontSize:11,display:"block",margin:"14px 0 2px"}}>Discovery notifications</b>
    <p style={{fontSize:10,color:"#8a8fa0",margin:"0 0 8px"}}>MemeCloud's intelligence engine runs 24/7 independent of your wallet or Live Trading — these fire from real discoveries, not trades.</p>
    {[['discoveryNewToken','New token discovered'],['discoverySmartWallet','Smart-wallet buys'],['discoveryWhaleActivity','Whale activity'],['discoveryHeatingUp','Heating up'],['discoveryStrong','Strong opportunities'],['discoveryHighConviction','High conviction']].map(([k,label])=><div className="switch-row" key={k}><div><b>{label}</b><small>Discovery notification preference</small></div><button className={`switch ${prefs?.[k]?"on":""}`} onClick={()=>patchNotifications({[k]:!prefs?.[k]})}><i/></button></div>)}
    <div className="switch-row"><div><b>Unread notifications</b><small>Personal to this account</small></div><div style={{display:"flex",gap:6,alignItems:"center"}}><span className="status-badge">{notifications.filter(x=>!x.readAt).length}</span>{notifications.some(x=>!x.readAt)&&<button className="soft-action" onClick={markNotificationsRead}>Mark read</button>}</div></div>
    <div className="notification-inbox">{notifications.slice(0,8).map((n:any)=><div className={`notification-row ${n.readAt?"":"unread"}`} key={n.id}><i/><div><b>{n.title}</b><small>{n.body}</small></div><span>{timeAgo(n.createdAt)}</span></div>)}{!notifications.length&&<small>No notifications yet.</small>}</div>
   </section>
   <section className="settings-block"><h3>Security &amp; permission</h3>
    <div className="notice green">Account login and wallet connection are separate from unattended trading authorization. Live automatic execution remains off until a reviewed delegated/session signer is configured.</div>
    <div className="switch-row"><div><b>Auto Copy</b><small>Controls new automatic entries</small></div><button className={`switch ${trading.autoCopyEnabled?"on":""}`} onClick={()=>patchTrading({autoCopyEnabled:!trading.autoCopyEnabled})}><i/></button></div>
    <div className="switch-row"><div><b>Signed-in devices</b><small>{sessions?.length||0} active session{sessions?.length===1?"":"s"}</small></div><button className="soft-action" onClick={()=>setSessionsOpen(true)}>Manage</button></div>
    <SessionsSheet open={sessionsOpen} sessions={sessions} onClose={()=>setSessionsOpen(false)} onRevoke={revokeSession} onRevokeOthers={async()=>{await apiFetch("/v1/me/sessions",{method:"DELETE"});await reload()}}/>
    <button className="soft-action" style={{width:"100%",marginTop:12}} onClick={signOut}><LogOut size={13}/> Sign out</button>
    <div className="danger-zone"><b>Close account</b><small>This disables Auto Copy and revokes signed-in sessions. Trading/audit records are preserved for financial integrity.</small><input type={me?.hasPassword?"password":"text"} value={closeValue} onChange={e=>setCloseValue(e.target.value)} placeholder={me?.hasPassword?"Enter your password":"Type CLOSE MY ACCOUNT"}/><button className="danger-action" onClick={closeAccount}>Close my account</button></div>
   </section>
  </div>
 </>;
}
function SessionsSheet({open,sessions,onClose,onRevoke,onRevokeOthers}:{open:boolean;sessions:any[];onClose:()=>void;onRevoke:(id:string)=>Promise<void>;onRevokeOthers:()=>Promise<void>}){
 const[busyId,setBusyId]=useState<string|null>(null);
 const[busyAll,setBusyAll]=useState(false);
 if(!open) return null;
 const hasOthers=(sessions||[]).some((s:any)=>!s.current);
 return <div className="wallet-chooser-wrap" onClick={onClose}>
  <div className="wallet-chooser-sheet" onClick={e=>e.stopPropagation()}>
   <div className="wallet-chooser-handle"/>
   <div className="wallet-chooser-head"><b>Signed-in devices</b><button type="button" className="wallet-chooser-close" onClick={onClose} aria-label="Close"><X size={16}/></button></div>
   <p>{sessions?.length||0} active session{sessions?.length===1?"":"s"}. Revoke any device you don't recognize.</p>
   {hasOthers&&<button className="soft-action" style={{width:"100%",marginBottom:10}} disabled={busyAll} onClick={async()=>{setBusyAll(true);try{await onRevokeOthers()}finally{setBusyAll(false)}}}>{busyAll?"Revoking…":"Revoke all other sessions"}</button>}
   {(sessions||[]).length?sessions.map((s:any)=>
    <div className="wallet-line" key={s.id}>
     <div>
      <b>{deviceLabel(s.userAgent)}{s.current&&<span className="status-badge" style={{marginLeft:6}}>Current device</span>}</b>
      <small>Last active {timeAgo(s.lastUsedAt)} · signed in {new Date(s.createdAt).toLocaleDateString()} · expires {new Date(s.expiresAt).toLocaleDateString()}</small>
     </div>
     {!s.current&&<button className="soft-action" disabled={busyId===s.id} onClick={async()=>{setBusyId(s.id);try{await onRevoke(s.id)}finally{setBusyId(null)}}}>{busyId===s.id?"Revoking…":"Revoke"}</button>}
    </div>
   ):<small>No active refresh sessions listed.</small>}
  </div>
 </div>;
}
function Empty({icon:Icon,title,body,action,onClick}:{icon:any;title:string;body:string;action?:string;onClick?:()=>void}){return <div className="empty"><Icon size={21}/><b>{title}</b><p>{body}</p>{action&&<button onClick={onClick}>{action}</button>}</div>}
