import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { db, walletActivityForUser, walletActivityContent, type Chain, type FollowMode } from "@memecloud/db";
import { CopySettingsSchema, solanaRpcCandidates, pickHealthyRpc, usdToMicros, microsToUsd, positionUsdFields, tradingCashUsdFields, positionExitUsdFields } from "@memecloud/shared";
import { getConfig, encryptJson, decryptJson, recordProviderResults, readExecutionState } from "@memecloud/config";
import { classifyLifecycle } from "@memecloud/brain";
import { sendEmail, sendPush, ensureVapid, publicPushKey, renderEmail } from "@memecloud/notifications";
import { PrivySolanaSigner } from "@memecloud/providers";
import { JupiterExecution } from "@memecloud/execution";
import { Connection, PublicKey } from "@solana/web3.js";
import { authLimiter, tradeLimiter, auth, requireAdmin, adminOnly, type TokenPayload, type AuthedRequest } from "./middleware.js";
import { authRoutes } from "./authRoutes.js";
import { walletRoutes } from "./walletRoutes.js";
import { adminRoutes } from "./adminRoutes.js";
import { curatedRoutes } from "./curatedRoutes.js";
import { redis } from "./queues.js";
import { runProviderTests } from "./providerHealth.js";
import { asyncRoute, routeParam, normalizeEmail, validPublicAddress, hashToken, randomToken, safeUser, parseCookies, refreshCookieOptions, audit, ensureUserDefaults, canEnableAutoCopy, reasonText } from "./auth.js";
import { USDC_SOL, manualTradeTrader, reconcileConfirmedManualSwap, recoverManualPrivyHash } from "./trading.js";

async function acquireApiLease(key:string,ttlMs=180_000,waitMs=30_000){
  const token=crypto.randomBytes(16).toString("hex"),deadline=Date.now()+Math.max(0,waitMs);
  do{
    const ok=await (redis as any).set(key,token,"PX",ttlMs,"NX");
    if(ok==="OK")return async()=>{try{await (redis as any).eval('if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',1,key,token)}catch{}};
    if(Date.now()>=deadline)return null;await new Promise(r=>setTimeout(r,75));
  }while(true);
}

const app = express();
const port = Number(process.env.PORT ?? 4000);

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
app.use("/auth", authLimiter);
app.use(authRoutes);
app.use(walletRoutes);
app.use(adminRoutes);
app.use(curatedRoutes);

app.get("/health", asyncRoute(async (_req,res) => {
  try {
    await db.$runCommandRaw({ping:1});
    const [redisStatus,executionState]=await Promise.all([redis.ping().then(()=>"healthy").catch(()=>"unavailable"),readExecutionState()]);
    res.json({ok:true,database:"healthy",redis:redisStatus,executionMode:executionState.actualRuntimeMode.toLowerCase(),executionStatus:executionState.status,release:process.env.MEMECLOUD_RELEASE_SHA||process.env.RELEASE_SHA||process.cwd().split(/[\\/]/).filter(Boolean).at(-1)||null});
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
    // Wallet-first production is currently Solana-only. Other enum values are schema capability,
    // not a claim that a scanner or execution adapter is running.
    adapterReadyChains:(process.env.ADAPTER_READY_CHAINS??"").split(",").filter(Boolean),
    discoveryOnlyChains:[],
    xOAuthConfigured:Boolean(socialCfg?.xOAuthClientId||process.env.X_OAUTH_CLIENT_ID),
    embeddedWalletsConfigured:Boolean(privyAppId&&privySignerId&&privyPolicyId),
    privyAppId:privyAppId||null,
    privySignerId:privySignerId||null,
    privyPolicyId:privyPolicyId||null
  });
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
  const tradingDefaults={
    autoCopyEnabled:false,
    globalBrainEnabled:true,
    sizingMode:"PERCENT",
    percentBalance:2,
    defaultAmountUsd:100,
    maxAmountPerTradeUsd:0,
    maxTotalExposureUsd:0,
    maxConcurrentPositions:0,
    maxSlippageBps:1500,
    takeProfitMode:"SIMPLE",
    simpleTakeProfitPct:100,
    simpleSellPct:100,
    tp1Pct:50,
    tp1SellPct:25,
    tp2Pct:100,
    tp2SellPct:25,
    tp3Pct:200,
    tp3SellPct:25,
    runnerPct:25,
    capitalRecoveryEnabled:true,
    capitalRecoveryTriggerPct:100,
    trailingEnabled:false,
    trailingActivationPct:80,
    trailingGivebackPct:20,
    sourceSellBehavior:"BRAIN_DECIDES",
    scalperCopyEnabled:false
  };

  res.json({
    trading:{...tradingDefaults,...(trading||{})},
    notifications
  });
}));

