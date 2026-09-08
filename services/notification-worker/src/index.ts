import { deliverWalletActivity } from "./walletActivity.js";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "@memecloud/db";
import { sendEmail, sendPush } from "@memecloud/notifications";
import { startHeartbeat, beat } from "@memecloud/ops";
import { pushAllowed as resolvePushAllowed, emailWorthSending } from "./decisions.js";

const connection=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
let active=0, processed=0;

async function targets(audience:string){
  const where:any={role:"USER",status:"ACTIVE"};
  if(audience==="AUTO_COPY") where.tradingSettings={is:{autoCopyEnabled:true}};
  const out:any[]=[];let cursor:string|undefined;
  do{
    const page=await db.user.findMany({where,select:{id:true,email:true,notificationPrefs:true},orderBy:{id:"asc"},take:1000,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    out.push(...page);if(page.length<1000)break;cursor=page[page.length-1]?.id;
  }while(cursor);
  return out;
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
  let n:any;
  try{n=await db.notification.create({data:{userId,deliveryKey,type,title,body,data:{...(data??{}),_delivery:{}} as any}})}
  catch(e:any){if(e.code!=="P2002")throw e;n=await db.notification.findUnique({where:{deliveryKey}});if(!n)throw e;}
  const delivery={...(((n.data as any)?._delivery)??{})};
  const persist=async()=>{n=await db.notification.update({where:{id:n.id},data:{data:{...((n.data as any)??{}),...(data??{}),_delivery:delivery} as any}})};
  if(resolvePushAllowed(type,pref) && delivery.push!=="SENT" && delivery.push!=="SKIPPED"){
    const r=await sendPush(userId,{title,body,url:data?.url||"/app/",type,tag:deliveryKey,data});
    if(r.sent>0){delivery.push="SENT";await persist()}
    else if(r.failed>0){delivery.push="RETRY";await persist();throw Object.assign(new Error("PUSH_DELIVERY_FAILED"),{code:"PUSH_DELIVERY_FAILED"})}
    else {delivery.push="SKIPPED";await persist()}
  }
  if(emailWorthSending(type) && pref?.emailEnabled!==false && delivery.email!=="SENT" && delivery.email!=="SKIPPED"){
    const user=await db.user.findUnique({where:{id:userId},select:{email:true}});
    if(user?.email){
      try{await sendEmail(user.email,title,`<p>${String(body).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\n","<br/>")}</p>`,userId);delivery.email="SENT";await persist()}
      catch(e){delivery.email="RETRY";await persist();throw e}
    }else{delivery.email="SKIPPED";await persist()}
  }
  return n.id;
},{connection,concurrency:10});

userWorker.on("failed",(job,err)=>console.error("[notification-worker] user notification failed",job?.id,err));

startHeartbeat("notification-broadcast-worker",()=>({active,processed}));
await beat("notification-broadcast-worker","healthy",{active,processed});
console.log("[notification-worker] running");

setInterval(()=>void deliverWalletActivity().catch(e=>console.error("[notification-worker] wallet outbox",e)),2000);
