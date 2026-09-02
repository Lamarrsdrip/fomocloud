import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { db, type Chain, type FollowMode } from "@memecloud/db";
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
import { redis } from "./queues.js";
import { runProviderTests } from "./providerHealth.js";
import { asyncRoute, routeParam, normalizeEmail, validPublicAddress, hashToken, randomToken, safeUser, parseCookies, refreshCookieOptions, audit, ensureUserDefaults, canEnableAutoCopy, reasonText } from "./auth.js";
import { USDC_SOL, manualTradeTrader, reconcileConfirmedManualSwap, recoverManualPrivyHash } from "./trading.js";

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
          db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsdMicros:usdToMicros(actualUsd),avgEntryPriceUsdMicros:usdToMicros(actualEntry),currentPriceUsdMicros:usdToMicros(actualEntry),peakPriceUsdMicros:usdToMicros(actualEntry),takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}})
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
      db.position.create({data:{userId:req.user.sub,sourceTraderId:trader.id,chain:"SOLANA",mode:"LIVE",mint,quoteMint:USDC_SOL,entryTxHash:hash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsdMicros:usdToMicros(actualUsd),avgEntryPriceUsdMicros:usdToMicros(actualEntry),currentPriceUsdMicros:usdToMicros(actualEntry),peakPriceUsdMicros:usdToMicros(actualEntry),takeProfitPct:200,status:"OPEN",lastMarkedAt:new Date()}})
    ]);
    await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"CONFIRMED",txHash:hash}});
    order=await db.order.findUnique({where:{id:order.id}});
    await db.userActivityEvent.create({data:{userId:req.user.sub,type:"TRADE_COPIED",title:"Manual buy confirmed",body:`Bought $${actualUsd.toFixed(2)} of the token. The transaction is confirmed on Solana.`,data:{orderId:order!.id,positionId:position.id,mint,txHash:hash} as any}});
    await audit(req.user.sub,"USER","MANUAL_TRADE",position.id,{mint,amountUsd:actualUsd,mode:"LIVE",txHash:hash});
    res.status(201).json({ok:true,mode:"LIVE",order,position:{...position,...positionUsdFields(position)}});
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
  if(address&&chain==="SOLANA")await db.smartWalletCandidate.upsert({
    where:{chain_address:{chain:"SOLANA",address}},
    update:{source:"USER_WATCHLIST"},
    create:{chain:"SOLANA",address,stage:"DISCOVERED",source:"USER_WATCHLIST",metadata:{discoveryReason:"Added by a user for observation. Objective scoring decides whether it earns PAPER_TRACKING or PROVEN status."}}
  }).catch(()=>{});
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
  if(chain==="SOLANA")await db.smartWalletCandidate.upsert({where:{chain_address:{chain:"SOLANA",address}},update:{source:"USER_WATCHLIST"},create:{chain:"SOLANA",address,stage:"DISCOVERED",source:"USER_WATCHLIST",metadata:{discoveryReason:"Added by a user for observation. Objective scoring decides whether it earns PAPER_TRACKING or PROVEN status."}}}).catch(()=>{});
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
        score:{gte:QUALIFIED_MIN_SCORE},
        state:{in:["BUILDING","BREAKOUT_FLOW","MONEY_RUSH"]}
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
  const [opportunity,flows,catalyst]=await Promise.all([
    db.globalBrainOpportunity.findUnique({where:{chain_mint:{chain,mint}}}),
    db.chainFlowObservation.findMany({where:{chain,mint},orderBy:{observedAt:"desc"},take:40}),
    db.catalystEvent.findFirst({where:{chain,mint},orderBy:{announcedAt:"desc"}})
  ]);
  const addresses=[...new Set(flows.map(f=>f.walletAddress))];
  const [candidates,signals,tokens]=await Promise.all([
    addresses.length?db.smartWalletCandidate.findMany({where:{chain,address:{in:addresses}},take:200}):Promise.resolve([]),
    addresses.length?db.signal.findMany({where:{chain,sourceWallet:{in:addresses},OR:[{outputMint:mint},{inputMint:mint}]},orderBy:{observedAt:"desc"},take:300}):Promise.resolve([]),
    db.discoveryToken.findMany({where:{chain,mint},take:1})
  ]);
  const relationships=relationshipRows(flows,signals,new Map(candidates.map((c:any)=>[c.address,c])),new Map(tokens.map((t:any)=>[t.mint,t])));
  const summary={distinctTrackedWallets:new Set(relationships.map(r=>r.walletAddress)).size,memeCloudPicks:relationships.filter(r=>r.source==="MemeCloud Pick").length,elite:relationships.filter(r=>r.stage==="PROVEN"&&Number(r.skillScore??0)>=90).length,proven:relationships.filter(r=>r.stage==="PROVEN").length,whales:relationships.filter(r=>r.isWhale).length,trackedBuyFlowUsd:relationships.reduce((n,r)=>n+r.boughtUsd,0),trackedSellFlowUsd:relationships.reduce((n,r)=>n+r.soldUsd,0),netTrackedInflowUsd:relationships.reduce((n,r)=>n+r.netFlowUsd,0),lastObservedHolding:relationships.filter(r=>r.state==="LAST_OBSERVED_HOLDING").length,partialExits:relationships.filter(r=>["TRIMMED","MOSTLY_EXITED"].includes(r.state)).length,fullExits:relationships.filter(r=>r.state==="EXITED").length};
  res.json({opportunity,flows,catalyst,token:tokens[0]??null,smartMoney:{relationships,summary}});
}));