app.patch("/v1/me/settings/trading", auth, asyncRoute(async (req:AuthedRequest,res) => {
  if(req.body?.autoCopyEnabled===true && !(await canEnableAutoCopy(req.user.sub,res))) return;
  const current=await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}});
  const allowedChains=(Array.isArray(req.body?.allowedChains)?req.body.allowedChains:current.allowedChains).filter((x:string)=>["SOLANA"].includes(x));
  const tpMode=String(req.body?.takeProfitMode??current.takeProfitMode??"SIMPLE").toUpperCase()==="ADVANCED"?"ADVANCED":"SIMPLE";
  const sellBehavior=String(req.body?.sourceSellBehavior??current.sourceSellBehavior??"BRAIN_DECIDES").toUpperCase();
  if(!["IGNORE","PROPORTIONAL","FULL_EXIT_ONLY","BRAIN_DECIDES"].includes(sellBehavior)) return res.status(400).json({error:"INVALID_SOURCE_SELL_BEHAVIOR"});
  const tp1Pct=Math.max(.01,Number(req.body?.tp1Pct??current.tp1Pct??50));
  const tp2Pct=Math.max(.01,Number(req.body?.tp2Pct??current.tp2Pct??100));
  const tp3Pct=Math.max(.01,Number(req.body?.tp3Pct??current.tp3Pct??200));
  if(tpMode==="ADVANCED" && !(tp1Pct<tp2Pct && tp2Pct<tp3Pct)) return res.status(400).json({error:"TAKE_PROFIT_TARGETS_MUST_ASCEND"});
  const tp1SellPct=Math.max(.01,Math.min(100,Number(req.body?.tp1SellPct??current.tp1SellPct??25)));
  const tp2SellPct=Math.max(.01,Math.min(100,Number(req.body?.tp2SellPct??current.tp2SellPct??25)));
  const tp3SellPct=Math.max(.01,Math.min(100,Number(req.body?.tp3SellPct??current.tp3SellPct??25)));
  const runnerPct=Math.max(0,Math.min(100,Number(req.body?.runnerPct??current.runnerPct??25)));
  if(tpMode==="ADVANCED" && tp1SellPct+tp2SellPct+tp3SellPct+runnerPct>100.0001) return res.status(400).json({error:"TP_SELLS_PLUS_RUNNER_EXCEED_100"});
  const capitalRecoveryTriggerPct=Math.max(.01,Math.min(100000,Number(req.body?.capitalRecoveryTriggerPct??current.capitalRecoveryTriggerPct??100)));
  const data={
    autoCopyEnabled:Boolean(req.body?.autoCopyEnabled??current.autoCopyEnabled),
    globalBrainEnabled:Boolean(req.body?.globalBrainEnabled??current.globalBrainEnabled??true),
    sizingMode:String(req.body?.sizingMode??current.sizingMode??"PERCENT").toUpperCase()==="FIXED"?"FIXED":"PERCENT",
    percentBalance:Math.max(.01,Math.min(100,Number(req.body?.percentBalance??current.percentBalance??2))),
    defaultAmountUsd:Math.max(1,Number(req.body?.defaultAmountUsd??current.defaultAmountUsd??100)),
    maxAmountPerTradeUsd:Math.max(0,Number(req.body?.maxAmountPerTradeUsd??current.maxAmountPerTradeUsd??0)),
    maxTotalExposureUsd:Math.max(0,Number(req.body?.maxTotalExposureUsd??current.maxTotalExposureUsd??0)),
    maxConcurrentPositions:Math.max(0,Math.min(10000,Math.floor(Number(req.body?.maxConcurrentPositions??current.maxConcurrentPositions??0)))),
    maxSlippageBps:Math.max(1,Math.min(10000,Math.floor(Number(req.body?.maxSlippageBps??current.maxSlippageBps??1500)))),
    adaptiveChase:Boolean(req.body?.adaptiveChase??current.adaptiveChase),
    takeProfitMode:tpMode,
    simpleTakeProfitPct:Math.max(.01,Number(req.body?.simpleTakeProfitPct??current.simpleTakeProfitPct??100)),
    simpleSellPct:Math.max(.01,Math.min(100,Number(req.body?.simpleSellPct??current.simpleSellPct??100))),
    tp1Pct,tp1SellPct,tp2Pct,tp2SellPct,tp3Pct,tp3SellPct,runnerPct,
    capitalRecoveryEnabled:Boolean(req.body?.capitalRecoveryEnabled??current.capitalRecoveryEnabled??true),
    capitalRecoveryTriggerPct,
    // Keep the legacy multiple synchronized while older releases roll forward.
    capitalRecoveryMultiple:1+capitalRecoveryTriggerPct/100,
    trailingEnabled:Boolean(req.body?.trailingEnabled??current.trailingEnabled??false),
    trailingActivationPct:Math.max(.01,Number(req.body?.trailingActivationPct??current.trailingActivationPct??80)),
    trailingGivebackPct:Math.max(.1,Math.min(99,Number(req.body?.trailingGivebackPct??current.trailingGivebackPct??20))),
    sourceSellBehavior:sellBehavior,
    scalperCopyEnabled:Boolean(req.body?.scalperCopyEnabled??current.scalperCopyEnabled??false),
    freshMemeMode:Boolean(req.body?.freshMemeMode??current.freshMemeMode),
    runnerMode:Boolean(req.body?.runnerMode??current.runnerMode),
    allowedChains:allowedChains as Chain[]
  };
  if(data.maxAmountPerTradeUsd>0 && data.defaultAmountUsd>data.maxAmountPerTradeUsd) return res.status(400).json({error:"DEFAULT_EXCEEDS_MAX_TRADE"});
  const row=await db.globalTradingSettings.update({where:{userId:req.user.sub},data});
  await audit(req.user.sub,"USER","UPDATE_TRADING_SETTINGS",undefined,{autoCopyEnabled:row.autoCopyEnabled,globalBrainEnabled:row.globalBrainEnabled,takeProfitMode:row.takeProfitMode,scalperCopyEnabled:row.scalperCopyEnabled});
  res.json({trading:row});
}));

