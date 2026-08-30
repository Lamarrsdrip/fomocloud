// Every field here already exists in the real heartbeat.detail written by each worker this
// session (flow-worker, balance-worker, social-worker) -- this only surfaces what's already true,
// nothing new is computed or estimated. No historical time-series exists (that would need its own
// metrics pipeline, not built) -- this is real-time current state, which is what actually would
// have surfaced the 1M-credit Helius burn while it was happening instead of only after.
const RPC_WORKERS=["solana-flow-scanner","solana-listener","market-worker","balance-worker","social-hype"];
function RpcUsage({services}:{services:any[]}){
 const rows=services.filter(s=>RPC_WORKERS.includes(s.name));
 if(!rows.length)return null;
 return <section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>RPC / PROVIDER USAGE</span><h2>Real-time request state by worker</h2></div></div>
  <table className="admin-table"><thead><tr><th>Worker</th><th>State</th><th>Rate limited</th><th>Errors / Dropped</th><th>Request budget</th><th>Shared account budget</th><th>Last event</th></tr></thead><tbody>
   {rows.map(s=>{const dt=s.detail||{};const rateLimited=Boolean(dt.rateLimited);const lastRl=dt.lastRateLimitAgoSec??dt.lastRateLimitAt;
    return <tr key={s.name}>
     <td><b>{s.name}</b></td>
     <td><span className={`status-badge ${s.healthy?"":"watch"}`}>{s.healthy?"Process healthy":"Process stale"}</span></td>
     <td>{rateLimited?<span className="status-badge watch">Rate limited now</span>:lastRl!=null?<small>Clear · last 429 {typeof lastRl==="number"?`${lastRl}s ago`:"recorded"}</small>:<small>No 429s recorded</small>}</td>
     <td>{dt.errors??0}{dt.dropped!=null?` / ${dt.dropped} dropped`:""}{dt.fallbackSkippedForRateLimit?` (${dt.fallbackSkippedForRateLimit} fallback skipped)`:""}</td>
     <td>{dt.maxRequestsPerSec?`${dt.maxRequestsPerSec}/sec cap`:dt.tickIntervalMs?`1 batch / ${Math.round(dt.tickIntervalMs/1000)}s`:"—"}</td>
     <td>{dt.sharedRpcBudgetPriority?<small>{dt.sharedRpcBudgetPriority} · {dt.sharedRpcBudgetDenied??0} denied{dt.lastSharedRpcBudgetDenyAgoSec!=null?` · last ${dt.lastSharedRpcBudgetDenyAgoSec}s ago`:""}</small>:<small>Not wired in</small>}</td>
     <td><small>{dt.lastSuccessfulRpcAgoSec!=null?`RPC OK ${dt.lastSuccessfulRpcAgoSec}s ago`:dt.lastDbWriteAgoSec!=null?`Last write ${dt.lastDbWriteAgoSec}s ago`:"—"}</small></td>
    </tr>;})}
  </tbody></table>
  <p style={{fontSize:10,color:"#7b8190",margin:"10px 2px 0"}}>No historical requests/min/hour/day graph exists yet -- this table is live current state only, refreshed on demand. "Shared account budget" is a cross-process Redis-backed token bucket (P0=highest priority, P5=lowest) protecting the account-wide Helius/Solana RPC limit -- background/bulk consumers back off first when it gets scarce.</p>
 </section>;
}
// Real gap found by forensic audit (M-47/48): every worker's real work metrics (scans,
// candidates, errors, backlog, reconnects, watchlist alerts, etc.) have always been stored in
// WorkerHeartbeat.detail and returned by this same API response -- "a heartbeat alone does not
// mean a system is healthy" was already true here, just never rendered. A worker reporting
// healthy=true while its own detail shows e.g. 0 candidates for hours looked identical to one
// doing real work. Surfacing the raw detail fields (compact, since each worker's shape differs)
// is what actually lets an operator catch "alive but useless."
function healthDetailLine(detail:any){
 if(!detail||typeof detail!=="object")return null;
 const skip=new Set(["running"]);
 const entries=Object.entries(detail).filter(([k])=>!skip.has(k)).slice(0,6);
 if(!entries.length)return null;
 return entries.map(([k,v])=>`${k}: ${typeof v==="object"?JSON.stringify(v):String(v)}`).join(" · ");
}
export function Health({d}:{d:any}){return <><div className="app-grid-4"><div className="stat-card"><span>Database</span><b>{d.database||"—"}</b><small>MongoDB</small></div><div className="stat-card"><span>Redis</span><b>{d.redis||"—"}</b><small>Queue/cache</small></div><div className="stat-card"><span>Actual execution</span><b>{d.executionState?.actualRuntimeMode||String(d.executionMode||"—").toUpperCase()}</b><small>{d.executionState?.status?String(d.executionState.status).replaceAll("_"," "):"Resolved backend mode"}</small></div><div className="stat-card"><span>Broadcast queue</span><b>{d.queue?.broadcasts?.waiting??0}</b><small>Waiting jobs</small></div></div><section className="app-card" style={{marginTop:10}}><div className="card-title"><div><span>REAL HEARTBEATS</span><h2>Backend workers</h2></div></div><div className="health-grid">{(d.services||[]).map((h:any)=><div className="health-item" key={h.id}><span>{h.name}</span><b className={h.healthy?"positive":"negative"}>{h.healthy?"Healthy":"Stale"}</b><small>Last beat {new Date(h.lastBeatAt).toLocaleTimeString()}</small>{healthDetailLine(h.detail)&&<small style={{display:"block",marginTop:2,color:"#8a8fa0",fontSize:10}}>{healthDetailLine(h.detail)}</small>}</div>)}</div></section><RpcUsage services={d.services||[]}/></>}
