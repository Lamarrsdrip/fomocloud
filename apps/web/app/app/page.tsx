"use client";
import {useEffect,useMemo,useState} from "react";
import dynamic from "next/dynamic";
import {
  Home,WalletCards,Bell,TrendingUp,Zap,Play,Pause,Search,Menu
} from "lucide-react";
import {apiFetch,logout,plainError} from "../../lib/api";
import {initials} from "../../lib/format";
import {MOBILE_NAV_IDS,normalizeAppView,type AppView} from "../../lib/appNavigation";
import {BrandGlyph} from "../../components/BrandGlyph";
import CommunityView from "../../components/CommunityView";
import TradeView from "../../components/TradeView";
import ActivityView from "../../components/ActivityView";
import CopyView from "../../components/CopyView";
import PositionsView from "../../components/PositionsView";
import SmartWalletsView from "../../components/SmartWalletsView";
import TokenDetail from "../../components/TokenDetail";
import HomeView from "../../components/HomeView";
import DiscoverView from "../../components/DiscoverView";
import TradersView from "../../components/TradersView";
import ProfileView from "../../components/ProfileView";
import MoreView from "../../components/MoreView";
const EmbeddedWalletPanel=dynamic(()=>import("../../components/EmbeddedWalletPanel"),{ssr:false});

const nav:[AppView,string,any][]=[["home","Home",Home],["discover","Hunt",TrendingUp],["trade","Trade",Zap],["positions","Wallet",WalletCards],["smart-wallets","Smart Money",Search],["more","More",Menu]];
const navById=new Map(nav.map(item=>[item[0],item]));
const mobileNav=MOBILE_NAV_IDS.map(id=>navById.get(id)!);

function initialView():AppView{
  if(typeof window==="undefined") return "home";
  return normalizeAppView(new URLSearchParams(location.search).get("view"),location.pathname);
}
export default function AppPage(){
  const[view,setViewState]=useState<AppView>("home");
  const[focusSection,setFocusSection]=useState<"notifications"|"security"|null>(null);
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
  // Funding is an overlay action. It must never mutate the current destination.
  const[fundSignal,setFundSignal]=useState(0);

  function navigate(v:AppView,anchor?:"notifications"|"security"){
    setSelectedMint(null);setViewState(v);setFocusSection(anchor||null);
    const params=new URLSearchParams({view:v});if(anchor)params.set("section",anchor);
    history.pushState(null,"",`/app/?${params}`);
  }
  function setView(v:AppView){navigate(v)}
  function openFund(){setFundSignal(x=>x+1)}
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
  useEffect(()=>{
    setViewState(initialView());
    const initialSection=new URLSearchParams(location.search).get("section");
    if(initialSection==="notifications"||initialSection==="security")setFocusSection(initialSection);
    const onPop=()=>{setSelectedMint(null);setViewState(initialView());const section=new URLSearchParams(location.search).get("section");setFocusSection(section==="notifications"||section==="security"?section:null)};
    addEventListener("popstate",onPop);void load();return()=>removeEventListener("popstate",onPop);
  },[]);
  useEffect(()=>{if(view==="profile"&&focusSection)setTimeout(()=>document.getElementById(`profile-${focusSection}`)?.scrollIntoView({behavior:"smooth",block:"start"}),0)},[view,focusSection]);
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
        <nav className="app-nav">{nav.map(([id,label,Icon])=><button key={id} onClick={()=>setView(id)} className={view===id||id==="more"&&!MOBILE_NAV_IDS.includes(view)?"active":""}><Icon size={16}/>{label}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||me?.wallets?.[0]?.address?.slice(0,10)||"Wallet account"}</small></div></div>
        </div>
      </aside>

      <section className="app-main">
        {selectedMint?<TokenDetail sel={selectedMint} opp={brain.find(o=>o.mint===selectedMint.mint)} me={me} close={()=>setSelectedMint(null)} onTraded={load}/>:<>
        <div className="app-top">
          <div><small>YOUR MemeCloud</small><h1>{view==="home"?"Home":view==="discover"?"Hunt":view==="trade"?"Trade":view==="traders"?"Traders":view==="community"?"Copy":view==="social"?"Community":view==="activity"?"Activity":view==="positions"?"Wallet":view==="profile"?"Account":view==="smart-wallets"?"Smart Money":view==="more"?"More":"MemeCloud"}</h1></div>
          <div className="app-top-actions">
            <button className={`auto-toggle ${autoOn?"":"off"}`} onClick={toggleAuto}>{autoOn?<Play size={14}/>:<Pause size={14}/>} Auto Trade {autoOn?"On":"Off"}</button>
            <button className="icon-btn notification-button" onClick={()=>navigate("profile","notifications")} aria-label={`${unread} unread notifications`}><Bell size={17}/>{unread>0&&<span className="notification-count">{unread>99?"99+":unread}</span>}</button>
          </div>
        </div>
        {error&&<div className="auth-error" style={{marginBottom:12}}>{error}</div>}
        <EmbeddedWalletPanel me={me} reload={load} openReceiveSignal={fundSignal} showCard={view==="positions"}/>
        {view==="home"&&<HomeView d={dashboard} activity={activity} brain={brain} brainDegraded={brainDegraded} setView={setView} openToken={setSelectedMint} onFund={openFund}/>}
        {view==="discover"&&<DiscoverView brain={brain} brainDegraded={brainDegraded} setView={setView} openToken={setSelectedMint}/>}
        {view==="smart-wallets"&&<SmartWalletsView/>}
        {view==="trade"&&<TradeView settings={settings} trades={trades} patchTrading={async(body:any)=>{try{const r=await apiFetch<any>("/v1/me/settings/trading",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,trading:r.trading}))}catch(e){setError(plainError(e))}}} setView={setView}/>}
        {view==="traders"&&<TradersView platform={platform} follows={follows} followMap={followMap} setMode={setTraderMode} customOpen={customOpen} setCustomOpen={setCustomOpen} reload={load}/>}
        {view==="community"&&<CopyView follows={follows} setMode={setTraderMode} setView={setView}/>}
        {view==="social"&&<CommunityView/>}
        {view==="activity"&&<ActivityView activity={activity} trades={trades}/>}
        {view==="positions"&&<PositionsView positions={positions} degraded={positionsDegraded} d={dashboard}/>}
        {view==="more"&&<MoreView navigate={navigate}/>}
        {view==="profile"&&<ProfileView me={me} setMe={setMe} settings={settings} notifications={notifications} sessions={sessions} setSettings={setSettings} reload={load} signOut={signOut} setView={setView} openReceiveSignal={fundSignal}/>}
        </>}
      </section>
    </div>
    <nav className="mobile-app-nav" aria-label="Primary">{mobileNav.map(([id,label,Icon])=><button key={id} onClick={()=>setView(id)} className={view===id||id==="more"&&!MOBILE_NAV_IDS.includes(view)?"active":""}><Icon size={19}/><span>{label}</span></button>)}</nav>
  </main>
}
