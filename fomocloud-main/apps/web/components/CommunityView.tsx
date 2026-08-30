"use client";
import {useEffect,useState} from "react";
import {Search,Users,UserRound} from "lucide-react";
import {apiFetch,plainError} from "../lib/api";
import {initials} from "../lib/format";
import {Empty} from "./Empty";

export default function CommunityView(){
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