app.patch("/v1/me/settings/notifications", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await ensureUserDefaults(req.user.sub);
  const keys=["pushEnabled","emailEnabled","traderBought","tradeCopied","skippedTrade","profitTaken","positionClosed","securityAlerts","platformBroadcast","discoverySmartWallet","discoveryWhaleActivity","discoveryHeatingUp","discoveryStrong","discoveryHighConviction"] as const;
  const alertKeys=["traderBought","tradeCopied","skippedTrade","profitTaken","positionClosed","securityAlerts","platformBroadcast","discoverySmartWallet","discoveryWhaleActivity","discoveryHeatingUp","discoveryStrong","discoveryHighConviction"] as const;
  const data:any={};
  // Normal users get ONE notification switch. Turning it on means "send me MemeCloud alerts",
  // not "now configure 13 more toggles." Granular fields stay in the schema for delivery routing
  // and backwards compatibility/admin tooling, but the master setting synchronizes all of them.
  if(typeof req.body?.masterEnabled==="boolean"){
    data.pushEnabled=req.body.masterEnabled;
    for(const k of alertKeys)data[k]=req.body.masterEnabled;
  }
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
  const [allocationRows,positionRows,follows,snapshots,settings,dayBaseline]=await Promise.all([
    db.tradingCashAllocation.findMany({where:{userId:req.user.sub},orderBy:{chain:"asc"}}),
    db.position.findMany({where:{userId:req.user.sub},include:{sourceTrader:{select:{id:true,displayName:true,handle:true,avatarUrl:true}},exits:{where:{createdAt:{gte:todayStart}},select:{proceedsUsdMicros:true,pnlUsdMicros:true}}},orderBy:{openedAt:"desc"}}),
    db.userFollow.findMany({where:{userId:req.user.sub}}),
    db.pnLSnapshot.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:120}),
    db.globalTradingSettings.findUnique({where:{userId:req.user.sub}}),
    db.pnLSnapshot.findFirst({where:{userId:req.user.sub,createdAt:{lt:todayStart}},orderBy:{createdAt:"desc"}})
  ]);
  // M-30: BigInt micro-USD storage (Decimal unavailable on Prisma+MongoDB) -- convert immediately
  // after fetch. `allocations`/`positions` are what actually get sent in the response below, so
  // this is also what keeps a raw BigInt from ever reaching res.json() (which would throw).
  const allocations=allocationRows.map(a=>({...a,...tradingCashUsdFields(a)}));
  const positions=positionRows.map(p=>({...p,...positionUsdFields(p),exits:p.exits.map(e=>({...e,...positionExitUsdFields(e)}))}));
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
  const positionRows=await db.position.findMany({
    where:{userId:req.user.sub,...(status?{status:status as any}:{})},
    include:{sourceTrader:{select:{id:true,displayName:true,handle:true,avatarUrl:true}},exits:{orderBy:{createdAt:"desc"}}},
    orderBy:{openedAt:"desc"},take:250
  });
  // M-30: BigInt micro-USD storage -- convert every position AND every included exit row before
  // this reaches res.json() below, which would otherwise throw on the raw BigInt fields.
  const positions=positionRows.map(p=>({...p,...positionUsdFields(p),exits:p.exits.map(e=>({...e,proceedsUsd:e.proceedsUsdMicros==null?null:microsToUsd(e.proceedsUsdMicros),pnlUsd:e.pnlUsdMicros==null?null:microsToUsd(e.pnlUsdMicros),proceedsUsdMicros:undefined as unknown as bigint|null,pnlUsdMicros:undefined as unknown as bigint|null}))}));
  // Same freshness pattern as /v1/brain/feed: freshness measured against the most
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

  const releaseManualLease=willTradeLive?await acquireApiLease(`live:user-entry:${req.user.sub}`,180_000,30_000):null;
  if(willTradeLive&&!releaseManualLease)return res.status(409).json({error:"USER_LIVE_ENTRY_BUSY",message:"Another live entry for this account is still being finalized. No second transaction was constructed."});
  try{
    if(willTradeLive){
      const allocation=await db.tradingCashAllocation.findUnique({where:{userId_chain:{userId:req.user.sub,chain:"SOLANA"}}});
      if(!allocation?.lastSyncedAt||Date.now()-allocation.lastSyncedAt.getTime()>120_000)return res.status(409).json({error:"TRADING_CASH_STALE",message:"Live trading is waiting for a fresh on-chain USDC balance sync."});
      if(microsToUsd(allocation.availableUsdMicros)+1e-9<amountUsd)return res.status(409).json({error:"INSUFFICIENT_TRADING_CASH",message:"The requested amount is above the currently reconciled USDC trading balance."});
    }
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
        db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"SIMULATION",mint,quoteMint:USDC_SOL,entryInputRaw:amountRaw,entryTokenRaw:quote.outAmount,remainingTokenRaw:quote.outAmount,costUsdMicros:usdToMicros(amountUsd),avgEntryPriceUsdMicros:usdToMicros(executablePriceUsd),currentPriceUsdMicros:usdToMicros(executablePriceUsd),peakPriceUsdMicros:usdToMicros(executablePriceUsd),takeProfitPct:200,status:"OPEN",lastMarkedAt:now}})
      ]);
      await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual simulation buy placed",body:`$${amountUsd.toFixed(2)} simulation buy from a real executable quote. No live funds moved.`,data:{orderId:order.id,positionId:position.id,mint} as any}});
      await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd,mode:"SIMULATION"});
      return res.status(201).json({ok:true,mode:"SIMULATION",order,position:{...position,...positionUsdFields(position)}});
    }

    // LIVE path — mirrors executor's automated buy exactly: SIGNING -> SUBMITTED -> CONFIRMED,
    // a durable LiveExecutionAttempt row for provider-reference reconciliation, and never a blind
    // retry of an ambiguous prior attempt.
    let order=await db.order.findUnique({where:{idempotencyKey:key}});
    if(order){
      if(order.status==="CONFIRMED"){
        const existingPosition=await db.position.findFirst({where:{userId:req.user.sub,mode:"LIVE",entryTxHash:order.txHash??undefined}});
        return res.status(200).json({ok:true,mode:"LIVE",order,position:existingPosition?{...existingPosition,...positionUsdFields(existingPosition)}:null});
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
          db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsdMicros:usdToMicros(actualUsd),avgEntryPriceUsdMicros:usdToMicros(actualEntry),currentPriceUsdMicros:usdToMicros(actualEntry),peakPriceUsdMicros:usdToMicros(actualEntry),takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}}),
          db.ledgerEntry.create({data:{userId:req.user.sub,type:"BUY_SPEND",amountUsdMicros:usdToMicros(-actualUsd),chain:"SOLANA",asset:"USDC",referenceType:"Order",referenceId:order.id,note:`Manual live buy confirmed on-chain, tx ${hash}`}}),
          db.tradingCashAllocation.update({where:{userId_chain:{userId:req.user.sub,chain:"SOLANA"}},data:{availableUsdMicros:{decrement:usdToMicros(actualUsd)},inTradesUsdMicros:{increment:usdToMicros(actualUsd)},lastSyncedAt:new Date(),source:"LIVE_EXECUTION_PENDING_RECONCILE"}})
        ]);
      }
      await db.liveExecutionAttempt.update({where:{id:attempt.id},data:{status:"CONFIRMED",txHash:hash}});
      order=await db.order.findUnique({where:{id:order.id}});
      return res.status(200).json({ok:true,mode:"LIVE",order,position:{...position,...positionUsdFields(position)}});
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
      db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsdMicros:usdToMicros(actualUsd),avgEntryPriceUsdMicros:usdToMicros(actualEntry),currentPriceUsdMicros:usdToMicros(actualEntry),peakPriceUsdMicros:usdToMicros(actualEntry),takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}}),
      db.ledgerEntry.create({data:{userId:req.user.sub,type:"BUY_SPEND",amountUsdMicros:usdToMicros(-actualUsd),chain:"SOLANA",asset:"USDC",referenceType:"Order",referenceId:order.id,note:`Manual live buy confirmed on-chain, tx ${hash}`}}),
      db.tradingCashAllocation.update({where:{userId_chain:{userId:req.user.sub,chain:"SOLANA"}},data:{availableUsdMicros:{decrement:usdToMicros(actualUsd)},inTradesUsdMicros:{increment:usdToMicros(actualUsd)},lastSyncedAt:new Date(),source:"LIVE_EXECUTION_PENDING_RECONCILE"}})
    ]);
    await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"CONFIRMED",txHash:hash}});
    order=await db.order.findUnique({where:{id:order.id}});
    await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual buy confirmed",body:`Bought $${actualUsd.toFixed(2)} of the token. The transaction is confirmed on Solana.`,data:{orderId:order!.id,positionId:position.id,mint,txHash:hash} as any}});
    await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd:actualUsd,mode:"LIVE",txHash:hash});
    res.status(201).json({ok:true,mode:"LIVE",order,position:{...position,...positionUsdFields(position)}});
  }catch(e:any){
    res.status(409).json({error:e?.code||"QUOTE_UNAVAILABLE",message:e?.message||"A genuine executable quote could not be verified, so MemeCloud did not fabricate a fill."});
  }finally{if(releaseManualLease)await releaseManualLease()}
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
  const [events,decisions,walletEvents]=await Promise.all([
    db.userActivityEvent.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:100}),
    db.copyDecision.findMany({where:{userId:req.user.sub},include:{signal:{include:{trader:true}},orders:true},orderBy:{createdAt:"desc"},take:50}),
    walletActivityForUser(req.user.sub)
  ]);
  res.json({
    events:[...walletEvents,...events.filter(e=>!["TRADER_SIGNAL","SMART_WALLET_BUY"].includes(e.type))].sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()).slice(0,100),
    decisions:decisions.map(d=>({...d,plainReason:reasonText(d.reason)}))
  });
}));

