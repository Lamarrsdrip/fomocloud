"use client";
import {useEffect,useState} from "react"; import {apiFetch,plainError} from "../../lib/api";
export default function Verify(){
 const[msg,setMsg]=useState("Verifying…");
 useEffect(()=>{const token=new URLSearchParams(location.search).get("token")||"";apiFetch("/auth/verify-email",{method:"POST",body:JSON.stringify({token})},false).then(()=>setMsg("Email verified. You can continue to your dashboard.")).catch(e=>setMsg(plainError(e)))},[]);
 return <main className="auth-page" style={{gridTemplateColumns:"1fr"}}><section className="auth-box-wrap"><div className="auth-box"><a className="brand" href="/"><span className="brandmark small">∞</span><b>FomoCloud</b></a><h2>{msg}</h2><a className="hero-primary" href="/app/">Open dashboard</a></div></section></main>
}
