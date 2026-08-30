"use client";
import {useState, type FormEvent} from "react";
import {apiFetch,plainError} from "../lib/api";

export default function CustomTrader({reload,close}:{reload:()=>Promise<void>;close:()=>void}){
 const[name,setName]=useState("");const[address,setAddress]=useState("");const[chain,setChain]=useState("SOLANA");const[x,setX]=useState("");const[err,setErr]=useState("");const[busy,setBusy]=useState(false);
 async function add(e:FormEvent){e.preventDefault();setBusy(true);setErr("");try{await apiFetch("/v1/me/traders/custom",{method:"POST",body:JSON.stringify({displayName:name,address,chain,xHandle:x})});await reload();close()}catch(e){setErr(plainError(e))}finally{setBusy(false)}}
 return <section className="app-card" style={{marginBottom:14}}><div className="card-title"><div><span>ADD MY OWN TRADER</span><h2>Save a favorite — then map the real wallet</h2></div><button onClick={close}>Close</button></div><form className="form-grid" onSubmit={add}>
  <label className="field"><span>Your label for this trader</span><input value={name} onChange={e=>setName(e.target.value)} placeholder="Example: My favorite trader" required/></label>
  <label className="field"><span>Chain</span><select value={chain} onChange={e=>setChain(e.target.value)}><option>SOLANA</option><option>BASE</option><option>ETHEREUM</option><option>BNB</option><option>ARBITRUM</option><option>AVALANCHE</option></select></label>
  <label className="field span2"><span>Public trading wallet (optional now)</span><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Public wallet address — required before Watch / Auto Copy"/></label>
  <label className="field"><span>X username (optional)</span><input value={x} onChange={e=>setX(e.target.value)} placeholder="@username"/></label>
  <div style={{alignSelf:"end"}}><button className="action-primary" style={{width:"100%",height:42,borderRadius:12}} disabled={busy}>{busy?"Adding…":"Add to my watchlist"}</button></div>
  {err&&<div className="auth-error span2">{err}</div>}
 </form><div className="notice" style={{marginTop:12,marginBottom:0}}>You can save an X favorite without a wallet. It stays FOLLOW ONLY / NEEDS WALLET until you add the genuine public trading wallet. The platform never invents wallet mappings.</div></section>
}
