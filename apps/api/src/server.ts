import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { db, type Chain, type FollowMode } from "@memecloud/db";
import { CopySettingsSchema } from "@memecloud/shared";
import { getConfig, setConfig, redactedConfig, encryptJson, decryptJson, maskHint, recordProviderResults, fingerprintOf, ackRestart, isLiveTradingEnabled, type ProviderRecord } from "@memecloud/config";
// A single raw test attempt, before a config fingerprint is attached (see withFingerprints below).
type TestResult = { ok: boolean; httpStatus?: number; latencyMs?: number; message: string; checkedAt: string };
import { sendEmail, sendPush, ensureVapid, publicPushKey, renderEmail } from "@memecloud/notifications";
import { PrivySolanaSigner } from "@memecloud/providers";
import { JupiterExecution } from "@memecloud/execution";
import { Connection, PublicKey } from "@solana/web3.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.AUTH_JWT_SECRET ?? "development-only-change-me";
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && (!process.env.AUTH_JWT_SECRET || process.env.AUTH_JWT_SECRET.startsWith("replace-") || process.env.AUTH_JWT_SECRET === "development-only-change-me")) {
  throw new Error("AUTH_JWT_SECRET must be a strong production secret");
}
const accessTtl = process.env.ACCESS_TOKEN_TTL ?? "60m";
const refreshDays = Number(process.env.REFRESH_TOKEN_DAYS ?? 30);
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
const broadcastQueue = new Queue("broadcasts", { connection: redis });

const configuredOrigins = (
  process.env.CORS_ALLOWED_ORIGINS ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3000"
).split(",").map(x => x.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || configuredOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS_ORIGIN_DENIED"));
  },
  credentials: true
}));
app.use(express.json({ limit: "512kb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/auth", authLimiter);

type TokenPayload = { sub:string; role:"USER"|"OWNER"|"ADMIN"|"SUPPORT"; email?:string };
type AuthedRequest = Request & { user: TokenPayload };

const asyncRoute = (fn:(req:any,res:Response,next:NextFunction)=>Promise<any>) =>
  (req:Request,res:Response,next:NextFunction) => { Promise.resolve(fn(req,res,next)).catch(next); };

function routeParam(value: string | string[] | undefined): string {
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

function normalizeEmail(value:string) { return value.trim().toLowerCase(); }
function validPublicAddress(chain:Chain,address:string){
  if(chain==="SOLANA"){ try{return bs58.decode(address).length===32}catch{return false} }
  if(["BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)) return /^0x[a-fA-F0-9]{40}$/.test(address);
  return address.length>=20&&address.length<=128;
}
function hashToken(value:string) { return crypto.createHash("sha256").update(value).digest("hex"); }
function randomToken(bytes=32) { return crypto.randomBytes(bytes).toString("base64url"); }
function safeUser(user:any) {
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
function parseCookies(req:Request) {
  const out:Record<string,string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i=part.indexOf("=");
    if(i>0) out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function refreshCookieOptions() {
  return {
    httpOnly:true,
    secure:isProduction,
    sameSite:(isProduction ? "none" : "lax") as "none"|"lax",
    path:"/auth",
    maxAge:refreshDays*24*60*60*1000
  };
}
function signAccess(user:any) {
  return jwt.sign(
    {sub:user.id,role:user.role,email:user.email ?? undefined},
    jwtSecret,
    {expiresIn:accessTtl as any,issuer:"memecloud-api",audience:"memecloud-web"}
  );
}
async function issueSession(req:Request,res:Response,user:any) {
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
  res.cookie("fomo_refresh",refresh,refreshCookieOptions());
  return signAccess(user);
}
function auth(req:Request,res:Response,next:NextFunction) {
  const token=String(req.headers.authorization??"").replace(/^Bearer\s+/i,"");
  try {
    const payload=jwt.verify(token,jwtSecret,{issuer:"memecloud-api",audience:"memecloud-web"}) as TokenPayload;
    void db.user.findUnique({where:{id:payload.sub},select:{email:true,role:true,status:true}}).then(user=>{
      if(!user||user.status!=="ACTIVE") return res.status(401).json({error:"UNAUTHORIZED"});
      (req as AuthedRequest).user={...payload,role:user.role as TokenPayload["role"],email:user.email??payload.email};
      next();
    }).catch(next);
  } catch {
    res.status(401).json({error:"UNAUTHORIZED"});
  }
}
function requireAdmin(req:Request,res:Response,next:NextFunction) {
  auth(req,res,()=>{
    const role=(req as AuthedRequest).user.role;
    if(role!=="OWNER" && role!=="ADMIN" && role!=="SUPPORT") return res.status(403).json({error:"ADMIN_FORBIDDEN"});
    next();
  });
}
function adminOnly(req:Request,res:Response,next:NextFunction) {
  requireAdmin(req,res,()=>{
    if((req as AuthedRequest).user.role!=="OWNER") return res.status(403).json({error:"OWNER_REQUIRED"});
    next();
  });
}
async function audit(userId:string|undefined,actor:string,action:string,target?:string,metadata?:Record<string,unknown>) {
  await db.auditLog.create({data:{userId,actor,action,target,metadata:metadata as any}});
}
async function createEmailToken(userId:string,purpose:string,minutes:number) {
  const token=randomToken(32);
  await db.verificationToken.create({
    data:{userId,purpose,tokenHash:hashToken(token),expiresAt:new Date(Date.now()+minutes*60_000)}
  });
  return token;
}
async function ensureUserDefaults(userId:string) {
  await Promise.all([
    db.globalTradingSettings.upsert({where:{userId},create:{userId},update:{}}),
    db.notificationPreference.upsert({where:{userId},create:{userId},update:{}})
  ]);
}
async function canEnableAutoCopy(userId:string,res:Response) {
  const user=await db.user.findUnique({where:{id:userId},select:{email:true,emailVerifiedAt:true,status:true}});
  if(!user||user.status!=="ACTIVE"){res.status(403).json({error:"ACCOUNT_NOT_ACTIVE"});return false}
  // Wallet-created accounts can proceed without email. Email-created accounts must prove that
  // address before enabling automatic entries. This does not grant live signing permission.
  if(user.email&&!user.emailVerifiedAt){res.status(403).json({error:"EMAIL_VERIFICATION_REQUIRED"});return false}
  return true;
}
function reasonText(reason?:string|null) {
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

app.get("/health", asyncRoute(async (_req,res) => {
  try {
    await db.$runCommandRaw({ping:1});
    const redisStatus=await redis.ping().then(()=>"healthy").catch(()=>"unavailable");
    res.json({ok:true,database:"healthy",redis:redisStatus,executionMode:process.env.EXECUTION_MODE??"simulation"});
  } catch {
    res.status(503).json({ok:false,database:"unavailable",executionMode:process.env.EXECUTION_MODE??"simulation"});
  }
}));

app.get("/v1/public/config", asyncRoute(async (_req,res) => {
  const [socialCfg,chainCfg]=await Promise.all([getConfig<any>("social"),getConfig<any>("chains")]);
  res.json({
    appName:"MemeCloud",
    executionMode:process.env.EXECUTION_MODE??"simulation",
    liveExecutionEnabled:await isLiveTradingEnabled(),
    pushPublicKey:await publicPushKey(),
    supportedChains:chainCfg?.enabled??(process.env.ENABLED_CHAINS??"SOLANA").split(","),
    adapterReadyChains:(process.env.ADAPTER_READY_CHAINS??"BASE,ETHEREUM,BNB,ARBITRUM,AVALANCHE").split(",").filter(Boolean),
    xOAuthConfigured:Boolean(socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID)
  });
}));

// ------------------------ EMAIL/PASSWORD AUTH ------------------------
app.post("/auth/signup", asyncRoute(async (req,res) => {
  const email=normalizeEmail(String(req.body?.email??""));
  const password=String(req.body?.password??"");
  const displayName=String(req.body?.displayName??"").trim().slice(0,80);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({error:"INVALID_EMAIL"});
  if(password.length<8 || password.length>128) return res.status(400).json({error:"PASSWORD_REQUIREMENTS"});
  if(await db.emailIdentity.findUnique({where:{emailNormalized:email}})) return res.status(409).json({error:"EMAIL_ALREADY_REGISTERED"});
  const passwordHash=await bcrypt.hash(password,12);
  const user=await db.user.create({data:{email,passwordHash,displayName:displayName||undefined,emailIdentity:{create:{emailNormalized:email}}}});
  await ensureUserDefaults(user.id);
  const verifyToken=await createEmailToken(user.id,"VERIFY_EMAIL",60*24);
  const appUrl=process.env.NEXT_PUBLIC_APP_URL??configuredOrigins[0]??"";
  let emailDelivery:"SENT"|"NOT_CONFIGURED"|"FAILED"="NOT_CONFIGURED";
  try {
    const verifyUrl=`${appUrl}/verify-email/?token=${encodeURIComponent(verifyToken)}`;
    const {html,text}=renderEmail({
      preheader:"Confirm your email to finish setting up MemeCloud.",
      heading:"Verify your email",
      bodyHtml:`Welcome to MemeCloud. Confirm <b style="color:#e2e4ee">${email}</b> to finish setting up your account.`,
      ctaLabel:"Verify email",ctaUrl:verifyUrl,
      footerNote:"You're receiving this because this email was used to create a MemeCloud account. If that wasn't you, no action is needed — the link expires automatically."
    });
    await sendEmail(email,"Verify your MemeCloud email",html,user.id,text);
    emailDelivery="SENT";
  } catch(e:any) {
    emailDelivery=e?.code==="EMAIL_NOT_CONFIGURED"?"NOT_CONFIGURED":"FAILED";
  }
  const accessToken=await issueSession(req,res,user);
  await audit(user.id,"USER","SIGNUP");
  res.status(201).json({accessToken,user:safeUser(user),emailDelivery});
}));

app.post("/auth/resend-verification", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const user=await db.user.findUnique({where:{id:req.user.sub}});
  if(!user?.email) return res.status(400).json({error:"EMAIL_REQUIRED"});
  if(user.emailVerifiedAt) return res.json({ok:true,alreadyVerified:true});
  const token=await createEmailToken(user.id,"VERIFY_EMAIL",60*24);
  const appUrl=process.env.NEXT_PUBLIC_APP_URL??configuredOrigins[0]??"";
  // Unlike /auth/forgot-password, this route is `auth`-gated — the caller is definitely the real
  // account owner, so there is no account-existence to protect. The frontend needs the REAL
  // outcome (unconfigured vs. genuine send failure vs. actually accepted by the SMTP provider),
  // not a blanket ok:true — see the resendVerification() UI fix in apps/web for why this matters.
  try {
    const verifyUrl=`${appUrl}/verify-email/?token=${encodeURIComponent(token)}`;
    const {html,text}=renderEmail({
      preheader:"Confirm your email to finish setting up MemeCloud.",
      heading:"Verify your email",
      bodyHtml:`Confirm <b style="color:#e2e4ee">${user.email}</b> to finish setting up your MemeCloud account.`,
      ctaLabel:"Verify email",ctaUrl:verifyUrl,
      footerNote:"You're receiving this because this email is on a MemeCloud account. If that wasn't you, no action is needed — the link expires automatically."
    });
    await sendEmail(user.email,"Verify your MemeCloud email",html,user.id,text);
  } catch(e:any) {
    if(e?.code==="EMAIL_NOT_CONFIGURED") return res.status(503).json({error:"EMAIL_NOT_CONFIGURED"});
    return res.status(502).json({error:"EMAIL_SEND_FAILED"});
  }
  res.json({ok:true,sent:true});
}));

app.post("/auth/login", asyncRoute(async (req,res) => {
  const email=normalizeEmail(String(req.body?.email??""));
  const password=String(req.body?.password??"");
  const identity=await db.emailIdentity.findUnique({where:{emailNormalized:email},include:{user:true}});
  const user=identity?.user;
  if(!user?.passwordHash || !(await bcrypt.compare(password,user.passwordHash))) return res.status(401).json({error:"INVALID_CREDENTIALS"});
  if(user.status!=="ACTIVE") return res.status(403).json({error:"ACCOUNT_NOT_ACTIVE"});
  await db.user.update({where:{id:user.id},data:{lastLoginAt:new Date()}});
  await ensureUserDefaults(user.id);
  const accessToken=await issueSession(req,res,user);
  await audit(user.id,"USER","LOGIN");
  res.json({accessToken,user:safeUser(user)});
}));

app.post("/auth/refresh", asyncRoute(async (req,res) => {
  const raw=parseCookies(req).fomo_refresh;
  if(!raw) return res.status(401).json({error:"NO_REFRESH_SESSION"});
  const oldHash=hashToken(raw);
  const session=await db.refreshSession.findUnique({where:{tokenHash:oldHash},include:{user:true}});
  if(!session || session.revokedAt || session.expiresAt<new Date() || session.user.status!=="ACTIVE")
    return res.status(401).json({error:"REFRESH_EXPIRED"});
  // Rotate the opaque refresh token on every use. The conditional update makes an already-used
  // token fail instead of allowing two replaying clients to keep the same long-lived credential.
  const nextRefresh=randomToken(48);
  const rotated=await db.refreshSession.updateMany({
    where:{id:session.id,tokenHash:oldHash,revokedAt:{isSet:false},expiresAt:{gt:new Date()}},
    data:{tokenHash:hashToken(nextRefresh),lastUsedAt:new Date()}
  });
  if(rotated.count!==1) return res.status(401).json({error:"REFRESH_REPLAYED"});
  res.cookie("fomo_refresh",nextRefresh,refreshCookieOptions());
  res.json({accessToken:signAccess(session.user),user:safeUser(session.user)});
}));

app.post("/auth/logout", asyncRoute(async (req,res) => {
  const raw=parseCookies(req).fomo_refresh;
  if(raw) await db.refreshSession.updateMany({where:{tokenHash:hashToken(raw),revokedAt:{isSet:false}},data:{revokedAt:new Date()}});
  res.clearCookie("fomo_refresh",{...refreshCookieOptions(),maxAge:0});
  res.json({ok:true});
}));

app.post("/auth/verify-email", asyncRoute(async (req,res) => {
  const raw=String(req.body?.token??"");
  const row=await db.verificationToken.findUnique({where:{tokenHash:hashToken(raw)}});
  if(!row || row.purpose!=="VERIFY_EMAIL" || row.usedAt || row.expiresAt<new Date())
    return res.status(400).json({error:"INVALID_OR_EXPIRED_TOKEN"});
  await db.$transaction([
    db.verificationToken.update({where:{id:row.id},data:{usedAt:new Date()}}),
    db.user.update({where:{id:row.userId},data:{emailVerifiedAt:new Date()}})
  ]);
  res.json({ok:true});
}));

app.post("/auth/forgot-password", asyncRoute(async (req,res) => {
  const email=normalizeEmail(String(req.body?.email??""));
  const identity=await db.emailIdentity.findUnique({where:{emailNormalized:email},include:{user:true}});
  const user=identity?.user;
  if(user?.email) {
    const token=await createEmailToken(user.id,"RESET_PASSWORD",30);
    const appUrl=process.env.NEXT_PUBLIC_APP_URL??configuredOrigins[0]??"";
    try {
      const resetUrl=`${appUrl}/reset-password/?token=${encodeURIComponent(token)}`;
      const {html,text}=renderEmail({
        preheader:"Reset your MemeCloud password.",
        heading:"Reset your password",
        bodyHtml:`We received a request to reset the password for <b style="color:#e2e4ee">${user.email}</b>. This link expires in 30 minutes.`,
        ctaLabel:"Reset password",ctaUrl:resetUrl,
        footerNote:"If you didn't request a password reset, you can safely ignore this email — your password won't change unless you click the link above and set a new one."
      });
      await sendEmail(user.email,"Reset your MemeCloud password",html,user.id,text);
    } catch {}
  }
  res.json({ok:true}); // never reveal whether an address exists
}));

app.post("/auth/reset-password", asyncRoute(async (req,res) => {
  const raw=String(req.body?.token??"");
  const password=String(req.body?.password??"");
  if(password.length<8 || password.length>128) return res.status(400).json({error:"PASSWORD_REQUIREMENTS"});
  const row=await db.verificationToken.findUnique({where:{tokenHash:hashToken(raw)}});
  if(!row || row.purpose!=="RESET_PASSWORD" || row.usedAt || row.expiresAt<new Date())
    return res.status(400).json({error:"INVALID_OR_EXPIRED_TOKEN"});
  const passwordHash=await bcrypt.hash(password,12);
  await db.$transaction([
    db.verificationToken.update({where:{id:row.id},data:{usedAt:new Date()}}),
    db.user.update({where:{id:row.userId},data:{passwordHash}}),
    db.refreshSession.updateMany({where:{userId:row.userId,revokedAt:{isSet:false}},data:{revokedAt:new Date()}})
  ]);
  res.json({ok:true});
}));

// ------------------------ WALLET AUTH / LINK ------------------------
app.post("/auth/wallet/challenge", asyncRoute(async (req,res) => {
  const chain=String(req.body?.chain??"SOLANA") as Chain;
  const address=String(req.body?.address??"").trim();
  if(chain!=="SOLANA") return res.status(400).json({error:"WALLET_LOGIN_CHAIN_NOT_IMPLEMENTED"});
  if(!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});
  const nonce=randomToken(24);
  const message=`MemeCloud sign-in\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
  const challenge=await db.walletChallenge.create({
    data:{chain:"SOLANA",address,message,expiresAt:new Date(Date.now()+5*60_000),purpose:"LOGIN"}
  });
  res.json({challengeId:challenge.id,message});
}));

app.post("/auth/wallet/verify", asyncRoute(async (req,res) => {
  const challengeId=String(req.body?.challengeId??"");
  const signature=String(req.body?.signature??"");
  const row=await db.walletChallenge.findUnique({where:{id:challengeId}});
  // These are never "you need to authenticate" (401) — this endpoint requires no prior auth at
  // all. Returning 401 here made the shared apiFetch client auto-retry this exact one-time-use
  // signed challenge whenever a stale refresh cookie happened to be present (see apps/web/lib/
  // api.ts), which can only ever fail as "already used" on the retry — masking a real first
  // success. 400/409/410 never trigger that retry path.
  if(!row||row.chain!=="SOLANA"||row.expiresAt<new Date()) return res.status(410).json({error:"CHALLENGE_EXPIRED"});
  if(row.consumedAt) return res.status(409).json({error:"CHALLENGE_ALREADY_USED"});
  let sigBytes:Uint8Array;
  try { sigBytes=signature.startsWith("base64:") ? Buffer.from(signature.slice(7),"base64") : bs58.decode(signature); }
  catch { return res.status(400).json({error:"INVALID_SIGNATURE_ENCODING"}); }
  const ok=nacl.sign.detached.verify(new TextEncoder().encode(row.message),sigBytes,bs58.decode(row.address));
  if(!ok) return res.status(400).json({error:"INVALID_SIGNATURE"});
  // consumedAt is never explicitly written as null — it's simply absent on an unconsumed
  // challenge. Prisma's MongoDB connector treats a bare `null` filter on an optional field as
  // "equals null", which does NOT match a field that was never set — only `isSet:false` does.
  // Using `consumedAt:null` here meant this atomic consume matched zero documents for every
  // challenge, always, regardless of whether it was genuinely already used — confirmed against a
  // real local MongoDB replica set (a fresh, unconsumed, unexpired challenge still got count:0).
  const consumed=await db.walletChallenge.updateMany({where:{id:row.id,consumedAt:{isSet:false},expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
  if(consumed.count!==1) return res.status(409).json({error:"CHALLENGE_ALREADY_USED"});
  let wallet=await db.wallet.findUnique({where:{chain_address:{chain:"SOLANA",address:row.address}}});
  let user;
  if(wallet) user=await db.user.findUnique({where:{id:wallet.userId}});
  else {
    user=await db.user.create({data:{displayName:`Trader ${row.address.slice(0,4)}`,wallets:{create:{chain:"SOLANA",address:row.address,isPrimary:true}}}});
    await ensureUserDefaults(user.id);
  }
  if(!user || user.status!=="ACTIVE") return res.status(403).json({error:"ACCOUNT_NOT_ACTIVE"});
  const accessToken=await issueSession(req,res,user);
  await audit(user.id,"USER","WALLET_LOGIN",row.address);
  res.json({accessToken,user:safeUser(user)});
}));

app.post("/v1/me/wallets/challenge", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA") as Chain;
  const address=String(req.body?.address??"").trim();
  if(chain!=="SOLANA") return res.status(400).json({error:"WALLET_LINK_CHAIN_NOT_IMPLEMENTED"});
  if(!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});
  const existing=await db.wallet.findUnique({where:{chain_address:{chain,address}}});
  if(existing && existing.userId!==req.user.sub) return res.status(409).json({error:"WALLET_ALREADY_LINKED"});
  const message=`MemeCloud link wallet\nAccount: ${req.user.sub}\nWallet: ${address}\nNonce: ${randomToken(24)}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
  const challenge=await db.walletChallenge.create({data:{chain,address,message,purpose:"LINK",userId:req.user.sub,expiresAt:new Date(Date.now()+5*60_000)}});
  res.json({challengeId:challenge.id,message});
}));

app.post("/v1/me/wallets/verify", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const row=await db.walletChallenge.findUnique({where:{id:String(req.body?.challengeId??"")}});
  // Same fix as /auth/wallet/verify: never 401 for a business-logic state (expired/already used/
  // bad signature) — this endpoint is behind `auth`, so a near-expiry access token makes the
  // shared apiFetch client's 401-triggers-refresh-then-retry path even more likely to fire here,
  // silently re-submitting the same one-time-use signed challenge a second time.
  if(!row||row.userId!==req.user.sub||row.purpose!=="LINK"||row.expiresAt<new Date()) return res.status(410).json({error:"CHALLENGE_EXPIRED"});
  if(row.consumedAt) return res.status(409).json({error:"CHALLENGE_ALREADY_USED"});
  const signature=String(req.body?.signature??"");
  let sigBytes:Uint8Array;
  try { sigBytes=signature.startsWith("base64:")?Buffer.from(signature.slice(7),"base64"):bs58.decode(signature); }
  catch { return res.status(400).json({error:"INVALID_SIGNATURE_ENCODING"}); }
  if(!nacl.sign.detached.verify(new TextEncoder().encode(row.message),sigBytes,bs58.decode(row.address)))
    return res.status(400).json({error:"INVALID_SIGNATURE"});
  // consumedAt is never explicitly written as null — it's simply absent on an unconsumed
  // challenge. Prisma's MongoDB connector treats a bare `null` filter on an optional field as
  // "equals null", which does NOT match a field that was never set — only `isSet:false` does.
  // Using `consumedAt:null` here meant this atomic consume matched zero documents for every
  // challenge, always, regardless of whether it was genuinely already used — confirmed against a
  // real local MongoDB replica set (a fresh, unconsumed, unexpired challenge still got count:0).
  const consumed=await db.walletChallenge.updateMany({where:{id:row.id,consumedAt:{isSet:false},expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
  if(consumed.count!==1) return res.status(409).json({error:"CHALLENGE_ALREADY_USED"});
  const count=await db.wallet.count({where:{userId:req.user.sub}});
  const wallet=await db.wallet.upsert({
    where:{chain_address:{chain:row.chain,address:row.address}},
    create:{userId:req.user.sub,chain:row.chain,address:row.address,isPrimary:count===0},
    update:{}
  });
  await audit(req.user.sub,"USER","LINK_WALLET",wallet.id,{chain:wallet.chain});
  res.json({wallet});
}));

// ------------------------ USER ACCOUNT ------------------------
app.get("/v1/me", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const user=await db.user.findUnique({
    where:{id:req.user.sub},
    include:{wallets:true,tradingSettings:true,notificationPrefs:true,linkedSocialAccounts:{select:{provider:true,username:true,displayName:true,avatarUrl:true}}}
  });
  if(!user) return res.status(404).json({error:"USER_NOT_FOUND"});
  res.json({user:{...safeUser(user),wallets:user.wallets,tradingSettings:user.tradingSettings,notificationPrefs:user.notificationPrefs,linkedSocialAccounts:user.linkedSocialAccounts}});
}));

app.patch("/v1/me/profile", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const displayName=String(req.body?.displayName??"").trim().slice(0,80);
  const username=String(req.body?.username??"").trim().toLowerCase();
  const publicProfileEnabled=typeof req.body?.publicProfileEnabled==="boolean"?req.body.publicProfileEnabled:undefined;
  if(username && !/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({error:"INVALID_USERNAME"});
  if(publicProfileEnabled===true && !username) return res.status(400).json({error:"PUBLIC_USERNAME_REQUIRED"});
  if(username){
    const taken=await db.userHandle.findUnique({where:{usernameNormalized:username}});
    if(taken&&taken.userId!==req.user.sub) return res.status(409).json({error:"USERNAME_UNAVAILABLE"});
    await db.$transaction([
      db.user.update({where:{id:req.user.sub},data:{displayName:displayName||undefined,username,publicProfileEnabled}}),
      db.userHandle.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub,usernameNormalized:username},update:{usernameNormalized:username}})
    ]);
  } else {
    await db.$transaction([
      db.user.update({where:{id:req.user.sub},data:{displayName:displayName||undefined,username:null,publicProfileEnabled}}),
      db.userHandle.deleteMany({where:{userId:req.user.sub}})
    ]);
  }
  const user=await db.user.findUniqueOrThrow({where:{id:req.user.sub}});
  res.json({user:safeUser(user)});
}));

