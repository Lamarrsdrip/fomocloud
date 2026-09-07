"use client";
import {useEffect,useState} from "react";

const fieldStyle={display:"grid",gap:6} as const;
const gridStyle={display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12} as const;
const hint={fontSize:12,color:"#8a8fa0",lineHeight:1.5} as const;

export default function TradeView({settings,patchTrading,setView}:{settings:any;trades:any[];patchTrading:(b:any)=>Promise<void>;setView:(v:any)=>void}){
 const incoming=settings?.trading||{};
 const [form,setForm]=useState<any>({});const[saving,setSaving]=useState(false);const[saved,setSaved]=useState("");
 useEffect(()=>setForm({...incoming}),[settings]);
 const set=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}));
 const on=Boolean(form.autoCopyEnabled&&form.globalBrainEnabled);
 async function save(){setSaving(true);setSaved("");try{await patchTrading(form);setSaved("Saved")}finally{setSaving(false)}}
 const number=(k:string,label:string,min=0,step=.1)=><label style={fieldStyle}><span>{label}</span><input type="number" min={min} step={step} value={form[k]??""} onChange={e=>set(k,Number(e.target.value))}/></label>;
 return <>
  <section className="app-card">
   <div className="card-title"><div><span>GLOBAL BRAIN</span><h2>{on?"Auto Trade is on":"Auto Trade is off"}</h2></div><button className={`switch ${on?"on":""}`} onClick={()=>setForm((f:any)=>({...f,autoCopyEnabled:!on,globalBrainEnabled:true}))}><i/></button></div>
   <p style={hint}>MemeCloud watches every Admin-listed trader, verifies real swaps, researches flow, holders, liquidity, risk and execution, then trades only opportunities that pass. Your limits below are enforced by the backend.</p>
   <div className="config-tabs"><button className={form.sizingMode!=="FIXED"?"active":""} onClick={()=>set("sizingMode","PERCENT")}>% balance</button><button className={form.sizingMode==="FIXED"?"active":""} onClick={()=>set("sizingMode","FIXED")}>Fixed $</button></div>
   <div style={gridStyle}>{form.sizingMode==="FIXED"?number("defaultAmountUsd","Trade amount ($)",1,1):number("percentBalance","Balance per entry (%)",.01,.1)}{number("maxAmountPerTradeUsd","Max per trade ($, 0 = no cap)",0,1)}{number("maxTotalExposureUsd","Max total exposure ($, 0 = no cap)",0,1)}{number("maxConcurrentPositions","Max open trades (0 = no cap)",0,1)}{number("maxSlippageBps","Max slippage (bps)",1,10)}</div>
  </section>

  <section className="app-card"><div className="card-title"><div><span>PROFIT PLAN</span><h2>Tell MemeCloud how to take profit</h2></div></div>
   <div className="config-tabs"><button className={form.takeProfitMode!=="ADVANCED"?"active":""} onClick={()=>set("takeProfitMode","SIMPLE")}>Simple</button><button className={form.takeProfitMode==="ADVANCED"?"active":""} onClick={()=>set("takeProfitMode","ADVANCED")}>Advanced</button></div>
   {form.takeProfitMode!=="ADVANCED"?<div style={gridStyle}>{number("simpleTakeProfitPct","Take profit at +%",.01,.1)}{number("simpleSellPct","Sell % of position",.01,.1)}</div>:<><div style={gridStyle}>{number("tp1Pct","TP1 +%",.01,.1)}{number("tp1SellPct","Sell at TP1 (%)",.01,.1)}{number("tp2Pct","TP2 +%",.01,.1)}{number("tp2SellPct","Sell at TP2 (%)",.01,.1)}{number("tp3Pct","TP3 +%",.01,.1)}{number("tp3SellPct","Sell at TP3 (%)",.01,.1)}{number("runnerPct","Keep as runner (%)",0,.1)}</div><p style={hint}>TP sell percentages plus the runner cannot exceed 100% of the original position.</p></>}
  </section>

  <section className="app-card"><div className="card-title"><div><span>PROFIT PROTECTION</span><h2>Protect gains your way</h2></div></div>
   <div className="control-list">
    <div><span>Recover original capital<small style={{display:"block"}}>Sell only enough to recover your initial stake once the trigger is reached.</small></span><button className={`switch ${form.capitalRecoveryEnabled?"on":""}`} onClick={()=>set("capitalRecoveryEnabled",!form.capitalRecoveryEnabled)}><i/></button></div>
    {form.capitalRecoveryEnabled&&<div>{number("capitalRecoveryTriggerPct","Trigger after profit +%",.01,.1)}</div>}
    <div><span>Trailing profit protection<small style={{display:"block"}}>After activation, exit the remainder if profit gives back your chosen amount.</small></span><button className={`switch ${form.trailingEnabled?"on":""}`} onClick={()=>set("trailingEnabled",!form.trailingEnabled)}><i/></button></div>
    {form.trailingEnabled&&<div style={gridStyle}>{number("trailingActivationPct","Activate at +%",.01,.1)}{number("trailingGivebackPct","Allowed giveback (%)",.1,.1)}</div>}
   </div>
   <label style={fieldStyle}><span>When the source trader sells</span><select value={form.sourceSellBehavior??"BRAIN_DECIDES"} onChange={e=>set("sourceSellBehavior",e.target.value)}><option value="BRAIN_DECIDES">Let Global Brain decide</option><option value="PROPORTIONAL">Follow sells proportionally</option><option value="FULL_EXIT_ONLY">Exit only when trader fully exits</option><option value="IGNORE">Ignore source sells</option></select></label>
  </section>

  <section className="app-card"><div className="card-title"><div><span>SCALPER COPY</span><h2>High-frequency copy</h2></div><button className={`switch ${form.scalperCopyEnabled?"on":""}`} onClick={()=>set("scalperCopyEnabled",!form.scalperCopyEnabled)}><i/></button></div><p style={hint}>Off by default. Rapid round-trips can be materially harder to copy because of latency, fees and slippage. Turn this on only if you deliberately want Global Brain/direct-copy to permit scalper-style entries.</p></section>

  <button className="action-primary" disabled={saving} onClick={save}>{saving?"Saving…":saved||"Save trading settings"}</button>

  <section className="app-card"><div className="card-title"><div><span>DIRECT COPY</span><h2>Copy specific traders</h2></div></div><p style={hint}>Choose exactly which Admin-listed traders you want. Each trader can inherit these global settings or use a custom position size, profit plan, sell behaviour and Scalper Copy setting.</p><button className="action-primary" onClick={()=>setView("traders")}>Choose traders</button></section>
 </>;
}
