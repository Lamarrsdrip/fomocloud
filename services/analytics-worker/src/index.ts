import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {microsToUsd} from "@memecloud/shared";
let usersScanned=0,snapshots=0,errors=0;
async function tick(){
 const users=await db.user.findMany({where:{status:"ACTIVE"},select:{id:true},take:20_000}); usersScanned+=users.length;
 for(const u of users){try{
   const recent=await db.pnLSnapshot.findFirst({where:{userId:u.id},orderBy:{createdAt:"desc"},select:{createdAt:true}});
   if(recent&&Date.now()-recent.createdAt.getTime()<5*60_000)continue;
   const [cash,positionRows]=await Promise.all([
     db.tradingCashAllocation.findMany({where:{userId:u.id}}),
     db.position.findMany({where:{userId:u.id,mode:"LIVE"},select:{costUsdMicros:true,entryTokenRaw:true,remainingTokenRaw:true,unrealizedPnlUsdMicros:true,realizedPnlUsdMicros:true,status:true}})
   ]);
   // M-30: Position/TradingCashAllocation store integer micro-USD (BigInt) now, not Float --
   // convert to plain numbers immediately here so every calculation below is byte-for-byte
   // identical to before the migration. PnLSnapshot itself stays Float (analytics/historical, not
   // the canonical ledger).
   const positions=positionRows.map(p=>({...p,costUsd:microsToUsd(p.costUsdMicros),unrealizedPnlUsd:microsToUsd(p.unrealizedPnlUsdMicros),realizedPnlUsd:microsToUsd(p.realizedPnlUsdMicros)}));
   const available=cash.reduce((a,x)=>a+microsToUsd(x.availableUsdMicros),0),reserved=cash.reduce((a,x)=>a+microsToUsd(x.inTradesUsdMicros),0);
   const open=positions.filter(p=>p.status==="OPEN"||p.status==="PARTIALLY_CLOSED");
   const realized=positions.reduce((a,p)=>a+p.realizedPnlUsd,0),unrealized=open.reduce((a,p)=>a+p.unrealizedPnlUsd,0);
   const openValue=open.reduce((a,p)=>{try{const original=BigInt(p.entryTokenRaw),remaining=BigInt(p.remainingTokenRaw);const f=original>0n?Number((remaining*1_000_000n)/original)/1_000_000:0;return a+(p.costUsd*f)+p.unrealizedPnlUsd}catch{return a+p.unrealizedPnlUsd}},0);
   await db.pnLSnapshot.create({data:{userId:u.id,accountValueUsd:available+openValue,realizedPnlUsd:realized,unrealizedPnlUsd:unrealized,netPnlUsd:realized+unrealized}}); snapshots++;
 }catch(e){errors++;console.error("[analytics-worker]",u.id,e)}}
 // Bound to roughly 90 days at five-minute resolution per user only when records exist.
 const cutoff=new Date(Date.now()-90*24*60*60_000); await db.pnLSnapshot.deleteMany({where:{createdAt:{lt:cutoff}}}).catch(()=>{});
}
startHeartbeat("analytics-worker",()=>({usersScanned,snapshots,errors}));
setInterval(()=>void tick(),60_000);void tick();console.log("[analytics-worker] generating real live-account P&L snapshots");