app.get("/v1/me/sessions", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const sessions=await db.refreshSession.findMany({
    where:{userId:req.user.sub,revokedAt:{isSet:false},expiresAt:{gt:new Date()}},
    select:{id:true,userAgent:true,ipAddress:true,createdAt:true,lastUsedAt:true,expiresAt:true},
    orderBy:{lastUsedAt:"desc"},take:50
  });
  res.json({sessions});
}));
app.delete("/v1/me/sessions/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.refreshSession.updateMany({where:{id:routeParam(req.params.id),userId:req.user.sub,revokedAt:{isSet:false}},data:{revokedAt:new Date()}});
  await audit(req.user.sub,"USER","REVOKE_SESSION",routeParam(req.params.id));
  res.json({ok:true});
}));
app.delete("/v1/me/wallets/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet) return res.status(404).json({error:"WALLET_NOT_FOUND"});
  if(wallet.tradingEnabled || wallet.permissionRef) return res.status(409).json({error:"REVOKE_TRADING_PERMISSION_FIRST"});
  await db.wallet.delete({where:{id:wallet.id}});
  if(wallet.isPrimary){
    const next=await db.wallet.findFirst({where:{userId:req.user.sub},orderBy:{createdAt:"asc"}});
    if(next) await db.wallet.update({where:{id:next.id},data:{isPrimary:true}});
  }
  await audit(req.user.sub,"USER","UNLINK_WALLET",wallet.id,{chain:wallet.chain});
  res.json({ok:true});
}));

app.post("/v1/me/account/close", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const user=await db.user.findUnique({where:{id:req.user.sub}});
  if(!user) return res.status(404).json({error:"USER_NOT_FOUND"});
  if(user.passwordHash){
    const password=String(req.body?.password??"");
    if(!password || !(await bcrypt.compare(password,user.passwordHash))) return res.status(401).json({error:"INVALID_CREDENTIALS"});
  }else if(String(req.body?.confirmation??"")!=="CLOSE MY ACCOUNT"){
    return res.status(400).json({error:"CLOSE_CONFIRMATION_REQUIRED"});
  }
  await db.$transaction([
    db.globalTradingSettings.updateMany({where:{userId:user.id},data:{autoCopyEnabled:false}}),
    db.userFollow.updateMany({where:{userId:user.id,mode:"AUTO_COPY"},data:{mode:"PAUSED"}}),
    db.refreshSession.updateMany({where:{userId:user.id,revokedAt:{isSet:false}},data:{revokedAt:new Date()}}),
    db.user.update({where:{id:user.id},data:{status:"CLOSED"}})
  ]);
  await audit(user.id,"USER","CLOSE_ACCOUNT");
  res.clearCookie("fomo_refresh",{...refreshCookieOptions(),maxAge:0});
  res.json({ok:true});
}));

app.get("/v1/me/settings", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await ensureUserDefaults(req.user.sub);
  const [trading,notifications]=await Promise.all([
    db.globalTradingSettings.findUnique({where:{userId:req.user.sub}}),
    db.notificationPreference.findUnique({where:{userId:req.user.sub}})
  ]);
  res.json({trading,notifications});
}));

