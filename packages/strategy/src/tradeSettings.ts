export type TakeProfitMode="SIMPLE"|"ADVANCED";
export type SourceSellBehavior="IGNORE"|"PROPORTIONAL"|"FULL_EXIT_ONLY"|"BRAIN_DECIDES";
export type CopySizingMode="PERCENT"|"FIXED";

export type EffectiveTradeSettings={
  sizingMode:CopySizingMode;
  percentBalance:number;
  fixedAmountUsd:number;
  maxAmountPerTradeUsd:number;
  maxTotalExposureUsd:number;
  maxConcurrentPositions:number;
  maxConcurrentFromTrader:number;
  maxSlippageBps:number;
  maxChasePct:number;
  minLiquidityUsd:number;
  copyAdditionalBuys:boolean;
  copyReentries:boolean;
  stopLossPct:number|null;
  takeProfitMode:TakeProfitMode;
  simpleTakeProfitPct:number;
  simpleSellPct:number;
  tp1Pct:number;
  tp1SellPct:number;
  tp2Pct:number;
  tp2SellPct:number;
  tp3Pct:number;
  tp3SellPct:number;
  runnerPct:number;
  capitalRecoveryEnabled:boolean;
  capitalRecoveryTriggerPct:number;
  trailingEnabled:boolean;
  trailingActivationPct:number;
  trailingGivebackPct:number;
  sourceSellBehavior:SourceSellBehavior;
  scalperCopyEnabled:boolean;
};

const num=(v:unknown,fallback:number)=>{const n=Number(v);return Number.isFinite(n)?n:fallback};
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const bool=(v:unknown,fallback:boolean)=>typeof v==="boolean"?v:fallback;
const sizing=(v:unknown):CopySizingMode=>String(v??"").toUpperCase()==="FIXED"?"FIXED":"PERCENT";
const tpMode=(v:unknown):TakeProfitMode=>String(v??"").toUpperCase()==="ADVANCED"?"ADVANCED":"SIMPLE";
export function normalizeSourceSellBehavior(v:unknown):SourceSellBehavior{
  const x=String(v??"").toUpperCase();
  return (["IGNORE","PROPORTIONAL","FULL_EXIT_ONLY","BRAIN_DECIDES"] as const).includes(x as SourceSellBehavior)?x as SourceSellBehavior:"BRAIN_DECIDES";
}

/**
 * One authoritative merge for Global settings + a direct-trader override.
 * When `useCustomSettings` is false, the follow row is only the relationship/mode; its legacy
 * sizing/TP fields cannot silently override the user's global plan.
 */
export function resolveEffectiveTradeSettings(global:any,follow:any):EffectiveTradeSettings{
  const g=global??{}, custom=Boolean(follow?.useCustomSettings);
  const pick=(key:string,fallback:unknown)=>custom&&follow?.[key]!==null&&follow?.[key]!==undefined?follow[key]:(g?.[key]!==null&&g?.[key]!==undefined?g[key]:fallback);
  const legacyTp=custom&&Number.isFinite(Number(follow?.takeProfitPct))?Number(follow.takeProfitPct):100;
  return {
    sizingMode:sizing(pick("sizingMode","PERCENT")),
    percentBalance:clamp(num(pick("percentBalance",2),2),0.01,100),
    fixedAmountUsd:Math.max(1,num(custom?follow?.fixedAmountUsd:g?.defaultAmountUsd,100)),
    maxAmountPerTradeUsd:Math.max(0,num(custom?follow?.maxPositionUsd:g?.maxAmountPerTradeUsd,0)),
    maxTotalExposureUsd:Math.max(0,num(pick("maxTotalExposureUsd",0),0)),
    maxConcurrentPositions:Math.max(0,Math.floor(num(g?.maxConcurrentPositions,0))),
    maxConcurrentFromTrader:Math.max(0,Math.floor(num(custom?follow?.maxConcurrentFromTrader:0,0))),
    maxSlippageBps:Math.round(clamp(num(pick("maxSlippageBps",1500),1500),1,10000)),
    maxChasePct:Math.max(0,num(custom?follow?.maxChasePct:0,0)),
    minLiquidityUsd:Math.max(0,num(custom?follow?.minLiquidityUsd:0,0)),
    copyAdditionalBuys:custom?bool(follow?.copyAdditionalBuys,true):true,
    copyReentries:custom?bool(follow?.copyReentries,true):true,
    stopLossPct:custom&&follow?.stopLossPct!==null&&follow?.stopLossPct!==undefined?Math.max(0,num(follow.stopLossPct,0)):null,
    takeProfitMode:tpMode(pick("takeProfitMode","SIMPLE")),
    simpleTakeProfitPct:Math.max(0.01,num(pick("simpleTakeProfitPct",legacyTp),legacyTp)),
    simpleSellPct:clamp(num(pick("simpleSellPct",100),100),0.01,100),
    tp1Pct:Math.max(0.01,num(pick("tp1Pct",50),50)),
    tp1SellPct:clamp(num(pick("tp1SellPct",25),25),0.01,100),
    tp2Pct:Math.max(0.01,num(pick("tp2Pct",100),100)),
    tp2SellPct:clamp(num(pick("tp2SellPct",25),25),0.01,100),
    tp3Pct:Math.max(0.01,num(pick("tp3Pct",200),200)),
    tp3SellPct:clamp(num(pick("tp3SellPct",25),25),0.01,100),
    runnerPct:clamp(num(pick("runnerPct",25),25),0,100),
    capitalRecoveryEnabled:bool(pick("capitalRecoveryEnabled",true),true),
    capitalRecoveryTriggerPct:Math.max(0.01,num(pick("capitalRecoveryTriggerPct",100),100)),
    trailingEnabled:bool(pick("trailingEnabled",false),false),
    trailingActivationPct:Math.max(0.01,num(pick("trailingActivationPct",80),80)),
    trailingGivebackPct:clamp(num(pick("trailingGivebackPct",20),20),0.1,99),
    sourceSellBehavior:normalizeSourceSellBehavior(pick("sourceSellBehavior","BRAIN_DECIDES")),
    scalperCopyEnabled:bool(pick("scalperCopyEnabled",false),false)
  };
}

