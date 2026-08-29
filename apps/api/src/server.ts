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
import { CopySettingsSchema, solanaRpcCandidates, pickHealthyRpc } from "@memecloud/shared";
import { getConfig, setConfig, redactedConfig, encryptJson, decryptJson, maskHint, recordProviderResults, fingerprintOf, ackRestart, readExecutionState, type ProviderRecord } from "@memecloud/config";
import { classifyLifecycle } from "@memecloud/brain";
// A single raw test attempt, before a config fingerprint is attached (see withFingerprints below).
// `state` is the honest classification of WHY a check failed -- HTTP 429 must never be reported
// the same way as an actually-invalid key. `ok` remains for backward compat (ok === state==="CONNECTED").
type ProviderState="CONNECTED"|"RATE_LIMITED"|"INVALID_CREDENTIALS"|"PROVIDER_UNAVAILABLE"|"NETWORK_ERROR"|"TIMEOUT"|"NOT_CONFIGURED"|"UNKNOWN";
type TestResult = { ok: boolean; state: ProviderState; httpStatus?: number; latencyMs?: number; message: string; checkedAt: string };
import { sendEmail, sendPush, ensureVapid, publicPushKey, renderEmail } from "@memecloud/notifications";
import { PrivySolanaSigner } from "@memecloud/providers";
import { JupiterExecution } from "@memecloud/execution";
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } from "@solana/spl-token";

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
// Every other /v1 route was previously unrated-limited. The manual-trade endpoint is the one
// that actually matters here: it calls Jupiter twice per request (forward+reverse quote) even
// in simulation, and once live trading is on it can submit real Solana transactions — an
// authenticated account hammering it is both a real-money risk and a way to exhaust the whole
// platform's shared Jupiter quota (the same 429 pressure fixed in market-worker/discovery-worker
// this session). Keyed by user, not IP, since this is auth-gated.
const tradeLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator:(req:any)=>req.user?.sub||req.ip });

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
const MAX_ACTIVE_SESSIONS_PER_USER=10;
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
    const [redisStatus,executionState]=await Promise.all([redis.ping().then(()=>"healthy").catch(()=>"unavailable"),readExecutionState()]);
    res.json({ok:true,database:"healthy",redis:redisStatus,executionMode:executionState.actualRuntimeMode.toLowerCase(),executionStatus:executionState.status});
  } catch {
    res.status(503).json({ok:false,database:"unavailable",apiSafetyGate:String(process.env.EXECUTION_MODE??"simulation").toLowerCase()});
  }
}));

app.get("/v1/public/config", asyncRoute(async (_req,res) => {
  const [socialCfg,chainCfg,signerCfg,executionState]=await Promise.all([getConfig<any>("social"),getConfig<any>("chains"),getConfig<any>("signer"),readExecutionState()]);
  // privyAppId/privySignerId/privyPolicyId are Privy dashboard object identifiers, not credentials
  // -- the client already has to pass signerId/policyIds directly to Privy's own createWallet/
  // addSigners calls (see docs.privy.io/wallets/wallets/create/create-a-wallet), so these were
  // always meant to be public. privyAppSecret and privyAuthorizationPrivateKey are the actual
  // secrets and are never read here.
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID;
  const privySignerId=signerCfg?.privySignerId||process.env.PRIVY_SIGNER_ID;
  const privyPolicyId=signerCfg?.privyPolicyId||process.env.PRIVY_POLICY_ID;
  res.json({
    appName:"MemeCloud",
    // Compatibility fields now report the resolved transaction truth, never a partial source.
    executionMode:executionState.actualRuntimeMode.toLowerCase(),
    liveExecutionEnabled:executionState.newEntriesLive,
    liveTradingRequested:executionState.liveTradingEnabled,
    executionState:{requestedMode:executionState.requestedMode,actualRuntimeMode:executionState.actualRuntimeMode,status:executionState.status,readiness:executionState.readiness,newEntriesLive:executionState.newEntriesLive},
    pushPublicKey:await publicPushKey(),
    supportedChains:chainCfg?.enabled??(process.env.ENABLED_CHAINS??"SOLANA").split(","),
    // Honest per the multi-chain capability audit: BASE/ARBITRUM/AVALANCHE/SUI/HYPERLIQUID exist
    // only as schema enum values with zero scanning or execution code anywhere in the repo.
    // BNB/Ethereum have a real discovery scanner (services/evm-flow-worker) but no signer -- no
    // chain other than Solana has an execution "adapter" in any real sense, so the field default
    // previously claiming BASE/ARBITRUM/AVALANCHE were "adapter ready" was simply false.
    adapterReadyChains:(process.env.ADAPTER_READY_CHAINS??"").split(",").filter(Boolean),
    discoveryOnlyChains:["BNB","ETHEREUM"],
    xOAuthConfigured:Boolean(socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID),
    embeddedWalletsConfigured:Boolean(privyAppId&&privySignerId&&privyPolicyId),
    privyAppId:privyAppId||null,
    privySignerId:privySignerId||null,
    privyPolicyId:privyPolicyId||null
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
  const currentHash=hashToken(parseCookies(req).fomo_refresh??"");
  const sessions=await db.refreshSession.findMany({
    where:{userId:req.user.sub,revokedAt:{isSet:false},expiresAt:{gt:new Date()}},
    select:{id:true,userAgent:true,ipAddress:true,createdAt:true,lastUsedAt:true,expiresAt:true,tokenHash:true},
    orderBy:{lastUsedAt:"desc"},take:50
  });
  res.json({sessions:sessions.map(({tokenHash,...s})=>({...s,current:tokenHash===currentHash}))});
}));
app.delete("/v1/me/sessions", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const currentHash=hashToken(parseCookies(req).fomo_refresh??"");
  await db.refreshSession.updateMany({where:{userId:req.user.sub,revokedAt:{isSet:false},tokenHash:{not:currentHash}},data:{revokedAt:new Date()}});
  res.json({ok:true});
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
  const keys=["pushEnabled","emailEnabled","traderBought","tradeCopied","skippedTrade","profitTaken","positionClosed","securityAlerts","platformBroadcast","discoveryNewToken","discoverySmartWallet","discoveryWhaleActivity","discoveryHeatingUp","discoveryStrong","discoveryHighConviction"] as const;
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
  const executionState=await readExecutionState();
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
    executionMode:executionState.actualRuntimeMode.toLowerCase(),
    executionState:{requestedMode:executionState.requestedMode,actualRuntimeMode:executionState.actualRuntimeMode,status:executionState.status,newEntriesLive:executionState.newEntriesLive}
  });
}));

app.get("/v1/me/positions", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const status=String(req.query.status??"");
  const positions=await db.position.findMany({
    where:{userId:req.user.sub,...(status?{status:status as any}:{})},
    include:{sourceTrader:{select:{id:true,displayName:true,handle:true,avatarUrl:true}},exits:{orderBy:{createdAt:"desc"}}},
    orderBy:{openedAt:"desc"},take:250
  });
  // Same pattern as /v1/brain/feed and /v1/smart-wallets: freshness measured against the most
  // recently marked-to-market position across the WHOLE table (not just this user's), so a
  // genuinely stalled exits mark loop is visible even to a user whose own positions haven't
  // updated in a while for an unrelated reason (e.g. all closed, or all on illiquid mints).
  // exits ticks every 3s and requires a MarketPrice observed within the last 60s to mark at all,
  // so 120s of total silence is real degradation, not a missed tick.
  const mostRecentlyMarked=await db.position.findFirst({where:{status:{in:["OPEN","PARTIALLY_CLOSED"]}},orderBy:{lastMarkedAt:"desc"},select:{lastMarkedAt:true}});
  // Unlike Discover/Smart Wallets, "nothing found" here just means no one has an open position
  // right now -- that's a quiet pipeline, not a degraded one, so it must not be flagged the same
  // way a genuinely stalled mark loop (positions exist but stopped updating) is.
  const dataFreshnessSec=mostRecentlyMarked?.lastMarkedAt?Math.round((Date.now()-mostRecentlyMarked.lastMarkedAt.getTime())/1000):null;
  const pipelineDegraded=mostRecentlyMarked!==null&&(dataFreshnessSec===null||dataFreshnessSec>120);
  res.json({positions,pipelineDegraded,dataFreshnessSec});
}));