app.patch("/v1/me/settings/trading", auth, asyncRoute(async (req:AuthedRequest,res) => {
  if(req.body?.autoCopyEnabled===true && !(await canEnableAutoCopy(req.user.sub,res))) return;
  const current=await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}});
  const allowedChains=(Array.isArray(req.body?.allowedChains)?req.body.allowedChains:current.allowedChains).filter((x:string)=>["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(x));
  const data={
    autoCopyEnabled:Boolean(req.body?.autoCopyEnabled??current.autoCopyEnabled),
    globalBrainEnabled:Boolean(req.body?.globalBrainEnabled??current.globalBrainEnabled??true),
    sizingMode:String(req.body?.sizingMode??current.sizingMode??"PERCENT")==="FIXED"?"FIXED":"PERCENT",
    percentBalance:Math.max(.01,Math.min(100,Number(req.body?.percentBalance??current.percentBalance??2))),
    defaultAmountUsd:Math.max(1,Number(req.body?.defaultAmountUsd??current.defaultAmountUsd)),
    // Zero means the USER deliberately chose no extra platform cap. MemeCloud does not silently
    // replace the user's risk choice with a smaller hidden limit.
    maxAmountPerTradeUsd:Math.max(0,Number(req.body?.maxAmountPerTradeUsd??current.maxAmountPerTradeUsd??0)),
    maxTotalExposureUsd:Math.max(0,Number(req.body?.maxTotalExposureUsd??current.maxTotalExposureUsd??0)),
    maxConcurrentPositions:Math.max(0,Math.min(10000,Number(req.body?.maxConcurrentPositions??current.maxConcurrentPositions??0))),
    adaptiveChase:Boolean(req.body?.adaptiveChase??current.adaptiveChase),
    capitalRecoveryEnabled:Boolean(req.body?.capitalRecoveryEnabled??current.capitalRecoveryEnabled??true),
    capitalRecoveryMultiple:Math.max(1.01,Math.min(100000,Number(req.body?.capitalRecoveryMultiple??current.capitalRecoveryMultiple??3))),
    freshMemeMode:Boolean(req.body?.freshMemeMode??current.freshMemeMode),
    runnerMode:Boolean(req.body?.runnerMode??current.runnerMode),
    allowedChains:allowedChains as Chain[]
  };
  if(data.maxAmountPerTradeUsd>0 && data.defaultAmountUsd>data.maxAmountPerTradeUsd) return res.status(400).json({error:"DEFAULT_EXCEEDS_MAX_TRADE"});
  const row=await db.globalTradingSettings.update({where:{userId:req.user.sub},data});
  await audit(req.user.sub,"USER","UPDATE_TRADING_SETTINGS",undefined,{autoCopyEnabled:row.autoCopyEnabled});
  res.json({trading:row});
}));

app.patch("/v1/me/settings/notifications", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await ensureUserDefaults(req.user.sub);
  const keys=["pushEnabled","emailEnabled","traderBought","tradeCopied","skippedTrade","profitTaken","positionClosed","securityAlerts","platformBroadcast"] as const;
  const data:any={};
  for(const k of keys) if(typeof req.body?.[k]==="boolean") data[k]=req.body[k];
  const row=await db.notificationPreference.update({where:{userId:req.user.sub},data});
  res.json({notifications:row});
}));

app.get("/v1/me/onboarding", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const [user,recommended,settings]=await Promise.all([
    db.user.findUnique({where:{id:req.user.sub},select:{onboardingCompletedAt:true,wallets:true}}),
    db.trader.findMany({where:{kind:"PLATFORM",enabled:true,recommended:true,wallets:{some:{verified:true,chain:"SOLANA"}}},include:{wallets:{where:{verified:true}},_count:{select:{signals:true}}},take:12}),
    db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}})
  ]);
  res.json({completed:Boolean(user?.onboardingCompletedAt),wallets:user?.wallets??[],recommended,settings});
}));
app.post("/v1/me/onboarding", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const autoCopyEnabled=Boolean(req.body?.autoCopyEnabled);
  if(autoCopyEnabled && !(await canEnableAutoCopy(req.user.sub,res))) return;
  const defaultAmountUsd=Math.max(1,Math.min(100_000,Number(req.body?.defaultAmountUsd??100)));
  const percentBalance=Math.max(.01,Math.min(100,Number(req.body?.percentBalance??2)));
  const selected=Array.isArray(req.body?.traderIds)?req.body.traderIds.map(String).slice(0,50):[];
  const traders=selected.length?await db.trader.findMany({where:{id:{in:selected},kind:"PLATFORM",enabled:true,wallets:{some:{verified:true,chain:"SOLANA"}}},select:{id:true}}):[];
  const settings=await db.globalTradingSettings.upsert({
    where:{userId:req.user.sub},
    create:{userId:req.user.sub,autoCopyEnabled,globalBrainEnabled:true,sizingMode:"PERCENT",percentBalance,defaultAmountUsd,maxAmountPerTradeUsd:0,maxTotalExposureUsd:0,maxConcurrentPositions:0},
    update:{autoCopyEnabled,globalBrainEnabled:true,sizingMode:"PERCENT",percentBalance,defaultAmountUsd}
  });
  for(const t of traders){
    await db.userFollow.upsert({
      where:{userId_traderId:{userId:req.user.sub,traderId:t.id}},
      create:{userId:req.user.sub,traderId:t.id,mode:autoCopyEnabled?"AUTO_COPY":"WATCH_ONLY",fixedAmountUsd:defaultAmountUsd,maxPositionUsd:0,maxTotalExposureUsd:0,maxChasePct:0,minLiquidityUsd:0,stopLossPct:null},
      update:{mode:autoCopyEnabled?"AUTO_COPY":"WATCH_ONLY",fixedAmountUsd:defaultAmountUsd}
    });
  }
  await db.user.update({where:{id:req.user.sub},data:{onboardingCompletedAt:new Date()}});
  await audit(req.user.sub,"USER","COMPLETE_ONBOARDING",undefined,{autoCopyEnabled,traders:traders.length});
  res.json({ok:true});
}));

app.get("/v1/me/performance", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const range=String(req.query.range??"7D").toUpperCase();
  const now=Date.now();
  const since=range==="1D"?new Date(now-24*60*60_000):range==="7D"?new Date(now-7*24*60*60_000):range==="30D"?new Date(now-30*24*60*60_000):undefined;
  const rows=await db.pnLSnapshot.findMany({
    where:{userId:req.user.sub,...(since?{createdAt:{gte:since}}:{})},
    orderBy:{createdAt:"asc"},
    take:range==="ALL"?30_000:10_000
  });
  const maxPoints=240,step=Math.max(1,Math.ceil(rows.length/maxPoints));
  const points=rows.filter((_,i)=>i%step===0||i===rows.length-1);
  const first=rows[0],last=rows[rows.length-1];
  res.json({range,points,pnlChangeUsd:first&&last?last.netPnlUsd-first.netPnlUsd:0,accountValueChangeUsd:first&&last?last.accountValueUsd-first.accountValueUsd:0,truncated:range==="ALL"&&rows.length>=30_000});
}));

app.get("/v1/me/dashboard", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const todayStart=new Date(); todayStart.setHours(0,0,0,0);
  const [allocations,positions,follows,snapshots,settings,dayBaseline]=await Promise.all([
    db.tradingCashAllocation.findMany({where:{userId:req.user.sub},orderBy:{chain:"asc"}}),
    db.position.findMany({where:{userId:req.user.sub},include:{sourceTrader:{select:{id:true,displayName:true,handle:true,avatarUrl:true}},exits:{where:{createdAt:{gte:todayStart}},select:{pnlUsd:true}}},orderBy:{openedAt:"desc"}}),
    db.userFollow.findMany({where:{userId:req.user.sub}}),
    db.pnLSnapshot.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:120}),
    db.globalTradingSettings.findUnique({where:{userId:req.user.sub}}),
    db.pnLSnapshot.findFirst({where:{userId:req.user.sub,createdAt:{lt:todayStart}},orderBy:{createdAt:"desc"}})
  ]);
  const livePositions=positions.filter(p=>p.mode==="LIVE");
  const simulationPositions=positions.filter(p=>p.mode==="SIMULATION");
  const open=livePositions.filter(p=>p.status==="OPEN"||p.status==="PARTIALLY_CLOSED");
  const closed=livePositions.filter(p=>p.status==="CLOSED");
  const simOpen=simulationPositions.filter(p=>p.status==="OPEN"||p.status==="PARTIALLY_CLOSED");
  const available=allocations.reduce((a,x)=>a+x.availableUsd,0);
  const reserved=allocations.reduce((a,x)=>a+x.inTradesUsd,0);
  const realized=livePositions.reduce((a,x)=>a+x.realizedPnlUsd,0);
  const unrealized=open.reduce((a,x)=>a+x.unrealizedPnlUsd,0);
  const currentOpenValue=open.reduce((a,x)=>{
    try{
      const original=BigInt(x.entryTokenRaw),remaining=BigInt(x.remainingTokenRaw);
      const fraction=original>0n?Number((remaining*1_000_000n)/original)/1_000_000:0;
      return a+(x.costUsd*fraction)+x.unrealizedPnlUsd;
    }catch{return a+x.unrealizedPnlUsd}
  },0);
  const wins=closed.filter(x=>x.realizedPnlUsd>0).length;
  const todayRealized=livePositions.reduce((sum,p)=>sum+(p.exits??[]).reduce((a,e)=>a+Number(e.pnlUsd??0),0),0);
  const netPnl=realized+unrealized;
  // Prefer a genuine pre-midnight account snapshot so "Today" is a change over the day, not
  // the account's entire unrealized P&L. On a brand-new account with no baseline, fall back to
  // today's realized P&L plus unrealized P&L only for positions actually opened today.
  const todayPnl=dayBaseline?netPnl-dayBaseline.netPnlUsd:todayRealized+open.filter(p=>p.openedAt>=todayStart).reduce((a,p)=>a+p.unrealizedPnlUsd,0);
  res.json({
    summary:{
      tradingCashUsd:available+reserved,
      availableUsd:available,
      inTradesUsd:reserved,
      accountValueUsd:available+currentOpenValue,
      todayPnlUsd:todayPnl,
      realizedPnlUsd:realized,
      unrealizedPnlUsd:unrealized,
      netPnlUsd:netPnl,
      profitTakenUsd:livePositions.reduce((a,x)=>a+x.profitTakenUsd,0),
      openPositions:open.length,
      copiedTraders:follows.filter(f=>f.mode==="AUTO_COPY").length,
      winRate:closed.length?(wins/closed.length)*100:null
    },
    simulation:{
      openPositions:simOpen.length,
      realizedPnlUsd:simulationPositions.reduce((a,x)=>a+x.realizedPnlUsd,0),
      unrealizedPnlUsd:simOpen.reduce((a,x)=>a+x.unrealizedPnlUsd,0)
    },
    allocations,positions:[...open,...simOpen].slice(0,10),snapshots:snapshots.reverse(),settings,
    executionMode:process.env.EXECUTION_MODE??"simulation"
  });
}));

app.get("/v1/me/positions", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const status=String(req.query.status??"");
  const positions=await db.position.findMany({
    where:{userId:req.user.sub,...(status?{status:status as any}:{})},
    include:{sourceTrader:{select:{id:true,displayName:true,handle:true,avatarUrl:true}},exits:{orderBy:{createdAt:"desc"}}},
    orderBy:{openedAt:"desc"},take:250
  });
  res.json({positions});
}));

const USDC_SOL="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
async function manualTradeTrader(){
  const handle="memecloud-manual-trade";
  const existing=await db.trader.findUnique({where:{handle}});
  if(existing) return existing;
  return db.trader.create({data:{handle,displayName:"Manual trade",bio:"Trades a user places directly from Discover.",category:"MANUAL",verification:"VERIFIED",kind:"PLATFORM",enabled:true,trackingStatus:"TRACKING"}});
}
app.post("/v1/me/trade/manual", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA");
  const mint=String(req.body?.mint??"");
  const amountUsd=Number(req.body?.amountUsd??0);
  if(!mint) return res.status(400).json({error:"MINT_REQUIRED"});
  if(!Number.isFinite(amountUsd)||amountUsd<=0) return res.status(400).json({error:"INVALID_AMOUNT"});
  if(chain!=="SOLANA") return res.status(409).json({error:"EXECUTION_ADAPTER_NOT_CONFIGURED",message:"Manual buying only has a verified route on Solana right now."});
  const allocation=await db.tradingCashAllocation.findFirst({where:{userId:req.user.sub,chain:"SOLANA"}});
  const available=allocation?.availableUsd??0;
  if(amountUsd>available) return res.status(400).json({error:"INSUFFICIENT_BALANCE",message:`Only $${available.toFixed(2)} is available on Solana.`});
  const marketCfg=await getConfig<any>("marketData");
  const rpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
  if(!rpc) return res.status(409).json({error:"SOLANA_RPC_REQUIRED",message:"No Solana RPC is configured yet."});
  const execCfg=await getConfig<any>("execution");
  const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  const amountRaw=String(Math.round(amountUsd*1_000_000));
  try{
    const quote=await jupiter.quote({inputMint:USDC_SOL,outputMint:mint,amountRaw,slippageBps:300});
    const conn=new Connection(rpc,"confirmed");
    const supply=await conn.getTokenSupply(new PublicKey(mint),"confirmed");
    const decimals=supply.value.decimals;
    const tokenAmount=Number(BigInt(quote.outAmount))/(10**decimals);
    if(!Number.isFinite(tokenAmount)||tokenAmount<=0) throw Object.assign(new Error("A genuine executable quote could not be verified."),{code:"INVALID_EXECUTABLE_QUOTE"});
    const executablePriceUsd=amountUsd/tokenAmount;
    const reverse=await jupiter.quote({inputMint:mint,outputMint:USDC_SOL,amountRaw:quote.outAmount,slippageBps:300}).catch(()=>null);
    if(!reverse) return res.status(409).json({error:"NO_EXECUTABLE_SELL_ROUTE",message:"MemeCloud could not verify a route back to USDC for this token, so no buy was placed."});
    const trader=await manualTradeTrader();
    const now=new Date();
    const key=`manual:${req.user.sub}:${mint}:${now.getTime()}`;
    const signal=await db.signal.create({data:{idempotencyKey:key,chain:"SOLANA",traderId:trader.id,sourceWallet:"MANUAL_USER_TRADE",sourceTx:key,action:"BUY",inputMint:USDC_SOL,outputMint:mint,inputRaw:amountRaw,outputRaw:quote.outAmount,sourcePriceUsd:executablePriceUsd,sourcePriceMethod:"MANUAL_EXECUTABLE_QUOTE",observedAt:now,status:"COMPLETED"}});
    const decision=await db.copyDecision.create({data:{signalId:signal.id,userId:req.user.sub,allowed:true,action:"BUY",amountUsd,sourcePriceUsd:executablePriceUsd,executablePriceUsd,walletChasePct:0,explanation:"User-initiated manual buy from Discover."}});
    const [order,position]=await db.$transaction([
      db.order.create({data:{idempotencyKey:key,decisionId:decision.id,userId:req.user.sub,chain:"SOLANA",mode:"SIMULATION",side:"BUY",inputMint:USDC_SOL,outputMint:mint,requestedInputRaw:amountRaw,expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"CONFIRMED",confirmedAt:now,venue:"JUPITER_QUOTE",quoteJson:{simulation:true,realQuote:true,manual:true,priceImpactPct:quote.priceImpactPct} as any}}),
      db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"SIMULATION",mint,quoteMint:USDC_SOL,entryInputRaw:amountRaw,entryTokenRaw:quote.outAmount,remainingTokenRaw:quote.outAmount,costUsd:amountUsd,avgEntryPriceUsd:executablePriceUsd,currentPriceUsd:executablePriceUsd,peakPriceUsd:executablePriceUsd,takeProfitPct:200,status:"OPEN",lastMarkedAt:now}})
    ]);
    await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual buy placed",body:`$${amountUsd.toFixed(2)} simulation buy from a real executable quote. No live funds moved.`,data:{orderId:order.id,positionId:position.id,mint} as any}});
    await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd,mode:"SIMULATION"});
    res.status(201).json({ok:true,order,position});
  }catch(e:any){
    res.status(409).json({error:e?.code||"QUOTE_UNAVAILABLE",message:e?.message||"A genuine executable quote could not be verified, so MemeCloud did not fabricate a fill."});
  }
}));
app.get("/v1/me/trades", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const orders=await db.order.findMany({
    where:{userId:req.user.sub},
    include:{decision:{include:{signal:{include:{trader:{select:{id:true,displayName:true,handle:true}}}}}}},
    orderBy:{createdAt:"desc"},take:250
  });
  res.json({orders});
}));

