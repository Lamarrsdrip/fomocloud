"use client";

import {useCallback,useEffect,useState} from "react";
import {apiFetch,plainError} from "./api";

export type CuratedLiveSnapshot={
  events:any[];
  traders:any[];
  generatedAt:string;
  sourcePolicy:string;
  aggregation?:string;
  sessionIdleMs?:number;
  release?:string|null;
};

let cache:CuratedLiveSnapshot|null=null;
let cacheAt=0;
let inFlight:Promise<CuratedLiveSnapshot>|null=null;

async function fetchSnapshot():Promise<CuratedLiveSnapshot>{
  if(inFlight)return inFlight;
  inFlight=(async()=>{
  try{
    const x=await apiFetch<any>("/v1/curated/live");
    return {
      events:Array.isArray(x.events)?x.events:[],
      traders:Array.isArray(x.traders)?x.traders:[],
      generatedAt:String(x.generatedAt||new Date().toISOString()),
      sourcePolicy:String(x.sourcePolicy||"REAL_SWAP_ADMIN_WALLETS_ONLY"),
      aggregation:x.aggregation,
      sessionIdleMs:Number(x.sessionIdleMs||0)||undefined,
      release:x.release??null
    };
  }catch(e:any){
    // Rolling deployments may briefly have the previous API, which already exposes these two
    // curated routes. Falling back keeps frontend/backend deploy order from fabricating an empty
    // Hunt. If even these are missing, the caller gets an explicit error instead of zeroes.
    if(e?.status!==404)throw e;
    const [f,t]=await Promise.all([
      apiFetch<any>("/v1/curated/flow"),
      apiFetch<any>("/v1/curated/traders")
    ]);
    return {
      events:Array.isArray(f.events)?f.events:[],
      traders:Array.isArray(t.traders)?t.traders:[],
      generatedAt:new Date().toISOString(),
      sourcePolicy:String(f.sourcePolicy||t.sourcePolicy||"REAL_SWAP_ADMIN_WALLETS_ONLY"),
      aggregation:f.aggregation,
      release:null
    };
  }
  })();
  try{return await inFlight}finally{inFlight=null}
}

function friendlyLiveError(e:any){
  if(e?.status===404)return "Live trader data is not on the same backend release yet. MemeCloud will retry automatically.";
  if(e?.status===503)return "Live trader data is temporarily unavailable. MemeCloud will retry automatically.";
  return plainError(e);
}

export function useCuratedLive(refreshMs=5000){
  const[data,setData]=useState<CuratedLiveSnapshot|null>(()=>cache);
  const[loading,setLoading]=useState(!cache);
  const[error,setError]=useState("");

  const refresh=useCallback(async()=>{
    try{
      const next=await fetchSnapshot();
      cache=next;cacheAt=Date.now();
      setData(next);setError("");
      return next;
    }catch(e:any){
      setError(friendlyLiveError(e));
      throw e;
    }finally{setLoading(false)}
  },[]);

  useEffect(()=>{
    let stopped=false;
    const run=async()=>{
      if(stopped||document.visibilityState!=="visible")return;
      // A view switch immediately after another curated view can reuse the exact same snapshot,
      // so Home/Hunt/Traders cannot disagree merely because their requests landed milliseconds apart.
      if(cache&&Date.now()-cacheAt<1500){setData(cache);setLoading(false);return;}
      try{await refresh()}catch{}
    };
    void run();
    const timer=setInterval(()=>void run(),Math.max(3000,refreshMs));
    const onVisible=()=>{if(document.visibilityState==="visible")void run()};
    document.addEventListener("visibilitychange",onVisible);
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener("visibilitychange",onVisible)};
  },[refresh,refreshMs]);

  return {data,loading,error,refresh};
}
