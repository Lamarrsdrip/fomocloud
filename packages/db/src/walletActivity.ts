import { db } from "./index.js";
import crypto from "node:crypto";

export function walletEventKey(chain:string,signature:string,wallet:string,mint:string,action:string){
  return crypto.createHash("sha256").update([chain,signature,wallet,mint,action].join(":" )).digest("hex");
}
export function walletActivityContent(event:any,token?:any){
  const symbol=token?.symbol||null,name=token?.name||null;
  const tokenLabel=symbol||name||"Unknown token";
  const verb:Record<string,string>={BOUGHT:"bought",ADDED:"added to",TRIMMED:"trimmed",MOSTLY_EXITED:"mostly exited",EXITED:"exited"};
  const amount=event.amountUsd!=null?`$${Number(event.amountUsd).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`:null;
  const mc=event.marketCapUsd!=null?`$${Number(event.marketCapUsd).toLocaleString("en-US",{maximumFractionDigits:0})} MC`:null;
  const title=`${event.walletLabel} ${verb[event.state]||event.action.toLowerCase()} ${tokenLabel}`;
  const data={...event,symbol,name,tokenLabel,icon:(token?.metadata as any)?.imageUrl??null,sourceTx:event.sourceTx,transactionUrl:`https://solscan.io/tx/${event.sourceTx}`,contractUrl:`https://solscan.io/token/${event.mint}`,url:`/app/?view=discover&mint=${encodeURIComponent(event.mint)}&chain=${event.chain}`};
  return {id:event.id,type:"WALLET_ACTIVITY",title,body:[tokenLabel,mc,amount].filter(Boolean).join(" · ")+`\nMint: ${event.mint}\n${new Date(event.observedAt).toISOString()}`,createdAt:event.observedAt,data};
}

/** All enrichment here is a database join. API refreshes never call a metadata provider. */
export async function walletActivityForUser(userId:string){
  const follows=await db.userFollow.findMany({where:{userId},select:{traderId:true}});
  const rows=await db.walletActivity.findMany({where:{OR:[{public:true},{traderId:{in:follows.map(f=>f.traderId)}}]},orderBy:{observedAt:"desc"},take:100});
  const tokens=await db.discoveryToken.findMany({where:{OR:rows.map(r=>({chain:r.chain,mint:r.mint}))}});
  const byMint=new Map(tokens.map(t=>[`${t.chain}:${t.mint}`,t]));
  return rows.map(r=>walletActivityContent(r,byMint.get(`${r.chain}:${r.mint}`)));
}
