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
import { db, type Chain, type FollowMode } from "@fomocloud/db";
import { CopySettingsSchema } from "@fomocloud/shared";
import { getConfig, setConfig, redactedConfig, encryptJson, decryptJson } from "@fomocloud/config";
import { sendEmail, sendPush, ensureVapid, publicPushKey } from "@fomocloud/notifications";

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

type TokenPayload = { sub:string; role:"USER"|"ADMIN"|"SUPPORT"; email?:string };
type AuthedRequest = Request<Record<string, string>> & { user: TokenPayload };

const asyncRoute = (fn:(req:any,res:Response,next:NextFunction)=>Promise<any>) =>
  (req:Request,res:Response,next:NextFunction) => { Promise.resolve(fn(req,res,next)).catch(next); };

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
    {expiresIn:accessTtl as any,issuer:"fomocloud-api",audience:"fomocloud-web"}
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
    const payload=jwt.verify(token,jwtSecret,{issuer:"fomocloud-api",audience:"fomocloud-web"}) as TokenPayload;
    (req as AuthedRequest).user=payload;
    next();
  } catch {
    res.status(401).json({error:"UNAUTHORIZED"});
  }
}
function requireAdmin(req:Request,res:Response,next:NextFunction) {
  auth(req,res,()=>{
    const role=(req as AuthedRequest).user.role;
    if(role!=="ADMIN" && role!=="SUPPORT") return res.status(403).json({error:"ADMIN_FORBIDDEN"});
    next();
  });
}
function adminOnly(req:Request,res:Response,next:NextFunction) {
  requireAdmin(req,res,()=>{
    if((req as AuthedRequest).user.role!=="ADMIN") return res.status(403).json({error:"ADMIN_REQUIRED"});
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
    appName:"FomoCloud",
    executionMode:process.env.EXECUTION_MODE??"simulation",
    liveExecutionEnabled:process.env.LIVE_EXECUTION_ENABLED==="true",
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
    await sendEmail(email,"Verify your FomoCloud email",
      `<h2>Verify your email</h2><p>Open this link to verify your account:</p><p><a href="${appUrl}/verify-email/?token=${encodeURIComponent(verifyToken)}">Verify email</a></p>`,
      user.id);
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
  await sendEmail(user.email,"Verify your FomoCloud email",`<h2>Verify your email</h2><p><a href="${appUrl}/verify-email/?token=${encodeURIComponent(token)}">Verify email</a></p>`,user.id);
  res.json({ok:true});
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
    where:{id:session.id,tokenHash:oldHash,revokedAt:null,expiresAt:{gt:new Date()}},
    data:{tokenHash:hashToken(nextRefresh),lastUsedAt:new Date()}
  });
  if(rotated.count!==1) return res.status(401).json({error:"REFRESH_REPLAYED"});
  res.cookie("fomo_refresh",nextRefresh,refreshCookieOptions());
  res.json({accessToken:signAccess(session.user),user:safeUser(session.user)});
}));