// ------------------------ SMART WALLETS (public) ------------------------
// Real evidence only, from packages/discovery's sample-size-aware scoring (shouldPaperTrack
// requires >=15 observed trades, shouldProve requires >=20 forward signals) -- never a label from
// one lucky trade. Whale status (when independently verified) is a separate signal from trading skill
// and is surfaced as its own field, not conflated with copyabilityScore.
function smartWalletSummary(c:any){
  const winRatePct=c.sampleTrades>0?Math.round((c.profitableTrades/c.sampleTrades)*1000)/10:null;
  const meta=(c.metadata??{}) as any;
  // A label or a stale historical observation is not whale evidence.  Only a
  // fresh, timestamped balance observation may render a whale badge.
  const balanceObservedAt=meta.walletBalanceObservedAt??null;
  const balanceFresh=balanceObservedAt&&Date.now()-new Date(balanceObservedAt).getTime()<=7*24*60*60_000;
  // Stablecoin capital alone is not meme-whale evidence. The scorer requires fresh, meaningful
  // meme positions/volume and persists that separate classification.
  const isWhale=Boolean(meta.isMemeWhale&&String(meta.whaleTier??"").startsWith("WHALE_MEME_"));
  const whaleTier=isWhale?meta.whaleTier:null;
  const lastObservedTradeAt=meta.lastObservedTradeAt??null;
  return {
    id:c.id,chain:c.chain,address:c.address,stage:c.stage,traderId:c.traderId??null,
    intelligenceTier:c.stage==="PROVEN"&&Number(meta.skillScore??c.copyabilityScore)>=90&&Number(c.riskScore)<=30&&Number(meta.evidenceCompleteness??0)>=85&&Number(meta.currentFormScore??0)>=60?"ELITE":c.stage==="PROVEN"?"PROVEN":c.stage==="PAPER_TRACKING"?"WATCHING":"CANDIDATE",
    copyEligible:c.stage==="PROVEN"&&Boolean(c.traderId),
    isWhale,whaleTier,walletBalanceUsd:balanceFresh?meta.walletBalanceUsd:null,walletBalanceObservedAt:balanceFresh?balanceObservedAt:null,
    walletType:meta.walletType??"INSUFFICIENT_EVIDENCE",isSmartDegen:Boolean(meta.isSmartDegen),capitalScore:meta.capitalScore??null,typicalMemePositionUsd:meta.typicalMemePositionUsd??null,largestMemePositionUsd:meta.largestMemePositionUsd??null,memeBuyVolume30dUsd:meta.memeBuyVolume30dUsd??null,
    copyabilityScore:c.copyabilityScore,sourceQualityScore:c.sourceQualityScore,riskScore:c.riskScore,consistencyScore:c.consistencyScore,entryQualityScore:c.entryQualityScore,
    skillScore:meta.skillScore??null,currentFormScore:meta.currentFormScore??null,activityScore:meta.activityScore??null,forwardHitRatePct:meta.forwardHitRatePct??null,forwardMeanPct:meta.forwardMeanPct??null,distinctTokens30d:meta.distinctTokens30d??null,
    sampleTrades:c.sampleTrades,profitableTrades:c.profitableTrades,
    winRatePct,
    realizedPnlUsd:c.realizedPnlUsd,totalPnlUsd:c.totalPnlUsd,volumeUsd:c.volumeUsd,
    realizedPnl7dUsd:c.realizedPnl7dUsd??null,winRate7dPct:c.winRate7dPct??null,
    averageWinnerPct:c.averageWinnerPct??null,averageLoserPct:c.averageLoserPct??null,averageChasePct:c.averageChasePct??null,
    verifiedRugExposurePct:meta.verifiedRugExposurePct??null,catastrophicLossRatePct:meta.catastrophicLossRatePct??null,insiderRiskPct:c.insiderRiskPct??null,evidenceCompleteness:meta.evidenceCompleteness??null,riskEvidenceCompleteness:meta.riskEvidenceCompleteness??null,
    performance90d:meta.walletPnl90d?.tradeCount>=10?meta.walletPnl90d:null,earlyEntry:meta.earlyEntryProvenance?.sampleSize>=10?{edgePct:meta.earlyEntryEdgePct,provenance:meta.earlyEntryProvenance}:null,
    source:c.source,sourceLabel:smartWalletSourceLabel(c,meta),sourceToken:c.sourceToken,discoveryReason:meta.discoveryReason??null,adminDesignation:meta.adminDesignation??null,monitoringPriority:meta.monitoringPriority??null,researchSource:meta.researchSource??null,researchReason:meta.researchReason??null,researchNotes:meta.researchNotes??null,researchAddedAt:meta.researchAddedAt??null,researchProvenanceStatus:meta.researchProvenanceStatus??null,providerStatus:meta.providerStatus??null,providerEvidenceObservedAt:meta.providerEvidenceObservedAt??null,providerEvidenceFresh:Boolean(meta.providerEvidenceFresh),
    // Never use a database update/scoring timestamp as blockchain activity.
    firstDiscoveredAt:c.createdAt,lastScoredAt:c.lastScoredAt,lastActivityAt:lastObservedTradeAt,
    paperStartedAt:c.paperStartedAt,provenAt:c.provenAt
  };
}
function smartWalletSourceLabel(c:any,meta:any){
  if(meta?.curatedByPlatform||c.source==="MEMECLOUD_CURATED")return "MemeCloud Pick";
  if(c.source==="PLATFORM_ADDED")return "Platform Added";
  if(c.source==="TRADER_LEADERBOARD")return "Highly Followed Trader";
  if(c.source==="TRUSTED_WALLET_NEIGHBORHOOD")return "Platform Tracked";
  if(c.source==="PUMPFUN_HIGH_EARNER")return "Pump.fun High Earner";
  if(c.source==="MANUAL_REVIEW")return "Manual Review";
  if(c.source==="LAUNCHPAD_COUNTERPARTY")return "Launchpad Trader Lead";
  return "Platform Tracked";
}
function rawBalanceState(raw:any){
  if(raw==null||raw==="")return null;
  try{return BigInt(String(raw))===0n?"EXITED":"LAST_OBSERVED_HOLDING"}catch{return null}
}
// A transaction balance is only an observed-at-that-transaction balance. It is
// intentionally never presented as a current holding without a later balance
// verification. This keeps wallet activity useful without inventing custody.
function relationshipRows(flows:any[],signals:any[],candidateByAddress:Map<string,any>,tokens=new Map<string,any>()){
  const grouped=new Map<string,any[]>();for(const f of flows){const k=`${f.walletAddress}:${f.mint}`;const a=grouped.get(k)??[];a.push(f);grouped.set(k,a);}
  const byTx=new Map(signals.map((s:any)=>[`${s.sourceWallet}:${s.sourceTx}:${s.action}`,s]));
  return [...grouped.values()].map(rows=>{
    const ordered=[...rows].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime()),last=ordered.at(-1)!;
    const candidate=candidateByAddress.get(last.walletAddress),meta=candidate?.metadata??{};
    const signal=byTx.get(`${last.walletAddress}:${last.txHash}:${last.side}`);
    const balanceState=rawBalanceState(signal?.sourceTokenBalanceAfterRaw);
    const buys=ordered.filter(x=>x.side==="BUY"),sells=ordered.filter(x=>x.side==="SELL");
    const soldPct=signal?.sourceSoldPct==null?null:Number(signal.sourceSoldPct);
    const state=balanceState??(last.side==="BUY"?(buys.length>1?"ADDED":"BOUGHT"):(soldPct!=null&&soldPct>=95?"EXITED":soldPct!=null&&soldPct>=75?"MOSTLY_EXITED":"TRIMMED"));
    const boughtUsd=buys.reduce((n,x)=>n+Number(x.amountUsd??0),0),soldUsd=sells.reduce((n,x)=>n+Number(x.amountUsd??0),0);
    return {chain:last.chain,mint:last.mint,token:tokens.get(last.mint)??null,walletAddress:last.walletAddress,label:candidate?.label??null,source:candidate?smartWalletSourceLabel(candidate,meta):"Tracked wallet",stage:candidate?.stage??"UNVERIFIED",skillScore:candidate?Number(meta.skillScore??candidate.copyabilityScore??0):null,isWhale:candidate?smartWalletSummary(candidate).isWhale:false,firstBuyAt:buys[0]?.observedAt??null,latestBuyAt:buys.at(-1)?.observedAt??null,latestActivityAt:last.observedAt,latestSide:last.side,latestTxHash:last.txHash,latestTrimOrSellAt:sells.at(-1)?.observedAt??null,boughtUsd,soldUsd,netFlowUsd:boughtUsd-soldUsd,eventCount:ordered.length,state,remainingPct:soldPct==null?null:Math.max(0,100-soldPct),lastObservedBalanceRaw:signal?.sourceTokenBalanceAfterRaw??null,balanceObservedAt:signal?.sourceTokenBalanceAfterRaw!=null?signal.observedAt:null,holdingVerification:balanceState?"LAST_OBSERVED_TRANSACTION_BALANCE":"PENDING_CURRENT_BALANCE_VERIFICATION",transactionUrl:last.chain==="SOLANA"?`https://solscan.io/tx/${last.txHash}`:null};
  }).sort((a,b)=>b.latestActivityAt.getTime()-a.latestActivityAt.getTime());
}
app.get("/v1/smart-wallets", asyncRoute(async (req,res) => {
  const stageParam=String(req.query.stage??"").toUpperCase();
  const includeWhalesOnly=String(req.query.whales??"")==="true";
  const where:any={stage:stageParam&&["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN","PAUSED"].includes(stageParam)?stageParam:{in:["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN"]}};
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
  const wallets=candidates.map(smartWalletSummary).filter(w=>!includeWhalesOnly||w.isWhale);
  res.json({wallets,pipelineDegraded,dataFreshnessSec});
}));
app.get("/v1/smart-wallets/:id", asyncRoute(async (req,res) => {
  const candidate=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});
  if(!candidate)return res.status(404).json({error:"SMART_WALLET_NOT_FOUND"});
  const recentFlow=await db.chainFlowObservation.findMany({where:{chain:candidate.chain,walletAddress:candidate.address},orderBy:{observedAt:"desc"},take:120});
  const uniqueMints=[...new Set(recentFlow.map(f=>f.mint))].slice(0,20);
  const tokenRows=uniqueMints.length?await db.discoveryToken.findMany({where:{chain:candidate.chain,mint:{in:uniqueMints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,liquidityUsd:true}}):[];
  const tokenMap=new Map<string,any>(tokenRows.map((t:any)=>[t.mint,t]));
  const signals=await db.signal.findMany({where:{chain:candidate.chain,sourceWallet:candidate.address},orderBy:{observedAt:"desc"},take:150});
  const relationships=relationshipRows(recentFlow,signals,new Map([[candidate.address,candidate]]),tokenMap);
  const recentActivity=recentFlow.map(f=>({...f,token:tokenMap.get(f.mint)||null}));
  res.json({wallet:smartWalletSummary(candidate),recentActivity,relationships,currentTokens:relationships});
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
