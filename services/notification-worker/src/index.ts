import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@fomocloud/db";
import { sendEmail, sendPush } from "@fomocloud/notifications";
import { startHeartbeat, beat } from "@fomocloud/ops";

const connection=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
let active=0, processed=0;

async function targets(audience:string){
  const where:any={role:"USER",status:"ACTIVE"};
  if(audience==="AUTO_COPY") where.tradingSettings={is:{autoCopyEnabled:true}};
  return db.user.findMany({
    where,
    select:{id:true,email:true,notificationPrefs:true},
    take:100_000
  });
}

const worker=new Worker("broadcasts",async job=>{
  active++;
  const b=await db.broadcast.findUnique({where:{id:job.data.broadcastId}});
  if(!b) return;
  await db.broadcast.update({where:{id:b.id},data:{status:"SENDING",startedAt:new Date()}});
  const users=await targets(b.audience);
  await db.broadcast.update({where:{id:b.id},data:{targetCount:users.length}});
  let sent=0,failed=0,skipped=0;
  for(let i=0;i<users.length;i+=100){
    const batch=users.slice(i,i+100);
    const results=await Promise.all(batch.map(async u=>{
      let anySent=false, anyFailed=false, attempted=false;
      const broadcastsAllowed=u.notificationPrefs?.platformBroadcast!==false;
      if((b.channel==="PUSH"||b.channel==="BOTH") && broadcastsAllowed){
        attempted=true;
        try {
          const r=await sendPush(u.id,{title:b.title,body:b.body,url:b.linkUrl||"/app/",type:"BROADCAST"});
          anySent ||= r.sent>0;
          // No active browser subscription is a skipped destination, not a successful send.
          if(r.sent===0 && r.failed>0) anyFailed=true;
        } catch { anyFailed=true; }
      }
      if((b.channel==="EMAIL"||b.channel==="BOTH") && broadcastsAllowed && u.notificationPrefs?.emailEnabled!==false){
        if(u.email){
          attempted=true;
          try { await sendEmail(u.email,b.title,`<p>${b.body.replaceAll("\n","<br/>")}</p>${b.linkUrl?`<p><a href="${b.linkUrl}">Open</a></p>`:""}`,u.id); anySent=true; }
          catch { anyFailed=true; }
        }
      }
      return {anySent,anyFailed,skipped:!anySent&&!anyFailed&&(!attempted||!broadcastsAllowed)};
    }));
    sent+=results.filter(x=>x.anySent).length;
    failed+=results.filter(x=>x.anyFailed&&!x.anySent).length;
    skipped+=results.filter(x=>x.skipped).length;
    await db.broadcast.update({where:{id:b.id},data:{sentCount:sent,failedCount:failed,skippedCount:skipped}});
    await new Promise(r=>setTimeout(r,100));
  }
  await db.broadcast.update({where:{id:b.id},data:{status:failed&&sent===0?"FAILED":"COMPLETED",sentAt:new Date(),sentCount:sent,failedCount:failed,skippedCount:skipped}});
  processed++;
},{connection,concurrency:2});

worker.on("failed",async(job,err)=>{
  console.error("[notification-worker] failed",job?.id,err);
  if(job?.data?.broadcastId) await db.broadcast.updateMany({where:{id:job.data.broadcastId},data:{status:"FAILED",error:String(err.message).slice(0,500)}}).catch(()=>{});
});
worker.on("active",()=>{});
worker.on("completed",()=>{active=Math.max(0,active-1)});
worker.on("failed",()=>{active=Math.max(0,active-1)});


const userWorker=new Worker("user-notifications",async job=>{
  const {userId,type,title,body,data}=job.data;
  const pref=await db.notificationPreference.findUnique({where:{userId}});
  const deliveryKey=String(job.data.deliveryKey??job.id??`${userId}:${type}`);
  const n=await db.notification.upsert({
    where:{deliveryKey},
    create:{userId,deliveryKey,type,title,body,data:data as any},
    update:{}
  });
  const pushAllowed=pref?.pushEnabled!==false && (
    type==="TRADER_SIGNAL"?pref?.traderBought!==false:
    type==="TRADE_COPIED"?pref?.tradeCopied!==false:
    type==="TRADE_SKIPPED"||type==="WAIT_PULLBACK"?pref?.skippedTrade!==false:
    type==="PROFIT_TAKEN"?pref?.profitTaken!==false:
    type==="POSITION_CLOSED"?pref?.positionClosed!==false:true
  );
  if(pushAllowed){
    try{await sendPush(userId,{title,body,url:"/app/",type});}catch(e){console.error("[notification-worker] push",e);}
  }
  const emailWorthSending=["TRADE_COPIED","PROFIT_TAKEN","POSITION_CLOSED","SECURITY_ALERT"].includes(type);
  if(emailWorthSending && pref?.emailEnabled!==false){
    const user=await db.user.findUnique({where:{id:userId},select:{email:true}});
    if(user?.email){
      try{await sendEmail(user.email,title,`<p>${String(body).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\n","<br/>")}</p>`,userId)}
      catch(e){console.error("[notification-worker] email",e);}
    }
  }
  return n.id;
},{connection,concurrency:10});

userWorker.on("failed",(job,err)=>console.error("[notification-worker] user notification failed",job?.id,err));

startHeartbeat("notification-broadcast-worker",()=>({active,processed}));
await beat("notification-broadcast-worker","healthy",{active,processed});
console.log("[notification-worker] running");