app.get("/v1/me/notifications", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const notifications=await db.notification.findMany({where:{userId:req.user.sub},orderBy:{createdAt:"desc"},take:100});
  const walletRows=notifications.filter(n=>n.type==="WALLET_ACTIVITY");
  const identities=walletRows.length?await db.discoveryToken.findMany({where:{OR:walletRows.map(n=>({chain:(n.data as any).chain,mint:(n.data as any).mint}))}}):[];
  res.json({notifications:notifications.map(n=>{
    if(n.type!=="WALLET_ACTIVITY")return n;
    const data=n.data as any,token=identities.find(t=>t.chain===data.chain&&t.mint===data.mint);
    const enriched=walletActivityContent(data,token);
    return {...n,title:enriched.title,body:enriched.body,data:enriched.data};
  })});
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

// ------------------------ TRADERS ------------------------
app.get("/v1/traders", asyncRoute(async (_req,res) => {
  const traders=await db.trader.findMany({
    // ONLY ADMIN-ADDED WALLETS ARE SIGNAL SOURCES: `kind:"PLATFORM"` alone is not proof of that --
    // scoring-worker auto-creates and auto-promotes its own PLATFORM traders purely from
    // algorithmic scoring. `wallets:{some:{source:"ADMIN"}}` requires at least one wallet Admin
    // actually added on this trader, so an auto-promoted trader (which the listener no longer
    // even subscribes to) can't still surface as a followable "platform trader" here.
    where:{kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},
    include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"desc"}],take:200
  });
  res.json({traders});
}));