const USDC_SOL="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
async function manualTradeTrader(){
  const handle="memecloud-manual-trade";
  const existing=await db.trader.findUnique({where:{handle}});
  if(existing) return existing;
  return db.trader.create({data:{handle,displayName:"Manual trade",bio:"Trades a user places directly from Discover.",category:"MANUAL",verification:"VERIFIED",kind:"PLATFORM",enabled:true,trackingStatus:"TRACKING"}});
}
async function reconcileConfirmedManualSwap(rpc:string,signature:string,owner:string,inputMint:string,outputMint:string){
  const conn=new Connection(rpc,"confirmed");
  const tx=await conn.getParsedTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx||tx.meta?.err)throw Object.assign(new Error("CONFIRMED_TRANSACTION_UNAVAILABLE"),{code:"RECONCILIATION_FAILED"});
  const bal=(side:"pre"|"post",mint:string)=>((side==="pre"?tx.meta?.preTokenBalances:tx.meta?.postTokenBalances)??[]).filter((x:any)=>x.owner===owner&&x.mint===mint).reduce((a:bigint,x:any)=>a+BigInt(x.uiTokenAmount?.amount??"0"),0n);
  const inPre=bal("pre",inputMint),inPost=bal("post",inputMint),outPre=bal("pre",outputMint),outPost=bal("post",outputMint);
  const actualInput=inPre>inPost?inPre-inPost:0n, actualOutput=outPost>outPre?outPost-outPre:0n;
  if(actualInput<=0n||actualOutput<=0n)throw Object.assign(new Error("CONFIRMED_SWAP_DELTAS_INVALID"),{code:"RECONCILIATION_FAILED"});
  return {actualInputRaw:actualInput.toString(),actualOutputRaw:actualOutput.toString()};
}
async function recoverManualPrivyHash(privy:PrivySolanaSigner,referenceId:string){
  try{
    const tx:any=await privy.transactionByReferenceId(referenceId);
    const status=String(tx?.status??"").toLowerCase();
    if(["failed","reverted","provider_error"].includes(status))return null;
    return String(tx?.transaction_hash??tx?.hash??"")||null;
  }catch(e){console.warn("[manual-trade] Privy reference recovery unavailable",referenceId,e);return null}
}
app.post("/v1/me/trade/manual", auth, tradeLimiter, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA");
  const mint=String(req.body?.mint??"");
  const amountUsd=Number(req.body?.amountUsd??0);
  // Required from the client so a network retry of the exact same tap reuses the same
  // idempotency key instead of the server minting a fresh one per HTTP request (which would
  // make a real double-tap or client retry indistinguishable from two separate real buys).
  const clientRequestId=String(req.body?.clientRequestId??"").trim();
  if(!mint) return res.status(400).json({error:"MINT_REQUIRED"});
  if(!Number.isFinite(amountUsd)||amountUsd<=0) return res.status(400).json({error:"INVALID_AMOUNT"});
  if(!clientRequestId||!/^[a-zA-Z0-9-]{8,64}$/.test(clientRequestId)) return res.status(400).json({error:"CLIENT_REQUEST_ID_REQUIRED"});
  if(chain!=="SOLANA") return res.status(409).json({error:"EXECUTION_ADAPTER_NOT_CONFIGURED",message:"Manual buying only has a verified route on Solana right now."});
  const marketCfg=await getConfig<any>("marketData");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[api]");
  if(!rpc) return res.status(409).json({error:"SOLANA_RPC_REQUIRED",message:"No Solana RPC is configured yet."});
  const execCfg=await getConfig<any>("execution");
  const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  const amountRaw=String(Math.round(amountUsd*1_000_000));

  // The exact same authoritative model used by the automated executor. This closes the former
  // gap where manual BUY checked only the DB request and could construct a live transaction even
  // while EXECUTION_MODE=simulation or the RPC/scanner was operationally degraded.
  const executionState=await readExecutionState();
  const permitted=executionState.newEntriesLive?await db.wallet.findFirst({where:{userId:req.user.sub,chain:"SOLANA",tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}}):null;
  const signerCfg=executionState.newEntriesLive&&permitted?await getConfig<any>("signer"):null;
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID, privyAppSecret=signerCfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const privyAuthKey=signerCfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const privy=permitted&&privyAppId&&privyAppSecret?new PrivySolanaSigner({appId:privyAppId,appSecret:privyAppSecret,authorizationPrivateKey:privyAuthKey,sponsorGas:Boolean(signerCfg?.sponsorGas)}):null;
  const willTradeLive=Boolean(executionState.newEntriesLive&&permitted&&privy);

  if(!willTradeLive && String(req.body?.mode??"")!=="SIMULATION"){
    // Never silently fall back to a fake fill. The caller must explicitly opt into simulation
    // (mode:"SIMULATION") once they've been shown this refusal — matching "Live trading is off" /
    // "Connect and authorize a wallet to trade" as an explicit choice, not a hidden default.
    const reason=!executionState.liveTradingEnabled?"LIVE_TRADING_OFF":!executionState.newEntriesLive?"LIVE_TRADING_BLOCKED":"TRADING_PERMISSION_REQUIRED";
    return res.status(409).json({
      error:reason,
      message:!executionState.liveTradingEnabled
        ?"Live Solana trading is currently off. Ask the owner to enable it, or explicitly run this as a simulation."
        :!executionState.newEntriesLive
          ?`Live trading is requested but blocked: ${executionState.reasons[0]??"the execution runtime is not ready"}`
          :"No wallet has an active delegated trading permission yet. Link and authorize a wallet in Account, or explicitly run this as a simulation.",
      executionState:{requestedMode:executionState.requestedMode,actualRuntimeMode:executionState.actualRuntimeMode,status:executionState.status,blockers:executionState.blockers},
      simulationAvailable:true
    });
  }

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
    const key=`manual:${req.user.sub}:${clientRequestId}`;

    if(!willTradeLive){
      const signal=await db.signal.create({data:{idempotencyKey:key,chain:"SOLANA",traderId:trader.id,sourceWallet:"MANUAL_USER_TRADE",sourceTx:key,action:"BUY",inputMint:USDC_SOL,outputMint:mint,inputRaw:amountRaw,outputRaw:quote.outAmount,sourcePriceUsd:executablePriceUsd,sourcePriceMethod:"MANUAL_EXECUTABLE_QUOTE",observedAt:now,status:"COMPLETED"}});
      const decision=await db.copyDecision.create({data:{signalId:signal.id,userId:req.user.sub,allowed:true,action:"BUY",amountUsd,sourcePriceUsd:executablePriceUsd,executablePriceUsd,walletChasePct:0,explanation:"User-initiated manual simulation buy from Discover."}});
      const [order,position]=await db.$transaction([
        db.order.create({data:{idempotencyKey:key,decisionId:decision.id,userId:req.user.sub,chain:"SOLANA",mode:"SIMULATION",side:"BUY",inputMint:USDC_SOL,outputMint:mint,requestedInputRaw:amountRaw,expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"CONFIRMED",confirmedAt:now,venue:"JUPITER_QUOTE",quoteJson:{simulation:true,realQuote:true,manual:true,priceImpactPct:quote.priceImpactPct} as any}}),
        db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"SIMULATION",mint,quoteMint:USDC_SOL,entryInputRaw:amountRaw,entryTokenRaw:quote.outAmount,remainingTokenRaw:quote.outAmount,costUsd:amountUsd,avgEntryPriceUsd:executablePriceUsd,currentPriceUsd:executablePriceUsd,peakPriceUsd:executablePriceUsd,takeProfitPct:200,status:"OPEN",lastMarkedAt:now}})
      ]);
      await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual simulation buy placed",body:`$${amountUsd.toFixed(2)} simulation buy from a real executable quote. No live funds moved.`,data:{orderId:order.id,positionId:position.id,mint} as any}});
      await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd,mode:"SIMULATION"});
      return res.status(201).json({ok:true,mode:"SIMULATION",order,position});
    }

    // LIVE path — mirrors executor's automated buy exactly: SIGNING -> SUBMITTED -> CONFIRMED,
    // a durable LiveExecutionAttempt row for provider-reference reconciliation, and never a blind
    // retry of an ambiguous prior attempt.
    let order=await db.order.findUnique({where:{idempotencyKey:key}});
    if(order){
      if(order.status==="CONFIRMED"){
        const existingPosition=await db.position.findFirst({where:{userId:req.user.sub,mode:"LIVE",entryTxHash:order.txHash??undefined}});
        return res.status(200).json({ok:true,mode:"LIVE",order,position:existingPosition});
      }
      const attempt=await db.liveExecutionAttempt.findFirst({where:{orderId:order.id,purpose:"BUY"},orderBy:{createdAt:"desc"}});
      if(!attempt) throw Object.assign(new Error("LIVE_BUY_ATTEMPT_MISSING"),{code:"LIVE_BUY_ATTEMPT_MISSING"});
      const ref=attempt.idempotencyKey.slice(0,64);
      const hash=attempt.txHash||order.txHash||await recoverManualPrivyHash(privy!,ref);
      if(!hash){
        return res.status(409).json({error:"AMBIGUOUS_PRIOR_BUY_ATTEMPT",message:"A previous attempt for this exact request has no confirmed result yet and cannot be safely resubmitted. Try again shortly."});
      }
      await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:hash,submittedAt:order.submittedAt??new Date()}});
      await db.liveExecutionAttempt.update({where:{id:attempt.id},data:{status:"SUBMITTED",txHash:hash}});
      await jupiter.waitConfirmed(rpc,hash,60_000);
      const fill=await reconcileConfirmedManualSwap(rpc,hash,permitted!.address,USDC_SOL,mint);
      const actualUsd=Number(BigInt(fill.actualInputRaw))/1_000_000, actualTokens=Number(BigInt(fill.actualOutputRaw))/(10**decimals);
      const actualEntry=actualUsd/actualTokens;
      let position=await db.position.findFirst({where:{userId:req.user.sub,mode:"LIVE",entryTxHash:hash}});
      if(!position){
        [,position]=await db.$transaction([
          db.order.update({where:{id:order.id},data:{status:"CONFIRMED",txHash:hash,actualInputRaw:fill.actualInputRaw,actualOutputRaw:fill.actualOutputRaw,confirmedAt:new Date()}}),
          db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsd:actualUsd,avgEntryPriceUsd:actualEntry,currentPriceUsd:actualEntry,peakPriceUsd:actualEntry,takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}})
        ]);
      }
      await db.liveExecutionAttempt.update({where:{id:attempt.id},data:{status:"CONFIRMED",txHash:hash}});
      order=await db.order.findUnique({where:{id:order.id}});
      return res.status(200).json({ok:true,mode:"LIVE",order,position});
    }

    const liveDecision=await db.copyDecision.create({data:{signalId:(await db.signal.create({data:{idempotencyKey:key,chain:"SOLANA",traderId:trader.id,sourceWallet:"MANUAL_USER_TRADE",sourceTx:key,action:"BUY",inputMint:USDC_SOL,outputMint:mint,inputRaw:amountRaw,outputRaw:quote.outAmount,sourcePriceUsd:executablePriceUsd,sourcePriceMethod:"MANUAL_EXECUTABLE_QUOTE",observedAt:now,status:"COMPLETED"}})).id,userId:req.user.sub,allowed:true,action:"BUY",amountUsd,sourcePriceUsd:executablePriceUsd,executablePriceUsd,walletChasePct:0,explanation:"User-initiated manual live buy from Discover."}});
    order=await db.order.create({data:{idempotencyKey:key,decisionId:liveDecision.id,userId:req.user.sub,chain:"SOLANA",mode:"LIVE",side:"BUY",inputMint:USDC_SOL,outputMint:mint,requestedInputRaw:amountRaw,expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"SIGNING",venue:"JUPITER",quoteJson:{manual:true,priceImpactPct:quote.priceImpactPct,quote:quote.raw} as any}});
    const built=await jupiter.buildSwap(quote,permitted!.address);
    const attemptKey=crypto.createHash("sha256").update(`MANUAL_BUY:${order.id}`).digest("hex");
    await db.liveExecutionAttempt.create({data:{idempotencyKey:attemptKey,userId:req.user.sub,orderId:order.id,purpose:"BUY",chain:"SOLANA",walletAddress:permitted!.address,provider:"PRIVY",providerRef:permitted!.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
    let hash:string;
    try{
      const sent=await privy!.signAndSend(permitted!.permissionRef!,built,attemptKey.slice(0,64));
      hash=sent.hash;
      await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:hash,submittedAt:new Date()}});
      await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:hash}});
    }catch(e:any){
      const recovered=await recoverManualPrivyHash(privy!,attemptKey.slice(0,64));
      if(!recovered){
        await db.order.update({where:{id:order.id},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT")}}).catch(()=>{});
        await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
        await db.riskIncident.create({data:{severity:"CRITICAL",scope:"LIVE_EXECUTION",userId:req.user.sub,chain:"SOLANA",mint,code:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT"),detail:{orderId:order.id,message:String(e?.message??e),referenceId:attemptKey.slice(0,64)}}}).catch(()=>{});
        return res.status(502).json({error:"LIVE_BUY_SUBMIT_FAILED",message:"MemeCloud could not confirm whether this buy reached Solana. It has not been retried automatically — check Portfolio shortly; support can reconcile it if needed."});
      }
      hash=recovered;
      await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:hash,submittedAt:new Date()}}).catch(()=>{});
      await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:hash}}).catch(()=>{});
    }
    await jupiter.waitConfirmed(rpc,hash,60_000);
    const fill=await reconcileConfirmedManualSwap(rpc,hash,permitted!.address,USDC_SOL,mint);
    const actualUsd=Number(BigInt(fill.actualInputRaw))/1_000_000, actualTokens=Number(BigInt(fill.actualOutputRaw))/(10**decimals);
    const actualEntry=actualUsd/actualTokens;
    const [,position]=await db.$transaction([
      db.order.update({where:{id:order.id},data:{status:"CONFIRMED",txHash:hash,actualInputRaw:fill.actualInputRaw,actualOutputRaw:fill.actualOutputRaw,confirmedAt:new Date()}}),
      db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsd:actualUsd,avgEntryPriceUsd:actualEntry,currentPriceUsd:actualEntry,peakPriceUsd:actualEntry,takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}})
    ]);
    await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"CONFIRMED",txHash:hash}});
    order=await db.order.findUnique({where:{id:order.id}});
    await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual buy confirmed",body:`Bought $${actualUsd.toFixed(2)} of the token. The transaction is confirmed on Solana.`,data:{orderId:order!.id,positionId:position.id,mint,txHash:hash} as any}});
    await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd:actualUsd,mode:"LIVE",txHash:hash});
    res.status(201).json({ok:true,mode:"LIVE",order,position});
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
// Shared by both the existing "delegate an already-connected external wallet" flow and the new
// "create a MemeCloud embedded wallet" flow below. Never trust the client's claim that delegation
// succeeded -- independently re-fetch the wallet from Privy's own API and check the actual
// additional_signers/policy_ids grants server-side before ever marking tradingEnabled:true. This is
// the same verification the delegated-execution path (executor/exits' signAndSend) implicitly
// depends on being correct, so it must never be weakened for either caller.
type PrivyDelegationCheck =
  | { ok:true; provider:PrivySolanaSigner; remote:any }
  | { ok:false; status:number; error:string };
