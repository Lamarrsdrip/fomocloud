"use client";
import {useEffect,useState} from "react";
import {LogOut,X} from "lucide-react";
import {apiFetch,plainError} from "../lib/api";
import {initials,timeAgo,urlB64ToBytes,pushEnv,deviceLabel} from "../lib/format";

function SessionsSheet({open,sessions,onClose,onRevoke,onRevokeOthers}:{open:boolean;sessions:any[];onClose:()=>void;onRevoke:(id:string)=>Promise<void>;onRevokeOthers:()=>Promise<void>}){
 const[busyId,setBusyId]=useState<string|null>(null),[busyAll,setBusyAll]=useState(false);
 if(!open)return null;
 const hasOthers=(sessions||[]).some((s:any)=>!s.current);
 return <div className="wallet-chooser-wrap" onClick={onClose}><div className="wallet-chooser-sheet" onClick={e=>e.stopPropagation()}>
  <div className="wallet-chooser-handle"/><div className="wallet-chooser-head"><b>Signed-in devices</b><button type="button" className="wallet-chooser-close" onClick={onClose} aria-label="Close"><X size={16}/></button></div>
  <p>{sessions?.length||0} active session{sessions?.length===1?"":"s"}. Revoke any device you don't recognize.</p>
  {hasOthers&&<button className="soft-action" style={{width:"100%",marginBottom:10}} disabled={busyAll} onClick={async()=>{setBusyAll(true);try{await onRevokeOthers()}finally{setBusyAll(false)}}}>{busyAll?"Revoking…":"Revoke all other sessions"}</button>}
  {(sessions||[]).map((s:any)=><div className="wallet-line" key={s.id}><div><b>{deviceLabel(s.userAgent)}{s.current&&<span className="status-badge" style={{marginLeft:6}}>Current device</span>}</b><small>Last active {timeAgo(s.lastUsedAt)} · signed in {new Date(s.createdAt).toLocaleDateString()}</small></div>{!s.current&&<button className="soft-action" disabled={busyId===s.id} onClick={async()=>{setBusyId(s.id);try{await onRevoke(s.id)}finally{setBusyId(null)}}}>{busyId===s.id?"Revoking…":"Revoke"}</button>}</div>)}
 </div></div>;
}

