import { db } from "./index.js";
import crypto from "node:crypto";

export function walletEventKey(chain:string,signature:string,wallet:string,mint:string,action:string){
  return crypto.createHash("sha256").update([chain,signature,wallet,mint,action].join(":" )).digest("hex");
}
const trimZeros=(s:string)=>s.includes(".")?s.replace(/0+$/,"").replace(/\.$/,""):s;
function compactUsd(n:number){
  const a=Math.abs(n);
  if(a>=1_000_000_000)return `$${trimZeros((n/1_000_000_000).toFixed(2))}B`;
  if(a>=1_000_000)return `$${trimZeros((n/1_000_000).toFixed(2))}M`;
  if(a>=1_000)return `$${trimZeros((n/1_000).toFixed(1))}K`;
  return `$${n.toFixed(2)}`;
}
function shortMint(mint:string){return mint.length>12?`${mint.slice(0,4)}…${mint.slice(-4)}`:mint}

/** Exact percentage of the position sold, from the wallet's own before/after balances. */
export function soldPercent(event:any):number|null{
  try{
    const before=BigInt(event.balanceBeforeRaw??"0"),after=BigInt(event.balanceAfterRaw??"0");
    if(before<=0n)return null;
    const sold=before>after?before-after:0n;
    return Math.max(0,Math.min(100,Number((sold*10000n)/before)/100));
  }catch{return null}
}

// The alert has to answer: WHO, WHAT token, WHAT they spent, at WHAT market cap, and WHEN --
// and it must be honest when a value genuinely is not known yet (no invented names or numbers).
export function walletActivityContent(event:any,token?:any){
  const symbol=token?.symbol||null,name=token?.name||null;
  // Never fabricate a name; fall back to the real mint, abbreviated.
  const tokenLabel=symbol||name||shortMint(event.mint);
  const usd=event.amountUsd!=null?Number(event.amountUsd):null;
  const mcValue=event.marketCapUsd!=null?Number(event.marketCapUsd):null;
  const mc=mcValue!=null?`${compactUsd(mcValue)} MC`:null;
  const pct=soldPercent(event);

  let title:string,lines:string[]=[];
  if(event.action==="BUY"){
    const verb=event.state==="ADDED"?"added":"bought";
    title=`🟢 ${event.walletLabel} ${verb} ${tokenLabel}`;
    if(usd!=null)lines.push(`Spent ${compactUsd(usd)}`);
  }else if(event.action==="SELL"){
    if(event.state==="EXITED"){title=`🔴 ${event.walletLabel} exited ${tokenLabel}`;lines.push("100% sold");}
    else{title=`🔴 ${event.walletLabel} sold ${pct!=null?`${Math.round(pct)}% of `:""}${tokenLabel}`;}
    if(usd!=null)lines.push(`Received ${compactUsd(usd)}`);
  }else{
    // Transfers are internal-only; if one is ever surfaced it must never read as a trade.
    const moved=event.action==="TRANSFER_IN"?"received a transfer of":"sent out a transfer of";
    title=`${event.walletLabel} ${moved} ${tokenLabel}`;
    lines.push("Not a trade — no swap evidence");
  }
  if(mc)lines.push(mcValue!=null&&event.action==="BUY"?`${mc} at entry`:mc);
  lines.push(`Mint: ${shortMint(event.mint)}`);

  const data={...event,symbol,name,tokenLabel,soldPct:pct,marketCapAtBuy:mcValue,
    icon:(token?.metadata as any)?.imageUrl??null,sourceTx:event.sourceTx,
    transactionUrl:`https://solscan.io/tx/${event.sourceTx}`,contractUrl:`https://solscan.io/token/${event.mint}`,
    url:`/app/?view=discover&mint=${encodeURIComponent(event.mint)}&chain=${event.chain}`};
  return {id:event.id,type:"WALLET_ACTIVITY",title,body:lines.join("\n"),createdAt:event.observedAt,data};
}

/** All enrichment here is a database join. API refreshes never call a metadata provider. */
export async function walletActivityForUser(userId:string){
  const follows=await db.userFollow.findMany({where:{userId},select:{traderId:true}});
  const rows=await db.walletActivity.findMany({where:{OR:[{public:true},{traderId:{in:follows.map(f=>f.traderId)}}]},orderBy:{observedAt:"desc"},take:100});
  const tokens=await db.discoveryToken.findMany({where:{OR:rows.map(r=>({chain:r.chain,mint:r.mint}))}});
  const byMint=new Map(tokens.map(t=>[`${t.chain}:${t.mint}`,t]));
  return rows.map(r=>walletActivityContent(r,byMint.get(`${r.chain}:${r.mint}`)));
}