app.get("/v1/me/activity", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const [events,decisions]=await Promise.all([
    db.userActivityEvent.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:100}),
    db.copyDecision.findMany({where:{userId:req.user.sub},include:{signal:{include:{trader:true}},orders:true},orderBy:{createdAt:"desc"},take:50})
  ]);
  res.json({
    events,
    decisions:decisions.map(d=>({...d,plainReason:reasonText(d.reason)}))
  });
}));

app.get("/v1/me/notifications", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const notifications=await db.notification.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:100});
  res.json({notifications});
}));

app.post("/v1/me/notifications/read", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String):[];
  await db.notification.updateMany({where:{userId:req.user.sub,...(ids.length?{id:{in:ids}}:{readAt:{isSet:false}})},data:{readAt:new Date()}});
  res.json({ok:true});
}));

app.post("/v1/me/pause", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub,autoCopyEnabled:false},update:{autoCopyEnabled:false}});
  await audit(req.user.sub,"USER","PAUSE_ALL_TRADING");
  res.json({ok:true});
}));
app.post("/v1/me/resume", auth, asyncRoute(async (req:AuthedRequest,res) => {
  if(!(await canEnableAutoCopy(req.user.sub,res))) return;
  await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub,autoCopyEnabled:true},update:{autoCopyEnabled:true}});
  await audit(req.user.sub,"USER","RESUME_AUTO_COPY");
  res.json({ok:true});
}));

// ------------------------ DELEGATED TRADING PERMISSION ------------------------
app.post("/v1/me/wallets/:id/enable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  if(wallet.chain!=="SOLANA")return res.status(400).json({error:"AUTOMATION_CHAIN_NOT_IMPLEMENTED"});
  const privyWalletId=String(req.body?.privyWalletId??"").trim();
  if(!privyWalletId)return res.status(400).json({error:"PRIVY_WALLET_ID_REQUIRED"});
  const cfg=await getConfig<any>("signer");
  const appId=cfg?.privyAppId||process.env.PRIVY_APP_ID,appSecret=cfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const authKey=cfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const expectedSigner=cfg?.privySignerId||process.env.PRIVY_SIGNER_ID;
  const expectedPolicy=cfg?.privyPolicyId||process.env.PRIVY_POLICY_ID;
  if(!appId||!appSecret||!authKey||!expectedSigner||!expectedPolicy)return res.status(503).json({error:"DELEGATED_SIGNER_NOT_CONFIGURED"});
  const provider=new PrivySolanaSigner({appId,appSecret,authorizationPrivateKey:authKey,sponsorGas:Boolean(cfg?.sponsorGas)});
  const remote:any=await provider.getWallet(privyWalletId);
  if(String(remote?.chain_type??"").toLowerCase()!=="solana"||String(remote?.address??"")!==wallet.address)return res.status(400).json({error:"PRIVY_WALLET_ADDRESS_MISMATCH"});
  const signers=Array.isArray(remote?.additional_signers)?remote.additional_signers:[];
  const signer=signers.find((x:any)=>String(x?.signer_id??x?.id??"")===expectedSigner);
  const policies=[...(Array.isArray(remote?.policy_ids)?remote.policy_ids:[]),...(Array.isArray(signer?.override_policy_ids)?signer.override_policy_ids:[])].map(String);
  if(!signer)return res.status(400).json({error:"RESTRICTED_SIGNER_NOT_GRANTED_BY_USER"});
  if(!policies.includes(String(expectedPolicy)))return res.status(400).json({error:"REQUIRED_TRADING_POLICY_NOT_GRANTED"});
  const expiryRaw=req.body?.permissionExpiry;const expiry=expiryRaw?new Date(String(expiryRaw)):new Date(Date.now()+30*24*60*60_000);
  if(!Number.isFinite(expiry.getTime())||expiry<=new Date())return res.status(400).json({error:"INVALID_PERMISSION_EXPIRY"});
  const updated=await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry}});
  await audit(req.user.sub,"USER","ENABLE_DELEGATED_TRADING",wallet.id,{provider:"PRIVY",permissionExpiry:expiry.toISOString(),policyId:expectedPolicy});
  res.json({wallet:{id:updated.id,chain:updated.chain,address:updated.address,tradingEnabled:true,permissionExpiry:updated.permissionExpiry}});
}));
app.post("/v1/me/wallets/:id/disable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:false,permissionRef:null,permissionExpiry:null}});
  await db.globalTradingSettings.updateMany({where:{userId:req.user.sub},data:{autoCopyEnabled:false}});
  await audit(req.user.sub,"USER","REVOKE_DELEGATED_TRADING",wallet.id);res.json({ok:true});
}));

// ------------------------ TRADERS ------------------------
app.get("/v1/traders", asyncRoute(async (_req,res) => {
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM",enabled:true,trackingStatus:{not:"PAPER_TRACKING"}},
    include:{wallets:{where:{verified:true}},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"desc"}],take:200
  });
  res.json({traders});
}));

app.get("/v1/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:routeParam(req.params.id)}}});
  const trader=await db.trader.findFirst({
    where:{id:routeParam(req.params.id),OR:[{kind:"PLATFORM",enabled:true,trackingStatus:{not:"PAPER_TRACKING"}},{ownerUserId:req.user.sub},{id:follow?.traderId??"000000000000000000000000"}]},
    include:{wallets:true,_count:{select:{follows:true,signals:true}},signals:{orderBy:{observedAt:"desc"},take:25}}
  });
  if(!trader) return res.status(404).json({error:"TRADER_NOT_FOUND"});
  const safeTrader=trader.kind==="CUSTOM"&&follow?{...trader,displayName:follow.customLabel||trader.displayName,xHandle:follow.customXHandle||undefined}:trader;
  res.json({trader:safeTrader,follow});
}));

app.get("/v1/me/traders", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const follows=await db.userFollow.findMany({
    where:{userId:req.user.sub},
    include:{trader:{include:{wallets:true,_count:{select:{signals:true,follows:true}}}}},
    orderBy:{updatedAt:"desc"}
  });
  const personal=follows.map(f=>({
    ...f,
    trader:f.trader.kind==="CUSTOM"?{...f.trader,displayName:f.customLabel||f.trader.displayName,xHandle:f.customXHandle||undefined}:f.trader
  }));
  res.json({follows:personal});
}));

app.put("/v1/me/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const existing=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:routeParam(req.params.id)}}});
  const trader=await db.trader.findFirst({where:{id:routeParam(req.params.id),OR:[{kind:"PLATFORM",enabled:true,trackingStatus:{not:"PAPER_TRACKING"}},{ownerUserId:req.user.sub},{id:existing?.traderId??"000000000000000000000000"}]},include:{wallets:true}});
  if(!trader) return res.status(404).json({error:"TRADER_NOT_FOUND"});
  const mode=String(req.body?.mode??existing?.mode??"FOLLOW_ONLY") as FollowMode;
  if(!["FOLLOW_ONLY","WATCH_ONLY","AUTO_COPY","PAUSED"].includes(mode)) return res.status(400).json({error:"INVALID_FOLLOW_MODE"});
  if(mode==="AUTO_COPY" && !(await canEnableAutoCopy(req.user.sub,res))) return;
  const hasImplementedSourceWallet=trader.wallets.some(w=>w.verified&&w.chain==="SOLANA");
  if((mode==="AUTO_COPY"||mode==="WATCH_ONLY") && !hasImplementedSourceWallet){
    if(!trader.wallets.some(w=>w.verified)) return res.status(409).json({error:"SOURCE_WALLET_REQUIRED"});
    return res.status(409).json({error:"CHAIN_LISTENER_NOT_IMPLEMENTED"});
  }
  const defaults=await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}});
  const requestedFixed=Math.max(1,Number(req.body?.fixedAmountUsd??existing?.fixedAmountUsd??defaults.defaultAmountUsd));
  const fixedAmountUsd=defaults.maxAmountPerTradeUsd>0?Math.min(defaults.maxAmountPerTradeUsd,requestedFixed):requestedFixed;
  const data={
    mode,
    fixedAmountUsd,
    takeProfitPct:Number(req.body?.takeProfitPct??existing?.takeProfitPct??100),
    stopLossPct:req.body?.stopLossPct===null?null:(req.body?.stopLossPct===undefined?(existing?.stopLossPct??null):Number(req.body.stopLossPct)),
    maxChasePct:Math.max(0,Number(req.body?.maxChasePct??existing?.maxChasePct??0)),
    maxSlippageBps:Math.max(1,Math.min(10000,Number(req.body?.maxSlippageBps??existing?.maxSlippageBps??1500))),
    maxPositionUsd:Math.max(0,Number(req.body?.maxPositionUsd??existing?.maxPositionUsd??0)),
    maxTotalExposureUsd:Math.max(0,Number(req.body?.maxTotalExposureUsd??existing?.maxTotalExposureUsd??0)),
    minLiquidityUsd:Math.max(0,Number(req.body?.minLiquidityUsd??existing?.minLiquidityUsd??0)),
    exitMode:String(req.body?.exitMode??existing?.exitMode??"ADAPTIVE"),
    copyAdditionalBuys:Boolean(req.body?.copyAdditionalBuys??existing?.copyAdditionalBuys??true),
    copyReentries:Boolean(req.body?.copyReentries??existing?.copyReentries??true)
  };
  const follow=await db.userFollow.upsert({
    where:{userId_traderId:{userId:req.user.sub,traderId:trader.id}},
    create:{userId:req.user.sub,traderId:trader.id,...data},
    update:data
  });
  await audit(req.user.sub,"USER","UPDATE_TRADER_FOLLOW",trader.id,{mode});
  res.json({follow});
}));

app.delete("/v1/me/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const trader=await db.trader.findUnique({where:{id:routeParam(req.params.id)},select:{id:true,kind:true,ownerUserId:true}});
  await db.userFollow.deleteMany({where:{userId:req.user.sub,traderId:routeParam(req.params.id)}});
  if(trader?.kind==="CUSTOM"&&trader.ownerUserId===req.user.sub){
    const stillUsed=await db.userFollow.count({where:{traderId:trader.id}});
    if(stillUsed===0) await db.trader.delete({where:{id:trader.id}});
  }
  await audit(req.user.sub,"USER","UNFOLLOW_TRADER",routeParam(req.params.id));
  res.json({ok:true});
}));

app.post("/v1/me/traders/custom", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA") as Chain;
  if(!["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)) return res.status(400).json({error:"UNSUPPORTED_CHAIN"});
  const address=String(req.body?.address??"").trim();
  const displayName=String(req.body?.displayName??"Custom trader").trim().slice(0,80);
  const xHandle=String(req.body?.xHandle??"").trim().replace(/^@/,"").slice(0,50)||undefined;
  if(!address && !xHandle) return res.status(400).json({error:"WALLET_OR_X_REQUIRED"});
  if(address && !validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});

  let trader:any;
  if(address){
    const existingWallet=await db.traderWallet.findUnique({where:{chain_address:{chain,address}},include:{trader:true}});
    trader=existingWallet?.trader;
    if(!trader){
      const handle=`custom-${chain.toLowerCase()}-${crypto.createHash("sha1").update(address).digest("hex").slice(0,16)}`;
      const genericName=`Custom ${chain} wallet ${address.slice(0,4)}…${address.slice(-4)}`;
      trader=await db.trader.create({data:{handle,displayName:genericName,kind:"CUSTOM",trackingStatus:chain==="SOLANA"?"TRACKING":"ADAPTER_READY",wallets:{create:{chain,address,verified:true,source:"USER_PUBLIC_WALLET"}}}});
    }
  }else{
    const handle=`favorite-${req.user.sub.slice(-6)}-${crypto.createHash("sha1").update(xHandle!).digest("hex").slice(0,12)}`;
    trader=await db.trader.upsert({
      where:{handle},
      create:{handle,displayName,kind:"CUSTOM",ownerUserId:req.user.sub,xHandle,trackingStatus:"NEEDS_WALLET"},
      update:{displayName,xHandle}
    });
  }
  const defaults=await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}});
  const follow=await db.userFollow.upsert({
    where:{userId_traderId:{userId:req.user.sub,traderId:trader.id}},
    create:{userId:req.user.sub,traderId:trader.id,mode:address&&chain==="SOLANA"?"WATCH_ONLY":"FOLLOW_ONLY",customLabel:displayName,customXHandle:xHandle,fixedAmountUsd:defaults.defaultAmountUsd,maxPositionUsd:defaults.maxAmountPerTradeUsd,maxTotalExposureUsd:defaults.maxTotalExposureUsd},
    update:{customLabel:displayName,customXHandle:xHandle}
  });
  await audit(req.user.sub,"USER",address?"ADD_CUSTOM_TRADER":"ADD_X_FAVORITE",trader.id,{chain,address:address||undefined,xHandle});
  res.status(201).json({trader:{...trader,displayName,xHandle},follow,trackingReady:Boolean(address&&chain==="SOLANA"),message:address&&chain!=="SOLANA"?"Wallet saved. This chain is adapter-ready but its live source listener is not implemented yet.":undefined});
}));