app.get("/v1/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const trader=await db.trader.findFirst({
    where:{id:routeParam(req.params.id),kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},
    include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}},_count:{select:{follows:true,signals:true}},signals:{orderBy:{observedAt:"desc"},take:25}}
  });
  if(!trader) return res.status(404).json({error:"TRADER_NOT_FOUND"});
  const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:trader.id}}});
  res.json({trader,follow});
}));

app.get("/v1/me/traders", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const follows=await db.userFollow.findMany({
    where:{userId:req.user.sub,trader:{kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}}},
    include:{trader:{include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}},_count:{select:{signals:true,follows:true}}}}},
    orderBy:{updatedAt:"desc"}
  });
  res.json({follows});
}));

app.put("/v1/me/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const trader=await db.trader.findFirst({
    where:{id:routeParam(req.params.id),kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},
    include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}}
  });
  if(!trader) return res.status(404).json({error:"ADMIN_TRACKED_TRADER_NOT_FOUND"});
  const existing=await db.userFollow.findUnique({where:{userId_traderId:{userId:req.user.sub,traderId:trader.id}}});
  const mode=String(req.body?.mode??existing?.mode??"FOLLOW_ONLY") as FollowMode;
  if(!["FOLLOW_ONLY","WATCH_ONLY","AUTO_COPY","PAUSED"].includes(mode)) return res.status(400).json({error:"INVALID_FOLLOW_MODE"});
  if(mode==="AUTO_COPY" && !(await canEnableAutoCopy(req.user.sub,res))) return;
  const defaults=await db.globalTradingSettings.upsert({where:{userId:req.user.sub},create:{userId:req.user.sub},update:{}});
  const custom=Boolean(req.body?.useCustomSettings??existing?.useCustomSettings??false);
  const strOrNull=(v:any,current:any)=>v===undefined?current:(v===null?null:String(v));
  const numOrNull=(v:any,current:any,min=0,max=Number.MAX_SAFE_INTEGER)=>v===undefined?current:(v===null?null:Math.max(min,Math.min(max,Number(v))));
  const boolOrNull=(v:any,current:any)=>v===undefined?current:(v===null?null:Boolean(v));
  const sellBehavior=strOrNull(req.body?.sourceSellBehavior,existing?.sourceSellBehavior)?.toUpperCase()??null;
  if(sellBehavior && !["IGNORE","PROPORTIONAL","FULL_EXIT_ONLY","BRAIN_DECIDES"].includes(sellBehavior)) return res.status(400).json({error:"INVALID_SOURCE_SELL_BEHAVIOR"});
  const takeProfitMode=strOrNull(req.body?.takeProfitMode,existing?.takeProfitMode)?.toUpperCase()??null;
  if(takeProfitMode && !["SIMPLE","ADVANCED"].includes(takeProfitMode)) return res.status(400).json({error:"INVALID_TAKE_PROFIT_MODE"});
  const tp1=numOrNull(req.body?.tp1Pct,existing?.tp1Pct,.01),tp2=numOrNull(req.body?.tp2Pct,existing?.tp2Pct,.01),tp3=numOrNull(req.body?.tp3Pct,existing?.tp3Pct,.01);
  if(custom && takeProfitMode==="ADVANCED" && tp1!=null && tp2!=null && tp3!=null && !(tp1<tp2&&tp2<tp3)) return res.status(400).json({error:"TAKE_PROFIT_TARGETS_MUST_ASCEND"});
  const requestedFixed=Math.max(1,Number(req.body?.fixedAmountUsd??existing?.fixedAmountUsd??defaults.defaultAmountUsd));
  const fixedAmountUsd=defaults.maxAmountPerTradeUsd>0?Math.min(defaults.maxAmountPerTradeUsd,requestedFixed):requestedFixed;
  const data:any={
    mode,
    useCustomSettings:custom,
    sizingMode:strOrNull(req.body?.sizingMode,existing?.sizingMode)?.toUpperCase()==="FIXED"?"FIXED":(strOrNull(req.body?.sizingMode,existing?.sizingMode)?"PERCENT":null),
    percentBalance:numOrNull(req.body?.percentBalance,existing?.percentBalance,.01,100),
    fixedAmountUsd,
    takeProfitPct:Math.max(.01,Number(req.body?.takeProfitPct??existing?.takeProfitPct??100)),
    stopLossPct:numOrNull(req.body?.stopLossPct,existing?.stopLossPct,0,100),
    maxChasePct:Math.max(0,Number(req.body?.maxChasePct??existing?.maxChasePct??0)),
    maxSlippageBps:Math.max(1,Math.min(10000,Math.floor(Number(req.body?.maxSlippageBps??existing?.maxSlippageBps??defaults.maxSlippageBps??1500)))),
    maxPositionUsd:Math.max(0,Number(req.body?.maxPositionUsd??existing?.maxPositionUsd??0)),
    maxTotalExposureUsd:Math.max(0,Number(req.body?.maxTotalExposureUsd??existing?.maxTotalExposureUsd??0)),
    maxConcurrentFromTrader:Math.max(0,Math.floor(Number(req.body?.maxConcurrentFromTrader??existing?.maxConcurrentFromTrader??0))),
    minLiquidityUsd:Math.max(0,Number(req.body?.minLiquidityUsd??existing?.minLiquidityUsd??0)),
    exitMode:String(req.body?.exitMode??existing?.exitMode??"ADAPTIVE"),
    copyAdditionalBuys:Boolean(req.body?.copyAdditionalBuys??existing?.copyAdditionalBuys??true),
    copyReentries:Boolean(req.body?.copyReentries??existing?.copyReentries??true),
    takeProfitMode,
    simpleTakeProfitPct:numOrNull(req.body?.simpleTakeProfitPct,existing?.simpleTakeProfitPct,.01),
    simpleSellPct:numOrNull(req.body?.simpleSellPct,existing?.simpleSellPct,.01,100),
    tp1Pct:tp1,tp1SellPct:numOrNull(req.body?.tp1SellPct,existing?.tp1SellPct,.01,100),
    tp2Pct:tp2,tp2SellPct:numOrNull(req.body?.tp2SellPct,existing?.tp2SellPct,.01,100),
    tp3Pct:tp3,tp3SellPct:numOrNull(req.body?.tp3SellPct,existing?.tp3SellPct,.01,100),
    runnerPct:numOrNull(req.body?.runnerPct,existing?.runnerPct,0,100),
    capitalRecoveryEnabled:boolOrNull(req.body?.capitalRecoveryEnabled,existing?.capitalRecoveryEnabled),
    capitalRecoveryTriggerPct:numOrNull(req.body?.capitalRecoveryTriggerPct,existing?.capitalRecoveryTriggerPct,.01,100000),
    trailingEnabled:boolOrNull(req.body?.trailingEnabled,existing?.trailingEnabled),
    trailingActivationPct:numOrNull(req.body?.trailingActivationPct,existing?.trailingActivationPct,.01,100000),
    trailingGivebackPct:numOrNull(req.body?.trailingGivebackPct,existing?.trailingGivebackPct,.1,99),
    sourceSellBehavior:sellBehavior,
    scalperCopyEnabled:boolOrNull(req.body?.scalperCopyEnabled,existing?.scalperCopyEnabled)
  };
  if(custom && data.takeProfitMode==="ADVANCED"){
    const total=Number(data.tp1SellPct??defaults.tp1SellPct??25)+Number(data.tp2SellPct??defaults.tp2SellPct??25)+Number(data.tp3SellPct??defaults.tp3SellPct??25)+Number(data.runnerPct??defaults.runnerPct??25);
    if(total>100.0001) return res.status(400).json({error:"TP_SELLS_PLUS_RUNNER_EXCEED_100"});
  }
  const follow=await db.userFollow.upsert({
    where:{userId_traderId:{userId:req.user.sub,traderId:trader.id}},
    create:{userId:req.user.sub,traderId:trader.id,...data},
    update:data
  });
  await audit(req.user.sub,"USER","UPDATE_TRADER_FOLLOW",trader.id,{mode,useCustomSettings:custom,scalperCopyEnabled:follow.scalperCopyEnabled});
  res.json({follow});
}));