app.post("/auth/logout", asyncRoute(async (req,res) => {
  const raw=parseCookies(req).fomo_refresh;
  if(raw) await db.refreshSession.updateMany({where:{tokenHash:hashToken(raw),revokedAt:null},data:{revokedAt:new Date()}});
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
      await sendEmail(user.email,"Reset your FomoCloud password",
        `<h2>Reset your password</h2><p><a href="${appUrl}/reset-password/?token=${encodeURIComponent(token)}">Reset password</a></p>`,
        user.id);
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
    db.refreshSession.updateMany({where:{userId:row.userId,revokedAt:null},data:{revokedAt:new Date()}})
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
  const message=`FomoCloud sign-in\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
  const challenge=await db.walletChallenge.create({
    data:{chain:"SOLANA",address,message,expiresAt:new Date(Date.now()+5*60_000),purpose:"LOGIN"}
  });
  res.json({challengeId:challenge.id,message});
}));

app.post("/auth/wallet/verify", asyncRoute(async (req,res) => {
  const challengeId=String(req.body?.challengeId??"");
  const signature=String(req.body?.signature??"");
  const row=await db.walletChallenge.findUnique({where:{id:challengeId}});
  if(!row||row.chain!=="SOLANA"||row.consumedAt||row.expiresAt<new Date()) return res.status(401).json({error:"CHALLENGE_EXPIRED"});
  let sigBytes:Uint8Array;
  try { sigBytes=signature.startsWith("base64:") ? Buffer.from(signature.slice(7),"base64") : bs58.decode(signature); }
  catch { return res.status(400).json({error:"INVALID_SIGNATURE_ENCODING"}); }
  const ok=nacl.sign.detached.verify(new TextEncoder().encode(row.message),sigBytes,bs58.decode(row.address));
  if(!ok) return res.status(401).json({error:"INVALID_SIGNATURE"});
  const consumed=await db.walletChallenge.updateMany({where:{id:row.id,consumedAt:null,expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
  if(consumed.count!==1) return res.status(401).json({error:"CHALLENGE_ALREADY_USED"});
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
  const message=`FomoCloud link wallet\nAccount: ${req.user.sub}\nWallet: ${address}\nNonce: ${randomToken(24)}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
  const challenge=await db.walletChallenge.create({data:{chain,address,message,purpose:"LINK",userId:req.user.sub,expiresAt:new Date(Date.now()+5*60_000)}});
  res.json({challengeId:challenge.id,message});
}));

app.post("/v1/me/wallets/verify", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const row=await db.walletChallenge.findUnique({where:{id:String(req.body?.challengeId??"")}});
  if(!row||row.userId!==req.user.sub||row.purpose!=="LINK"||row.consumedAt||row.expiresAt<new Date()) return res.status(401).json({error:"CHALLENGE_EXPIRED"});
  const signature=String(req.body?.signature??"");
  let sigBytes:Uint8Array;
  try { sigBytes=signature.startsWith("base64:")?Buffer.from(signature.slice(7),"base64"):bs58.decode(signature); }
  catch { return res.status(400).json({error:"INVALID_SIGNATURE_ENCODING"}); }
  if(!nacl.sign.detached.verify(new TextEncoder().encode(row.message),sigBytes,bs58.decode(row.address)))
    return res.status(401).json({error:"INVALID_SIGNATURE"});
  const consumed=await db.walletChallenge.updateMany({where:{id:row.id,consumedAt:null,expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
  if(consumed.count!==1) return res.status(401).json({error:"CHALLENGE_ALREADY_USED"});
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
    where:{userId:req.user.sub,revokedAt:null,expiresAt:{gt:new Date()}},
    select:{id:true,userAgent:true,ipAddress:true,createdAt:true,lastUsedAt:true,expiresAt:true},
    orderBy:{lastUsedAt:"desc"},take:50
  });
  res.json({sessions});
}));
app.delete("/v1/me/sessions/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.refreshSession.updateMany({where:{id:req.params.id,userId:req.user.sub,revokedAt:null},data:{revokedAt:new Date()}});
  await audit(req.user.sub,"USER","REVOKE_SESSION",req.params.id);
  res.json({ok:true});
}));
app.delete("/v1/me/wallets/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:req.params.id,userId:req.user.sub}});
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
    db.refreshSession.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:new Date()}}),
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
    defaultAmountUsd:Math.max(1,Number(req.body?.defaultAmountUsd??current.defaultAmountUsd)),
    maxAmountPerTradeUsd:Math.max(1,Number(req.body?.maxAmountPerTradeUsd??current.maxAmountPerTradeUsd)),
    maxTotalExposureUsd:Math.max(1,Number(req.body?.maxTotalExposureUsd??current.maxTotalExposureUsd)),
    maxConcurrentPositions:Math.max(1,Math.min(100,Number(req.body?.maxConcurrentPositions??current.maxConcurrentPositions))),
    adaptiveChase:Boolean(req.body?.adaptiveChase??current.adaptiveChase),
    freshMemeMode:Boolean(req.body?.freshMemeMode??current.freshMemeMode),
    runnerMode:Boolean(req.body?.runnerMode??current.runnerMode),
    allowedChains:allowedChains as Chain[]
  };
  if(data.defaultAmountUsd>data.maxAmountPerTradeUsd) return res.status(400).json({error:"DEFAULT_EXCEEDS_MAX_TRADE"});
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
  const selected=Array.isArray(req.body?.traderIds)?req.body.traderIds.map(String).slice(0,50):[];
  const traders=selected.length?await db.trader.findMany({where:{id:{in:selected},kind:"PLATFORM",enabled:true,wallets:{some:{verified:true,chain:"SOLANA"}}},select:{id:true}}):[];
  const settings=await db.globalTradingSettings.upsert({
    where:{userId:req.user.sub},
    create:{userId:req.user.sub,autoCopyEnabled,defaultAmountUsd,maxAmountPerTradeUsd:Math.max(500,defaultAmountUsd)},
    update:{autoCopyEnabled,defaultAmountUsd,maxAmountPerTradeUsd:{set:Math.max(500,defaultAmountUsd)}}
  });
  for(const t of traders){
    await db.userFollow.upsert({
      where:{userId_traderId:{userId:req.user.sub,traderId:t.id}},
      create:{userId:req.user.sub,traderId:t.id,mode:autoCopyEnabled?"AUTO_COPY":"WATCH_ONLY",fixedAmountUsd:defaultAmountUsd,maxPositionUsd:settings.maxAmountPerTradeUsd,maxTotalExposureUsd:settings.maxTotalExposureUsd},
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
  await db.notification.updateMany({where:{userId:req.user.sub,...(ids.length?{id:{in:ids}}:{readAt:null})},data:{readAt:new Date()}});
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

// ------------------------ TRADERS ------------------------
app.get("/v1/traders", asyncRoute(async (_req,res) => {
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM",enabled:true},
    include:{wallets:{where:{verified:true}},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"desc"}],take:200
  });
  res.json({traders});
}));

