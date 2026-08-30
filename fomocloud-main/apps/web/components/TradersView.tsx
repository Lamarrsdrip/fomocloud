"use client";
import {useState} from "react";
import {Plus,Users} from "lucide-react";
import {apiFetch,money,plainError} from "../lib/api";
import {initials} from "../lib/format";
import {Empty} from "./Empty";
import TraderDetail from "./TraderDetail";
import CustomTrader from "./CustomTrader";

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

export default function TradersView({platform,follows,followMap,setMode,customOpen,setCustomOpen,reload}:{platform:any[];follows:any[];followMap:Map<string,any>;setMode:(id:string,m:string)=>void;customOpen:boolean;setCustomOpen:(v:boolean)=>void;reload:()=>Promise<void>}){
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