async function verifyPrivyDelegation(privyWalletId:string, expectedAddress?:string):Promise<PrivyDelegationCheck>{
  const cfg=await getConfig<any>("signer");
  const appId=cfg?.privyAppId||process.env.PRIVY_APP_ID,appSecret=cfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const authKey=cfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const expectedSigner=cfg?.privySignerId||process.env.PRIVY_SIGNER_ID;
  const expectedPolicy=cfg?.privyPolicyId||process.env.PRIVY_POLICY_ID;
  if(!appId||!appSecret||!authKey||!expectedSigner||!expectedPolicy)return {ok:false,status:503,error:"DELEGATED_SIGNER_NOT_CONFIGURED"};
  const provider=new PrivySolanaSigner({appId,appSecret,authorizationPrivateKey:authKey,sponsorGas:Boolean(cfg?.sponsorGas)});
  const remote:any=await provider.getWallet(privyWalletId);
  if(String(remote?.chain_type??"").toLowerCase()!=="solana")return {ok:false,status:400,error:"PRIVY_WALLET_NOT_SOLANA"};
  if(expectedAddress&&String(remote?.address??"")!==expectedAddress)return {ok:false,status:400,error:"PRIVY_WALLET_ADDRESS_MISMATCH"};
  const signers=Array.isArray(remote?.additional_signers)?remote.additional_signers:[];
  const signer=signers.find((x:any)=>String(x?.signer_id??x?.id??"")===expectedSigner);
  const policies=[...(Array.isArray(remote?.policy_ids)?remote.policy_ids:[]),...(Array.isArray(signer?.override_policy_ids)?signer.override_policy_ids:[])].map(String);
  if(!signer)return {ok:false,status:400,error:"RESTRICTED_SIGNER_NOT_GRANTED_BY_USER"};
  if(!policies.includes(String(expectedPolicy)))return {ok:false,status:400,error:"REQUIRED_TRADING_POLICY_NOT_GRANTED"};
  return {ok:true,provider,remote};
}
app.post("/v1/me/wallets/:id/enable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  if(wallet.chain!=="SOLANA")return res.status(400).json({error:"AUTOMATION_CHAIN_NOT_IMPLEMENTED"});
  const privyWalletId=String(req.body?.privyWalletId??"").trim();
  if(!privyWalletId)return res.status(400).json({error:"PRIVY_WALLET_ID_REQUIRED"});
  const check=await verifyPrivyDelegation(privyWalletId,wallet.address);
  if(!check.ok)return res.status(check.status).json({error:check.error});
  const expiryRaw=req.body?.permissionExpiry;const expiry=expiryRaw?new Date(String(expiryRaw)):new Date(Date.now()+30*24*60*60_000);
  if(!Number.isFinite(expiry.getTime())||expiry<=new Date())return res.status(400).json({error:"INVALID_PERMISSION_EXPIRY"});
  const updated=await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry}});
  await audit(req.user.sub,"USER","ENABLE_DELEGATED_TRADING",wallet.id,{provider:"PRIVY",permissionExpiry:expiry.toISOString()});
  res.json({wallet:{id:updated.id,chain:updated.chain,address:updated.address,tradingEnabled:true,permissionExpiry:updated.permissionExpiry}});
}));
// ------------------------ EMBEDDED WALLET (created + delegated client-side via Privy, never a
// plaintext key/seed touching this backend) ------------------------
// The client already: (1) created a Privy embedded Solana wallet for the logged-in user via
// useCreateWallet, (2) granted MemeCloud's restricted signer+policy via useSigners().addSigners.
// This endpoint independently re-verifies both facts against Privy's own API (verifyPrivyDelegation
// above) before ever creating a Wallet row or marking it tradingEnabled -- the client's report of
// its own success is never trusted on its own.
app.post("/v1/me/wallets/embedded", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const privyWalletId=String(req.body?.privyWalletId??"").trim();
  const address=String(req.body?.address??"").trim();
  if(!privyWalletId||!address)return res.status(400).json({error:"PRIVY_WALLET_ID_AND_ADDRESS_REQUIRED"});
  const check=await verifyPrivyDelegation(privyWalletId,address);
  if(!check.ok)return res.status(check.status).json({error:check.error});
  // Ownership must be checked BEFORE any write -- upserting straight through would silently
  // re-point another user's existing wallet row at this request's delegation if the address
  // somehow already belonged to someone else (practically unreachable for a freshly Privy-
  // generated keypair, but a real cross-account correctness bug if it were ever possible).
  const existing=await db.wallet.findUnique({where:{chain_address:{chain:"SOLANA",address}}});
  if(existing&&existing.userId!==req.user.sub)return res.status(409).json({error:"WALLET_ALREADY_LINKED_TO_ANOTHER_ACCOUNT"});
  const expiry=new Date(Date.now()+30*24*60*60_000);
  const count=await db.wallet.count({where:{userId:req.user.sub}});
  const wallet=await db.wallet.upsert({
    where:{chain_address:{chain:"SOLANA",address}},
    create:{userId:req.user.sub,chain:"SOLANA",address,isPrimary:count===0,label:"MemeCloud wallet",tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry},
    update:{tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry}
  });
  await audit(req.user.sub,"USER","CREATE_EMBEDDED_WALLET",wallet.id,{provider:"PRIVY",permissionExpiry:expiry.toISOString()});
  res.status(201).json({wallet:{id:wallet.id,chain:wallet.chain,address:wallet.address,isPrimary:wallet.isPrimary,tradingEnabled:true,permissionExpiry:wallet.permissionExpiry}});
}));
app.post("/v1/me/wallets/:id/disable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:false,permissionRef:null,permissionExpiry:null}});
  await db.globalTradingSettings.updateMany({where:{userId:req.user.sub},data:{autoCopyEnabled:false}});
  await audit(req.user.sub,"USER","REVOKE_DELEGATED_TRADING",wallet.id);res.json({ok:true});
}));

