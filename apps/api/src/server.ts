import express from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "node:crypto";
import { db } from "@fomocloud/db";
import { CopySettingsSchema } from "@fomocloud/shared";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.AUTH_JWT_SECRET ?? "development-only-change-me";
const challenges = new Map<string, { message: string; expires: number }>();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", credentials: true }));
app.use(express.json({ limit: "256kb" }));

app.get("/health", async (_req, res) => {
  try {
    await db.$runCommandRaw({ ping: 1 });
    res.json({ ok: true, database: "healthy", executionMode: process.env.EXECUTION_MODE ?? "simulation" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.post("/auth/challenge", (req, res) => {
  const address = String(req.body?.address ?? "");
  if (address.length < 32 || address.length > 64) return res.status(400).json({ error: "INVALID_WALLET" });
  const nonce = crypto.randomBytes(24).toString("hex");
  const message = `FomoCloud sign-in\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
  challenges.set(address, { message, expires: Date.now()+5*60_000 });
  res.json({ message });
});

app.post("/auth/verify", async (req, res) => {
  try {
    const address = String(req.body.address ?? "");
    const signature = String(req.body.signature ?? "");
    const challenge = challenges.get(address);
    if (!challenge || challenge.expires < Date.now()) return res.status(401).json({ error: "CHALLENGE_EXPIRED" });
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(challenge.message),
      bs58.decode(signature),
      bs58.decode(address)
    );
    if (!ok) return res.status(401).json({ error: "INVALID_SIGNATURE" });
    challenges.delete(address);
    let wallet = await db.wallet.findUnique({ where: { chain_address: { chain: "SOLANA", address } } });
    if (!wallet) {
      const user = await db.user.create({ data: { wallets: { create: { chain: "SOLANA", address, isPrimary: true } } }, include: { wallets: true } });
      wallet = user.wallets[0];
    }
    if (!wallet) return res.status(500).json({ error: "USER_INIT_FAILED" });
    const token = jwt.sign({ sub: wallet.userId, wallet: address }, jwtSecret, { expiresIn: "12h" });
    res.json({ token, user: { id: wallet.userId, wallet: address } });
  } catch (e) {
    res.status(400).json({ error: "AUTH_FAILED" });
  }
});

function auth(req: any, res: any, next: any) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  try { req.user = jwt.verify(token, jwtSecret); next(); }
  catch { res.status(401).json({ error: "UNAUTHORIZED" }); }
}

app.get("/v1/traders", async (_req, res) => {
  const traders = await db.trader.findMany({
    where: { enabled: true },
    include: { wallets: true, _count: { select: { follows: true } } },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ traders });
});

app.get("/v1/me/portfolio", auth, async (req: any, res) => {
  const userId = req.user.sub as string;
  const [positions, follows] = await Promise.all([
    db.position.findMany({ where: { userId }, orderBy: { openedAt: "desc" }, take: 100 }),
    db.userFollow.findMany({ where: { userId }, include: { trader: true } })
  ]);
  const realized = positions.reduce((a, p) => a + Number(p.realizedPnlUsd), 0);
  res.json({ positions, follows, realizedPnlUsd: realized, executionMode: process.env.EXECUTION_MODE ?? "simulation" });
});

app.post("/v1/traders/:id/follow", auth, async (req: any, res) => {
  const parsed = CopySettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_SETTINGS", details: parsed.error.flatten() });
  const s = parsed.data;
  const follow = await db.userFollow.upsert({
    where: { userId_traderId: { userId: req.user.sub, traderId: req.params.id } },
    create: {
      userId: req.user.sub, traderId: req.params.id, mode: s.enabled ? "AUTO_COPY" : "WATCH_ONLY",
      fixedAmountUsd: s.fixedAmountUsd, takeProfitPct: s.takeProfitPct, stopLossPct: s.stopLossPct,
      maxChasePct: s.maxChasePct, maxSlippageBps: s.maxSlippageBps, maxPositionUsd: s.maxPositionUsd,
      maxTotalExposureUsd: s.maxTotalExposureUsd, minLiquidityUsd: s.minLiquidityUsd, exitMode: s.exitMode
    },
    update: {
      mode: s.enabled ? "AUTO_COPY" : "WATCH_ONLY", fixedAmountUsd: s.fixedAmountUsd,
      takeProfitPct: s.takeProfitPct, stopLossPct: s.stopLossPct, maxChasePct: s.maxChasePct,
      maxSlippageBps: s.maxSlippageBps, maxPositionUsd: s.maxPositionUsd,
      maxTotalExposureUsd: s.maxTotalExposureUsd, minLiquidityUsd: s.minLiquidityUsd, exitMode: s.exitMode
    }
  });
  res.json({ follow });
});

app.post("/v1/me/pause", auth, async (req: any, res) => {
  await db.userFollow.updateMany({ where: { userId: req.user.sub, mode: "AUTO_COPY" }, data: { mode: "PAUSED" } });
  await db.auditLog.create({ data: { userId: req.user.sub, actor: "USER", action: "PAUSE_ALL_TRADING" } });
  res.json({ ok: true });
});

app.get("/v1/me/activity", auth, async (req: any, res) => {
  const decisions = await db.copyDecision.findMany({
    where: { userId: req.user.sub },
    include: { signal: { include: { trader: true } }, orders: true },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ activity: decisions });
});


function adminAuth(req:any,res:any,next:any){
  auth(req,res,()=>{
    const token=String(req.headers["x-admin-token"]??"");
    const expected=process.env.ADMIN_API_TOKEN??"";
    if(!expected||token!==expected) return res.status(403).json({error:"ADMIN_FORBIDDEN"});
    next();
  });
}

app.get("/v1/admin/config", adminAuth, async (_req:any,res)=>{
  const rows=await db.appConfig.findMany({orderBy:{key:"asc"}});
  res.json({config:rows.map(r=>({key:r.key,value:r.isSecret?{configured:true}:r.valueJson,isSecret:r.isSecret,updatedAt:r.updatedAt}))});
});

app.put("/v1/admin/config/:key", adminAuth, async (req:any,res)=>{
  const key=String(req.params.key);
  const allowed=new Set(["push","email","chains","execution","fees","risk","marketData","social","branding"]);
  if(!allowed.has(key)) return res.status(400).json({error:"INVALID_CONFIG_KEY"});
  const isSecret=["push","email","execution","marketData","social"].includes(key);
  const row=await db.appConfig.upsert({
    where:{key},
    create:{key,valueJson:req.body,isSecret,updatedBy:String(req.user?.sub??"admin")},
    update:{valueJson:req.body,isSecret,updatedBy:String(req.user?.sub??"admin")}
  });
  await db.auditLog.create({data:{userId:req.user?.sub,actor:"ADMIN",action:"CONFIG_UPDATE",target:key}});
  res.json({ok:true,updatedAt:row.updatedAt});
});

app.post("/v1/admin/test-email", adminAuth, async (req:any,res)=>{
  const { sendEmail } = await import("@fomocloud/notifications");
  await sendEmail(String(req.body.to),"FomoCloud email test","<h2>FomoCloud email is working.</h2>");
  res.json({ok:true});
});

app.post("/v1/admin/broadcast", adminAuth, async (req:any,res)=>{
  const title=String(req.body.title??"");
  const body=String(req.body.body??"");
  const channel=String(req.body.channel??"PUSH");
  if(!title||!body) return res.status(400).json({error:"TITLE_AND_BODY_REQUIRED"});
  const row=await db.broadcast.create({data:{title,body,channel,audience:String(req.body.audience??"ALL"),status:"QUEUED",createdBy:String(req.user?.sub??"admin")}});
  // Queue fanout in production; do not block HTTP on thousands of recipients.
  res.json({broadcast:row});
});

app.post("/v1/push/subscribe", auth, async (req:any,res)=>{
  const sub=req.body;
  if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth) return res.status(400).json({error:"INVALID_PUSH_SUBSCRIPTION"});
  await db.pushSubscription.upsert({
    where:{endpoint:String(sub.endpoint)},
    create:{userId:req.user.sub,endpoint:String(sub.endpoint),p256dh:String(sub.keys.p256dh),auth:String(sub.keys.auth),userAgent:String(req.headers["user-agent"]??"")},
    update:{userId:req.user.sub,p256dh:String(sub.keys.p256dh),auth:String(sub.keys.auth),userAgent:String(req.headers["user-agent"]??"")}
  });
  res.json({ok:true});
});

app.listen(port, () => console.log(`[api] listening on :${port}`));
