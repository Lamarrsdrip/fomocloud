import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {computeAccountSnapshot} from "./snapshot.js";
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
   const snap=computeAccountSnapshot(positionRows,cash);
   await db.pnLSnapshot.create({data:{userId:u.id,...snap}}); snapshots++;
 }catch(e){errors++;console.error("[analytics-worker]",u.id,e)}}
 // Bound to roughly 90 days at five-minute resolution per user only when records exist.
 const cutoff=new Date(Date.now()-90*24*60*60_000); await db.pnLSnapshot.deleteMany({where:{createdAt:{lt:cutoff}}}).catch(()=>{});
}
startHeartbeat("analytics-worker",()=>({usersScanned,snapshots,errors}));
setInterval(()=>void tick(),60_000);void tick();console.log("[analytics-worker] generating real live-account P&L snapshots");
