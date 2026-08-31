"use client";
import {useEffect,useState} from "react";
import {apiFetch,plainError} from "../../lib/api";
import {Users,Radio,WalletCards,Settings2,Send,Activity,ShieldCheck,BarChart3,RefreshCw,Gauge,SlidersHorizontal,Home,Coins,Fish,AlertTriangle,Layers,ChartNoAxesCombined} from "lucide-react";
import {BrandGlyph} from "../../components/BrandGlyph";
import {Overview} from "../../components/admin/Overview";
import {BrainAdmin} from "../../components/admin/BrainAdmin";
import {UsersView} from "../../components/admin/UsersView";
import {TradersAdmin} from "../../components/admin/TradersAdmin";
import {Signals} from "../../components/admin/Signals";
import {Trades} from "../../components/admin/Trades";
import {AdminPositions} from "../../components/admin/AdminPositions";
import {FailedTrades} from "../../components/admin/FailedTrades";
import {Tokens} from "../../components/admin/Tokens";
import {Whales} from "../../components/admin/Whales";
import {Broadcasts} from "../../components/admin/Broadcasts";
import {Audit} from "../../components/admin/Audit";
import {Health} from "../../components/admin/Health";
import {Config} from "../../components/admin/Config";
import {ProviderUsage} from "../../components/admin/ProviderUsage";

const sections=[
 ["overview","Control",Gauge],["brain","Global Brain",BarChart3],["tokens","Tokens",Coins],["whales","Whales",Fish],["users","Users",Users],["traders","Wallets",Radio],["signals","Decisions",Activity],
 ["trades","Live Trades",WalletCards],["positions","Positions",Layers],["failed","Failed Trades",AlertTriangle],["usage","API Usage",ChartNoAxesCombined],["config","Settings",SlidersHorizontal],["broadcasts","Messages",Send],["audit","Audit",ShieldCheck],["health","Health",Activity]
] as const;
const navGroups=[
 ["OVERVIEW",["overview"]],
 ["GLOBAL BRAIN",["brain"]],
 ["DISCOVERY",["tokens","whales","traders"]],
 ["TRADING",["trades","positions","signals","failed"]],
 ["USERS",["users"]],
 ["CONFIGURATION",["config"]],
 ["SYSTEM",["usage","broadcasts","audit","health"]]
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
  if(which==="usage")r=await apiFetch("/v1/admin/provider-usage");
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
    {tab==="usage"&&<ProviderUsage d={data}/>}
   </>}
  </section>
  <nav className="admin-mobile-nav">{sections.slice(0,6).map(([id,label,Icon])=><button key={id} className={tab===id?"active":""} onClick={()=>change(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
 </main>
}