export type UserProfitState={
  tp1Taken:boolean;
  tp2Taken:boolean;
  tp3Taken:boolean;
  simpleTpTaken?:boolean;
  principalRecoveredPct:number;
  peakProfitPct:number;
  remainingPct:number; // % of original position still held
};
export type UserProfitMarket={profitPct:number;drawdownFromPeakPct:number};
export type UserProfitInstruction=
  | {action:"HOLD";reason:string}
  | {action:"PARTIAL_TP";sellPct:number;reason:string;tag:string}
  | {action:"EXIT";sellPct:100;reason:string;tag:string};

function sellOriginalPctAsCurrent(remainingPct:number,originalPct:number,runnerFloorPct:number){
  const remaining=Math.max(0,remainingPct);
  const availableAboveRunner=Math.max(0,remaining-Math.max(0,runnerFloorPct));
  const originalToSell=Math.min(Math.max(0,originalPct),availableAboveRunner);
  return remaining>0?clamp(originalToSell/remaining*100,0,100):0;
}

/** Deterministic user profit plan. Risk/liquidity fail-closed exits are evaluated separately. */
export function evaluateUserProfitPlan(settings:EffectiveTradeSettings,market:UserProfitMarket,state:UserProfitState):UserProfitInstruction{
  const profit=Number(market.profitPct),remaining=Math.max(0,Number(state.remainingPct));
  if(!Number.isFinite(profit)||remaining<=0)return {action:"HOLD",reason:"No active position quantity"};

  // A user-defined trail protects whatever remains, including the runner.
  if(settings.trailingEnabled&&state.peakProfitPct>=settings.trailingActivationPct&&market.drawdownFromPeakPct>=settings.trailingGivebackPct)
    return {action:"EXIT",sellPct:100,tag:"USER_TRAILING_EXIT",reason:`User trailing protection: peak profit reached ${state.peakProfitPct.toFixed(1)}% and price gave back ${market.drawdownFromPeakPct.toFixed(1)}%`};

  // Capital recovery has priority over ordinary ladder harvesting because its job is to remove the
  // user's original principal once the chosen threshold is reached. The exit worker calculates the
  // exact fraction needed from current value; this marker tells it when to do so.
  if(settings.capitalRecoveryEnabled&&state.principalRecoveredPct<99.999&&profit>=settings.capitalRecoveryTriggerPct)
    return {action:"PARTIAL_TP",sellPct:0,tag:"USER_CAPITAL_RECOVERY",reason:`Recover original capital after +${settings.capitalRecoveryTriggerPct}%`};

  if(settings.takeProfitMode==="SIMPLE"){
    if(!state.simpleTpTaken&&profit>=settings.simpleTakeProfitPct){
      if(settings.simpleSellPct>=99.999)return {action:"EXIT",sellPct:100,tag:"USER_SIMPLE_TP",reason:`User take-profit reached +${settings.simpleTakeProfitPct}%`};
      return {action:"PARTIAL_TP",sellPct:settings.simpleSellPct,tag:"USER_SIMPLE_TP",reason:`User take-profit reached +${settings.simpleTakeProfitPct}%`};
    }
    return {action:"HOLD",reason:"Waiting for user take-profit target"};
  }

  const stages=[
    {taken:state.tp1Taken,target:settings.tp1Pct,originalSell:settings.tp1SellPct,tag:"USER_TP1"},
    {taken:state.tp2Taken,target:settings.tp2Pct,originalSell:settings.tp2SellPct,tag:"USER_TP2"},
    {taken:state.tp3Taken,target:settings.tp3Pct,originalSell:settings.tp3SellPct,tag:"USER_TP3"}
  ];
  for(const stage of stages){
    if(stage.taken||profit<stage.target)continue;
    const sellPct=sellOriginalPctAsCurrent(remaining,stage.originalSell,settings.runnerPct);
    if(sellPct<=0)return {action:"HOLD",reason:`${stage.tag} reached, but the configured ${settings.runnerPct}% runner floor is already protected`};
    return {action:"PARTIAL_TP",sellPct,tag:stage.tag,reason:`${stage.tag.replace("USER_","")} reached +${stage.target}%`};
  }
  return {action:"HOLD",reason:"Waiting for the next user profit target"};
}