app.get("/v1/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:req.params.id}}});
  const trader=await db.trader.findFirst({
    where:{id:req.params.id,OR:[{kind:"PLATFORM",enabled:true},{ownerUserId:req.user.sub},{id:follow?.traderId??"000000000000000000000000"}]},
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
  const existing=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:req.params.id}}});
  const trader=await db.trader.findFirst({where:{id:req.params.id,OR:[{kind:"PLATFORM",enabled:true},{ownerUserId:req.user.sub},{id:existing?.traderId??"000000000000000000000000"}]},include:{wallets:true}});
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
  const fixedAmountUsd=Math.max(1,Math.min(defaults.maxAmountPerTradeUsd,Number(req.body?.fixedAmountUsd??existing?.fixedAmountUsd??defaults.defaultAmountUsd)));
  const data={
    mode,
    fixedAmountUsd,
    takeProfitPct:Number(req.body?.takeProfitPct??existing?.takeProfitPct??100),
    stopLossPct:req.body?.stopLossPct===null?null:Number(req.body?.stopLossPct??existing?.stopLossPct??55),
    maxChasePct:Math.max(0,Math.min(55,Number(req.body?.maxChasePct??existing?.maxChasePct??40))),
    maxSlippageBps:Math.max(1,Math.min(5000,Number(req.body?.maxSlippageBps??existing?.maxSlippageBps??500))),
    maxPositionUsd:Math.max(1,Number(req.body?.maxPositionUsd??existing?.maxPositionUsd??defaults.maxAmountPerTradeUsd)),
    maxTotalExposureUsd:Math.max(1,Number(req.body?.maxTotalExposureUsd??existing?.maxTotalExposureUsd??defaults.maxTotalExposureUsd)),
    minLiquidityUsd:Math.max(0,Number(req.body?.minLiquidityUsd??existing?.minLiquidityUsd??5000)),
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
  const trader=await db.trader.findUnique({where:{id:req.params.id},select:{id:true,kind:true,ownerUserId:true}});
  await db.userFollow.deleteMany({where:{userId:req.user.sub,traderId:req.params.id}});
  if(trader?.kind==="CUSTOM"&&trader.ownerUserId===req.user.sub){
    const stillUsed=await db.userFollow.count({where:{traderId:trader.id}});
    if(stillUsed===0) await db.trader.delete({where:{id:trader.id}});
  }
  await audit(req.user.sub,"USER","UNFOLLOW_TRADER",req.params.id);
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
  const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:req.params.id}}});
  const pending=await db.trader.findFirst({where:{id:req.params.id,kind:"CUSTOM",ownerUserId:req.user.sub},include:{wallets:true}});
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
  if(req.params.id===req.user.sub) return res.status(400).json({error:"CANNOT_FOLLOW_SELF"});
  const target=await db.user.findFirst({where:{id:req.params.id,status:"ACTIVE",publicProfileEnabled:true},select:{id:true}});
  if(!target) return res.status(404).json({error:"PUBLIC_PROFILE_NOT_FOUND"});
  await db.userSocialFollow.upsert({where:{followerId_followingId:{followerId:req.user.sub,followingId:target.id}},create:{followerId:req.user.sub,followingId:target.id},update:{}});
  res.json({ok:true});
}));
app.delete("/v1/social/users/:id/follow", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.userSocialFollow.deleteMany({where:{followerId:req.user.sub,followingId:req.params.id}});
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
  if(await db.user.count({where:{role:"ADMIN"}})>0) return res.status(409).json({error:"ADMIN_ALREADY_EXISTS"});
  const email=normalizeEmail(String(req.body?.email??""));
  const password=String(req.body?.password??"");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({error:"INVALID_EMAIL"});
  if(await db.emailIdentity.findUnique({where:{emailNormalized:email}})) return res.status(409).json({error:"EMAIL_ALREADY_REGISTERED"});
  if(password.length<12) return res.status(400).json({error:"ADMIN_PASSWORD_TOO_SHORT"});
  const passwordHash=await bcrypt.hash(password,12);
  const user=await db.user.create({data:{email,passwordHash,displayName:"Administrator",role:"ADMIN",emailVerifiedAt:new Date(),emailIdentity:{create:{emailNormalized:email}}}});
  await ensureUserDefaults(user.id);
  await audit(user.id,"SYSTEM","BOOTSTRAP_ADMIN");
  res.status(201).json({ok:true,admin:safeUser(user)});
}));