app.post("/v1/me/traders/:id/wallet", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:routeParam(req.params.id)}}});
  const pending=await db.trader.findFirst({where:{id:routeParam(req.params.id),kind:"CUSTOM",ownerUserId:req.user.sub},include:{wallets:true}});
  if(!follow||!pending) return res.status(404).json({error:"PERSONAL_TRADER_NOT_FOUND"});
  if(pending.wallets.length) return res.status(409).json({error:"TRADER_WALLET_ALREADY_SET"});
  const chain=String(req.body?.chain??"SOLANA") as Chain,address=String(req.body?.address??"").trim();
  if(!["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)||!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});
  const existing=await db.traderWallet.findUnique({where:{chain_address:{chain,address}},include:{trader:true}});
  if(existing){
    await db.userFollow.upsert({
      where:{userId_traderId:{userId:req.user.sub,traderId:existing.traderId}},
      create:{userId:req.user.sub,traderId:existing.traderId,mode:"WATCH_ONLY",fixedAmountUsd:follow.fixedAmountUsd,takeProfitPct:follow.takeProfitPct,stopLossPct:follow.stopLossPct,maxChasePct:follow.maxChasePct,maxSlippageBps:follow.maxSlippageBps,maxPositionUsd:follow.maxPositionUsd,maxTotalExposureUsd:follow.maxTotalExposureUsd,minLiquidityUsd:follow.minLiquidityUsd,exitMode:follow.exitMode,copyAdditionalBuys:follow.copyAdditionalBuys,copyReentries:follow.copyReentries,customLabel:follow.customLabel,customXHandle:follow.customXHandle},
      update:{customLabel:follow.customLabel,customXHandle:follow.customXHandle}
    });
    await db.userFollow.delete({where:{id:follow.id}});
    await db.trader.delete({where:{id:pending.id}});
    await audit(req.user.sub,"USER","MAP_FAVORITE_TO_TRACKED_WALLET",existing.traderId,{chain,address});
    return res.json({ok:true,traderId:existing.traderId,reused:true,trackingReady:existing.chain==="SOLANA",message:existing.chain==="SOLANA"?"Wallet matched an existing tracked source. Tracking is ready.":"Wallet matched an existing source, but this chain's listener is adapter-ready only."});
  }
  await db.traderWallet.create({data:{traderId:pending.id,chain,address,verified:true,source:"USER_PUBLIC_WALLET"}});
  await db.trader.update({where:{id:pending.id},data:{trackingStatus:chain==="SOLANA"?"TRACKING":"ADAPTER_READY"}});
  await db.userFollow.update({where:{id:follow.id},data:{mode:chain==="SOLANA"?"WATCH_ONLY":"FOLLOW_ONLY"}});
  await audit(req.user.sub,"USER","ADD_FAVORITE_TRADER_WALLET",pending.id,{chain,address});
  res.json({ok:true,traderId:pending.id,reused:false,trackingReady:chain==="SOLANA",message:chain==="SOLANA"?"Wallet mapped. Source tracking is ready.":"Wallet mapped, but this chain's source listener is adapter-ready only."});
}));

// ------------------------ COMMUNITY FOLLOWING ------------------------
app.get("/v1/social/users", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const q=String(req.query.q??"").trim().slice(0,80);
  const users=await db.user.findMany({
    where:{id:{not:req.user.sub},status:"ACTIVE",publicProfileEnabled:true,username:{not:null},...(q?{OR:[{username:{contains:q.toLowerCase()}},{displayName:{contains:q}}]}:{})},
    select:{id:true,username:true,displayName:true,avatarUrl:true,_count:{select:{followers:true,following:true}}},
    take:30,orderBy:{createdAt:"desc"}
  });
  const following=await db.userSocialFollow.findMany({where:{followerId:req.user.sub,followingId:{in:users.map(u=>u.id)}}});
  const set=new Set(following.map(x=>x.followingId));
  res.json({users:users.map(u=>({...u,isFollowing:set.has(u.id)}))});
}));
app.get("/v1/me/social/following", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const rows=await db.userSocialFollow.findMany({where:{followerId:req.user.sub},include:{following:{select:{id:true,username:true,displayName:true,avatarUrl:true,publicProfileEnabled:true}}},orderBy:{createdAt:"desc"},take:100});
  res.json({following:rows.map(r=>r.following).filter(u=>u.publicProfileEnabled)});
}));
app.post("/v1/social/users/:id/follow", auth, asyncRoute(async (req:AuthedRequest,res) => {
  if(routeParam(req.params.id)===req.user.sub) return res.status(400).json({error:"CANNOT_FOLLOW_SELF"});
  const target=await db.user.findFirst({where:{id:routeParam(req.params.id),status:"ACTIVE",publicProfileEnabled:true},select:{id:true}});
  if(!target) return res.status(404).json({error:"PUBLIC_PROFILE_NOT_FOUND"});
  await db.userSocialFollow.upsert({where:{followerId_followingId:{followerId:req.user.sub,followingId:target.id}},create:{followerId:req.user.sub,followingId:target.id},update:{}});
  res.json({ok:true});
}));
app.delete("/v1/social/users/:id/follow", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.userSocialFollow.deleteMany({where:{followerId:req.user.sub,followingId:routeParam(req.params.id)}});
  res.json({ok:true});
}));

// ------------------------ PUSH ------------------------
app.post("/v1/push/subscribe", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const sub=req.body;
  if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth) return res.status(400).json({error:"INVALID_PUSH_SUBSCRIPTION"});
  await db.pushSubscription.upsert({
    where:{endpoint:String(sub.endpoint)},
    create:{userId:req.user.sub,endpoint:String(sub.endpoint),p256dh:String(sub.keys.p256dh),auth:String(sub.keys.auth),userAgent:String(req.headers["user-agent"]??"")},
    update:{userId:req.user.sub,p256dh:String(sub.keys.p256dh),auth:String(sub.keys.auth),userAgent:String(req.headers["user-agent"]??"")}
  });
  res.json({ok:true});
}));
app.delete("/v1/push/subscribe", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.pushSubscription.deleteMany({where:{userId:req.user.sub,endpoint:String(req.body?.endpoint??"")}});
  res.json({ok:true});
}));

// ------------------------ X OAUTH ------------------------
app.get("/v1/me/social/x/start", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const socialCfg=await getConfig<any>("social");
  const clientId=socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID;
  const callback=socialCfg?.xOAuthCallbackUrl||process.env.X_OAUTH_CALLBACK_URL;
  if(!clientId||!callback) return res.status(503).json({error:"X_OAUTH_NOT_CONFIGURED"});
  const state=randomToken(24), verifier=randomToken(48);
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  await db.oAuthState.create({
    data:{userId:req.user.sub,provider:"X",stateHash:hashToken(state),verifierEnc:encryptJson({verifier}),expiresAt:new Date(Date.now()+10*60_000)}
  });
  const u=new URL("https://twitter.com/i/oauth2/authorize");
  u.searchParams.set("response_type","code"); u.searchParams.set("client_id",clientId);
  u.searchParams.set("redirect_uri",callback); u.searchParams.set("scope","users.read tweet.read offline.access");
  u.searchParams.set("state",state); u.searchParams.set("code_challenge",challenge); u.searchParams.set("code_challenge_method","S256");
  res.json({url:u.toString()});
}));

