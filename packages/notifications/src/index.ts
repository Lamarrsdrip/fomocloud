import webpush from "web-push";
import nodemailer from "nodemailer";
import { db } from "@fomocloud/db";

async function config(key:string){
  const row=await db.appConfig.findUnique({where:{key}});
  return row?.valueJson as any;
}

export async function sendPush(userId:string, payload:{title:string;body:string;url?:string}) {
  const cfg=await config("push");
  if(!cfg?.vapidPublicKey||!cfg?.vapidPrivateKey||!cfg?.subject) throw new Error("PUSH_NOT_CONFIGURED");
  webpush.setVapidDetails(cfg.subject,cfg.vapidPublicKey,cfg.vapidPrivateKey);
  const subs=await db.pushSubscription.findMany({where:{userId}});
  let sent=0,failed=0;
  for(const s of subs){
    try{
      await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify(payload));
      sent++;
    }catch(e:any){
      failed++;
      if(e?.statusCode===404||e?.statusCode===410) await db.pushSubscription.delete({where:{id:s.id}});
    }
  }
  return {sent,failed};
}

export async function sendEmail(to:string, subject:string, html:string, userId?:string){
  const cfg=await config("email");
  if(!cfg?.host||!cfg?.port||!cfg?.from) throw new Error("EMAIL_NOT_CONFIGURED");
  const transporter=nodemailer.createTransport({
    host:cfg.host, port:Number(cfg.port), secure:Boolean(cfg.secure),
    auth: cfg.user ? {user:cfg.user,pass:cfg.pass} : undefined
  });
  try{
    const info=await transporter.sendMail({from:cfg.from,to,subject,html});
    await db.emailLog.create({data:{userId,toEmail:to,subject,status:"SENT",providerId:info.messageId}});
    return info;
  }catch(e:any){
    await db.emailLog.create({data:{userId,toEmail:to,subject,status:"FAILED",error:String(e?.message??e)}});
    throw e;
  }
}
