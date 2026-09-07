"use client";

import {useEffect,useState} from "react";

const DEFAULTS:any={
  autoCopyEnabled:false,
  globalBrainEnabled:true,
  sizingMode:"PERCENT",
  percentBalance:2,
  defaultAmountUsd:100,
  maxAmountPerTradeUsd:0,
  maxTotalExposureUsd:0,
  maxConcurrentPositions:0,
  maxSlippageBps:1500,

  takeProfitMode:"SIMPLE",
  simpleTakeProfitPct:100,
  simpleSellPct:100,

  tp1Pct:50,
  tp1SellPct:25,
  tp2Pct:100,
  tp2SellPct:25,
  tp3Pct:200,
  tp3SellPct:25,
  runnerPct:25,

  capitalRecoveryEnabled:true,
  capitalRecoveryTriggerPct:100,

  trailingEnabled:false,
  trailingActivationPct:80,
  trailingGivebackPct:20,

  sourceSellBehavior:"BRAIN_DECIDES",
  scalperCopyEnabled:false
};

function Toggle({
  on,
  onClick,
  title,
  text
}:{
  on:boolean;
  onClick:()=>void;
  title:string;
  text?:string;
}){
  return <div className="trade-toggle-row">
    <div>
      <b>{title}</b>
      {text&&<small>{text}</small>}
    </div>
    <button
      type="button"
      aria-pressed={on}
      className={`switch ${on?"on":""}`}
      onClick={onClick}
    >
      <i/>
    </button>
  </div>;
}

