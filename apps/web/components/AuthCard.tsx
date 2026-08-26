"use client";
import { useState } from "react";
import { ArrowRight, WalletCards, CheckCircle2, ShieldCheck, Zap } from "lucide-react";
import { apiFetch, login, signup, setAccessToken, plainError } from "../lib/api";

function toBase64(bytes:Uint8Array){
  let s=""; bytes.forEach(b=>s+=String.fromCharCode(b)); return btoa(s);
}

export default function AuthCard({mode}:{mode:"login"|"signup"}){
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [displayName,setDisplayName]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [note,setNote]=useState("");

  async function submit(e:React.FormEvent){
    e.preventDefault(); setBusy(true);setError("");setNote("");
    try{
      const data=mode==="signup"?await signup(email,password,displayName):await login(email,password);
      if(mode==="signup"&&data.emailDelivery==="NOT_CONFIGURED") setNote("Account created. Email verification will become available when SMTP is configured.");
      location.href=data.user?.onboardingCompleted?"/app/":"/onboarding/";
    }catch(e){setError(plainError(e));}finally{setBusy(false)}
  }
  async function walletLogin(){
    setBusy(true);setError("");
    try{
      const provider=(window as any).solana;
      if(!provider?.isPhantom && !provider?.connect) throw new Error("No supported Solana wallet was found in this browser.");
      const connected=await provider.connect();
      const address=connected.publicKey.toString();
      const c=await apiFetch<any>("/auth/wallet/challenge",{method:"POST",body:JSON.stringify({chain:"SOLANA",address})},false);
      const signed=await provider.signMessage(new TextEncoder().encode(c.message),"utf8");
      const data=await apiFetch<any>("/auth/wallet/verify",{method:"POST",body:JSON.stringify({challengeId:c.challengeId,signature:`base64:${toBase64(signed.signature)}`})},false);
      setAccessToken(data.accessToken); location.href=data.user?.onboardingCompleted?"/app/":"/onboarding/";
    }catch(e:any){setError(plainError(e));}finally{setBusy(false)}
  }

  return <div className="auth-page">
    <section className="auth-art">
      <a className="brand" href="/"><span className="brandmark">M</span><b>MemeCloud</b></a>
      <div className="auth-art-copy"><span>AUTONOMOUS CRYPTO INTELLIGENCE</span><h1>Discover.<br/>Decide.<br/>Manage.</h1><p>Your private MemeCloud workspace combines market discovery, wallet intelligence, scoring, execution controls and position management without fabricating account data.</p></div>
      <div className="auth-points">
        <div className="auth-point"><CheckCircle2 size={15}/> Follow, watch or Auto Copy each trader independently</div>
        <div className="auth-point"><Zap size={15}/> 24/7 backend keeps monitoring after you close the browser</div>
        <div className="auth-point"><ShieldCheck size={15}/> Account login never equals unrestricted wallet signing</div>
      </div>
    </section>
    <section className="auth-box-wrap">
      <div className="auth-box">
        <a className="brand" href="/"><span className="brandmark small">M</span><b>MemeCloud</b></a>
        <h2>{mode==="signup"?"Create your account":"Welcome back"}</h2>
        <p>{mode==="signup"?"Start with an account, then choose your traders and connect a trading wallet separately.":"Sign in to your private dashboard."}</p>
        <form className="auth-form" onSubmit={submit}>
          {mode==="signup"&&<label className="field"><span>Name</span><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your name" autoComplete="name"/></label>}
          <label className="field"><span>Email</span><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required/></label>
          <label className="field"><span>Password</span><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={mode==="signup"?"new-password":"current-password"} required/></label>
          {error&&<div className="auth-error">{error}</div>}{note&&<div className="auth-success">{note}</div>}
          <button className="action-primary" disabled={busy}>{busy?"Working…":mode==="signup"?"Create account":"Sign in"} <ArrowRight size={16}/></button>
          {mode==="login"&&<a style={{fontSize:10,color:"#8d92a2",textAlign:"right"}} href="/forgot-password/">Forgot password?</a>}
          <div className="auth-divider">OR</div>
          <button className="wallet-auth" type="button" onClick={walletLogin} disabled={busy}><WalletCards size={16} style={{verticalAlign:"middle",marginRight:7}}/> Continue with Solana wallet</button>
        </form>
        <div className="form-foot">{mode==="signup"?<>Already have an account? <a href="/login/">Sign in</a></>:<>New here? <a href="/signup/">Create account</a></>}</div>
      </div>
    </section>
  </div>
}