app.delete("/v1/me/traders/:id", auth, asyncRoute(async (req:AuthedRequest,res) => {
  await db.userFollow.deleteMany({where:{userId:req.user.sub,traderId:routeParam(req.params.id)}});
  await audit(req.user.sub,"USER","UNFOLLOW_TRADER",routeParam(req.params.id));
  res.json({ok:true});
}));

// Legacy user-added wallet discovery is deliberately retired. MemeCloud's only signal sources are
// enabled, Admin-curated trader wallets. Keeping explicit 410 responses prevents old clients from
// silently recreating the retired candidate architecture.
app.post("/v1/me/traders/custom", auth, (_req,res) => res.status(410).json({error:"ADMIN_CURATED_TRADERS_ONLY"}));
app.post("/v1/me/traders/:id/wallet", auth, (_req,res) => res.status(410).json({error:"ADMIN_CURATED_TRADERS_ONLY"}));

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

// Deliberately public — platform-wide market intelligence, not per-user data (no req.user is
// ever read here). Requiring login just to SEE what the Global Brain is watching was blocking
// the entire discovery experience for anyone without an account; wallet/login should only ever
// gate EXECUTION, never observation.
app.get("/v1/brain/feed", asyncRoute(async (_req,res) => {
  const now=Date.now();
  // Real gap found by forensic audit (M-5/PC-E): the main feed's qualification was "any nonzero
  // inflow/buyer OR just-seen" -- a token with a single $0.01 buy technically qualified, just
  // ranked low by score. That's not "MemeCloud recommends this," it's a token-list API with sorting.
  // QUALIFIED_MIN_SCORE reuses evaluateOpportunity's own "WATCH" threshold (score>=56) -- the same
  // principled bar already used elsewhere to mean "genuine, evidence-backed evidence," not an
  // arbitrary new number invented for this route. A token with truly no real buyer/inflow/whale
  // evidence cannot reach this score (the formula's base is ~24-30 with zero evidence).
  const QUALIFIED_MIN_SCORE=58;
  const [opportunities,brainHeartbeat]=await Promise.all([
    db.globalBrainOpportunity.findMany({
      where:{
        // Real bug found by audit, surfaced by a live 20+ hour outage (Helius RPC quota exhausted
        // -> market-worker stalled -> brain-worker had nothing fresh to evaluate): widened so a
        // genuine outage doesn't erase the feed entirely; pipelineDegraded below is what actually
        // tells the client this isn't live right now.
        lastEvaluatedAt:{gte:new Date(now-48*60*60_000)},
        score:{gte:QUALIFIED_MIN_SCORE},
        state:{in:["BUILDING","BREAKOUT_FLOW","MONEY_RUSH"]}
      },
      orderBy:[{score:"desc"},{lastEvaluatedAt:"desc"}],take:150
    }),
    db.workerHeartbeat.findUnique({where:{name:"global-brain"}})
  ]);
  // The wallet-first rewrite scoped tick() down to only mints a tracked wallet actually bought (or
  // an open position) -- GlobalBrainOpportunity rows now only get touched when something qualifies,
  // so a long real gap between evaluations is an expected quiet period, not a stall (confirmed live:
  // a healthy heartbeating brain-worker sat with a 3-day-old lastEvaluatedAt simply because nothing
  // had qualified). The genuine "is Brain actually alive and cycling" signal is its own heartbeat --
  // pulsed every 15s by startHeartbeat() -- combined with lastTickAt, which tick() only stamps at
  // the START of a real attempt (see services/brain-worker), so a wedged tick (stuck on one hung
  // await, `running` never reset) shows up as lastTickAt going stale even though the heartbeat
  // pulse itself, on its own independent timer, keeps reporting "healthy" regardless.
  const brainDetail=(brainHeartbeat?.detail??{}) as any;
  const heartbeatAgeSec=brainHeartbeat?Math.round((now-brainHeartbeat.lastBeatAt.getTime())/1000):null;
  const lastTickAgeSec=brainDetail.lastTickAt?Math.round((now-new Date(brainDetail.lastTickAt).getTime())/1000):null;
  const dataFreshnessSec=lastTickAgeSec??heartbeatAgeSec;
  const pipelineDegraded=heartbeatAgeSec===null||heartbeatAgeSec>45||lastTickAgeSec===null||lastTickAgeSec>60;
  // Main Hunt is intentionally NOT a generic trending-token list. A row must have earned either
  // quality smart-wallet convergence, whale participation, or material tracked smart-money flow.
  // High raw volume alone never qualifies a wallet-first opportunity; capital quality is required.
  const qualifiedOpportunities=opportunities.filter((o:any)=>{
    const ev=(o.evidence??{}) as any;
    const weighted=Number(ev.convergentWeightedScore??ev.smartWalletWeightedScore??0);
    const whales=Number(o.whaleBuyers60s??0)+Number(o.knownWhaleBuyers60s??0);
    const smartNet=Number(o.smartMoneyNetFlow5mUsd??0);
    const materialSmartNet=smartNet>=Math.max(2500,Number(o.liquidityUsd??0)*.03);
    return weighted>=1||whales>=1||materialSmartNet;
  });
  res.json({
    watching:true,
    opportunities:qualifiedOpportunities.map(o=>({...o,lifecycleStatus:classifyLifecycle(o,now)})),
    intelligenceMode:"WALLET_FIRST",
    pipelineDegraded,dataFreshnessSec
  });
}));
app.get("/v1/brain/token/:chain/:mint", asyncRoute(async (req:Request,res) => {
  const chain=routeParam(req.params.chain) as Chain;
  const mint=routeParam(req.params.mint);
  const since=new Date(Date.now()-24*60*60_000);
  const [opportunity,flows,catalyst,token,activity]=await Promise.all([
    db.globalBrainOpportunity.findUnique({where:{chain_mint:{chain,mint}}}),
    db.chainFlowObservation.findMany({where:{chain,mint},orderBy:{observedAt:"desc"},take:80}),
    db.catalystEvent.findFirst({where:{chain,mint},orderBy:{announcedAt:"desc"}}),
    db.discoveryToken.findFirst({where:{chain,mint}}),
    db.walletActivity.findMany({where:{chain,mint,public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:since}},orderBy:{observedAt:"asc"},take:1000})
  ]);

  // Token detail uses the same absolute source invariant as Hunt: an activity row only earns
  // tracked-money authority when its trader STILL owns an enabled, verified Admin Solana wallet.
  // No SmartWalletCandidate stage/score can make a wallet appear here.
  const traderIds=[...new Set(activity.map(a=>a.traderId))];
  const traders=traderIds.length?await db.trader.findMany({
    where:{id:{in:traderIds},kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},
    select:{id:true,displayName:true,handle:true,avatarUrl:true,wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"},select:{address:true}}}
  }):[];
  const traderById=new Map(traders.map(t=>[t.id,t]));
  const activeAdminAddresses=new Set(traders.flatMap(t=>t.wallets.map(w=>w.address)));
  const verifiedFlows=flows.filter(f=>activeAdminAddresses.has(f.walletAddress));
  const verified=activity.filter(a=>traderById.has(a.traderId)&&activeAdminAddresses.has(a.walletAddress));
  const groups=new Map<string,typeof verified>();
  for(const a of verified){const key=`${a.traderId}:${a.walletAddress}`;const rows=groups.get(key)||[];rows.push(a);groups.set(key,rows)}
  const relationships=[...groups.values()].map(rows=>{
    const ordered=[...rows].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime()),first=ordered[0],last=ordered[ordered.length-1];
    const trader=traderById.get(last.traderId)!;
    const buys=ordered.filter(a=>a.action==="BUY"),sells=ordered.filter(a=>a.action==="SELL");
    const boughtUsd=buys.reduce((n,a)=>n+Number(a.amountUsd??0),0),soldUsd=sells.reduce((n,a)=>n+Number(a.amountUsd??0),0);
    const exited=last.action==="SELL"&&last.balanceAfterRaw==="0";
    const state=exited?"EXITED":last.action==="SELL"?"TRIMMED":buys.length>1?"ADDING":"BOUGHT";
    return {
      traderId:trader.id,traderName:trader.displayName,handle:trader.handle,avatarUrl:trader.avatarUrl,
      walletAddress:last.walletAddress,mint:last.mint,state,source:"Admin tracked",stage:"ADMIN_TRACKED",
      firstBuyAt:buys[0]?.observedAt??null,latestBuyAt:buys[buys.length-1]?.observedAt??null,
      latestActivityAt:last.observedAt,latestSide:last.action,latestTxHash:last.sourceTx,
      latestTrimOrSellAt:sells[sells.length-1]?.observedAt??null,
      boughtUsd,soldUsd,netFlowUsd:boughtUsd-soldUsd,eventCount:ordered.length,
      remainingPct:last.balanceBeforeRaw&&last.balanceAfterRaw?(()=>{try{const before=BigInt(last.balanceBeforeRaw),after=BigInt(last.balanceAfterRaw);return before>0n?Math.max(0,Math.min(100,Number(after*10000n/before)/100)):null}catch{return null}})():null,
      holdingVerification:last.balanceAfterRaw!=null?"LAST_OBSERVED_TRANSACTION_BALANCE":"PENDING_CURRENT_BALANCE_VERIFICATION",
      transactionUrl:chain==="SOLANA"?`https://solscan.io/tx/${last.sourceTx}`:null
    };
  }).sort((a,b)=>new Date(b.latestActivityAt).getTime()-new Date(a.latestActivityAt).getTime());

  const summary={
    distinctTrackedTraders:new Set(relationships.map(r=>r.traderId)).size,
    distinctTrackedWallets:new Set(relationships.map(r=>r.walletAddress)).size,
    trackedBuyFlowUsd:relationships.reduce((n,r)=>n+r.boughtUsd,0),
    trackedSellFlowUsd:relationships.reduce((n,r)=>n+r.soldUsd,0),
    netTrackedInflowUsd:relationships.reduce((n,r)=>n+r.netFlowUsd,0),
    activeWallets:relationships.filter(r=>r.state!=="EXITED").length,
    partialExits:relationships.filter(r=>r.state==="TRIMMED").length,
    fullExits:relationships.filter(r=>r.state==="EXITED").length,
    // Rolling-deploy compatibility for a briefly cached older web bundle. These are not candidate
    // grades; every relationship in this route already passed the Admin-tracked invariant above.
    memeCloudPicks:relationships.length,elite:0,proven:0,whales:0
  };
  const trackedMoney={relationships,summary,sourcePolicy:"ADMIN_VERIFIED_SWAP_ACTIVITY_ONLY",windowHours:24};
  res.setHeader("cache-control","no-store");
  res.json({opportunity,flows:verifiedFlows,catalyst,token:token??null,trackedMoney,smartMoney:trackedMoney});
}));