export default function ProfileView({me,setMe,settings,notifications,sessions,setSettings,reload,signOut}:{me:any;setMe:any;settings:any;notifications:any[];sessions:any[];setSettings:any;reload:()=>Promise<void>;signOut:()=>void;setView:(v:any)=>void;openReceiveSignal?:number}){
 const[err,setErr]=useState(""),[note,setNote]=useState(""),[name,setName]=useState(me?.displayName||""),[username,setUsername]=useState(me?.username||""),[closeValue,setCloseValue]=useState("");
 const[usernameStatus,setUsernameStatus]=useState<"idle"|"saving"|"saved"|"error">("idle"),[usernameMsg,setUsernameMsg]=useState(""),[sessionsOpen,setSessionsOpen]=useState(false);
 const prefs=settings?.notifications||{};
 const masterNotifications=prefs?.pushEnabled!==false;
 const[pushState,setPushState]=useState<"checking"|"ios-need-install"|"unsupported"|"need-permission"|"denied"|"on"|"error">("checking");
 const[pushBusy,setPushBusy]=useState(false),[pushMsg,setPushMsg]=useState("");

 useEffect(()=>{const p=new URLSearchParams(location.search),x=p.get("x");if(x==="connected"){setNote("X account connected.");history.replaceState(null,"","/app/?view=profile")}else if(x==="error"){setErr(p.get("reason")||"Unable to link X right now.");history.replaceState(null,"","/app/?view=profile")}},[]);
 useEffect(()=>{(async()=>{const env=pushEnv();if(env.isIOS&&!env.isStandalone){setPushState("ios-need-install");return}if(!env.supported){setPushState("unsupported");return}if(Notification.permission==="denied"){setPushState("denied");return}try{const reg=await navigator.serviceWorker.getRegistration("/sw.js"),sub=reg?await reg.pushManager.getSubscription():null;if(sub&&Notification.permission==="granted"){setPushState("on");return}}catch{}setPushState("need-permission")})()},[]);

 async function patchNotifications(body:any){const r=await apiFetch<any>("/v1/me/settings/notifications",{method:"PATCH",body:JSON.stringify(body)});setSettings((x:any)=>({...x,notifications:r.notifications}));return r.notifications}
 async function enablePush(){
  setPushBusy(true);setPushMsg("");setErr("");
  try{
   const env=pushEnv();if(env.isIOS&&!env.isStandalone){setPushState("ios-need-install");return}if(!env.supported){setPushState("unsupported");return}
   const cfg=await apiFetch<any>("/v1/public/config",{},false);if(!cfg.pushPublicKey)throw new Error("Push has not been configured yet.");
   const reg=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;const perm=await Notification.requestPermission();
   if(perm==="denied"){setPushState("denied");return}if(perm!=="granted")throw new Error("Notification permission was not granted.");
   const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToBytes(cfg.pushPublicKey)});
   await apiFetch("/v1/push/subscribe",{method:"POST",body:JSON.stringify(sub.toJSON())});await patchNotifications({masterEnabled:true});setPushState("on");await reload();
  }catch(e){setPushMsg(plainError(e));setPushState("error")}finally{setPushBusy(false)}
 }
 async function toggleNotifications(){
  setErr("");
  try{if(masterNotifications){await patchNotifications({masterEnabled:false});return}if(pushState==="on"){await patchNotifications({masterEnabled:true});return}await enablePush()}catch(e){setErr(plainError(e))}
 }
 async function saveProfile(){setUsernameStatus("saving");setUsernameMsg("");try{const r=await apiFetch<any>("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username})});setMe((x:any)=>({...x,...r.user}));setUsernameStatus("saved");setTimeout(()=>setUsernameStatus(s=>s==="saved"?"idle":s),2500)}catch(e){setUsernameStatus("error");setUsernameMsg(plainError(e))}}
 async function resendVerification(){setErr("");setNote("");try{const r=await apiFetch<any>("/auth/resend-verification",{method:"POST"});setNote(r?.alreadyVerified?"This email is already verified.":"Verification email sent — check your inbox.")}catch(e){setErr(plainError(e))}}
 async function linkX(){try{const r=await apiFetch<any>("/v1/me/social/x/start");location.href=r.url}catch(e){setErr(plainError(e))}}
 async function revokeSession(id:string){try{await apiFetch(`/v1/me/sessions/${id}`,{method:"DELETE"});await reload()}catch(e){setErr(plainError(e))}}
 async function markNotificationsRead(){try{await apiFetch("/v1/me/notifications/read",{method:"POST",body:JSON.stringify({})});await reload()}catch(e){setErr(plainError(e))}}
 async function closeAccount(){const expected=me?.hasPassword?"your password":"CLOSE MY ACCOUNT";if(!closeValue){setErr(`Enter ${expected} to close this account.`);return}if(!confirm("Close this account? Trading will stop and signed-in sessions will be revoked."))return;try{await apiFetch("/v1/me/account/close",{method:"POST",body:JSON.stringify(me?.hasPassword?{password:closeValue}:{confirmation:closeValue})});signOut()}catch(e){setErr(plainError(e))}}
 const linkedX=me?.linkedSocialAccounts?.find((x:any)=>x.provider==="X")?.username;
 const unread=notifications.filter(x=>!x.readAt).length;

 return <>
  {err&&<div className="auth-error">{err}</div>}{note&&<div className="auth-success">{note}</div>}
  <div className="settings-grid">
   <section className="settings-block"><h3>Account</h3>
    <div className="user-mini"><div className="avatar">{initials(me?.displayName||me?.email)}</div><div><b>{me?.displayName||"Your account"}</b><small>{me?.email||"MemeCloud account"}</small></div></div>
    <label className="field"><span>Display name</span><input value={name} onChange={e=>setName(e.target.value)}/></label>
    <label className="field"><span>Public username</span><input value={username} onChange={e=>{setUsername(e.target.value.toLowerCase());setUsernameStatus("idle");setUsernameMsg("")}} placeholder="username"/></label>
    {usernameStatus==="error"&&<div className="auth-error" style={{margin:"0 0 8px"}}>{usernameMsg}</div>}
    <div className="switch-row"><div><b>Public community profile</b><small>Your financial information always stays private.</small></div><button className={`switch ${me?.publicProfileEnabled?"on":""}`} onClick={async()=>{try{const r=await apiFetch<any>("/v1/me/profile",{method:"PATCH",body:JSON.stringify({displayName:name,username,publicProfileEnabled:!me?.publicProfileEnabled})});setMe((x:any)=>({...x,...r.user}))}catch(e){setErr(plainError(e))}}}><i/></button></div>
    <button className="soft-action" disabled={usernameStatus==="saving"} onClick={saveProfile}>{usernameStatus==="saving"?"Saving…":usernameStatus==="saved"?"Saved":"Save profile"}</button>
    <div className="switch-row"><div><b>Email</b><small>{me?.email||"No email added"}</small></div>{me?.email?(me.emailVerified?<span className="status-badge">Verified</span>:<button className="soft-action" onClick={resendVerification}>Verify</button>):null}</div>
    <div className="switch-row"><div><b>X account</b><small>{linkedX?`@${linkedX}`:"Not connected"}</small></div><button className="soft-action" onClick={linkX}>{linkedX?"Reconnect":"Link X"}</button></div>
    {me?.role==="OWNER"&&<div className="switch-row"><div><b>Admin Command Center</b><small>Owner platform controls</small></div><a className="soft-action" href="/admin/">Open Admin</a></div>}
   </section>

   <section className="settings-block"><h3>Notifications</h3>
    <div className="switch-row"><div><b>MemeCloud alerts</b><small>{
     !masterNotifications?"Paused — no push alerts will be sent.":
     pushState==="on"?"On — smart-wallet trades, whales, alpha discoveries, trades and security alerts are included automatically.":
     pushState==="ios-need-install"?"Add MemeCloud to your Home Screen first to receive iPhone alerts.":
     pushState==="denied"?"Notification permission is blocked on this device.":pushState==="unsupported"?"Push notifications are unavailable in this browser.":"Turn on once — MemeCloud handles the alert types for you."
    }</small></div>
     {(pushState==="on"||!masterNotifications)?<button className={`switch ${masterNotifications&&pushState==="on"?"on":""}`} disabled={pushBusy} onClick={toggleNotifications}><i/></button>:<button className="soft-action" disabled={pushBusy} onClick={toggleNotifications}>{pushBusy?"Enabling…":"Turn on"}</button>}
    </div>
    {pushState==="ios-need-install"&&<button className="soft-action" style={{width:"100%"}} onClick={()=>setPushMsg('Safari → Share → Add to Home Screen. Open MemeCloud from the new icon, then turn alerts on.')}>How to enable on iPhone</button>}
    {pushState==="denied"&&<button className="soft-action" style={{width:"100%"}} onClick={()=>setPushMsg("iPhone Settings → Notifications → MemeCloud → Allow Notifications, then reopen MemeCloud.")}>How to enable</button>}
    {pushMsg&&<div className="notice" style={{marginTop:8}}>{pushMsg}</div>}
    <div className="switch-row"><div><b>Notification inbox</b><small>{unread?`${unread} unread alert${unread===1?"":"s"}`:"You're caught up"}</small></div>{unread?<button className="soft-action" onClick={markNotificationsRead}>Mark read</button>:<span className="status-badge">Clear</span>}</div>
   </section>

   <section className="settings-block"><h3>Security</h3>
    <div className="switch-row"><div><b>Signed-in devices</b><small>{sessions?.length||0} active session{sessions?.length===1?"":"s"}</small></div><button className="soft-action" onClick={()=>setSessionsOpen(true)}>Manage</button></div>
    <SessionsSheet open={sessionsOpen} sessions={sessions} onClose={()=>setSessionsOpen(false)} onRevoke={revokeSession} onRevokeOthers={async()=>{await apiFetch("/v1/me/sessions",{method:"DELETE"});await reload()}}/>
    <button className="soft-action" style={{width:"100%",marginTop:12}} onClick={signOut}><LogOut size={13}/> Sign out</button>
    <div className="danger-zone"><b>Close account</b><small>Stops trading and revokes sessions. Financial/audit records remain for integrity.</small><input type={me?.hasPassword?"password":"text"} value={closeValue} onChange={e=>setCloseValue(e.target.value)} placeholder={me?.hasPassword?"Enter your password":"Type CLOSE MY ACCOUNT"}/><button className="danger-action" onClick={closeAccount}>Close my account</button></div>
   </section>
  </div>
 </>;
}