// ------------------------ WALLET TRANSACTION HISTORY (real on-chain reads) ------------------------
app.get("/v1/me/wallets/:id/history", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub,chain:"SOLANA"}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const marketCfg=await getConfig<any>("marketData");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[api]");
  if(!rpc)return res.json({transactions:[],rpcConfigured:false});
  const conn=new Connection(rpc,"confirmed");
  const usdcMint=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  let sigs;
  try{
    sigs=await conn.getSignaturesForAddress(new PublicKey(wallet.address),{limit:20});
  }catch(e:any){
    // The RPC IS configured (checked above) -- this is a live call failing, most likely the
    // documented Helius rate-limit/quota exhaustion. Distinct from "not configured" so the client
    // shows an honest "temporarily unavailable" state instead of a misleading configuration error,
    // and distinct from a raw 500 so a genuine backend bug isn't masked as an external outage.
    return res.json({transactions:[],rpcConfigured:true,rpcError:String(e?.message??e)});
  }
  const transactions=await Promise.all(sigs.map(async s=>{
    if(s.err)return {signature:s.signature,blockTime:s.blockTime,status:"FAILED" as const};
    try{
      const tx=await conn.getParsedTransaction(s.signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
      if(!tx||!tx.meta)return {signature:s.signature,blockTime:s.blockTime,status:"UNKNOWN" as const};
      const idx=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey.toBase58()===wallet.address);
      const solDeltaSol=idx>=0?(tx.meta.postBalances[idx]-tx.meta.preBalances[idx])/1e9:0;
      const usdcOf=(rows:typeof tx.meta.preTokenBalances)=>(rows??[]).filter(b=>b.owner===wallet.address&&b.mint===usdcMint).reduce((a,b)=>a+Number(b.uiTokenAmount.amount||0),0);
      const usdcDelta=(usdcOf(tx.meta.postTokenBalances)-usdcOf(tx.meta.preTokenBalances))/1e6;
      return {signature:s.signature,blockTime:s.blockTime,status:"CONFIRMED" as const,solDeltaSol,usdcDelta,feeSol:(tx.meta.fee??0)/1e9};
    }catch{
      // A transaction this old may have fallen out of the RPC's retained history, or the RPC
      // itself may be rate-limited (documented external Helius blocker) -- surface it honestly as
      // unresolved rather than silently dropping the row or fabricating a delta.
      return {signature:s.signature,blockTime:s.blockTime,status:"UNKNOWN" as const};
    }
  }));
  res.json({transactions,rpcConfigured:true});
}));

