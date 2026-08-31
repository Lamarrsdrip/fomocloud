export type SocialEligibility={qualifiedWallets:number;provenWallets:number;eliteWallets:number;verifiedWhales:number;state?:string;action?:string;materialCapitalUsd?:number};

/** X is context after capital evidence, never a discovery source. */
export function socialResearchEligibility(x:SocialEligibility){
  if(x.qualifiedWallets>=3)return {eligible:true,priority:x.qualifiedWallets>=10?1:x.qualifiedWallets>=5?2:3,reason:"QUALIFIED_CONVERGENCE"};
  if(x.eliteWallets>=1&&Number(x.materialCapitalUsd??0)>=10_000)return {eligible:true,priority:2,reason:"ELITE_CAPITAL"};
  if(x.verifiedWhales>=1&&x.provenWallets>=1)return {eligible:true,priority:2,reason:"WHALE_AND_PROVEN"};
  if(x.state==="MONEY_RUSH"||x.state==="BREAKOUT_FLOW"||x.action==="BUY_NOW")return {eligible:true,priority:x.state==="MONEY_RUSH"?1:2,reason:"BRAIN_STAGE"};
  return {eligible:false,priority:5,reason:"INSUFFICIENT_ONCHAIN_EVIDENCE"};
}

export function socialTtlMs(state?:string,materialStateChange=false){
  return state==="MONEY_RUSH"&&materialStateChange?20*60_000:60*60_000;
}