app.get("/auth/x/callback", asyncRoute(async (req,res) => {
  const state=String(req.query.state??""), code=String(req.query.code??"");
  const row=await db.oAuthState.findUnique({where:{stateHash:hashToken(state)}});
  if(!row||row.provider!=="X"||row.expiresAt<new Date()) return res.status(400).send("X authorization expired.");
  const {verifier}=decryptJson<{verifier:string}>(row.verifierEnc);
  const socialCfg=await getConfig<any>("social");
  const clientId=socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID, callback=socialCfg?.xOAuthCallbackUrl||process.env.X_OAUTH_CALLBACK_URL;
  const clientSecret=socialCfg?.xOAuthClientSecret||process.env.X_OAUTH_CLIENT_SECRET;
  if(!clientId||!callback) return res.status(503).send("X OAuth is not configured.");
  const body=new URLSearchParams({code,grant_type:"authorization_code",redirect_uri:callback,code_verifier:verifier,client_id:clientId});
  const headers:Record<string,string>={"content-type":"application/x-www-form-urlencoded"};
  if(clientSecret) headers.authorization=`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const tokenRes=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers,body,signal:AbortSignal.timeout(8000)});
  if(!tokenRes.ok) return res.status(502).send("X token exchange failed.");
  const tokens:any=await tokenRes.json();
  const meRes=await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,name,username",{headers:{authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(8000)});
  if(!meRes.ok) return res.status(502).send("X profile lookup failed.");
  const me:any=await meRes.json();
  await db.linkedSocialAccount.upsert({
    where:{userId_provider:{userId:row.userId,provider:"X"}},
    create:{
      userId:row.userId,provider:"X",providerUserId:String(me.data.id),username:me.data.username,displayName:me.data.name,avatarUrl:me.data.profile_image_url,
      accessTokenEnc:encryptJson({token:tokens.access_token}),refreshTokenEnc:tokens.refresh_token?encryptJson({token:tokens.refresh_token}):null,
      expiresAt:tokens.expires_in?new Date(Date.now()+Number(tokens.expires_in)*1000):null
    },
    update:{
      providerUserId:String(me.data.id),username:me.data.username,displayName:me.data.name,avatarUrl:me.data.profile_image_url,
      accessTokenEnc:encryptJson({token:tokens.access_token}),refreshTokenEnc:tokens.refresh_token?encryptJson({token:tokens.refresh_token}):undefined,
      expiresAt:tokens.expires_in?new Date(Date.now()+Number(tokens.expires_in)*1000):null
    }
  });
  await db.oAuthState.delete({where:{id:row.id}});
  const appUrl=process.env.NEXT_PUBLIC_APP_URL??configuredOrigins[0]??"/";
  res.redirect(`${appUrl}/app/?view=profile&x=connected`);
}));

// ------------------------ ADMIN AUTH / OPERATIONS ------------------------
app.post("/v1/admin/bootstrap", asyncRoute(async (req,res) => {
  const expected=process.env.ADMIN_BOOTSTRAP_SECRET??"";
  if(!expected||String(req.headers["x-bootstrap-secret"]??"")!==expected) return res.status(403).json({error:"BOOTSTRAP_FORBIDDEN"});
  if(await db.user.count({where:{role:{in:["OWNER","ADMIN"]}}})>0) return res.status(409).json({error:"ADMIN_ALREADY_EXISTS"});
  const email=normalizeEmail(String(req.body?.email??""));
  const password=String(req.body?.password??"");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({error:"INVALID_EMAIL"});
  if(await db.emailIdentity.findUnique({where:{emailNormalized:email}})) return res.status(409).json({error:"EMAIL_ALREADY_REGISTERED"});
  if(password.length<12) return res.status(400).json({error:"ADMIN_PASSWORD_TOO_SHORT"});
  const passwordHash=await bcrypt.hash(password,12);
  const user=await db.user.create({data:{email,passwordHash,displayName:"Administrator",role:"OWNER",emailVerifiedAt:new Date(),emailIdentity:{create:{emailNormalized:email}}}});
  await ensureUserDefaults(user.id);
  await audit(user.id,"SYSTEM","BOOTSTRAP_OWNER");
  res.status(201).json({ok:true,admin:safeUser(user)});
}));

app.get("/v1/admin/overview", requireAdmin, asyncRoute(async (_req:AuthedRequest,res) => {
  const nowDate=new Date(), today=new Date(Date.UTC(nowDate.getUTCFullYear(),nowDate.getUTCMonth(),nowDate.getUTCDate())), week=new Date(today.getTime()-6*24*60*60_000);
  const [registeredUsers,activeUsers,newToday,newWeek,verifiedUsers,walletUsers,autoCopyUsers,platformTraders,openPositions,ordersToday,buyOrders,sellOrders,liveOrders,simulationOrders,livePnl,cash,candidates,paperCandidates,provenCandidates,rejectedCandidates,averageCopyability,discoveryTokens,newTokensToday,signals,signalsToday,buyDecisions,waitDecisions,skipDecisions,broadcasts,heartbeats]=await Promise.all([
    db.user.count(),
    db.user.count({where:{role:"USER",status:"ACTIVE"}}),
    db.user.count({where:{createdAt:{gte:today}}}),
    db.user.count({where:{createdAt:{gte:week}}}),
    db.user.count({where:{emailVerifiedAt:{not:null}}}),
    db.user.count({where:{wallets:{some:{}}}}),
    db.user.count({where:{tradingSettings:{is:{autoCopyEnabled:true}}}}),
    db.trader.count({where:{kind:"PLATFORM"}}),
    db.position.count({where:{status:{in:["OPEN","PARTIALLY_CLOSED"]}}}),
    db.order.count({where:{createdAt:{gte:today}}}),
    db.order.count({where:{createdAt:{gte:today},side:"BUY"}}),
    db.order.count({where:{createdAt:{gte:today},side:"SELL"}}),
    db.order.count({where:{mode:"LIVE"}}),
    db.order.count({where:{mode:"SIMULATION"}}),
    db.position.aggregate({where:{mode:"LIVE"},_sum:{realizedPnlUsd:true,unrealizedPnlUsd:true}}),
    db.tradingCashAllocation.aggregate({_sum:{availableUsd:true,inTradesUsd:true}}),
    db.smartWalletCandidate.count(),
    db.smartWalletCandidate.count({where:{stage:"PAPER_TRACKING"}}),
    db.smartWalletCandidate.count({where:{stage:"PROVEN"}}),
    db.smartWalletCandidate.count({where:{stage:"REJECTED"}}),
    db.smartWalletCandidate.aggregate({_avg:{copyabilityScore:true}}),
    db.discoveryToken.count(),
    db.discoveryToken.count({where:{discoveredAt:{gte:today}}}),
    db.signal.count(),
    db.signal.count({where:{observedAt:{gte:today}}}),
    db.copyDecision.count({where:{createdAt:{gte:today},action:"BUY"}}),
    db.copyDecision.count({where:{createdAt:{gte:today},action:"WAIT"}}),
    db.copyDecision.count({where:{createdAt:{gte:today},action:"SKIP"}}),
    db.broadcast.findMany({orderBy:{createdAt:"desc"},take:10}),
    db.workerHeartbeat.findMany({orderBy:{name:"asc"}})
  ]);
  const now=Date.now();
  res.json({
    metrics:{
      users:{registered:registeredUsers,active:activeUsers,newToday,newWeek,verified:verifiedUsers,walletConnected:walletUsers,autoCopyEnabled:autoCopyUsers},
      trading:{openPositions,ordersToday,buysToday:buyOrders,sellsToday:sellOrders,liveOrders,simulationOrders,realizedPnlUsd:livePnl._sum.realizedPnlUsd,unrealizedPnlUsd:livePnl._sum.unrealizedPnlUsd,allocatedCashUsd:(cash._sum.availableUsd??0)+(cash._sum.inTradesUsd??0)},
      smartTraders:{platform:platformTraders,candidates,paperTracked:paperCandidates,proven:provenCandidates,rejected:rejectedCandidates,averageCopyability:averageCopyability._avg.copyabilityScore},
      discovery:{watchedTokens:discoveryTokens,opportunitiesToday:newTokensToday},
      engine:{signals,signalsToday,buyDecisions,waitDecisions,skipDecisions}
    },
    executionMode:process.env.EXECUTION_MODE??"simulation",
    liveExecutionEnabled:await isLiveTradingEnabled(),
    broadcasts,
    health:heartbeats.map(h=>({...h,healthy:now-h.lastBeatAt.getTime()<45_000}))
  });
}));

app.get("/v1/admin/users", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const users=await db.user.findMany({
    where:{role:"USER"},
    select:{
      id:true,email:true,emailVerifiedAt:true,displayName:true,username:true,status:true,createdAt:true,lastLoginAt:true,
      tradingSettings:true,_count:{select:{wallets:true,positions:true,follows:true}}
    },
    orderBy:{createdAt:"desc"},take:500
  });
  res.json({users});
}));
app.get("/v1/admin/users/:id", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const user=await db.user.findFirst({
    where:{id:routeParam(req.params.id),role:"USER"},
    select:{
      id:true,email:true,emailVerifiedAt:true,displayName:true,username:true,status:true,createdAt:true,lastLoginAt:true,publicProfileEnabled:true,
      wallets:{select:{id:true,chain:true,address:true,label:true,isPrimary:true,tradingEnabled:true,permissionExpiry:true}},
      tradingSettings:true,cashAllocations:true,
      follows:{include:{trader:{select:{id:true,displayName:true,handle:true,xHandle:true,kind:true}}},orderBy:{updatedAt:"desc"},take:100},
      positions:{include:{sourceTrader:{select:{displayName:true,handle:true}}},orderBy:{openedAt:"desc"},take:100},
      activityEvents:{orderBy:{createdAt:"desc"},take:50},
      orders:{select:{id:true,mode:true,chain:true,side:true,status:true,venue:true,feeUsd:true,createdAt:true,confirmedAt:true},orderBy:{createdAt:"desc"},take:50}
    }
  });
  if(!user)return res.status(404).json({error:"USER_NOT_FOUND"});
  const live=user.positions.filter(p=>p.mode==="LIVE"), open=live.filter(p=>p.status==="OPEN"||p.status==="PARTIALLY_CLOSED");
  const available=user.cashAllocations.reduce((a,x)=>a+x.availableUsd,0), inTrades=user.cashAllocations.reduce((a,x)=>a+x.inTradesUsd,0);
  const summary={
    tradingCashUsd:available+inTrades,availableUsd:available,inTradesUsd:inTrades,
    realizedPnlUsd:live.reduce((a,p)=>a+p.realizedPnlUsd,0),unrealizedPnlUsd:open.reduce((a,p)=>a+p.unrealizedPnlUsd,0),
    openLivePositions:open.length,simulationPositions:user.positions.filter(p=>p.mode==="SIMULATION"&&(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED")).length
  };
  res.json({user,summary});
}));

app.patch("/v1/admin/users/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const status=String(req.body?.status??"");
  if(!["ACTIVE","SUSPENDED","CLOSED"].includes(status)) return res.status(400).json({error:"INVALID_STATUS"});
  const user=await db.user.update({where:{id:routeParam(req.params.id)},data:{status:status as any}});
  if(status!=="ACTIVE") await Promise.all([
    db.globalTradingSettings.updateMany({where:{userId:user.id},data:{autoCopyEnabled:false}}),
    db.refreshSession.updateMany({where:{userId:user.id,revokedAt:{isSet:false}},data:{revokedAt:new Date()}})
  ]);
  await audit(req.user.sub,"ADMIN","USER_STATUS_CHANGE",user.id,{status});
  res.json({user:safeUser(user)});
}));

app.get("/v1/admin/traders", requireAdmin, asyncRoute(async (_req,res) => {
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM"},
    include:{wallets:true,_count:{select:{follows:true,signals:true}}},
    orderBy:{createdAt:"desc"}
  });
  res.json({traders});
}));
app.post("/v1/admin/traders", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const handle=String(req.body?.handle??"").trim().replace(/^@/,"").toLowerCase();
  const displayName=String(req.body?.displayName??"").trim();
  const wallets=Array.isArray(req.body?.wallets)?req.body.wallets:[];
  if(!handle||!displayName) return res.status(400).json({error:"HANDLE_AND_NAME_REQUIRED"});
  for(const w of wallets){
    const chain=String(w?.chain??"SOLANA") as Chain, address=String(w?.address??"").trim();
    if(!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET",chain});
  }
  const trader=await db.trader.create({
    data:{
      handle,displayName,xHandle:String(req.body?.xHandle??handle).replace(/^@/,"")||undefined,bio:req.body?.bio||undefined,category:req.body?.category||undefined,
      kind:"PLATFORM",enabled:req.body?.enabled!==false,featured:Boolean(req.body?.featured),recommended:Boolean(req.body?.recommended),
      defaultSelected:Boolean(req.body?.defaultSelected),verification:req.body?.verification??"UNVERIFIED",
      wallets:{create:wallets.map((w:any)=>({chain:w.chain,address:String(w.address),verified:Boolean(w.verified),source:w.source||"ADMIN"}))}
    },
    include:{wallets:true}
  });
  await audit(req.user.sub,"ADMIN","CREATE_PLATFORM_TRADER",trader.id);
  res.status(201).json({trader});
}));
app.patch("/v1/admin/traders/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const allowed=["displayName","xHandle","bio","category","enabled","featured","recommended","defaultSelected","verification","trackingStatus"] as const;
  const data:any={}; for(const k of allowed) if(req.body?.[k]!==undefined) data[k]=req.body[k];
  const trader=await db.trader.update({where:{id:routeParam(req.params.id)},data});
  await audit(req.user.sub,"ADMIN","UPDATE_PLATFORM_TRADER",trader.id,data);
  res.json({trader});
}));
app.post("/v1/admin/traders/:id/wallets", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA") as Chain, address=String(req.body?.address??"").trim();
  if(!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});
  const trader=await db.trader.findFirst({where:{id:routeParam(req.params.id),kind:"PLATFORM"},select:{id:true}});
  if(!trader) return res.status(404).json({error:"TRADER_NOT_FOUND"});
  const mapped=await db.traderWallet.findUnique({where:{chain_address:{chain,address}}});
  if(mapped){
    if(mapped.traderId===trader.id) return res.json({wallet:mapped,alreadyMapped:true});
    return res.status(409).json({error:"SOURCE_WALLET_ALREADY_MAPPED",traderId:mapped.traderId});
  }
  const wallet=await db.traderWallet.create({data:{traderId:trader.id,chain,address,verified:Boolean(req.body?.verified),source:"ADMIN"}});
  await audit(req.user.sub,"ADMIN","ADD_TRADER_WALLET",wallet.id,{traderId:trader.id,chain,address});
  res.status(201).json({wallet});
}));

app.delete("/v1/admin/trader-wallets/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.traderWallet.findUnique({where:{id:routeParam(req.params.id)}});
  if(!wallet) return res.status(404).json({error:"TRADER_WALLET_NOT_FOUND"});
  await db.traderWallet.delete({where:{id:wallet.id}});
  await audit(req.user.sub,"ADMIN","REMOVE_TRADER_WALLET",wallet.id,{traderId:wallet.traderId,chain:wallet.chain,address:wallet.address});
  res.json({ok:true});
}));


// Deliberately public — platform-wide market intelligence, not per-user data (no req.user is
// ever read here). Requiring login just to SEE what the Global Brain is watching was blocking
// the entire discovery experience for anyone without an account; wallet/login should only ever
// gate EXECUTION, never observation.
app.get("/v1/brain/feed", asyncRoute(async (_req,res) => {
  // lastEvaluatedAt alone is not evidence of a real opportunity — the brain-worker touches it on
  // every tick for any token with a fresh market-data snapshot, even when the snapshot itself
  // carries zero real flow (e.g. during an upstream scanner outage). action:"IGNORE" is the
  // Brain's own scoring already having decided a token isn't a real opportunity right now; showing
  // it under "Trending" anyway would directly contradict the system's own evaluation. Requiring at
  // least one genuine evidence signal (not just a non-IGNORE label) additionally guards against a
  // token sitting at the WATCH threshold on stale/default inputs.
  const opportunities=await db.globalBrainOpportunity.findMany({
    where:{
      lastEvaluatedAt:{gte:new Date(Date.now()-6*60*60_000)},
      action:{not:"IGNORE"},
      OR:[
        {inflow60sUsd:{gt:0}},
        {buyers60s:{gt:0}},
        {whaleBuyers60s:{gt:0}},
        {knownWhaleBuyers60s:{gt:0}}
      ]
    },
    orderBy:[{score:"desc"},{lastEvaluatedAt:"desc"}],take:120
  });
  res.json({watching:true,opportunities});
}));
app.get("/v1/brain/token/:chain/:mint", asyncRoute(async (req:Request,res) => {
  const chain=routeParam(req.params.chain) as Chain;
  const mint=routeParam(req.params.mint);
  const [opportunity,flows,catalyst]=await Promise.all([
    db.globalBrainOpportunity.findUnique({where:{chain_mint:{chain,mint}}}),
    db.chainFlowObservation.findMany({where:{chain,mint},orderBy:{observedAt:"desc"},take:40}),
    db.catalystEvent.findFirst({where:{chain,mint},orderBy:{announcedAt:"desc"}})
  ]);
  res.json({opportunity,flows,catalyst});
}));
app.get("/v1/admin/brain", requireAdmin, asyncRoute(async (_req,res) => {
  const [opportunities,flows,outcomes]=await Promise.all([
    db.globalBrainOpportunity.findMany({orderBy:[{lastEvaluatedAt:"desc"},{score:"desc"}],take:300}),
    db.chainFlowObservation.findMany({orderBy:{observedAt:"desc"},take:500}),
    db.brainOutcomeSample.findMany({orderBy:{observedAt:"desc"},take:500})
  ]);
  res.json({opportunities,flows,outcomes});
}));

app.get("/v1/admin/discovery/candidates", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const stage=String(req.query.stage??"").toUpperCase();
  const where:any={}; if(stage)where.stage=stage;
  const candidates=await db.smartWalletCandidate.findMany({where,orderBy:[{copyabilityScore:"desc"},{updatedAt:"desc"}],take:500});
  res.json({candidates});
}));
app.post("/v1/admin/discovery/candidates", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"").toUpperCase();
  const address=String(req.body?.address??"").trim();
  const label=req.body?.label?String(req.body.label):undefined;
  if(!["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)) return res.status(400).json({error:"INVALID_CHAIN"});
  if(!address) return res.status(400).json({error:"ADDRESS_REQUIRED"});
  const existing=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:chain as Chain,address}}});
  if(existing) return res.status(409).json({error:"WALLET_ALREADY_TRACKED"});
  const candidate=await db.smartWalletCandidate.create({data:{chain:chain as Chain,address,stage:"PAPER_TRACKING",source:"ADMIN_MANUAL",label}});
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_ADD",candidate.id,{chain,address,label});
  res.status(201).json({candidate});
}));
app.patch("/v1/admin/discovery/candidates/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const c=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});if(!c)return res.status(404).json({error:"CANDIDATE_NOT_FOUND"});
  const data:any={};
  if(typeof req.body?.label==="string") data.label=req.body.label;
  const updated=await db.smartWalletCandidate.update({where:{id:c.id},data});
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_UPDATE",c.id,data);
  res.json({candidate:updated});
}));
app.get("/v1/admin/discovery/tokens", requireAdmin, asyncRoute(async (_req,res) => {
  const tokens=await db.discoveryToken.findMany({orderBy:{lastSeenAt:"desc"},take:500});
  res.json({tokens});
}));
app.get("/v1/admin/positions", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const status=String(req.query.status??"").toUpperCase();
  const positions=await db.position.findMany({
    where:status?{status:status as any}:undefined,
    include:{user:{select:{id:true,email:true,displayName:true}},sourceTrader:{select:{id:true,displayName:true,handle:true}}},
    orderBy:{openedAt:"desc"},take:300
  });
  res.json({positions});
}));
app.get("/v1/admin/intelligence/snapshots", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const mint=String(req.query.mint??"").trim();
  const snapshots=await db.memeMarketSnapshot.findMany({where:mint?{mint}:undefined,orderBy:{observedAt:"desc"},take:250});
  res.json({snapshots});
}));
app.get("/v1/admin/risk-incidents", requireAdmin, asyncRoute(async (_req,res) => {
  res.json({incidents:await db.riskIncident.findMany({orderBy:{createdAt:"desc"},take:250})});
}));
app.post("/v1/admin/discovery/candidates/:id/decision", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const action=String(req.body?.action??"").toUpperCase();
  if(!["PROVEN","REJECTED","PAUSED"].includes(action))return res.status(400).json({error:"INVALID_DISCOVERY_ACTION"});
  const c=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});if(!c)return res.status(404).json({error:"CANDIDATE_NOT_FOUND"});
  const updated=await db.smartWalletCandidate.update({where:{id:c.id},data:{stage:action as any,provenAt:action==="PROVEN"?new Date():undefined,rejectedReason:action==="REJECTED"?String(req.body?.reason??"ADMIN_REJECTED"):undefined}});
  if(c.traderId){
    await db.trader.update({where:{id:c.traderId},data:{enabled:action==="PROVEN",trackingStatus:action,recommended:action==="PROVEN"&&c.copyabilityScore>=85}}).catch(()=>{});
    await db.traderWallet.updateMany({where:{traderId:c.traderId},data:{monitoringStatus:action==="PROVEN"?"PROVEN":action}}).catch(()=>{});
  }
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_DECISION",c.id,{action,reason:req.body?.reason});
  res.json({candidate:updated});
}));

app.get("/v1/admin/signals", requireAdmin, asyncRoute(async (_req,res) => {
  const signals=await db.signal.findMany({
    include:{trader:true,_count:{select:{copyDecisions:true}}},
    orderBy:{observedAt:"desc"},take:200
  });
  res.json({signals});
}));
app.get("/v1/admin/trades", requireAdmin, asyncRoute(async (_req,res) => {
  const orders=await db.order.findMany({
    include:{user:{select:{id:true,email:true,displayName:true}},decision:{include:{signal:{include:{trader:true}}}}},
    orderBy:{createdAt:"desc"},take:250
  });
  res.json({orders});
}));

const allowedConfigKeys=new Set(["push","email","chains","execution","fees","risk","marketData","social","branding","signer","discovery","brain"]);
const secretConfigKeys=new Set(["push","email","execution","marketData","social","signer"]);
// Every long-running worker (services/*) reads these once at process boot — a save here only takes
// effect on the next restart. Stays true until the admin explicitly acknowledges the restart.
const RESTART_REQUIRED_KEYS=new Set(["marketData","execution","chains","signer","discovery","risk","brain"]);
// Only these fields within a secret config get a masked hint + "Replace/Remove" UX. Non-secret
// fields inside the same section (e.g. execution.jupiterBaseUrl) are shown in plain text as-is.
const SECRET_FIELDS:Record<string,string[]>={
  execution:["jupiterApiKey","zeroXApiKey"],
  signer:["privyAppSecret","privyAuthorizationPrivateKey"],
  social:["xBearerToken","xOAuthClientSecret"],
  // RPC URLs are treated as secrets too — a paid RPC URL commonly embeds the provider's API key
  // as a query param (as MemeCloud's own Helius auto-derivation does), so returning it in the
  // clear would leak that key right back out through a field that isn't literally named "*Key".
  marketData:["heliusApiKey","birdeyeApiKey","solanaRpc","heliusRpc","fallbackRpc"],
  email:["pass"]
};
// Which fields feed each provider's connectivity, per config key — this is what a "verified"
// result is pinned to. Changing any of these fields for a provider invalidates ONLY that
// provider's standing verification, not its siblings (e.g. rotating the Birdeye key never
// invalidates an already-verified Helius key in the same marketData section).
const PROVIDER_FINGERPRINT_FIELDS:Record<string,Record<string,string[]>>={
  execution:{jupiter:["jupiterBaseUrl","jupiterApiKey"],zeroX:["zeroXApiKey"]},
  marketData:{rpc:["solanaRpc","heliusRpc","fallbackRpc"],helius:["heliusApiKey"],birdeye:["birdeyeApiKey"]},
  signer:{privy:["privyAppId","privyAppSecret","privyAuthorizationPrivateKey","privySignerId","privyPolicyId"]},
  social:{x:["xBearerToken"]},
  brain:{bnb:["bnbWs"],eth:["ethWs"]},
  push:{push:["vapidPublicKey","vapidPrivateKey","subject"]},
  email:{smtp:["host","port","secure","user","pass","from"]}
};
app.use("/v1/admin/config", (_req,res,next)=>{res.set("Cache-Control","no-store");next()});
// heliusRpc/solanaRpc/fallbackRpc are now listed in SECRET_FIELDS.marketData (a paid RPC URL
// commonly embeds the provider's API key in its query string), so redactedConfig already strips
// them before this runs. Kept as an explicit hook rather than removed outright, in case another
// field-shaped leak like this shows up again.
function sanitizeForClient(cfg:any){
  return cfg;
}
app.get("/v1/admin/config", requireAdmin, asyncRoute(async (_req,res) => {
  const rows=await db.appConfig.findMany({orderBy:{key:"asc"}});
  res.json({config:rows.map(r=>sanitizeForClient(redactedConfig(r as any,SECRET_FIELDS[r.key]??[],PROVIDER_FINGERPRINT_FIELDS[r.key])))});
}));
app.put("/v1/admin/config/:key", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const key=routeParam(req.params.key);
  if(!allowedConfigKeys.has(key)) return res.status(400).json({error:"INVALID_CONFIG_KEY"});
  if(!req.body || typeof req.body!=="object" || Array.isArray(req.body)) return res.status(400).json({error:"INVALID_CONFIG"});
  const secret=secretConfigKeys.has(key);
  let value:any=req.body;
  let secretHints:Record<string,string>|undefined;
  // Secret forms intentionally send blanks for values the browser is not allowed to read back.
  // Preserve existing encrypted fields (and their hints) unless the admin explicitly supplies a
  // replacement. A field is only cleared when the admin explicitly sends null for it (Remove key).
  if(secret){
    const current=await getConfig<any>(key)??{};
    const existingRow=await db.appConfig.findUnique({where:{key}});
    value={...current};
    secretHints={...(existingRow?.secretHints as any??{})};
    const fields=SECRET_FIELDS[key]??[];
    for(const [field,incoming] of Object.entries(req.body)){
      if(incoming===undefined || incoming==="") continue;
      if(incoming===null){
        delete value[field];
        if(fields.includes(field)) delete secretHints![field];
      } else {
        value[field]=incoming;
        if(fields.includes(field)) secretHints![field]=maskHint(incoming);
      }
    }
    // Helius: a saved API key must actually feed the real Solana RPC/scanning path (every worker
    // already falls back to marketData.heliusRpc — see services/*), not sit unused. Auto-derive the
    // Helius RPC URL from the key only when the admin hasn't set an explicit heliusRpc themselves —
    // an explicit heliusRpc always wins and is never silently overwritten, and the dedicated
    // solanaRpc primary is never touched here.
    if(key==="marketData"){
      const explicitHeliusRpc=req.body.heliusRpc!==undefined && req.body.heliusRpc!=="";
      if(explicitHeliusRpc){
        value.heliusRpcAutoManaged=false;
      } else if(value.heliusApiKey && (value.heliusRpcAutoManaged || !value.heliusRpc)){
        value.heliusRpc=`https://mainnet.helius-rpc.com/?api-key=${value.heliusApiKey}`;
        value.heliusRpcAutoManaged=true;
        secretHints!.heliusRpc=maskHint(value.heliusRpc); // programmatic write, bypasses the loop above
      } else if(!value.heliusApiKey && value.heliusRpcAutoManaged){
        delete value.heliusRpc;
        value.heliusRpcAutoManaged=false;
        delete secretHints!.heliusRpc;
      }
    }
  }
  const restartRequired=RESTART_REQUIRED_KEYS.has(key);
  await setConfig(key,value,{secret,updatedBy:req.user.sub,secretHints,restartPending:restartRequired?true:undefined});
  await audit(req.user.sub,"ADMIN","CONFIG_UPDATE",key,secret?{secret:true,fields:Object.keys(req.body)}:{value:req.body});
  // "Save" must mean something real: for a provider-backed section, immediately run the same test
  // a manual "Test connection" click would — never leave the operator to guess whether Save worked.
  const testResults=await runProviderTests(key);
  if(testResults) await recordProviderResults(key,testResults);
  const freshRow=await db.appConfig.findUnique({where:{key}});
  res.json({ok:true,config:sanitizeForClient(redactedConfig(freshRow as any,SECRET_FIELDS[key]??[],PROVIDER_FINGERPRINT_FIELDS[key])),restartRequired});
}));