app.get("/v1/admin/overview", requireAdmin, asyncRoute(async (_req:AuthedRequest,res) => {
  const [users,traders,signals,orders,positions,broadcasts,heartbeats]=await Promise.all([
    db.user.count({where:{role:"USER"}}),db.trader.count({where:{kind:"PLATFORM"}}),db.signal.count(),
    db.order.count(),db.position.count({where:{status:{in:["OPEN","PARTIALLY_CLOSED"]}}}),
    db.broadcast.findMany({orderBy:{createdAt:"desc"},take:10}),
    db.workerHeartbeat.findMany({orderBy:{name:"asc"}})
  ]);
  const now=Date.now();
  res.json({
    counts:{users,traders,signals,orders,openPositions:positions},
    executionMode:process.env.EXECUTION_MODE??"simulation",
    liveExecutionEnabled:process.env.LIVE_EXECUTION_ENABLED==="true",
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
    where:{id:req.params.id,role:"USER"},
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
  const user=await db.user.update({where:{id:req.params.id},data:{status:status as any}});
  if(status!=="ACTIVE") await Promise.all([
    db.globalTradingSettings.updateMany({where:{userId:user.id},data:{autoCopyEnabled:false}}),
    db.refreshSession.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:new Date()}})
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
  const trader=await db.trader.update({where:{id:req.params.id},data});
  await audit(req.user.sub,"ADMIN","UPDATE_PLATFORM_TRADER",trader.id,data);
  res.json({trader});
}));
app.post("/v1/admin/traders/:id/wallets", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"SOLANA") as Chain, address=String(req.body?.address??"").trim();
  if(!validPublicAddress(chain,address)) return res.status(400).json({error:"INVALID_WALLET"});
  const trader=await db.trader.findFirst({where:{id:req.params.id,kind:"PLATFORM"},select:{id:true}});
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
  const wallet=await db.traderWallet.findUnique({where:{id:req.params.id}});
  if(!wallet) return res.status(404).json({error:"TRADER_WALLET_NOT_FOUND"});
  await db.traderWallet.delete({where:{id:wallet.id}});
  await audit(req.user.sub,"ADMIN","REMOVE_TRADER_WALLET",wallet.id,{traderId:wallet.traderId,chain:wallet.chain,address:wallet.address});
  res.json({ok:true});
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

const allowedConfigKeys=new Set(["push","email","chains","execution","fees","risk","marketData","social","branding"]);
const secretConfigKeys=new Set(["push","email","execution","marketData","social"]);
app.get("/v1/admin/config", requireAdmin, asyncRoute(async (_req,res) => {
  const rows=await db.appConfig.findMany({orderBy:{key:"asc"}});
  res.json({config:rows.map(redactedConfig)});
}));
app.put("/v1/admin/config/:key", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const key=String(req.params.key);
  if(!allowedConfigKeys.has(key)) return res.status(400).json({error:"INVALID_CONFIG_KEY"});
  if(!req.body || typeof req.body!=="object" || Array.isArray(req.body)) return res.status(400).json({error:"INVALID_CONFIG"});
  const secret=secretConfigKeys.has(key);
  let value:any=req.body;
  // Secret forms intentionally send blanks for values the browser is not allowed to read back.
  // Preserve existing encrypted fields unless the admin explicitly supplies a replacement.
  if(secret){
    const current=await getConfig<any>(key)??{};
    value={...current};
    for(const [field,incoming] of Object.entries(req.body)){
      if(incoming===undefined || incoming==="") continue;
      if(incoming===null) delete value[field]; else value[field]=incoming;
    }
  }
  const row=await setConfig(key,value,{secret,updatedBy:req.user.sub});
  await audit(req.user.sub,"ADMIN","CONFIG_UPDATE",key,secret?{secret:true,fields:Object.keys(req.body)}:{value:req.body});
  res.json({ok:true,config:redactedConfig(row as any),restartRequired:["marketData","execution","chains"].includes(key)});
}));

