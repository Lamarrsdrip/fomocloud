import { Router } from "express";
import bcrypt from "bcryptjs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { db, type Chain } from "@memecloud/db";
import { renderEmail, sendEmail } from "@memecloud/notifications";
import {
  asyncRoute, normalizeEmail, validPublicAddress, hashToken, randomToken, safeUser,
  parseCookies, refreshCookieOptions, signAccess, issueSession, audit, createEmailToken,
  ensureUserDefaults,
} from "./auth.js";
import { auth, type AuthedRequest } from "./middleware.js";

// Mirrors the CORS origin list in server.ts -- only used here as the base URL for links inside
// transactional emails (verify/reset), never for an actual CORS decision.
const configuredOrigins = (
  process.env.CORS_ALLOWED_ORIGINS ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3000"
).split(",").map(x => x.trim()).filter(Boolean);

export const authRoutes = Router();

authRoutes.post("/auth/signup", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/resend-verification", auth, asyncRoute(async (req:AuthedRequest,res) => {
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

authRoutes.post("/auth/login", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/refresh", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/logout", asyncRoute(async (req,res) => {
  const raw=parseCookies(req).fomo_refresh;
  if(raw) await db.refreshSession.updateMany({where:{tokenHash:hashToken(raw),revokedAt:{isSet:false}},data:{revokedAt:new Date()}});
  res.clearCookie("fomo_refresh",{...refreshCookieOptions(),maxAge:0});
  res.json({ok:true});
}));

authRoutes.post("/auth/verify-email", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/forgot-password", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/reset-password", asyncRoute(async (req,res) => {
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
authRoutes.post("/auth/wallet/challenge", asyncRoute(async (req,res) => {
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

authRoutes.post("/auth/wallet/verify", asyncRoute(async (req,res) => {
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

authRoutes.post("/v1/me/wallets/challenge", auth, asyncRoute(async (req:AuthedRequest,res) => {
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

authRoutes.post("/v1/me/wallets/verify", auth, asyncRoute(async (req:AuthedRequest,res) => {
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