app.post("/v1/admin/push/generate", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const cfg=await ensureVapid(req.user.sub);
  await audit(req.user.sub,"ADMIN","GENERATE_VAPID");
  res.json({ok:true,publicKey:cfg.vapidPublicKey});
}));
app.post("/v1/admin/test-push", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const target=String(req.body?.userId??req.user.sub);
  const started=Date.now();
  const pushCfg=await getConfig<any>("push");
  const pushResult=await sendPush(target,{title:"MemeCloud push test",body:"Push notifications are working.",url:"/app/"});
  // subscriptions:0 proves the VAPID/backend path itself is genuinely working (sendPush would have
  // thrown PUSH_NOT_CONFIGURED otherwise) — there's simply nothing to deliver to yet. That's a real,
  // distinct outcome, not a "Connection failed."
  const noRecipients=pushResult?.subscriptions===0;
  const ok=noRecipients||Boolean(pushResult?.sent>0);
  const message=noRecipients?"Push backend ready — no subscribed devices":(ok?`Sent to ${pushResult.sent} subscription(s).`:`0 sent, ${pushResult?.failed||0} failed out of ${pushResult?.subscriptions??0} subscription(s).`);
  await recordProviderResults("push",{push:{ok,message,latencyMs:Date.now()-started,checkedAt:new Date().toISOString(),fingerprint:fingerprintOf(pushCfg,PROVIDER_FINGERPRINT_FIELDS.push.push)}});
  res.json({ok:true,result:pushResult});
}));
app.post("/v1/admin/test-email", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const to=String(req.body?.to??"");
  if(!to) return res.status(400).json({error:"EMAIL_REQUIRED"});
  const started=Date.now();
  const emailCfg=await getConfig<any>("email");
  const emailFp=fingerprintOf(emailCfg,PROVIDER_FINGERPRINT_FIELDS.email.smtp);
  try{
    const info=await sendEmail(to,"MemeCloud email test","<h2>Email is working.</h2>");
    await recordProviderResults("email",{smtp:{ok:true,message:"Test email accepted by SMTP provider.",latencyMs:Date.now()-started,checkedAt:new Date().toISOString(),fingerprint:emailFp}});
    res.json({ok:true,messageId:info.messageId});
  }catch(e:any){
    await recordProviderResults("email",{smtp:{ok:false,message:e?.message||"SMTP send failed.",latencyMs:Date.now()-started,checkedAt:new Date().toISOString(),fingerprint:emailFp}});
    throw e;
  }
}));
// Every sub-test below hits the saved backend config (getConfig — never req.body/frontend state)
// with a genuine, harmless provider request, and returns a typed, timed, non-secret result.
const withTimeout=(p:Promise<any>,ms=8000)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("Timed out")),ms))]);
type FetchResponse=Awaited<ReturnType<typeof fetch>>;
async function timedFetch(url:string,init:RequestInit={}):Promise<{r:FetchResponse|null;latencyMs:number;error?:Error}>{
  const started=Date.now();
  try{
    const r=await withTimeout(fetch(url,init)) as FetchResponse;
    return {r,latencyMs:Date.now()-started};
  }catch(e:any){
    return {r:null,latencyMs:Date.now()-started,error:e};
  }
}
// How recent a background health check must be to count for the strict "ready for live trading"
// claim (see /v1/admin/live-readiness) — this is intentionally NOT used for the general admin
// "Connected" badge, which is fingerprint-based and does not decay with time on its own.
const HEALTH_CHECK_MAX_AGE_MS=60*60_000;
function result(ok:boolean,message:string,extra:{httpStatus?:number;latencyMs?:number}={}):TestResult{
  return {ok,message,httpStatus:extra.httpStatus,latencyMs:extra.latencyMs,checkedAt:new Date().toISOString()};
}
async function testJupiter(cfg:any):Promise<TestResult>{
  const base=(cfg?.jupiterBaseUrl||"https://api.jup.ag").replace(/\/$/,"");
  const usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",wsol="So11111111111111111111111111111111111111112";
  // Same path/headers as the live JupiterExecution class (packages/execution) — this must test
  // the exact route real trades use, not a stale/guessed one.
  const url=`${base}/swap/v1/quote?inputMint=${wsol}&outputMint=${usdc}&amount=10000000&slippageBps=100`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:cfg?.jupiterApiKey?{"x-api-key":cfg.jupiterApiKey}:{}});
  if(error) return result(false,error.message||"Jupiter request failed.",{latencyMs});
  if(r!.ok) return result(true,"Jupiter returned a real executable quote.",{httpStatus:r!.status,latencyMs});
  return result(false,`Jupiter responded with HTTP ${r!.status}.`,{httpStatus:r!.status,latencyMs});
}
async function testZeroX(cfg:any):Promise<TestResult>{
  if(!cfg?.zeroXApiKey) return result(false,"No 0x API key is saved yet.");
  const weth="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const url=`https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${weth}&buyToken=${usdc}&sellAmount=1000000000000000`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:{"0x-api-key":cfg.zeroXApiKey,"0x-version":"v2"}});
  if(error) return result(false,error.message||"0x request failed.",{latencyMs});
  if(r!.ok) return result(true,"0x returned a real price quote.",{httpStatus:r!.status,latencyMs});
  if(r!.status===401) return result(false,"0x rejected the API key.",{httpStatus:r!.status,latencyMs});
  return result(false,`0x responded with HTTP ${r!.status}.`,{httpStatus:r!.status,latencyMs});
}
async function testSolanaRpc(cfg:any):Promise<TestResult>{
  const rpc=cfg?.solanaRpc||cfg?.heliusRpc;
  if(!rpc) return result(false,"No Solana RPC URL is saved yet.");
  const {r,latencyMs,error}=await timedFetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(false,error.message||"RPC request failed.",{latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result(true,"Solana RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  return result(false,`RPC responded with HTTP ${r!.status}${body?.error?.message?`: ${body.error.message}`:""}`,{httpStatus:r!.status,latencyMs});
}
async function testBirdeye(cfg:any):Promise<TestResult>{
  if(!cfg?.birdeyeApiKey) return result(false,"No Birdeye API key is saved yet.");
  const {r,latencyMs,error}=await timedFetch(`https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`,{headers:{"accept":"application/json","X-API-KEY":cfg.birdeyeApiKey,"x-chain":"solana"}});
  if(error) return result(false,error.message||"Birdeye request failed.",{latencyMs});
  if(r!.ok) return result(true,"Birdeye accepted the API key.",{httpStatus:r!.status,latencyMs});
  return result(false,`Birdeye responded with HTTP ${r!.status}. Check the API key.`,{httpStatus:r!.status,latencyMs});
}
async function testHelius(cfg:any):Promise<TestResult>{
  if(!cfg?.heliusApiKey) return result(false,"No Helius API key is saved yet.");
  // Tests the key directly against Helius's real RPC, independent of whatever ended up in
  // heliusRpc — this is what actually validates the saved key, not just a URL string.
  const url=`https://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;
  const {r,latencyMs,error}=await timedFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(false,error.message||"Helius request failed.",{latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result(true,"Helius RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  if(r!.status===401) return result(false,"Helius rejected the API key.",{httpStatus:r!.status,latencyMs});
  return result(false,`Helius responded with HTTP ${r!.status}.`,{httpStatus:r!.status,latencyMs});
}
async function testX(cfg:any):Promise<TestResult>{
  if(!cfg?.xBearerToken) return result(false,"No X bearer token is saved yet.");
  const {r,latencyMs,error}=await timedFetch("https://api.x.com/2/tweets/search/recent?query=test&max_results=10",{headers:{authorization:`Bearer ${cfg.xBearerToken}`}});
  if(error) return result(false,error.message||"X API request failed.",{latencyMs});
  if(r!.ok) return result(true,"X API accepted the bearer token.",{httpStatus:r!.status,latencyMs});
  return result(false,`X API responded with HTTP ${r!.status}. Check the bearer token.`,{httpStatus:r!.status,latencyMs});
}
async function testPrivy(cfg:any):Promise<TestResult>{
  if(!cfg?.privyAppId||!cfg?.privyAppSecret) return result(false,"Privy App ID and App Secret are both required.");
  const auth=Buffer.from(`${cfg.privyAppId}:${cfg.privyAppSecret}`).toString("base64");
  // Privy rejects every request with HTTP 400 unless privy-app-id is ALSO set as its own header,
  // in addition to the Basic-auth credentials — Basic auth alone is not sufficient. This mirrors
  // the header packages/providers already sends for the real signing calls (transactionByReferenceId);
  // this test endpoint was the one place that omitted it, which is what actually produced the 400,
  // not invalid App ID/Secret.
  const {r,latencyMs,error}=await timedFetch(`https://api.privy.io/v1/apps/${cfg.privyAppId}`,{headers:{authorization:`Basic ${auth}`,"privy-app-id":cfg.privyAppId}});
  if(error) return result(false,error.message||"Privy request failed.",{latencyMs});
  if(r!.ok){
    const missing=["privyAuthorizationPrivateKey","privySignerId","privyPolicyId"].filter(f=>!cfg?.[f]);
    const note=missing.length?` Delegated signing also needs ${missing.join(", ")} — the signer ID and policy ID can only be fully verified once a real user connects a wallet and grants them, not from this app-level check.`:" Authorization key, signer ID, and policy ID are saved but can only be fully verified once a real user connects a wallet and grants them (they're scoped per-wallet, not per-app).";
    return result(true,`Privy accepted the App ID and Secret.${note}`,{httpStatus:r!.status,latencyMs});
  }
  // Surface Privy's own sanitized reason instead of guessing "check App ID/Secret" for every 400 —
  // Privy's error body describes what's actually wrong with the request (e.g. a missing header,
  // a malformed key), which is frequently not a credential problem at all.
  const body=await r!.json().catch(()=>null);
  const reason=body?.error||body?.message||`HTTP ${r!.status}`;
  return result(false,`Privy rejected the request: ${reason}`,{httpStatus:r!.status,latencyMs});
}
const EXPECTED_CHAIN_ID:Record<string,string>={BNB:"0x38",Ethereum:"0x1"};
async function testWebSocket(url:string,label:string):Promise<TestResult>{
  if(!url) return result(false,`No ${label} WebSocket URL is saved yet.`);
  const started=Date.now();
  const expected=EXPECTED_CHAIN_ID[label];
  return new Promise<TestResult>((resolve)=>{
    let done=false,ws:WebSocket;
    const finish=(r:TestResult)=>{if(done)return;done=true;clearTimeout(timer);try{ws?.close()}catch{}resolve(r)};
    const timer=setTimeout(()=>finish(result(false,`${label} WebSocket timed out.`,{latencyMs:Date.now()-started})),8000);
    try{ws=new WebSocket(url)}catch(e:any){clearTimeout(timer);return resolve(result(false,e?.message||`${label} WebSocket failed to connect.`))}
    // A socket that merely opens proves reachability, not the right chain — confirm via a real
    // eth_chainId JSON-RPC call so a reachable-but-wrong-network endpoint fails verification.
    ws.onopen=()=>{try{ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}))}catch(e:any){finish(result(false,`${label} WebSocket connected but the chain ID request failed to send.`,{latencyMs:Date.now()-started}))}};
    ws.onmessage=(ev:any)=>{
      const latencyMs=Date.now()-started;
      try{
        const chainId=JSON.parse(String(ev.data))?.result;
        if(!chainId) return finish(result(false,`${label} WebSocket connected but returned no chain ID.`,{latencyMs}));
        if(expected && String(chainId).toLowerCase()!==expected) return finish(result(false,`${label} WebSocket connected but reports chain ID ${chainId} (expected ${expected} for ${label}) — wrong network.`,{latencyMs}));
        finish(result(true,`${label} WebSocket connected — chain ID ${chainId} confirmed.`,{httpStatus:200,latencyMs}));
      }catch{
        finish(result(false,`${label} WebSocket connected but sent an unparseable response.`,{latencyMs}));
      }
    };
    ws.onerror=()=>finish(result(false,`${label} WebSocket connection failed.`,{latencyMs:Date.now()-started}));
  });
}
// Shared by both the manual "Test connection" button and the automatic post-save verification —
// one code path, so a save and a manual test can never disagree about what "real" means.
// Attaches each provider's config fingerprint to its raw test outcome — this is what lets a
// later save/read decide whether a past PASS still applies (fingerprint unchanged) or needs a
// fresh test (fingerprint changed), instead of an arbitrary time-based staleness window.
function withFingerprints(key:string,cfg:any,raw:Record<string,TestResult>):Record<string,ProviderRecord>{
  const fields=PROVIDER_FINGERPRINT_FIELDS[key]??{};
  const out:Record<string,ProviderRecord>={};
  for(const [provider,r] of Object.entries(raw)) out[provider]={...r,fingerprint:fingerprintOf(cfg,fields[provider]??[])};
  return out;
}
async function runProviderTests(key:string):Promise<Record<string,ProviderRecord>|null>{
  if(key==="marketData"){
    const cfg=await getConfig<any>("marketData");
    return withFingerprints(key,cfg,{rpc:await testSolanaRpc(cfg),helius:await testHelius(cfg),birdeye:await testBirdeye(cfg)});
  }
  if(key==="execution"){
    const cfg=await getConfig<any>("execution");
    return withFingerprints(key,cfg,{jupiter:await testJupiter(cfg),zeroX:await testZeroX(cfg)});
  }
  if(key==="social"){
    const cfg=await getConfig<any>("social");
    return withFingerprints(key,cfg,{x:await testX(cfg)});
  }
  if(key==="signer"){
    const cfg=await getConfig<any>("signer");
    return withFingerprints(key,cfg,{privy:await testPrivy(cfg)});
  }
  if(key==="brain"){
    const cfg=await getConfig<any>("brain");
    return withFingerprints(key,cfg,{bnb:await testWebSocket(cfg?.bnbWs,"BNB"),eth:await testWebSocket(cfg?.ethWs,"Ethereum")});
  }
  return null;
}
app.post("/v1/admin/config/:key/test", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const key=routeParam(req.params.key);
  try{
    const results=await runProviderTests(key);
    if(!results) return res.json({ok:false,message:"No live test is available for this provider yet.",results:{}});
    await recordProviderResults(key,results);
    const entries=Object.entries(results);
    const configured=entries.filter(([,v])=>v.ok||!/no .* is saved yet/i.test(v.message));
    const ok=configured.length>0 && configured.every(([,v])=>v.ok);
    const message=entries.map(([name,v])=>`${name}: ${v.ok?"OK":v.message}`).join(" · ");
    res.json({ok,message,results});
  }catch(e:any){
    res.json({ok:false,message:e?.message||"The test request failed.",results:{}});
  }
}));
app.post("/v1/admin/config/:key/ack-restart", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const key=routeParam(req.params.key);
  const row=await ackRestart(key);
  await audit(req.user.sub,"ADMIN","CONFIG_RESTART_ACK",key);
  res.json({ok:true,config:row?sanitizeForClient(redactedConfig(row as any,SECRET_FIELDS[key]??[],PROVIDER_FINGERPRINT_FIELDS[key])):null});
}));
app.post("/v1/admin/broadcast", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const title=String(req.body?.title??"").trim(), body=String(req.body?.body??"").trim();
  const channel=String(req.body?.channel??"PUSH").toUpperCase(), audience=String(req.body?.audience??"ALL").toUpperCase();
  if(!title||!body) return res.status(400).json({error:"TITLE_AND_BODY_REQUIRED"});
  if(!["PUSH","EMAIL","BOTH"].includes(channel)) return res.status(400).json({error:"INVALID_CHANNEL"});
  const row=await db.broadcast.create({data:{title,body,channel,audience,linkUrl:req.body?.linkUrl||undefined,status:"QUEUED",createdBy:req.user.sub}});
  await broadcastQueue.add("broadcast",{broadcastId:row.id},{jobId:row.id,attempts:4,backoff:{type:"exponential",delay:2000}});
  await audit(req.user.sub,"ADMIN","QUEUE_BROADCAST",row.id,{channel,audience});
  res.status(202).json({broadcast:row});
}));
app.get("/v1/admin/broadcasts", requireAdmin, asyncRoute(async (_req,res) => {
  res.json({broadcasts:await db.broadcast.findMany({orderBy:{createdAt:"desc"},take:100})});
}));
app.get("/v1/admin/audit", requireAdmin, asyncRoute(async (_req,res) => {
  const logs=await db.auditLog.findMany({
    include:{user:{select:{email:true,displayName:true}}},
    orderBy:{createdAt:"desc"},
    take:250
  });
  res.json({logs:logs.map(log=>({
    id:log.id,
    actor:log.actor,
    action:log.action,
    target:log.target,
    createdAt:log.createdAt,
    user:log.user,
    hasMetadata:log.metadata!==null
  }))});
}));
app.get("/v1/admin/health", requireAdmin, asyncRoute(async (_req,res) => {
  const [heartbeats,queueCounts]=await Promise.all([
    db.workerHeartbeat.findMany({orderBy:{name:"asc"}}),
    broadcastQueue.getJobCounts("waiting","active","failed","completed","delayed")
  ]);
  const now=Date.now();
  res.json({
    services:heartbeats.map(h=>({...h,healthy:now-h.lastBeatAt.getTime()<45_000})),
    queue:{broadcasts:queueCounts},
    database:"healthy",
    redis:await redis.ping().then(()=>"healthy").catch(()=>"unavailable"),
    executionMode:process.env.EXECUTION_MODE??"simulation"
  });
}));
// Answers "can MemeCloud actually trade real money right now?" purely from real, currently-fresh
// signals — never from whether a value merely exists in the database. This checks the real
// INFRASTRUCTURE dependencies only; whether live trading is currently switched on is reported
// separately (liveTradingEnabled) and is never itself a readiness dependency — that would be
// circular when this same function gates turning it on in the first place.
async function computeLiveReadiness(){
  const [marketDataRow,executionRow,signerRow,marketDataCfg,executionCfg,signerCfg,activeWallets,heartbeats,liveTradingEnabled]=await Promise.all([
    db.appConfig.findUnique({where:{key:"marketData"}}),
    db.appConfig.findUnique({where:{key:"execution"}}),
    db.appConfig.findUnique({where:{key:"signer"}}),
    getConfig<any>("marketData"),
    getConfig<any>("execution"),
    getConfig<any>("signer"),
    db.wallet.count({where:{chain:"SOLANA",tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}}),
    db.workerHeartbeat.findMany({where:{name:{in:["executor","exits","market-worker","solana-listener","solana-flow-scanner"]}}}),
    isLiveTradingEnabled()
  ]);
  const now=Date.now();
  // Live-trading readiness is a stricter, safety-critical claim than the general admin "Connected"
  // badge: it must require BOTH a standing verification whose fingerprint still matches the saved
  // config (not merely "was correct once, config unchanged forever") AND a health check recent
  // enough to mean something for "right now" — the periodic background health check keeps this
  // fresh automatically, so this never depends on the operator manually re-testing.
  function readyNow(row:any,cfg:any,fields:Record<string,string[]>,provider:string):boolean{
    const status=row?.testResults?.[provider];
    if(!status?.verified?.ok) return false;
    if(status.verified.fingerprint!==fingerprintOf(cfg,fields[provider]??[])) return false;
    if(!status.health?.ok) return false;
    if(!status.health.checkedAt||(now-new Date(status.health.checkedAt).getTime())>HEALTH_CHECK_MAX_AGE_MS) return false;
    return true;
  }
  const rpcOk=readyNow(marketDataRow,marketDataCfg,PROVIDER_FINGERPRINT_FIELDS.marketData,"rpc")||readyNow(marketDataRow,marketDataCfg,PROVIDER_FINGERPRINT_FIELDS.marketData,"helius");
  const jupiterOk=readyNow(executionRow,executionCfg,PROVIDER_FINGERPRINT_FIELDS.execution,"jupiter");
  const privyOk=readyNow(signerRow,signerCfg,PROVIDER_FINGERPRINT_FIELDS.signer,"privy");
  const workers=["executor","exits","market-worker","solana-listener","solana-flow-scanner"].map(name=>{
    const h=heartbeats.find(x=>x.name===name);
    return {name,running:Boolean(h)&&now-h!.lastBeatAt.getTime()<45_000,lastBeatAt:h?.lastBeatAt??null};
  });
  const workersHealthy=workers.every(w=>w.running);
  const signerReady=privyOk && activeWallets>0;
  const ready=rpcOk && jupiterOk && signerReady && workersHealthy;
  const reasons:string[]=[];
  if(!rpcOk) reasons.push("Solana RPC has not passed a fresh connection test (test connection or re-save Market data).");
  if(!jupiterOk) reasons.push("Jupiter has not passed a fresh connection test (test connection or re-save Trade routing).");
  if(!privyOk) reasons.push("Privy signer has not passed a fresh connection test.");
  if(activeWallets===0) reasons.push("No user wallet currently has an active delegated trading permission — connect a wallet and grant MemeCloud as an additional signer with the required policy before activating.");
  if(!workersHealthy) reasons.push("One or more execution workers (executor / exits / market-worker / listener / flow scanner) are not sending a healthy heartbeat.");
  return {
    chain:"SOLANA",ready,reasons,liveTradingEnabled,
    dependencies:{rpc:rpcOk,jupiter:jupiterOk,signerCredentialsConnected:privyOk,walletsWithActivePermission:activeWallets},
    workers,
    note:"BNB/Ethereum/other chains have no delegated live-execution signer implemented yet — Solana is the only chain this endpoint evaluates for live trading readiness."
  };
}
app.get("/v1/admin/live-readiness", requireAdmin, asyncRoute(async (_req,res) => {
  res.json(await computeLiveReadiness());
}));
// Owner-only. The DB-backed switch executor/exits actually check on every decision (see
// isLiveTradingEnabled) — takes effect immediately, no env file, no VPS restart. Turning it ON
// always re-verifies the real dependency chain first and refuses if anything's not genuinely
// ready; turning it OFF is unconditional and immediate.
app.post("/v1/admin/live-trading/enable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const readiness=await computeLiveReadiness();
  if(!readiness.ready) return res.status(409).json({error:"NOT_READY",reasons:readiness.reasons});
  await setConfig("liveTrading",{enabled:true,enabledAt:new Date().toISOString(),enabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_ENABLE","liveTrading",{});
  res.json({ok:true,enabled:true});
}));
app.post("/v1/admin/live-trading/disable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  await setConfig("liveTrading",{enabled:false,disabledAt:new Date().toISOString(),disabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_DISABLE","liveTrading",{});
  res.json({ok:true,enabled:false});
}));