// ------------------------ WALLET SEND (real on-chain transfer, signed via the same delegated
// Privy signer already used for trade execution) ------------------------
app.post("/v1/me/wallets/:id/send", auth, tradeLimiter, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub,chain:"SOLANA"}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const permitted=wallet.tradingEnabled&&wallet.permissionRef&&(!wallet.permissionExpiry||wallet.permissionExpiry>new Date());
  if(!permitted)return res.status(409).json({error:"TRADING_PERMISSION_REQUIRED",message:"This wallet has no active delegated signing permission, so MemeCloud cannot sign a send on its behalf."});

  const asset=String(req.body?.asset??"").toUpperCase();
  if(asset!=="SOL"&&asset!=="USDC")return res.status(400).json({error:"INVALID_ASSET"});
  const toAddressRaw=String(req.body?.toAddress??"").trim();
  const amount=Number(req.body?.amount??0);
  const clientRequestId=String(req.body?.clientRequestId??"").trim();
  if(!clientRequestId||!/^[a-zA-Z0-9-]{8,64}$/.test(clientRequestId))return res.status(400).json({error:"CLIENT_REQUEST_ID_REQUIRED"});
  if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"INVALID_AMOUNT"});
  if(toAddressRaw===wallet.address)return res.status(400).json({error:"CANNOT_SEND_TO_SELF"});
  let toPubkey:PublicKey;
  try{toPubkey=new PublicKey(toAddressRaw)}catch{return res.status(400).json({error:"INVALID_DESTINATION_ADDRESS"})}

  const marketCfg=await getConfig<any>("marketData");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[api]");
  if(!rpc)return res.status(409).json({error:"SOLANA_RPC_REQUIRED"});
  const signerCfg=await getConfig<any>("signer");
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID,privyAppSecret=signerCfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const privyAuthKey=signerCfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  if(!privyAppId||!privyAppSecret)return res.status(503).json({error:"DELEGATED_SIGNER_NOT_CONFIGURED"});
  const sponsorGas=Boolean(signerCfg?.sponsorGas);
  const privy=new PrivySolanaSigner({appId:privyAppId,appSecret:privyAppSecret,authorizationPrivateKey:privyAuthKey,sponsorGas});
  // Only used for its generic waitConfirmed() (a plain signature-status poll, no Jupiter API call
  // involved) -- same shared execution utility the manual-trade route already constructs, not a
  // Jupiter-specific step for a plain transfer.
  const execCfg=await getConfig<any>("execution");
  const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);

  const key=`send:${req.user.sub}:${clientRequestId}`;
  const fromPubkey=new PublicKey(wallet.address);
  const usdcMint=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  try{
    const conn=new Connection(rpc,"confirmed");

    // Idempotent resume: an existing attempt for this exact client request either already has a
    // hash (return it) or is ambiguous and must be reconciled via Privy's own reference lookup
    // before ever considering a resubmit -- never a blind retry of a real-money transfer.
    const existing=await db.liveExecutionAttempt.findUnique({where:{idempotencyKey:key}});
    if(existing){
      if(existing.status==="CONFIRMED"&&existing.txHash)return res.status(200).json({ok:true,txHash:existing.txHash});
      const ref=existing.idempotencyKey.slice(0,64);
      const recovered=existing.txHash||await recoverManualPrivyHash(privy,ref);
      if(!recovered)return res.status(409).json({error:"AMBIGUOUS_PRIOR_SEND_ATTEMPT",message:"A previous send for this exact request has no confirmed result yet and cannot be safely resubmitted. Try again shortly."});
      await db.liveExecutionAttempt.update({where:{id:existing.id},data:{status:"SUBMITTED",txHash:recovered}});
      await jupiter.waitConfirmed(rpc,recovered,60_000);
      await db.liveExecutionAttempt.update({where:{id:existing.id},data:{status:"CONFIRMED",txHash:recovered}});
      await audit(req.user.sub,"USER","WALLET_SEND",wallet.id,{asset,toAddress:toAddressRaw,amount,txHash:recovered});
      return res.status(200).json({ok:true,txHash:recovered});
    }

    const instructions=[];
    if(asset==="SOL"){
      const lamports=Math.round(amount*1_000_000_000);
      const balance=await conn.getBalance(fromPubkey,"confirmed");
      const feeReserveLamports=sponsorGas?0:10_000;
      if(lamports+feeReserveLamports>balance)return res.status(409).json({error:"INSUFFICIENT_BALANCE",message:"This wallet does not have enough SOL to cover the amount plus network fees."});
      // Real gap found by audit: a partial send that leaves the source account below Solana's
      // rent-exempt minimum (~0.00089 SOL) isn't caught up front -- it either fails on-chain with a
      // confusing error, or silently gets rejected by the RPC. Leaving exactly 0 (a full sweep) is
      // fine; anything else below the minimum is refused clearly before ever building the tx.
      const remainingLamports=balance-lamports-feeReserveLamports;
      const RENT_EXEMPT_MIN_LAMPORTS=890_880;
      if(remainingLamports>0&&remainingLamports<RENT_EXEMPT_MIN_LAMPORTS)return res.status(409).json({error:"LEAVES_DUST_BELOW_RENT_EXEMPTION",message:`Sending this amount would leave a tiny leftover balance Solana doesn't allow (below the rent-exempt minimum). Send the full balance instead, or a smaller amount.`});
      instructions.push(SystemProgram.transfer({fromPubkey,toPubkey,lamports}));
    }else{
      const amountRaw=BigInt(Math.round(amount*1_000_000));
      const mint=new PublicKey(usdcMint);
      const sourceAta=await getAssociatedTokenAddress(mint,fromPubkey);
      const destAta=await getAssociatedTokenAddress(mint,toPubkey);
      // Real bug found by a full-platform audit: catching every failure here as null (-> treated
      // as a genuine $0 balance) conflated two very different facts -- "this wallet's USDC token
      // account has never been created, so it really does hold zero" (legitimate, common, safe to
      // treat as 0) vs. "the RPC call itself failed" (rate-limit/timeout/network -- balance is
      // UNKNOWN, not zero). The second case was silently telling real, funded users they had
      // insufficient balance. Only a genuine "account does not exist" response means real zero.
      let sourceRaw:bigint;
      let destInfo:Awaited<ReturnType<typeof conn.getAccountInfo>>;
      try{
        const [sourceBalance,dest]=await Promise.all([
          conn.getTokenAccountBalance(sourceAta,"confirmed").catch((e:any)=>{
            const msg=String(e?.message??e??"");
            if(/could not find account|invalid param|account.*not.*found/i.test(msg))return {value:{amount:"0"}} as any;
            throw e;
          }),
          conn.getAccountInfo(destAta,"confirmed")
        ]);
        sourceRaw=BigInt(sourceBalance?.value?.amount??"0");
        destInfo=dest;
      }catch(e:any){
        return res.status(503).json({error:"BALANCE_CHECK_FAILED",message:"MemeCloud could not verify this wallet's USDC balance right now (the Solana RPC provider may be rate-limited). Please try again shortly."});
      }
      if(amountRaw>sourceRaw)return res.status(409).json({error:"INSUFFICIENT_BALANCE",message:"This wallet does not have enough USDC to cover this amount."});
      if(!destInfo){
        // Recipient has no USDC token account yet -- this wallet pays to create it (standard
        // practice; costs a small amount of rent-exempt SOL), same as any real Solana wallet app.
        const solBalance=await conn.getBalance(fromPubkey,"confirmed");
        if(solBalance<3_000_000)return res.status(409).json({error:"INSUFFICIENT_SOL_FOR_ATA",message:"The recipient has no USDC account yet and this wallet needs a small amount of SOL to create one."});
        instructions.push(createAssociatedTokenAccountInstruction(fromPubkey,destAta,toPubkey,mint));
      }
      instructions.push(createTransferInstruction(sourceAta,destAta,fromPubkey,amountRaw));
    }

    const {blockhash}=await conn.getLatestBlockhash("confirmed");
    const message=new TransactionMessage({payerKey:fromPubkey,recentBlockhash:blockhash,instructions}).compileToV0Message();
    const built=Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

    await db.liveExecutionAttempt.create({data:{idempotencyKey:key,userId:req.user.sub,purpose:"SEND",chain:"SOLANA",walletAddress:wallet.address,provider:"PRIVY",providerRef:wallet.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
    let hash:string;
    try{
      const sent=await privy.signAndSend(wallet.permissionRef!,built,key.slice(0,64));
      hash=sent.hash;
      await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"SUBMITTED",txHash:hash}});
    }catch(e:any){
      const recovered=await recoverManualPrivyHash(privy,key.slice(0,64));
      if(!recovered){
        await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_SEND_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
        await db.riskIncident.create({data:{severity:"CRITICAL",scope:"LIVE_EXECUTION",userId:req.user.sub,chain:"SOLANA",code:String(e?.code??"AMBIGUOUS_SEND_ATTEMPT"),detail:{message:String(e?.message??e),referenceId:key.slice(0,64),asset,toAddress:toAddressRaw,amount}}}).catch(()=>{});
        return res.status(502).json({error:"SEND_SUBMIT_FAILED",message:"MemeCloud could not confirm whether this send reached Solana. It has not been retried automatically."});
      }
      hash=recovered;
      await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"SUBMITTED",txHash:hash}}).catch(()=>{});
    }
    await jupiter.waitConfirmed(rpc,hash,60_000);
    await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"CONFIRMED",txHash:hash}});
    await audit(req.user.sub,"USER","WALLET_SEND",wallet.id,{asset,toAddress:toAddressRaw,amount,txHash:hash});
    res.status(200).json({ok:true,txHash:hash});
  }catch(e:any){
    res.status(409).json({error:e?.code||"SEND_FAILED",message:e?.message||"This send could not be completed."});
  }
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
  // Every failure path here used to dead-end with a raw status/text response rendered on the API
  // domain itself -- the user is left staring at meme-api.xaucloud.io with no way back into the
  // app. Every path below must redirect back to the frontend's Account view with a safe, specific,
  // non-raw reason instead, matching the same-shape success redirect at the bottom of this route.
  const appUrl=process.env.NEXT_PUBLIC_APP_URL??configuredOrigins[0]??"/";
  const failRedirect=(reason:string)=>res.redirect(`${appUrl}/app/?view=profile&x=error&reason=${encodeURIComponent(reason)}`);
  const state=String(req.query.state??""), code=String(req.query.code??"");
  if(req.query.error) return failRedirect("X connection cancelled");
  const row=await db.oAuthState.findUnique({where:{stateHash:hashToken(state)}});
  if(!row||row.provider!=="X"||row.expiresAt<new Date()) return failRedirect("X authorization expired");
  const {verifier}=decryptJson<{verifier:string}>(row.verifierEnc);
  const socialCfg=await getConfig<any>("social");
  const clientId=socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID, callback=socialCfg?.xOAuthCallbackUrl||process.env.X_OAUTH_CALLBACK_URL;
  const clientSecret=socialCfg?.xOAuthClientSecret||process.env.X_OAUTH_CLIENT_SECRET;
  if(!clientId||!callback) return failRedirect("Unable to link X right now");
  const body=new URLSearchParams({code,grant_type:"authorization_code",redirect_uri:callback,code_verifier:verifier,client_id:clientId});
  const headers:Record<string,string>={"content-type":"application/x-www-form-urlencoded"};
  if(clientSecret) headers.authorization=`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const tokenRes=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers,body,signal:AbortSignal.timeout(8000)});
  if(!tokenRes.ok){ await db.oAuthState.delete({where:{id:row.id}}).catch(()=>{}); return failRedirect("Unable to link X right now"); }
  const tokens:any=await tokenRes.json();
  const meRes=await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,name,username",{headers:{authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(8000)});
  if(!meRes.ok){ await db.oAuthState.delete({where:{id:row.id}}).catch(()=>{}); return failRedirect("Unable to link X right now"); }
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
  // Same authoritative status computeLiveReadiness/Settings uses -- the overview hero must never
  // show its own separately-derived guess of execution state again (that's exactly how "Execution:
  // SIMULATION" / "Live trading enabled" ended up contradicting each other in production: two
  // different endpoints each doing their own partial read of the underlying gates).
  const liveReadiness=await computeLiveReadiness();
  res.json({
    metrics:{
      users:{registered:registeredUsers,active:activeUsers,newToday,newWeek,verified:verifiedUsers,walletConnected:walletUsers,autoCopyEnabled:autoCopyUsers},
      trading:{openPositions,ordersToday,buysToday:buyOrders,sellsToday:sellOrders,liveOrders,simulationOrders,realizedPnlUsd:livePnl._sum.realizedPnlUsd,unrealizedPnlUsd:livePnl._sum.unrealizedPnlUsd,allocatedCashUsd:(cash._sum.availableUsd??0)+(cash._sum.inTradesUsd??0)},
      smartTraders:{platform:platformTraders,candidates,paperTracked:paperCandidates,proven:provenCandidates,rejected:rejectedCandidates,averageCopyability:averageCopyability._avg.copyabilityScore},
      discovery:{watchedTokens:discoveryTokens,opportunitiesToday:newTokensToday},
      engine:{signals,signalsToday,buyDecisions,waitDecisions,skipDecisions}
    },
    executionMode:liveReadiness.actualRuntimeMode.toLowerCase(),
    liveExecutionEnabled:liveReadiness.newEntriesLive,
    liveTradingRequested:liveReadiness.liveTradingEnabled,
    liveReadiness,
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
  const now=Date.now();
  const [opportunities,mostRecentlyEvaluated]=await Promise.all([
    db.globalBrainOpportunity.findMany({
      where:{
        // Real bug found by audit, surfaced by a live 20+ hour outage (Helius RPC quota exhausted
        // -> market-worker stalled -> brain-worker had nothing fresh to evaluate): every row's
        // lastEvaluatedAt is touched on every 750ms tick regardless of whether it currently has
        // live evidence, so in healthy operation this filter is close to a no-op -- it only
        // actually excludes data during an extended pipeline outage exactly like this one, which is
        // precisely when a user most needs to still see the last real, meaningful evidence instead
        // of a bare empty list. Widened so genuine outages don't erase the feed entirely;
        // pipelineDegraded below is what actually tells the client this isn't live right now.
        lastEvaluatedAt:{gte:new Date(now-48*60*60_000)},
        OR:[
          {inflow60sUsd:{gt:0}},
          {buyers60s:{gt:0}},
          {whaleBuyers60s:{gt:0}},
          {knownWhaleBuyers60s:{gt:0}},
          {firstSeenAt:{gte:new Date(now-10*60_000)}}
        ]
      },
      orderBy:[{score:"desc"},{lastEvaluatedAt:"desc"}],take:150
    }),
    // Deliberately unfiltered by the 6h window above -- this is the real signal of whether the
    // Brain's scoring loop is actually running at all right now, independent of whether any
    // individual token happened to qualify. An empty `opportunities` array is ambiguous on its
    // own (it could mean "pipeline dead" or "genuinely nothing interesting right now"); this
    // resolves that ambiguity so the client can tell users the real reason instead of a bare,
    // unexplained empty state.
    db.globalBrainOpportunity.findFirst({orderBy:{lastEvaluatedAt:"desc"},select:{lastEvaluatedAt:true}})
  ]);
  const dataFreshnessSec=mostRecentlyEvaluated?Math.round((now-mostRecentlyEvaluated.lastEvaluatedAt.getTime())/1000):null;
  // 5 minutes matches the same chain-data-freshness bar already used for live-trading readiness
  // elsewhere in this file -- the Brain loop runs every 750ms when healthy, so anything idle this
  // long means its upstream data (MemeMarketSnapshot, itself dependent on the Solana RPC) has
  // stalled, not that the loop is just between ticks.
  const pipelineDegraded=dataFreshnessSec===null||dataFreshnessSec>300;
  res.json({watching:true,opportunities:opportunities.map(o=>({...o,lifecycleStatus:classifyLifecycle(o,now)})),pipelineDegraded,dataFreshnessSec});
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

// ------------------------ SMART WALLETS (public) ------------------------
// Real evidence only, from packages/discovery's sample-size-aware scoring (shouldPaperTrack
// requires >=15 observed trades, shouldProve requires >=20 forward signals) -- never a label from
// one lucky trade. Whale status (walletTier in flow-worker) is a separate signal from trading skill
// and is surfaced as its own field, not conflated with copyabilityScore.
function smartWalletSummary(c:any){
  const winRatePct=c.sampleTrades>0?Math.round((c.profitableTrades/c.sampleTrades)*1000)/10:null;
  const isWhale=String(c.label??"").startsWith("WHALE_");
  return {
    id:c.id,chain:c.chain,address:c.address,stage:c.stage,
    isWhale,whaleTier:isWhale?c.label:null,
    copyabilityScore:c.copyabilityScore,sourceQualityScore:c.sourceQualityScore,riskScore:c.riskScore,consistencyScore:c.consistencyScore,entryQualityScore:c.entryQualityScore,
    sampleTrades:c.sampleTrades,profitableTrades:c.profitableTrades,
    winRatePct, // null = not enough resolved trades yet to compute -- never shown as 0%
    realizedPnlUsd:c.realizedPnlUsd,totalPnlUsd:c.totalPnlUsd,volumeUsd:c.volumeUsd,
    averageWinnerPct:c.averageWinnerPct??null,averageLoserPct:c.averageLoserPct??null,
    rugExposurePct:c.rugExposurePct??null,insiderRiskPct:c.insiderRiskPct??null,
    source:c.source,sourceToken:c.sourceToken,
    firstDiscoveredAt:c.createdAt,lastScoredAt:c.lastScoredAt,lastActivityAt:c.updatedAt,
    paperStartedAt:c.paperStartedAt,provenAt:c.provenAt
  };
}
app.get("/v1/smart-wallets", asyncRoute(async (req,res) => {
  const stageParam=String(req.query.stage??"").toUpperCase();
  const includeWhalesOnly=String(req.query.whales??"")==="true";
  const where:any={stage:stageParam&&["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN","PAUSED"].includes(stageParam)?stageParam:{in:["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN"]}};
  if(includeWhalesOnly)where.label={startsWith:"WHALE_"};
  const [candidates,mostRecentlyScored]=await Promise.all([
    db.smartWalletCandidate.findMany({where,orderBy:[{copyabilityScore:"desc"},{updatedAt:"desc"}],take:200}),
    // Same gap found and fixed on /v1/brain/feed this session, found here too by a full-platform
    // audit before it ever got reported live: with zero freshness signal, this list looks equally
    // "live" whether scoring-worker (10min tick, round-robins the whole candidate set) is healthy
    // or has been stalled for hours -- unfiltered by design (a candidate's score staying visible
    // while stale is fine, that's just this list's own scores aging normally), but the client
    // should still be able to tell "not yet run in a while" from "actively scoring."
    db.smartWalletCandidate.findFirst({orderBy:{lastScoredAt:"desc"},select:{lastScoredAt:true}})
  ]);
  const dataFreshnessSec=mostRecentlyScored?.lastScoredAt?Math.round((Date.now()-mostRecentlyScored.lastScoredAt.getTime())/1000):null;
  // 30 minutes, not brain/feed's 5 -- scoring-worker's own healthy cadence is a 10min tick
  // round-robining 50 candidates at a time, so normal operation alone can leave any single
  // candidate's lastScoredAt lagging by more than one tick.
  const pipelineDegraded=dataFreshnessSec===null||dataFreshnessSec>1800;
  res.json({wallets:candidates.map(smartWalletSummary),pipelineDegraded,dataFreshnessSec});
}));
app.get("/v1/smart-wallets/:id", asyncRoute(async (req,res) => {
  const candidate=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});
  if(!candidate)return res.status(404).json({error:"SMART_WALLET_NOT_FOUND"});
  const recentFlow=await db.chainFlowObservation.findMany({where:{chain:candidate.chain,walletAddress:candidate.address},orderBy:{observedAt:"desc"},take:40});
  // Real, currently-tracked tokens for this wallet -- derived from its own recent observed activity,
  // not a separate unverified list.
  const currentTokens=[...new Map(recentFlow.map(f=>[f.mint,f])).values()].slice(0,10).map(f=>({mint:f.mint,chain:f.chain,side:f.side,lastSeenAt:f.observedAt}));
  res.json({wallet:smartWalletSummary(candidate),recentActivity:recentFlow,currentTokens});
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
// Verified 2026-08-29 against every current consumer (services/listener, executor, exits,
// market-worker, balance-worker, paper-worker, discovery-worker, scoring-worker, flow-worker,
// brain-worker): every key that once required a restart is now re-read on a live timer or fresh
// every cycle/tick (executor/exits/paper-worker on a 60s reloadConfig timer; market-worker,
// balance-worker, listener, flow-worker per-cycle; discovery-worker, scoring-worker fresh inside
// each scan; brain-worker fresh every 750ms tick). "chains" was never cached anywhere -- only
// /v1/public/config reads it, fresh on every request. This set is intentionally empty; if a future
// worker introduces a genuinely startup-only config read, add its key back here (and say why).
const RESTART_REQUIRED_KEYS=new Set<string>([]);
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
// HTTP 429 means rate limiting, not an invalid key -- it must never be reported or treated the
// same as a genuine credential rejection. This is the single place every provider test classifies
// a response, so "check your token" only ever appears when a provider actually said the
// credential itself was rejected (401/403).
function classifyHttp(status:number):ProviderState{
  if(status===429) return "RATE_LIMITED";
  if(status===401||status===403) return "INVALID_CREDENTIALS";
  if(status>=500) return "PROVIDER_UNAVAILABLE";
  if(status>=200&&status<300) return "CONNECTED";
  return "UNKNOWN";
}
function classifyError(e:Error):ProviderState{
  return /timed out/i.test(e?.message||"")?"TIMEOUT":"NETWORK_ERROR";
}
function stateMessage(state:ProviderState,provider:string,httpStatus?:number,detail?:string):string{
  switch(state){
    case "RATE_LIMITED":return `${provider} rate limited MemeCloud (HTTP 429). This is a temporary quota limit, not an invalid credential -- the last verified connection remains trusted.`;
    case "INVALID_CREDENTIALS":return `${provider} rejected the credential (HTTP ${httpStatus}).${detail?` ${detail}`:""}`;
    case "PROVIDER_UNAVAILABLE":return `${provider} returned a server error (HTTP ${httpStatus}) -- this looks like a provider-side outage, not a configuration problem.`;
    case "TIMEOUT":return `${provider} did not respond before the request timed out.`;
    case "NETWORK_ERROR":return `Could not reach ${provider}: ${detail||"network error"}.`;
    case "UNKNOWN":return `${provider} responded with HTTP ${httpStatus}.${detail?` ${detail}`:""}`;
    default:return `${provider} is not configured yet.`;
  }
}
function result(state:ProviderState,message:string,extra:{httpStatus?:number;latencyMs?:number}={}):TestResult{
  return {ok:state==="CONNECTED",state,message,httpStatus:extra.httpStatus,latencyMs:extra.latencyMs,checkedAt:new Date().toISOString()};
}
async function testJupiter(cfg:any):Promise<TestResult>{
  const base=(cfg?.jupiterBaseUrl||"https://api.jup.ag").replace(/\/$/,"");
  const usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",wsol="So11111111111111111111111111111111111111112";
  // Same path/headers as the live JupiterExecution class (packages/execution) — this must test
  // the exact route real trades use, not a stale/guessed one.
  const url=`${base}/swap/v1/quote?inputMint=${wsol}&outputMint=${usdc}&amount=10000000&slippageBps=100`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:cfg?.jupiterApiKey?{"x-api-key":cfg.jupiterApiKey}:{}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Jupiter",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","Jupiter returned a real executable quote.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Jupiter",r!.status),{httpStatus:r!.status,latencyMs});
}
async function testZeroX(cfg:any):Promise<TestResult>{
  if(!cfg?.zeroXApiKey) return result("NOT_CONFIGURED","No 0x API key is saved yet.");
  const weth="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const url=`https://api.0x.org/swap/permit2/price?chainId=1&sellToken=${weth}&buyToken=${usdc}&sellAmount=1000000000000000`;
  const {r,latencyMs,error}=await timedFetch(url,{headers:{"0x-api-key":cfg.zeroXApiKey,"0x-version":"v2"}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"0x",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","0x returned a real price quote.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"0x",r!.status,state==="INVALID_CREDENTIALS"?"Check the API key.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testSolanaRpc(cfg:any):Promise<TestResult>{
  const rpc=cfg?.solanaRpc||cfg?.heliusRpc;
  if(!rpc) return result("NOT_CONFIGURED","No Solana RPC URL is saved yet.");
  const {r,latencyMs,error}=await timedFetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Solana RPC",undefined,error.message),{latencyMs});
  if(r!.status===429) return result("RATE_LIMITED",stateMessage("RATE_LIMITED","Solana RPC"),{httpStatus:r!.status,latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result("CONNECTED","Solana RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Solana RPC",r!.status,body?.error?.message),{httpStatus:r!.status,latencyMs});
}
async function testBirdeye(cfg:any):Promise<TestResult>{
  if(!cfg?.birdeyeApiKey) return result("NOT_CONFIGURED","No Birdeye API key is saved yet.");
  const {r,latencyMs,error}=await timedFetch(`https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`,{headers:{"accept":"application/json","X-API-KEY":cfg.birdeyeApiKey,"x-chain":"solana"}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Birdeye",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","Birdeye accepted the API key.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Birdeye",r!.status,state==="INVALID_CREDENTIALS"?"Check the API key.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testHelius(cfg:any):Promise<TestResult>{
  if(!cfg?.heliusApiKey) return result("NOT_CONFIGURED","No Helius API key is saved yet.");
  // Tests the key directly against Helius's real RPC, independent of whatever ended up in
  // heliusRpc — this is what actually validates the saved key, not just a URL string.
  const url=`https://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;
  const {r,latencyMs,error}=await timedFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Helius",undefined,error.message),{latencyMs});
  if(r!.status===429) return result("RATE_LIMITED",stateMessage("RATE_LIMITED","Helius"),{httpStatus:r!.status,latencyMs});
  const body=await r!.json().catch(()=>null);
  if(r!.ok&&body?.result==="ok") return result("CONNECTED","Helius RPC responded healthy.",{httpStatus:r!.status,latencyMs});
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"Helius",r!.status),{httpStatus:r!.status,latencyMs});
}
async function testX(cfg:any):Promise<TestResult>{
  if(!cfg?.xBearerToken) return result("NOT_CONFIGURED","No X bearer token is saved yet.");
  const {r,latencyMs,error}=await timedFetch("https://api.x.com/2/tweets/search/recent?query=test&max_results=10",{headers:{authorization:`Bearer ${cfg.xBearerToken}`}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"X API",undefined,error.message),{latencyMs});
  if(r!.ok) return result("CONNECTED","X API accepted the bearer token.",{httpStatus:r!.status,latencyMs});
  // X's free/basic search tier has an extremely tight rate limit -- 429 here is routine and must
  // never be read as "the token is bad." Only 401/403 actually proves the token itself is rejected.
  const state=classifyHttp(r!.status);
  return result(state,stateMessage(state,"X API",r!.status,state==="INVALID_CREDENTIALS"?"Check the bearer token.":undefined),{httpStatus:r!.status,latencyMs});
}
async function testPrivy(cfg:any):Promise<TestResult>{
  if(!cfg?.privyAppId||!cfg?.privyAppSecret) return result("NOT_CONFIGURED","Privy App ID and App Secret are both required.");
  const auth=Buffer.from(`${cfg.privyAppId}:${cfg.privyAppSecret}`).toString("base64");
  // Privy rejects every request with HTTP 400 unless privy-app-id is ALSO set as its own header,
  // in addition to the Basic-auth credentials — Basic auth alone is not sufficient. This mirrors
  // the header packages/providers already sends for the real signing calls (transactionByReferenceId);
  // this test endpoint was the one place that omitted it, which is what actually produced the 400,
  // not invalid App ID/Secret.
  const {r,latencyMs,error}=await timedFetch(`https://api.privy.io/v1/apps/${cfg.privyAppId}`,{headers:{authorization:`Basic ${auth}`,"privy-app-id":cfg.privyAppId}});
  if(error) return result(classifyError(error),stateMessage(classifyError(error),"Privy",undefined,error.message),{latencyMs});
  if(r!.ok){
    const missing=["privyAuthorizationPrivateKey","privySignerId","privyPolicyId"].filter(f=>!cfg?.[f]);
    const note=missing.length?` Delegated signing also needs ${missing.join(", ")} — the signer ID and policy ID can only be fully verified once a real user connects a wallet and grants them, not from this app-level check.`:" Authorization key, signer ID, and policy ID are saved but can only be fully verified once a real user connects a wallet and grants them (they're scoped per-wallet, not per-app).";
    return result("CONNECTED",`Privy accepted the App ID and Secret.${note}`,{httpStatus:r!.status,latencyMs});
  }
  // Surface Privy's own sanitized reason instead of guessing "check App ID/Secret" for every 400 —
  // Privy's error body describes what's actually wrong with the request (e.g. a missing header,
  // a malformed key), which is frequently not a credential problem at all.
  const body=await r!.json().catch(()=>null);
  const reason=body?.error||body?.message||`HTTP ${r!.status}`;
  const state=classifyHttp(r!.status);
  return result(state,state==="RATE_LIMITED"?stateMessage(state,"Privy"):`Privy rejected the request: ${reason}`,{httpStatus:r!.status,latencyMs});
}
const EXPECTED_CHAIN_ID:Record<string,string>={BNB:"0x38",Ethereum:"0x1"};
async function testWebSocket(url:string,label:string):Promise<TestResult>{
  if(!url) return result("NOT_CONFIGURED",`No ${label} WebSocket URL is saved yet.`);
  const started=Date.now();
  const expected=EXPECTED_CHAIN_ID[label];
  return new Promise<TestResult>((resolve)=>{
    let done=false,ws:WebSocket;
    const finish=(r:TestResult)=>{if(done)return;done=true;clearTimeout(timer);try{ws?.close()}catch{}resolve(r)};
    const timer=setTimeout(()=>finish(result("TIMEOUT",`${label} WebSocket timed out.`,{latencyMs:Date.now()-started})),8000);
    try{ws=new WebSocket(url)}catch(e:any){clearTimeout(timer);return resolve(result("NETWORK_ERROR",e?.message||`${label} WebSocket failed to connect.`))}
    // A socket that merely opens proves reachability, not the right chain — confirm via a real
    // eth_chainId JSON-RPC call so a reachable-but-wrong-network endpoint fails verification.
    ws.onopen=()=>{try{ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}))}catch(e:any){finish(result("NETWORK_ERROR",`${label} WebSocket connected but the chain ID request failed to send.`,{latencyMs:Date.now()-started}))}};
    ws.onmessage=(ev:any)=>{
      const latencyMs=Date.now()-started;
      try{
        const chainId=JSON.parse(String(ev.data))?.result;
        if(!chainId) return finish(result("UNKNOWN",`${label} WebSocket connected but returned no chain ID.`,{latencyMs}));
        if(expected && String(chainId).toLowerCase()!==expected) return finish(result("UNKNOWN",`${label} WebSocket connected but reports chain ID ${chainId} (expected ${expected} for ${label}) — wrong network.`,{latencyMs}));
        finish(result("CONNECTED",`${label} WebSocket connected — chain ID ${chainId} confirmed.`,{httpStatus:200,latencyMs}));
      }catch{
        finish(result("UNKNOWN",`${label} WebSocket connected but sent an unparseable response.`,{latencyMs}));
      }
    };
    ws.onerror=()=>finish(result("NETWORK_ERROR",`${label} WebSocket connection failed.`,{latencyMs:Date.now()-started}));
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
  const [heartbeats,queueCounts,executionState]=await Promise.all([
    db.workerHeartbeat.findMany({orderBy:{name:"asc"}}),
    broadcastQueue.getJobCounts("waiting","active","failed","completed","delayed"),
    readExecutionState()
  ]);
  const now=Date.now();
  res.json({
    services:heartbeats.map(h=>({...h,healthy:now-h.lastBeatAt.getTime()<45_000})),
    queue:{broadcasts:queueCounts},
    database:"healthy",
    redis:await redis.ping().then(()=>"healthy").catch(()=>"unavailable"),
    executionMode:executionState.actualRuntimeMode.toLowerCase(),
    executionState
  });
}));
// One authoritative implementation for Admin, public config, manual trading and the executor.
async function computeLiveReadiness(){return readExecutionState()}

app.get("/v1/admin/live-readiness", requireAdmin, asyncRoute(async (_req,res) => {
  res.json(await computeLiveReadiness());
}));
// Owner-only. This is a NEW-ENTRIES gate, not a global kill switch: only executor's BUY path
// checks the authoritative DB-backed request fresh on every decision (takes effect immediately,
// no env file or VPS restart) before ever constructing a brand-new live position. It deliberately does NOT gate
// services/exits' stop-loss/take-profit or executor's handleSourceSell (source-sell mirroring) —
// both manage positions that are already real purely off each position's own stored mode, so
// turning this OFF cannot leave real money unprotected or trapped. That also means OFF is not
// "nothing real can happen" whenever real positions are already open (see openLivePositions in
// computeLiveReadiness) — the admin UI must always show that distinction explicitly, never imply
// this switch freezes every real code path. Turning it ON always re-verifies the real dependency
// chain first and refuses if anything's not genuinely ready; turning it OFF is unconditional and
// immediate.
app.post("/v1/admin/live-trading/enable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const readiness=await computeLiveReadiness();
  if(!readiness.ready) return res.status(409).json({error:"NOT_READY",reasons:readiness.reasons,blockers:readiness.blockers,executionState:readiness});
  await setConfig("liveTrading",{enabled:true,enabledAt:new Date().toISOString(),enabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_ENABLE","liveTrading",{});
  const executionState=await computeLiveReadiness();
  res.json({ok:true,enabled:executionState.newEntriesLive,requested:true,executionState});
}));
app.post("/v1/admin/live-trading/disable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  await setConfig("liveTrading",{enabled:false,disabledAt:new Date().toISOString(),disabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_DISABLE","liveTrading",{});
  res.json({ok:true,enabled:false,requested:false,executionState:await computeLiveReadiness()});
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
// Real, provider-quota-percentage information isn't programmatically available from Helius with
// what's configured here, so this monitors what actually is available: each worker's own tracked
// rate-limit state (see the rateLimited field added to flow-worker/balance-worker/social-worker
// heartbeats this session). Runs on the same 15-minute cadence as the provider tests above, so a
// single momentary blip can't trigger it -- only a worker still showing rate-limited at the next
// full sampling interval does. Deduped via an unresolved RiskIncident per worker (never spams
// repeatedly) and auto-resolves the moment that worker reports clear again.
const RPC_HEARTBEAT_WORKERS=["solana-flow-scanner","solana-listener","market-worker","balance-worker","social-hype"];
async function checkProviderDegradation(){
  try{
    const heartbeats=await db.workerHeartbeat.findMany({where:{name:{in:RPC_HEARTBEAT_WORKERS}}});
    for(const h of heartbeats){
      const dt:any=h.detail??{};
      const open=await db.riskIncident.findFirst({where:{scope:"PROVIDER_DEGRADED",code:h.name,resolvedAt:{isSet:false}}});
      if(dt.rateLimited){
        if(!open) await db.riskIncident.create({data:{severity:"WARNING",scope:"PROVIDER_DEGRADED",code:h.name,detail:{message:`${h.name} is currently being rate-limited by its RPC/provider.`,snapshot:dt}}});
      }else if(open){
        await db.riskIncident.update({where:{id:open.id},data:{resolvedAt:new Date()}});
      }
    }
  }catch(e){console.error("[background-health] provider degradation check failed",e)}
}
setInterval(()=>{void runBackgroundHealthChecks();void checkProviderDegradation()},15*60_000).unref?.();
setTimeout(()=>{void runBackgroundHealthChecks();void checkProviderDegradation()},30_000).unref?.();

async function apiHeartbeat(){
  await db.workerHeartbeat.upsert({where:{name:"api"},create:{name:"api",status:"healthy",detail:{port} as any,lastBeatAt:new Date()},update:{status:"healthy",detail:{port} as any,lastBeatAt:new Date()}}).catch(()=>{});
}
setInterval(()=>void apiHeartbeat(),15_000); void apiHeartbeat();
app.listen(port,()=>console.log(`[api] listening on :${port}`));
