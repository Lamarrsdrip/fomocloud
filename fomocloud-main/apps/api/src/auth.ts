import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bs58 from "bs58";
import crypto from "node:crypto";
import { db, type Chain } from "@memecloud/db";

const jwtSecret = process.env.AUTH_JWT_SECRET ?? "development-only-change-me";
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && (!process.env.AUTH_JWT_SECRET || process.env.AUTH_JWT_SECRET.startsWith("replace-") || process.env.AUTH_JWT_SECRET === "development-only-change-me")) {
  throw new Error("AUTH_JWT_SECRET must be a strong production secret");
}
const accessTtl = process.env.ACCESS_TOKEN_TTL ?? "60m";
const refreshDays = Number(process.env.REFRESH_TOKEN_DAYS ?? 30);

export const asyncRoute = (fn:(req:any,res:Response,next:NextFunction)=>Promise<any>) =>
  (req:Request,res:Response,next:NextFunction) => { Promise.resolve(fn(req,res,next)).catch(next); };

export function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    if (value.length !== 1 || !value[0]) {
      throw new Error("INVALID_ROUTE_PARAMETER");
    }
    return value[0];
  }

  if (!value) {
    throw new Error("MISSING_ROUTE_PARAMETER");
  }

  return value;
}

export function normalizeEmail(value:string) { return value.trim().toLowerCase(); }
export function validPublicAddress(chain:Chain,address:string){
  if(chain==="SOLANA"){ try{return bs58.decode(address).length===32}catch{return false} }
  if(["BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)) return /^0x[a-fA-F0-9]{40}$/.test(address);
  return address.length>=20&&address.length<=128;
}
export function hashToken(value:string) { return crypto.createHash("sha256").update(value).digest("hex"); }
export function randomToken(bytes=32) { return crypto.randomBytes(bytes).toString("base64url"); }
export function safeUser(user:any) {
  return {
    id:user.id,
    email:user.email,
    emailVerified:Boolean(user.emailVerifiedAt),
    hasPassword:Boolean(user.passwordHash),
    displayName:user.displayName,
    username:user.username,
    avatarUrl:user.avatarUrl,
    publicProfileEnabled:Boolean(user.publicProfileEnabled),
    role:user.role,
    status:user.status,
    onboardingCompleted:Boolean(user.onboardingCompletedAt),
    createdAt:user.createdAt
  };
}
export function parseCookies(req:Request) {
  const out:Record<string,string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i=part.indexOf("=");
    if(i>0) out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
export function refreshCookieOptions() {
  return {
    httpOnly:true,
    secure:isProduction,
    sameSite:(isProduction ? "none" : "lax") as "none"|"lax",
    path:"/auth",
    maxAge:refreshDays*24*60*60*1000
  };
}
export function signAccess(user:any) {
  return jwt.sign(
    {sub:user.id,role:user.role,email:user.email ?? undefined},
    jwtSecret,
    {expiresIn:accessTtl as any,issuer:"memecloud-api",audience:"memecloud-web"}
  );
}
const MAX_ACTIVE_SESSIONS_PER_USER=10;
export async function issueSession(req:Request,res:Response,user:any) {
  const refresh=randomToken(48);
  await db.refreshSession.create({
    data:{
      userId:user.id,
      tokenHash:hashToken(refresh),
      expiresAt:new Date(Date.now()+refreshDays*24*60*60_000),
      userAgent:String(req.headers["user-agent"]??"").slice(0,500),
      ipAddress:req.ip
    }
  });
  // Bounds unlimited session growth (e.g. a client retry-looping through repeated failed logins,
  // which is exactly what an embedded WebView dropping its session cookie produces) without ever
  // touching a session that's still genuinely in use. Keeps the most recently used N, revokes only
  // the older excess -- the session just created above always sorts first and is never touched.
  const active=await db.refreshSession.findMany({where:{userId:user.id,revokedAt:{isSet:false},expiresAt:{gt:new Date()}},select:{id:true},orderBy:{lastUsedAt:"desc"}});
  if(active.length>MAX_ACTIVE_SESSIONS_PER_USER){
    const excess=active.slice(MAX_ACTIVE_SESSIONS_PER_USER).map(s=>s.id);
    await db.refreshSession.updateMany({where:{id:{in:excess}},data:{revokedAt:new Date()}});
  }
  res.cookie("fomo_refresh",refresh,refreshCookieOptions());
  return signAccess(user);
}
export async function audit(userId:string|undefined,actor:string,action:string,target?:string,metadata?:Record<string,unknown>) {
  await db.auditLog.create({data:{userId,actor,action,target,metadata:metadata as any}});
}
export async function createEmailToken(userId:string,purpose:string,minutes:number) {
  const token=randomToken(32);
  await db.verificationToken.create({
    data:{userId,purpose,tokenHash:hashToken(token),expiresAt:new Date(Date.now()+minutes*60_000)}
  });
  return token;
}
export async function ensureUserDefaults(userId:string) {
  await Promise.all([
    db.globalTradingSettings.upsert({where:{userId},create:{userId},update:{}}),
    db.notificationPreference.upsert({where:{userId},create:{userId},update:{}})
  ]);
}
export async function canEnableAutoCopy(userId:string,res:Response) {
  const user=await db.user.findUnique({where:{id:userId},select:{email:true,emailVerifiedAt:true,status:true}});
  if(!user||user.status!=="ACTIVE"){res.status(403).json({error:"ACCOUNT_NOT_ACTIVE"});return false}
  // Wallet-created accounts can proceed without email. Email-created accounts must prove that
  // address before enabling automatic entries. This does not grant live signing permission.
  if(user.email&&!user.emailVerifiedAt){res.status(403).json({error:"EMAIL_VERIFICATION_REQUIRED"});return false}
  return true;
}
export function reasonText(reason?:string|null) {
  const map:Record<string,string> = {
    AUTO_COPY_DISABLED:"Auto Copy is off for this trader.",
    GLOBAL_AUTO_COPY_DISABLED:"Your global Auto Copy switch is off.",
    INSUFFICIENT_BALANCE:"There isn't enough available Trading Cash for this copy.",
    MAX_TOTAL_EXPOSURE_REACHED:"Your total open-trade limit is currently reached.",
    MAX_POSITION_REACHED:"Your limit for this token is currently reached.",
    LIQUIDITY_TOO_LOW:"Liquidity is below your configured minimum.",
    PRICE_MOVED_TOO_FAR:"The coin moved quickly after the trader bought it. We're watching for a better entry.",
    NO_EXECUTABLE_SELL_ROUTE:"We couldn't find a reliable way to sell this token, so we didn't buy it.",
    LIVE_EXECUTION_NOT_ENABLED:"Live execution is not enabled yet."
  };
  return reason ? (map[reason] ?? reason.replaceAll("_"," ").toLowerCase()) : null;
}