// ------------------------ RETIRED SMART-WALLET COMPATIBILITY ------------------------
// No candidate lifecycle or scoring helpers remain active. Old clients get an explicit retirement
// response rather than silently rebuilding the old architecture.
app.get("/v1/smart-wallets", (_req,res) => res.status(410).json({error:"RETIRED",replacement:"/v1/traders"}));
app.get("/v1/smart-wallets/:id", (_req,res) => res.status(410).json({error:"RETIRED",replacement:"/v1/traders/:id"}));

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
// X social research is optional and explicitly event-only.  A periodic health probe would itself
// consume read quota, so X may be tested manually from Admin but is never background-polled.
const BACKGROUND_HEALTH_KEYS=["marketData","execution","signer","brain"];
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
// rate-limit state (see the rateLimited field added to listener/balance-worker/social-worker
// heartbeats this session). Runs on the same 15-minute cadence as the provider tests above, so a
// single momentary blip can't trigger it -- only a worker still showing rate-limited at the next
// full sampling interval does. Deduped via an unresolved RiskIncident per worker (never spams
// repeatedly) and auto-resolves the moment that worker reports clear again.
const RPC_HEARTBEAT_WORKERS=["solana-listener","market-worker","balance-worker","social-hype"];
async function checkProviderDegradation(){
  try{
    const heartbeats=await db.workerHeartbeat.findMany({where:{name:{in:RPC_HEARTBEAT_WORKERS}}});
    for(const h of heartbeats){
      const dt:any=h.detail??{};
      // A worker's `detail` is whatever it last reported before it stopped heartbeating -- if it
      // died while rate-limited, that stale `rateLimited:true` would otherwise keep recreating/
      // renewing a PROVIDER_DEGRADED incident forever, long after the condition (and the worker's
      // own process) is gone. Only a heartbeat still fresh enough to be a live report counts.
      const heartbeatFresh=Date.now()-h.lastBeatAt.getTime()<=5*60_000;
      const open=await db.riskIncident.findFirst({where:{scope:"PROVIDER_DEGRADED",code:h.name,resolvedAt:{isSet:false}}});
      if(dt.rateLimited&&heartbeatFresh){
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
