"use client";
import {useState} from "react"; import {apiFetch,plainError} from "../../lib/api";
export default function Reset(){
 const[pw,setPw]=useState("");const[msg,setMsg]=useState("");const[err,setErr]=useState("");
 async function go(e:React.FormEvent){e.preventDefault();setErr("");const token=new URLSearchParams(location.search).get("token")||"";try{await apiFetch("/auth/reset-password",{method:"POST",body:JSON.stringify({token,password:pw})},false);setMsg("Password changed. You can sign in now.");}catch(e){setErr(plainError(e))}}
 return <main className="auth-page" style={{gridTemplateColumns:"1fr"}}><section className="auth-box-wrap"><div className="auth-box"><a className="brand" href="/"><span className="brandmark small">K</span><b>KAIRO</b></a><h2>Choose a new password</h2><form className="auth-form" onSubmit={go}><label className="field"><span>New password</span><input type="password" value={pw} onChange={e=>setPw(e.target.value)} minLength={8} required/></label>{msg&&<div className="auth-success">{msg}</div>}{err&&<div className="auth-error">{err}</div>}<button className="action-primary">Save new password</button></form><div className="form-foot"><a href="/login/">Sign in</a></div></div></section></main>
}
