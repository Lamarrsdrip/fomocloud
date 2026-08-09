"use client";
import {useState} from "react"; import {apiFetch,plainError} from "../../lib/api";
export default function Forgot(){
 const[email,setEmail]=useState("");const[msg,setMsg]=useState("");const[err,setErr]=useState("");
 async function go(e:React.FormEvent){e.preventDefault();setErr("");try{await apiFetch("/auth/forgot-password",{method:"POST",body:JSON.stringify({email})},false);setMsg("If that email exists, a reset link has been sent.");}catch(e){setErr(plainError(e))}}
 return <main className="auth-page" style={{gridTemplateColumns:"1fr"}}><section className="auth-box-wrap"><div className="auth-box"><a className="brand" href="/"><span className="brandmark small">∞</span><b>MemeCloud</b></a><h2>Reset password</h2><p>Enter your account email.</p><form className="auth-form" onSubmit={go}><label className="field"><span>Email</span><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>{msg&&<div className="auth-success">{msg}</div>}{err&&<div className="auth-error">{err}</div>}<button className="action-primary">Send reset link</button></form><div className="form-foot"><a href="/login/">Back to sign in</a></div></div></section></main>
}
