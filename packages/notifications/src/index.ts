import webpush from "web-push";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { getConfig, setConfig } from "@memecloud/config";

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
  // subscriptions:0 means the backend/VAPID validated fine but there was nothing to deliver to —
  // that's a real, distinct outcome from "delivery failed," never conflate the two.
  return {sent,failed,subscriptions:subs.length};
}

// A bare address with no display name ("support@meme.xaucloud.io") is itself a weak spam
// signal to receiving filters, distinct from any DNS/auth issue. Wrap it as a proper identity
// unless the admin already configured one — never invent a different address (no spoofing).
function formatFrom(from:string){
  return from.includes("<") ? from : `MemeCloud <${from}>`;
}

function htmlToPlainFallback(html:string){
  return html
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,"$2 ($1)")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/(p|div|h1|h2|h3|li|tr)>/gi,"\n")
    .replace(/<[^>]+>/g,"")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/\n{3,}/g,"\n\n").trim();
}

const EMAIL_APP_URL = "https://meme.xaucloud.io";

/**
 * Shared branded transactional-email shell. Every real MemeCloud email (verification, password
 * reset, security/account events) should render through this — one visual identity instead of
 * ad-hoc inline HTML per call site, and it stays genuinely transactional-looking (no promotional
 * banners/imagery that read as marketing to spam filters).
 */
export function renderEmail(opts:{preheader:string;heading:string;bodyHtml:string;ctaLabel?:string;ctaUrl?:string;footerNote?:string}){
  const {preheader,heading,bodyHtml,ctaLabel,ctaUrl,footerNote} = opts;
  const cta = ctaLabel && ctaUrl
    ? `<tr><td style="padding:28px 0 8px"><a href="${ctaUrl}" style="display:inline-block;background:#6468ff;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:12px">${ctaLabel}</a></td></tr>
       <tr><td style="padding:0 0 4px;font-size:11px;color:#8d93a4">Or paste this link into your browser:<br><a href="${ctaUrl}" style="color:#9a97ff;word-break:break-all">${ctaUrl}</a></td></tr>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#07080c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<span style="display:none;font-size:1px;color:#07080c;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07080c;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0f1118;border:1px solid rgba(255,255,255,.08);border-radius:20px;overflow:hidden">
<tr><td style="padding:26px 28px 0">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#9087ff,#5b5dff);text-align:center;vertical-align:middle;font-weight:900;color:#fff;font-size:17px">M</td>
    <td style="padding-left:9px;font-weight:800;font-size:15px;color:#f7f8fc">MemeCloud</td>
  </tr></table>
</td></tr>
<tr><td style="padding:22px 28px 6px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="font-size:20px;font-weight:800;color:#f7f8fc;letter-spacing:-.02em;padding-bottom:12px">${heading}</td></tr>
  <tr><td style="font-size:13px;line-height:1.6;color:#b6bac6">${bodyHtml}</td></tr>
  ${cta}
  </table>
</td></tr>
<tr><td style="padding:22px 28px 26px;border-top:1px solid rgba(255,255,255,.06);margin-top:20px">
  <p style="margin:20px 0 0;font-size:10.5px;line-height:1.6;color:#6b7182">${footerNote??"This is an automated message from MemeCloud. If you didn't expect this email, you can safely ignore it."}</p>
  <p style="margin:8px 0 0;font-size:10.5px;color:#6b7182"><a href="${EMAIL_APP_URL}" style="color:#8d93a4">${EMAIL_APP_URL.replace("https://","")}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  return {html, text:htmlToPlainFallback(html)};
}

export async function sendEmail(to:string, subject:string, html:string, userId?:string, text?:string){
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
    // A multipart message (html + a real text/plain alternative) is both a genuine accessibility
    // improvement and a widely-used spam-score signal — an HTML-only transactional email is
    // itself something spam filters weigh against a low-reputation domain.
    const info=await transporter.sendMail({from:formatFrom(finalCfg.from),to,subject,html,text:text??htmlToPlainFallback(html)});
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
