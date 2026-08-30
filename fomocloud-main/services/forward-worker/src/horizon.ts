export const FORWARD_HORIZONS=[30,60,300,900,3600,21600,86400] as const;

export function toleranceForHorizonMs(horizonSeconds:number):number{
  // Short horizons need tight evidence; longer horizons receive a proportionate but bounded
  // collection window. The price itself must still be observed inside this window.
  return Math.min(45*60_000,Math.max(15_000,horizonSeconds*1000*0.25));
}

export function classifyObservation(nowMs:number,targetAtMs:number,maxToleranceMs:number,hasSourcePrice:boolean,hasBoundedPrice:boolean):"OK"|"LATE"|"MISSING"|"INVALID"{
  if(!hasSourcePrice)return "INVALID";
  if(!hasBoundedPrice)return "MISSING";
  return nowMs>targetAtMs+maxToleranceMs?"LATE":"OK";
}