app.post("/v1/admin/push/generate", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const cfg=await ensureVapid(req.user.sub);
  await audit(req.user.sub,"ADMIN","GENERATE_VAPID");
  res.json({ok:true,publicKey:cfg.vapidPublicKey});
}));
app.post("/v1/admin/test-push", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const target=String(req.body?.userId??req.user.sub);
  const result=await sendPush(target,{title:"FomoCloud push test",body:"Push notifications are working.",url:"/app/"});
  res.json({ok:true,result});
}));
app.post("/v1/admin/test-email", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const to=String(req.body?.to??"");
  if(!to) return res.status(400).json({error:"EMAIL_REQUIRED"});
  const info=await sendEmail(to,"FomoCloud email test","<h2>Email is working.</h2>");
  res.json({ok:true,messageId:info.messageId});
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

app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
  if(err?.message==="CORS_ORIGIN_DENIED") return res.status(403).json({error:"CORS_ORIGIN_DENIED"});
  console.error("[api]",err);
  res.status(500).json({error:"INTERNAL_ERROR"});
});

async function apiHeartbeat(){
  await db.workerHeartbeat.upsert({where:{name:"api"},create:{name:"api",status:"healthy",detail:{port} as any,lastBeatAt:new Date()},update:{status:"healthy",detail:{port} as any,lastBeatAt:new Date()}}).catch(()=>{});
}
setInterval(()=>void apiHeartbeat(),15_000); void apiHeartbeat();
app.listen(port,()=>console.log(`[api] listening on :${port}`));
