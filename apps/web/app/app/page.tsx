"use client";
import {useEffect,useMemo,useState} from "react";
import dynamic from "next/dynamic";
import {
  Home,Users,WalletCards,Bell,Power,Plus,Settings2,
  LogOut,ArrowUpRight,Pause,Play,ChevronRight,Link2,RefreshCw,
  TrendingUp,CheckCheck,Zap,X
} from "lucide-react";
import {apiFetch,logout,money,plainError} from "../../lib/api";
import {
  initials,timeAgo,urlB64ToBytes,pushEnv,
  decisionActionLabel,deviceLabel
} from "../../lib/format";
import {connectWallet,signWithWallet,type DetectedWallet} from "../../lib/wallet";
import {BrandGlyph} from "../../components/BrandGlyph";
import WalletChooser from "../../components/WalletChooser";
import TraderDetail from "../../components/TraderDetail";
import CommunityView from "../../components/CommunityView";
import CustomTrader from "../../components/CustomTrader";
import {Empty} from "../../components/Empty";
import TradeView from "../../components/TradeView";
import ActivityView from "../../components/ActivityView";
import CopyView from "../../components/CopyView";
import PositionsView from "../../components/PositionsView";
import SmartWalletsView from "../../components/SmartWalletsView";
import TokenDetail from "../../components/TokenDetail";
import HomeView from "../../components/HomeView";
import DiscoverView from "../../components/DiscoverView";
// Privy's SDK is large (full multi-chain support) even though only its Solana slice is used here
// -- next/dynamic keeps it out of this route's main bundle entirely, fetched only once someone
// actually opens the wallet panel. See the comment at the top of EmbeddedWalletPanel.tsx.
const EmbeddedWalletPanel=dynamic(()=>import("../../components/EmbeddedWalletPanel"),{ssr:false,loading:()=><div className="switch-row"><div><b>MemeCloud wallet</b><small>Loading…</small></div></div>});

type View="home"|"discover"|"trade"|"positions"|"profile"|"traders"|"community"|"social"|"activity"|"smart-wallets";
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
          <div><small>YOUR MemeCloud</small><h1>{view==="home"?"Home":view==="discover"?"Discover":view==="trade"?"Trade":view==="traders"?"Traders":view==="community"?"Copy":view==="social"?"Community":view==="activity"?"Activity":view==="positions"?"Portfolio":view==="profile"?"Account":view==="smart-wallets"?"Smart Wallets":"MemeCloud"}</h1></div>
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
        {view==="social"&&<CommunityView/>}
        {view==="activity"&&<ActivityView activity={activity} trades={trades}/>}
        {view==="positions"&&<PositionsView positions={positions} degraded={positionsDegraded} d={dashboard} me={me} reload={load}/>}
        {view==="profile"&&<ProfileView me={me} setMe={setMe} settings={settings} notifications={notifications} sessions={sessions} setSettings={setSettings} reload={load} signOut={signOut} setView={setView}/>}
        </>}
      </section>
    </div>
    <nav className="mobile-app-nav">{mobileNav.map(([id,label,Icon])=><button key={id} onClick={()=>{setSelectedMint(null);setView(id)}} className={view===id?"active":""}><Icon size={19}/>{label}</button>)}</nav>
  </main>
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
