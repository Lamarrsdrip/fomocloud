import type { ConfirmedSignatureInfo } from "@solana/web3.js";

type FetchSignaturePage=(before:string|undefined,limit:number)=>Promise<ConfirmedSignatureInfo[]>;

export type ReplayPlan={
  baseline?:ConfirmedSignatureInfo;
  signatures:ConfirmedSignatureInfo[];
  complete:boolean;
};

export async function planSignatureReplay(
  fetchPage:FetchSignaturePage,
  lastSeenSignature:string|undefined,
  maxSignatures=500
):Promise<ReplayPlan>{
  if(!lastSeenSignature){
    const [baseline]=await fetchPage(undefined,1);
    return {baseline,signatures:[],complete:true};
  }

  const newestFirst:ConfirmedSignatureInfo[]=[];
  let before:string|undefined;
  while(newestFirst.length<maxSignatures){
    const limit=Math.min(100,maxSignatures-newestFirst.length);
    const page=await fetchPage(before,limit);
    if(!page.length) return {signatures:[],complete:false};
    const cursorIndex=page.findIndex(item=>item.signature===lastSeenSignature);
    if(cursorIndex>=0){
      newestFirst.push(...page.slice(0,cursorIndex));
      return {signatures:newestFirst.reverse(),complete:true};
    }
    newestFirst.push(...page);
    if(page.length<limit) return {signatures:[],complete:false};
    before=page.at(-1)?.signature;
  }
  return {signatures:[],complete:false};
}
