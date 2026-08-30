"use client";
import {useEffect,useState} from "react";
import dynamic from "next/dynamic";
import {Link2,Zap,LogOut,X} from "lucide-react";
import {apiFetch,plainError} from "../lib/api";
import {initials,timeAgo,urlB64ToBytes,pushEnv,deviceLabel} from "../lib/format";
import {connectWallet,signWithWallet,type DetectedWallet} from "../lib/wallet";
import WalletChooser from "./WalletChooser";

// Privy's SDK is large (full multi-chain support) even though only its Solana slice is used here
// -- next/dynamic keeps it out of this route's main bundle entirely, fetched only once someone
// actually opens the wallet panel. See the comment at the top of EmbeddedWalletPanel.tsx.
const EmbeddedWalletPanel=dynamic(()=>import("./EmbeddedWalletPanel"),{ssr:false,loading:()=><div className="switch-row"><div><b>MemeCloud wallet</b><small>Loading…</small></div></div>});

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

export default function ProfileView({me,setMe,settings,notifications,sessions,setSettings,reload,signOut,setView,openReceiveSignal}:{me:any;setMe:any;settings:any;notifications:any[];sessions:any[];setSettings:any;reload:()=>Promise<void>;signOut:()=>void;setView:(v:any)=>void;openReceiveSignal?:number}){
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
    <EmbeddedWalletPanel me={me} reload={reload} openReceiveSignal={openReceiveSignal}/>
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
