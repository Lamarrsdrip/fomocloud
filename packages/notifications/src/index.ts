import webpush from "web-push";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { db } from "@fomocloud/db";
import { getConfig, setConfig } from "@fomocloud/config";

export type PushConfig = {
  vapidPublicKey:string;
  vapidPrivateKey:string;
  subject:string;
};

export type EmailConfig = {
  host:string;
  port:number;
  secure:boolean;
  user?:string;
  pass?:string;
  from:string;
};

export async function ensureVapid(updatedBy?:string) {
  let cfg = await getConfig<PushConfig>("push");
  if (cfg?.vapidPublicKey && cfg?.vapidPrivateKey && cfg?.subject) return cfg;
  const pair = webpush.generateVAPIDKeys();
  cfg = {
    vapidPublicKey: pair.publicKey,
    vapidPrivateKey: pair.privateKey,
    subject: cfg?.subject || process.env.VAPID_SUBJECT || process.env.NEXT_PUBLIC_APP_URL || "mailto:admin@example.com"
  };
  await setConfig("push", cfg, {secret:true, updatedBy});
  return cfg;
}

export async function publicPushKey() {
  const cfg = await getConfig<PushConfig>("push");
  return cfg?.vapidPublicKey ?? process.env.VAPID_PUBLIC_KEY ?? null;
}

export async function sendPush(userId:string, payload:{title:string;body:string;url?:string;type?:string}) {
  const cfg = await getConfig<PushConfig>("push");
  const finalCfg:PushConfig | null = cfg?.vapidPublicKey ? cfg : (
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? {vapidPublicKey:process.env.VAPID_PUBLIC_KEY,vapidPrivateKey:process.env.VAPID_PRIVATE_KEY,subject:process.env.VAPID_SUBJECT||"mailto:admin@example.com"}
      : null
  );
  if(!finalCfg) throw Object.assign(new Error("Push is not configured"),{code:"PUSH_NOT_CONFIGURED"});
  webpush.setVapidDetails(finalCfg.subject,finalCfg.vapidPublicKey,finalCfg.vapidPrivateKey);
  const pref=await db.notificationPreference.findUnique({where:{userId}});
  if(pref && !pref.pushEnabled) return {sent:0,failed:0,skipped:true};
  const subs=await db.pushSubscription.findMany({where:{userId}});
  let sent=0,failed=0;
  for(const s of subs){
    try{
      await webpush.sendNotification(
        {endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},
        JSON.stringify(payload),
        {TTL:120,urgency:"high"}
      );
      sent++;
    }catch(e:any){
      failed++;
      if(e?.statusCode===404||e?.statusCode===410) await db.pushSubscription.delete({where:{id:s.id}});
    }
  }
  return {sent,failed};
}

export async function sendEmail(to:string, subject:string, html:string, userId?:string){
  const cfg = await getConfig<EmailConfig>("email");
  const finalCfg:EmailConfig | null = cfg?.host ? cfg : (
    process.env.SMTP_HOST && process.env.SMTP_FROM
      ? {
          host:process.env.SMTP_HOST,
          port:Number(process.env.SMTP_PORT||587),
          secure:process.env.SMTP_SECURE==="true",
          user:process.env.SMTP_USER,
          pass:process.env.SMTP_PASS,
          from:process.env.SMTP_FROM
        }
      : null
  );
  if(!finalCfg) throw Object.assign(new Error("Email is not configured"),{code:"EMAIL_NOT_CONFIGURED"});
  const transporter=nodemailer.createTransport({
    host:finalCfg.host,
    port:Number(finalCfg.port),
    secure:Boolean(finalCfg.secure),
    auth:finalCfg.user ? {user:finalCfg.user,pass:finalCfg.pass} : undefined
  });
  try{
    const info=await transporter.sendMail({from:finalCfg.from,to,subject,html});
    await db.emailLog.create({data:{userId,toEmail:to,subject,status:"SENT",providerId:info.messageId}});
    return info;
  }catch(e:any){
    await db.emailLog.create({data:{userId,toEmail:to,subject,status:"FAILED",error:String(e?.message??e)}});
    throw e;
  }
}

export async function createNotification(userId:string, data:{type:string;title:string;body:string;payload?:Record<string,unknown>;push?:boolean}) {
  const n=await db.notification.create({
    data:{userId,deliveryKey:`direct:${crypto.randomUUID()}`,type:data.type,title:data.title,body:data.body,data:data.payload as any}
  });
  if(data.push!==false){
    try { await sendPush(userId,{title:data.title,body:data.body,url:"/app/",type:data.type}); } catch {}
  }
  return n;
}