export default function TradeView({
  settings,
  patchTrading,
  setView
}:{
  settings:any;
  trades:any[];
  patchTrading:(body:any)=>Promise<void>;
  setView:(view:any)=>void;
}){
  const incoming=settings?.trading||{};
  const [form,setForm]=useState<any>({...DEFAULTS});
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState("");

  useEffect(()=>{
    setForm({...DEFAULTS,...incoming});
  },[settings]);

  const set=(key:string,value:any)=>{
    setSaved("");
    setForm((current:any)=>({...current,[key]:value}));
  };

  const autoOn=Boolean(form.autoCopyEnabled&&form.globalBrainEnabled);

  const numeric=(
    key:string,
    label:string,
    min=0,
    step=.1,
    suffix?:string
  )=><label className="trade-field">
    <span>{label}</span>
    <div className="trade-input-wrap">
      <input
        type="number"
        min={min}
        step={step}
        value={form[key]??DEFAULTS[key]??""}
        onChange={e=>set(key,Number(e.target.value))}
      />
      {suffix&&<em>{suffix}</em>}
    </div>
  </label>;

  async function save(){
    setSaving(true);
    setSaved("");
    try{
      await patchTrading(form);
      setSaved("Settings saved");
    }finally{
      setSaving(false);
    }
  }

  const slippagePct=Number(form.maxSlippageBps??1500)/100;

  return <div className="trade-page-stack">

    <section className="app-card trade-hero-card">
      <div className="trade-section-head">
        <div>
          <span>GLOBAL BRAIN</span>
          <h2>Auto Trade</h2>
          <p>
            MemeCloud chooses opportunities from verified buys made by
            Admin-tracked traders and applies your rules before trading.
          </p>
        </div>

        <button
          type="button"
          aria-label="Toggle Global Brain Auto Trade"
          aria-pressed={autoOn}
          className={`switch trade-main-switch ${autoOn?"on":""}`}
          onClick={()=>{
            setForm((f:any)=>({
              ...f,
              autoCopyEnabled:!autoOn,
              globalBrainEnabled:true
            }));
            setSaved("");
          }}
        >
          <i/>
        </button>
      </div>

      <div className={`trade-state ${autoOn?"live":""}`}>
        <b>{autoOn?"Auto Trade On":"Auto Trade Off"}</b>
        <span>
          {autoOn
            ?"Global Brain may trade opportunities that pass your settings."
            :"No new Global Brain entries will be opened for you."}
        </span>
      </div>
    </section>

    <section className="app-card">
      <div className="trade-section-head">
        <div>
          <span>TRADE SIZE</span>
          <h2>How much should MemeCloud use?</h2>
        </div>
      </div>

      <div className="config-tabs trade-tabs">
        <button
          type="button"
          className={form.sizingMode!=="FIXED"?"active":""}
          onClick={()=>set("sizingMode","PERCENT")}
        >
          % of balance
        </button>

        <button
          type="button"
          className={form.sizingMode==="FIXED"?"active":""}
          onClick={()=>set("sizingMode","FIXED")}
        >
          Fixed amount
        </button>
      </div>

      <div className="trade-primary-setting">
        {form.sizingMode==="FIXED"
          ?numeric("defaultAmountUsd","Amount per entry",1,1,"USD")
          :numeric("percentBalance","Balance per entry",.01,.1,"%")}
      </div>

      <div className="trade-settings-grid">
        {numeric("maxAmountPerTradeUsd","Maximum per trade",0,1,"USD")}
        {numeric("maxTotalExposureUsd","Maximum total exposure",0,1,"USD")}
        {numeric("maxConcurrentPositions","Maximum open trades",0,1)}
        <label className="trade-field">
          <span>Maximum slippage</span>
          <div className="trade-input-wrap">
            <input
              type="number"
              min=".01"
              max="100"
              step=".1"
              value={Number.isFinite(slippagePct)?slippagePct:""}
              onChange={e=>
                set("maxSlippageBps",
                  Math.round(Number(e.target.value)*100)
                )
              }
            />
            <em>%</em>
          </div>
        </label>
      </div>

      <small className="trade-help">
        Enter 0 for a limit if you deliberately want no additional cap.
      </small>
    </section>

    <section className="app-card">
      <div className="trade-section-head">
        <div>
          <span>PROFIT PLAN</span>
          <h2>Choose how profits are taken</h2>
          <p>
            Start simple. Advanced mode lets you split profit-taking across
            several targets and keep a runner.
          </p>
        </div>
      </div>

      <div className="config-tabs trade-tabs">
        <button
          type="button"
          className={form.takeProfitMode!=="ADVANCED"?"active":""}
          onClick={()=>set("takeProfitMode","SIMPLE")}
        >
          Simple
        </button>

        <button
          type="button"
          className={form.takeProfitMode==="ADVANCED"?"active":""}
          onClick={()=>set("takeProfitMode","ADVANCED")}
        >
          Advanced
        </button>
      </div>

      {form.takeProfitMode!=="ADVANCED"
        ?<div className="trade-settings-grid">
          {numeric("simpleTakeProfitPct","Target profit",.01,.1,"%")}
          {numeric("simpleSellPct","Sell at target",.01,.1,"%")}
        </div>
        :<div className="trade-advanced-grid">
          {numeric("tp1Pct","TP1 profit",.01,.1,"%")}
          {numeric("tp1SellPct","Sell at TP1",.01,.1,"%")}

          {numeric("tp2Pct","TP2 profit",.01,.1,"%")}
          {numeric("tp2SellPct","Sell at TP2",.01,.1,"%")}

          {numeric("tp3Pct","TP3 profit",.01,.1,"%")}
          {numeric("tp3SellPct","Sell at TP3",.01,.1,"%")}

          {numeric("runnerPct","Keep as runner",0,.1,"%")}
        </div>}
    </section>

    <section className="app-card">
      <div className="trade-section-head">
        <div>
          <span>PROFIT PROTECTION</span>
          <h2>Protect winning trades</h2>
        </div>
      </div>

      <div className="trade-control-list">
        <Toggle
          on={Boolean(form.capitalRecoveryEnabled)}
          onClick={()=>set(
            "capitalRecoveryEnabled",
            !form.capitalRecoveryEnabled
          )}
          title="Recover original capital"
          text="Sell only enough to recover your original stake once the trigger is reached."
        />

        {form.capitalRecoveryEnabled&&
          <div className="trade-inline-setting">
            {numeric(
              "capitalRecoveryTriggerPct",
              "Recover capital after profit reaches",
              .01,
              .1,
              "%"
            )}
          </div>}

        <Toggle
          on={Boolean(form.trailingEnabled)}
          onClick={()=>set("trailingEnabled",!form.trailingEnabled)}
          title="Trailing profit protection"
          text="Protect gains if price falls after reaching your activation level."
        />

        {form.trailingEnabled&&
          <div className="trade-settings-grid">
            {numeric(
              "trailingActivationPct",
              "Activate trailing after",
              .01,
              .1,
              "%"
            )}
            {numeric(
              "trailingGivebackPct",
              "Allowed giveback",
              .1,
              .1,
              "%"
            )}
          </div>}
      </div>
    </section>

    <details className="app-card trade-advanced-box">
      <summary>
        <div>
          <span>ADVANCED</span>
          <b>Copy behaviour & execution</b>
        </div>
        <strong>›</strong>
      </summary>

      <div className="trade-advanced-content">
        <label className="trade-field">
          <span>When the source trader sells</span>
          <select
            value={form.sourceSellBehavior??"BRAIN_DECIDES"}
            onChange={e=>set("sourceSellBehavior",e.target.value)}
          >
            <option value="BRAIN_DECIDES">
              Let Global Brain decide
            </option>
            <option value="PROPORTIONAL">
              Follow sells proportionally
            </option>
            <option value="FULL_EXIT_ONLY">
              Exit only when trader fully exits
            </option>
            <option value="IGNORE">
              Ignore source sells
            </option>
          </select>
        </label>

        <Toggle
          on={Boolean(form.scalperCopyEnabled)}
          onClick={()=>set("scalperCopyEnabled",!form.scalperCopyEnabled)}
          title="Scalper Copy"
          text="Off by default. Allows rapid copy entries from high-frequency traders. Fees, latency and slippage can differ from the source wallet."
        />
      </div>
    </details>

    <button
      className="action-primary trade-save"
      disabled={saving}
      onClick={save}
    >
      {saving?"Saving…":saved||"Save trading settings"}
    </button>

    <section className="app-card trade-direct-copy">
      <div>
        <span>DIRECT COPY</span>
        <h2>Copy a specific trader</h2>
        <p>
          Choose an Admin-tracked trader. Use your Global settings or customize
          that trader separately.
        </p>
      </div>

      <button
        type="button"
        className="action-primary"
        onClick={()=>setView("traders")}
      >
        Choose traders
      </button>
    </section>

  </div>;
}