app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
  if(err?.message==="CORS_ORIGIN_DENIED") return res.status(403).json({error:"CORS_ORIGIN_DENIED"});
  console.error("[api]",err);
  res.status(500).json({error:"INTERNAL_ERROR"});
});

// Automatic, low-frequency background health checks — keeps "currently healthy" / "temporarily
// unreachable" state fresh (see live-readiness's HEALTH_CHECK_MAX_AGE_MS) without the operator
// needing to click Test Connection. Deliberately excludes push/email: those "tests" send a real
// push notification / real email to a real recipient, so running them automatically would spam
// users rather than just check health — only a manual Test/Send from the admin covers those.
const BACKGROUND_HEALTH_KEYS=["marketData","execution","social","signer","brain"];
async function runBackgroundHealthChecks(){
  for(const key of BACKGROUND_HEALTH_KEYS){
    try{
      const results=await runProviderTests(key);
      if(results) await recordProviderResults(key,results);
    }catch(e){
      console.error(`[background-health] ${key}`,e);
    }
  }
}
setInterval(()=>{void runBackgroundHealthChecks()},15*60_000).unref?.();
setTimeout(()=>{void runBackgroundHealthChecks()},30_000).unref?.();

async function apiHeartbeat(){
  await db.workerHeartbeat.upsert({where:{name:"api"},create:{name:"api",status:"healthy",detail:{port} as any,lastBeatAt:new Date()},update:{status:"healthy",detail:{port} as any,lastBeatAt:new Date()}}).catch(()=>{});
}
setInterval(()=>void apiHeartbeat(),15_000); void apiHeartbeat();
app.listen(port,()=>console.log(`[api] listening on :${port}`));
