import {Users,UserRound,Copy,Eye} from "lucide-react";
import {Empty} from "./Empty";

export default function CopyView({follows,setMode,setView}:{follows:any[];setMode:(id:string,m:string)=>void;setView:(v:any)=>void}){
 const auto=follows.filter((f:any)=>f.mode==="AUTO_COPY");
 const watching=follows.filter((f:any)=>f.mode!=="AUTO_COPY");
 return <>
  <section className="copy-hero"><div><span>AUTO COPY</span><h2>Choose who MemeCloud can follow for you.</h2><p>Pick a trader, set them to Auto Copy, and your own account rules still decide whether each trade is safe to take.</p></div><div style={{display:"flex",gap:8}}><button className="action-primary" onClick={()=>setView("traders")}><Users size={15}/> Find traders</button><button className="soft-action" onClick={()=>setView("social")}><UserRound size={15}/> Community</button></div></section>
  <div className="app-two">
   <section className="app-card"><div className="card-title"><div><span>ACTIVE</span><h2>Auto Copy</h2></div><span className="status-badge">{auto.length} active</span></div>{auto.length?<div className="list">{auto.map((f:any)=><div className="list-row copy-row" key={f.id}><div><b>{f.trader?.displayName||"Trader"}</b><small>@{f.trader?.handle||"tracked"}</small></div><span className="status-badge">Auto Copy</span><button className="soft-action" onClick={()=>setMode(f.traderId,"WATCH_ONLY")}>Pause</button></div>)}</div>:<Empty icon={Copy} title="No Auto Copy traders yet" body="Discover a trader you trust and tap Auto Copy. MemeCloud still applies your personal limits before acting." action="Discover traders" onClick={()=>setView("traders")}/>}</section>
   <section className="app-card"><div className="card-title"><div><span>WATCHLIST</span><h2>Following & watching</h2></div></div>{watching.length?<div className="list">{watching.map((f:any)=><div className="list-row copy-row" key={f.id}><div><b>{f.trader?.displayName||"Trader"}</b><small>{String(f.mode||"FOLLOW_ONLY").replaceAll("_"," ")}</small></div><button className="soft-action" onClick={()=>setMode(f.traderId,"AUTO_COPY")}>Auto Copy</button></div>)}</div>:<Empty icon={Eye} title="Nothing on your watchlist" body="Follow traders first, then decide who should be watched or copied." action="Discover" onClick={()=>setView("traders")}/>}</section>
  </div>
  <section className="app-card copy-explainer"><div className="card-title"><div><span>HOW IT WORKS</span><h2>Simple on the surface. Careful underneath.</h2></div></div><div className="simple-steps"><div><b>1</b><span>Trader buys</span><small>MemeCloud sees the tracked wallet action.</small></div><div><b>2</b><span>Your rules check it</span><small>Price, liquidity, exposure and your settings are checked.</small></div><div><b>3</b><span>Only then act</span><small>Eligible trades can execute; bad entries are skipped or waited on.</small></div></div></section>
 </>;
}
