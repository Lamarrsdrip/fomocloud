import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, type Chain } from "@memecloud/db";
import { microsToUsd, tradingCashUsdFields, positionUsdFields } from "@memecloud/shared";
import { getConfig, setConfig, redactedConfig, maskHint, recordProviderResults, fingerprintOf, ackRestart, readExecutionState } from "@memecloud/config";
import { shouldProve } from "@memecloud/discovery";
import { sendEmail, sendPush, ensureVapid } from "@memecloud/notifications";
import { asyncRoute, routeParam, normalizeEmail, safeUser, validPublicAddress, audit, ensureUserDefaults } from "./auth.js";
import { requireAdmin, adminOnly, type AuthedRequest } from "./middleware.js";
import { runProviderTests, PROVIDER_FINGERPRINT_FIELDS } from "./providerHealth.js";
import { broadcastQueue, redis } from "./queues.js";

export const adminRoutes = Router();

adminRoutes.post("/v1/admin/bootstrap", asyncRoute(async (req,res) => {
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

adminRoutes.get("/v1/admin/overview", requireAdmin, asyncRoute(async (_req:AuthedRequest,res) => {
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
    db.position.aggregate({where:{mode:"LIVE"},_sum:{realizedPnlUsdMicros:true,unrealizedPnlUsdMicros:true}}),
    db.tradingCashAllocation.aggregate({_sum:{availableUsdMicros:true,inTradesUsdMicros:true}}),
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
      trading:{openPositions,ordersToday,buysToday:buyOrders,sellsToday:sellOrders,liveOrders,simulationOrders,realizedPnlUsd:microsToUsd(livePnl._sum.realizedPnlUsdMicros??0n),unrealizedPnlUsd:microsToUsd(livePnl._sum.unrealizedPnlUsdMicros??0n),allocatedCashUsd:microsToUsd((cash._sum.availableUsdMicros??0n)+(cash._sum.inTradesUsdMicros??0n))},
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

adminRoutes.get("/v1/admin/users", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
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
adminRoutes.get("/v1/admin/users/:id", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
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
  // M-30: BigInt micro-USD storage -- convert both before any arithmetic AND before this reaches
  // res.json() below (a raw BigInt field would throw there).
  const cashAllocations=user.cashAllocations.map(a=>({...a,...tradingCashUsdFields(a)}));
  const positions=user.positions.map(p=>({...p,...positionUsdFields(p)}));
  const live=positions.filter(p=>p.mode==="LIVE"), open=live.filter(p=>p.status==="OPEN"||p.status==="PARTIALLY_CLOSED");
  const available=cashAllocations.reduce((a,x)=>a+x.availableUsd,0), inTrades=cashAllocations.reduce((a,x)=>a+x.inTradesUsd,0);
  const summary={
    tradingCashUsd:available+inTrades,availableUsd:available,inTradesUsd:inTrades,
    realizedPnlUsd:live.reduce((a,p)=>a+p.realizedPnlUsd,0),unrealizedPnlUsd:open.reduce((a,p)=>a+p.unrealizedPnlUsd,0),
    openLivePositions:open.length,simulationPositions:positions.filter(p=>p.mode==="SIMULATION"&&(p.status==="OPEN"||p.status==="PARTIALLY_CLOSED")).length
  };
  res.json({user:{...user,cashAllocations,positions},summary});
}));

adminRoutes.patch("/v1/admin/users/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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

adminRoutes.get("/v1/admin/traders", requireAdmin, asyncRoute(async (_req,res) => {
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM"},
    include:{wallets:true,_count:{select:{follows:true,signals:true}}},
    orderBy:{createdAt:"desc"}
  });
  res.json({traders});
}));
adminRoutes.post("/v1/admin/traders", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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
adminRoutes.patch("/v1/admin/traders/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const allowed=["displayName","xHandle","bio","category","enabled","featured","recommended","defaultSelected","verification","trackingStatus"] as const;
  const data:any={}; for(const k of allowed) if(req.body?.[k]!==undefined) data[k]=req.body[k];
  const trader=await db.trader.update({where:{id:routeParam(req.params.id)},data});
  await audit(req.user.sub,"ADMIN","UPDATE_PLATFORM_TRADER",trader.id,data);
  res.json({trader});
}));
adminRoutes.post("/v1/admin/traders/:id/wallets", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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

adminRoutes.delete("/v1/admin/trader-wallets/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.traderWallet.findUnique({where:{id:routeParam(req.params.id)}});
  if(!wallet) return res.status(404).json({error:"TRADER_WALLET_NOT_FOUND"});
  await db.traderWallet.delete({where:{id:wallet.id}});
  await audit(req.user.sub,"ADMIN","REMOVE_TRADER_WALLET",wallet.id,{traderId:wallet.traderId,chain:wallet.chain,address:wallet.address});
  res.json({ok:true});
}));

adminRoutes.get("/v1/admin/brain", requireAdmin, asyncRoute(async (_req,res) => {
  const [opportunities,flows,outcomes,mostRecentlyEvaluated]=await Promise.all([
    db.globalBrainOpportunity.findMany({orderBy:[{lastEvaluatedAt:"desc"},{score:"desc"}],take:300}),
    db.chainFlowObservation.findMany({orderBy:{observedAt:"desc"},take:500}),
    db.brainOutcomeSample.findMany({orderBy:{observedAt:"desc"},take:500}),
    // Real gap found by forensic audit (M-46): the user-facing /v1/brain/feed already computes
    // pipelineDegraded/dataFreshnessSec so a stalled brain-worker reads as "degraded," not
    // falsely-live -- the admin equivalent of this exact same feed had never had it.
    db.globalBrainOpportunity.findFirst({orderBy:{lastEvaluatedAt:"desc"},select:{lastEvaluatedAt:true}})
  ]);
  const dataFreshnessSec=mostRecentlyEvaluated?Math.round((Date.now()-mostRecentlyEvaluated.lastEvaluatedAt.getTime())/1000):null;
  const pipelineDegraded=dataFreshnessSec===null||dataFreshnessSec>300;
  res.json({opportunities,flows,outcomes,pipelineDegraded,dataFreshnessSec});
}));

adminRoutes.get("/v1/admin/discovery/candidates", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const stage=String(req.query.stage??"").toUpperCase();
  const where:any={}; if(stage)where.stage=stage;
  const [candidates,mostRecentlyScored]=await Promise.all([
    db.smartWalletCandidate.findMany({where,orderBy:[{copyabilityScore:"desc"},{updatedAt:"desc"}],take:500}),
    // Real gap found by forensic audit (M-46): the user-facing /v1/smart-wallets already computes
    // pipelineDegraded/dataFreshnessSec (30min threshold, matching scoring-worker's real cadence)
    // so a stalled scoring-worker reads as "degraded," not falsely-live -- the admin Whales desk,
    // reading the exact same candidate table, never had it.
    db.smartWalletCandidate.findFirst({orderBy:{lastScoredAt:"desc"},select:{lastScoredAt:true}})
  ]);
  const dataFreshnessSec=mostRecentlyScored?.lastScoredAt?Math.round((Date.now()-mostRecentlyScored.lastScoredAt.getTime())/1000):null;
  const pipelineDegraded=dataFreshnessSec===null||dataFreshnessSec>1800;
  res.json({candidates,pipelineDegraded,dataFreshnessSec});
}));
adminRoutes.post("/v1/admin/discovery/candidates", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const chain=String(req.body?.chain??"").toUpperCase();
  const address=String(req.body?.address??"").trim();
  const label=req.body?.label?String(req.body.label):undefined;
  if(!["SOLANA","BASE","ETHEREUM","BNB","ARBITRUM","AVALANCHE"].includes(chain)) return res.status(400).json({error:"INVALID_CHAIN"});
  if(!address) return res.status(400).json({error:"ADDRESS_REQUIRED"});
  const existing=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:chain as Chain,address}}});
  if(existing) return res.status(409).json({error:"WALLET_ALREADY_TRACKED"});
  const candidate=await db.smartWalletCandidate.create({data:{chain:chain as Chain,address,stage:"DISCOVERED",source:"ADMIN_MANUAL",label,adminWatched:true,adminWatchedAt:new Date(),metadata:{discoveryReason:"Added by admin for observation. Objective scoring decides PAPER_TRACKING/PROVEN automatically; admin addition itself grants no trust."}}});
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_ADD",candidate.id,{chain,address,label});
  res.status(201).json({candidate});
}));
adminRoutes.patch("/v1/admin/discovery/candidates/:id", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const c=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});if(!c)return res.status(404).json({error:"CANDIDATE_NOT_FOUND"});
  const data:any={};
  if(typeof req.body?.label==="string") data.label=req.body.label;
  const updated=await db.smartWalletCandidate.update({where:{id:c.id},data});
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_UPDATE",c.id,data);
  res.json({candidate:updated});
}));
adminRoutes.get("/v1/admin/discovery/tokens", requireAdmin, asyncRoute(async (_req,res) => {
  const [tokens,mostRecentlySeen]=await Promise.all([
    db.discoveryToken.findMany({orderBy:{lastSeenAt:"desc"},take:500}),
    // Real gap found by forensic audit (M-46): same pipelineDegraded/dataFreshnessSec pattern
    // already applied to admin Brain/Whales this session -- discovery-worker writing lastSeenAt
    // is what actually keeps this table live; a stalled worker should read as degraded, not silently
    // look like "no new tokens right now."
    db.discoveryToken.findFirst({orderBy:{lastSeenAt:"desc"},select:{lastSeenAt:true}})
  ]);
  const dataFreshnessSec=mostRecentlySeen?Math.round((Date.now()-mostRecentlySeen.lastSeenAt.getTime())/1000):null;
  // discovery-worker's default tick is 15 minutes (DISCOVERY_SCAN_INTERVAL_MS); 30 minutes gives a
  // full missed-tick margin before calling it degraded, same discipline as /v1/smart-wallets' 30min
  // bar against scoring-worker's 10min tick.
  const pipelineDegraded=dataFreshnessSec===null||dataFreshnessSec>1800;
  res.json({tokens,pipelineDegraded,dataFreshnessSec});
}));
adminRoutes.get("/v1/admin/positions", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const status=String(req.query.status??"").toUpperCase();
  const positions=await db.position.findMany({
    where:status?{status:status as any}:undefined,
    include:{user:{select:{id:true,email:true,displayName:true}},sourceTrader:{select:{id:true,displayName:true,handle:true}}},
    orderBy:{openedAt:"desc"},take:300
  });
  res.json({positions});
}));
adminRoutes.get("/v1/admin/intelligence/snapshots", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const mint=String(req.query.mint??"").trim();
  const snapshots=await db.memeMarketSnapshot.findMany({where:mint?{mint}:undefined,orderBy:{observedAt:"desc"},take:250});
  res.json({snapshots});
}));
adminRoutes.get("/v1/admin/risk-incidents", requireAdmin, asyncRoute(async (_req,res) => {
  res.json({incidents:await db.riskIncident.findMany({orderBy:{createdAt:"desc"},take:250})});
}));
// Real gap found by forensic audit (M-12/PC-D): there was no admin-facing view of watched wallets
// at all. Recent activity is pulled live from chainFlowObservation, the same continuous stream
// wallet-first listener writes for explicitly monitored wallets -- this route doesn't drive the
// monitoring itself (that runs in brain-worker's checkWatchlist regardless of whether anyone ever
// opens this page), it just surfaces what's already been detected.
adminRoutes.get("/v1/admin/discovery/watchlist", requireAdmin, asyncRoute(async (_req,res) => {
  const watched=await db.smartWalletCandidate.findMany({where:{adminWatched:true},orderBy:{adminWatchedAt:"desc"}});
  const addresses=watched.map(w=>w.address);
  const recentActivity=addresses.length?await db.chainFlowObservation.findMany({where:{walletAddress:{in:addresses},observedAt:{gte:new Date(Date.now()-24*3600_000)}},orderBy:{observedAt:"desc"},take:200}):[];
  const byAddress=new Map<string,typeof recentActivity>();
  for(const row of recentActivity){const list=byAddress.get(row.walletAddress)??[];list.push(row);byAddress.set(row.walletAddress,list)}
  res.json({watchlist:watched.map(w=>({...w,recentActivity:byAddress.get(w.address)??[]}))});
}));
adminRoutes.get("/v1/admin/alerts", requireAdmin, asyncRoute(async (req:AuthedRequest,res) => {
  const unresolvedOnly=String(req.query.unresolved??"")==="true";
  const alerts=await db.adminAlert.findMany({where:unresolvedOnly?{resolvedAt:null}:undefined,orderBy:{createdAt:"desc"},take:250});
  res.json({alerts});
}));
adminRoutes.post("/v1/admin/alerts/:id/resolve", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const alert=await db.adminAlert.update({where:{id:routeParam(req.params.id)},data:{resolvedAt:new Date()}}).catch(()=>null);
  if(!alert)return res.status(404).json({error:"ALERT_NOT_FOUND"});
  await audit(req.user.sub,"ADMIN","ADMIN_ALERT_RESOLVED",alert.id,{});
  res.json({alert});
}));
adminRoutes.post("/v1/admin/discovery/candidates/:id/decision", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const action=String(req.body?.action??"").toUpperCase();
  if(!["REJECTED","PAUSED","WATCH","UNWATCH"].includes(action))return res.status(400).json({error:"INVALID_DISCOVERY_ACTION"});
  const c=await db.smartWalletCandidate.findUnique({where:{id:routeParam(req.params.id)}});if(!c)return res.status(404).json({error:"CANDIDATE_NOT_FOUND"});
  // WATCH/UNWATCH deliberately never touch `stage` -- a separate boolean so admin watch/unwatch can
  // never fight with or get silently overwritten by the objective scoring-worker pipeline. "WATCH
  // != PROVEN" holds structurally here, not just as a rule someone has to remember to follow.
  if(action==="WATCH"||action==="UNWATCH"){
    const updated=await db.smartWalletCandidate.update({where:{id:c.id},data:{adminWatched:action==="WATCH",adminWatchedAt:action==="WATCH"?new Date():null}});
    await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_DECISION",c.id,{action});
    return res.json({candidate:updated});
  }
  // PROVEN is intentionally not an admin action. The scorer owns promotion from objective evidence.
  // REJECTED/PAUSED are safety controls only and always remove live-copy eligibility immediately.
  const updated=await db.smartWalletCandidate.update({where:{id:c.id},data:{stage:action as any,rejectedReason:action==="REJECTED"?String(req.body?.reason??"ADMIN_REJECTED"):undefined}});
  if(c.traderId){
    await db.trader.update({where:{id:c.traderId},data:{enabled:false,trackingStatus:action,recommended:false}}).catch(()=>{});
    await db.traderWallet.updateMany({where:{traderId:c.traderId},data:{monitoringStatus:action}}).catch(()=>{});
  }
  await audit(req.user.sub,"ADMIN","DISCOVERY_CANDIDATE_DECISION",c.id,{action,reason:req.body?.reason});
  res.json({candidate:updated});
}));

adminRoutes.get("/v1/admin/signals", requireAdmin, asyncRoute(async (_req,res) => {
  const signals=await db.signal.findMany({
    include:{trader:true,_count:{select:{copyDecisions:true}}},
    orderBy:{observedAt:"desc"},take:200
  });
  res.json({signals});
}));
adminRoutes.get("/v1/admin/trades", requireAdmin, asyncRoute(async (_req,res) => {
  const orders=await db.order.findMany({
    include:{user:{select:{id:true,email:true,displayName:true}},decision:{include:{signal:{include:{trader:true}}}}},
    orderBy:{createdAt:"desc"},take:250
  });
  res.json({orders});
}));

const allowedConfigKeys=new Set(["push","email","chains","execution","fees","risk","marketData","social","branding","signer","discovery","brain"]);
const secretConfigKeys=new Set(["push","email","execution","marketData","social","signer"]);
// Verified 2026-08-29 against every current consumer (services/listener, executor, exits,
// market-worker, balance-worker, paper-worker, discovery-worker, scoring-worker, brain-worker):
// every key that once required a restart is now re-read on a live timer or fresh every cycle/tick
// (executor/exits/paper-worker on a 60s reloadConfig timer; market-worker, balance-worker, listener
// per-cycle; discovery-worker, scoring-worker fresh inside
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
adminRoutes.use("/v1/admin/config", (_req,res,next)=>{res.set("Cache-Control","no-store");next()});
// heliusRpc/solanaRpc/fallbackRpc are now listed in SECRET_FIELDS.marketData (a paid RPC URL
// commonly embeds the provider's API key in its query string), so redactedConfig already strips
// them before this runs. Kept as an explicit hook rather than removed outright, in case another
// field-shaped leak like this shows up again.
function sanitizeForClient(cfg:any){
  return cfg;
}
adminRoutes.get("/v1/admin/config", requireAdmin, asyncRoute(async (_req,res) => {
  const rows=await db.appConfig.findMany({orderBy:{key:"asc"}});
  res.json({config:rows.map(r=>sanitizeForClient(redactedConfig(r as any,SECRET_FIELDS[r.key]??[],PROVIDER_FINGERPRINT_FIELDS[r.key])))});
}));
adminRoutes.put("/v1/admin/config/:key", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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

adminRoutes.post("/v1/admin/push/generate", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const cfg=await ensureVapid(req.user.sub);
  await audit(req.user.sub,"ADMIN","GENERATE_VAPID");
  res.json({ok:true,publicKey:cfg.vapidPublicKey});
}));
adminRoutes.post("/v1/admin/test-push", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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
adminRoutes.post("/v1/admin/test-email", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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
adminRoutes.post("/v1/admin/config/:key/test", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
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
adminRoutes.post("/v1/admin/config/:key/ack-restart", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const key=routeParam(req.params.key);
  const row=await ackRestart(key);
  await audit(req.user.sub,"ADMIN","CONFIG_RESTART_ACK",key);
  res.json({ok:true,config:row?sanitizeForClient(redactedConfig(row as any,SECRET_FIELDS[key]??[],PROVIDER_FINGERPRINT_FIELDS[key])):null});
}));
adminRoutes.post("/v1/admin/broadcast", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const title=String(req.body?.title??"").trim(), body=String(req.body?.body??"").trim();
  const channel=String(req.body?.channel??"PUSH").toUpperCase(), audience=String(req.body?.audience??"ALL").toUpperCase();
  if(!title||!body) return res.status(400).json({error:"TITLE_AND_BODY_REQUIRED"});
  if(!["PUSH","EMAIL","BOTH"].includes(channel)) return res.status(400).json({error:"INVALID_CHANNEL"});
  const row=await db.broadcast.create({data:{title,body,channel,audience,linkUrl:req.body?.linkUrl||undefined,status:"QUEUED",createdBy:req.user.sub}});
  await broadcastQueue.add("broadcast",{broadcastId:row.id},{jobId:row.id,attempts:4,backoff:{type:"exponential",delay:2000}});
  await audit(req.user.sub,"ADMIN","QUEUE_BROADCAST",row.id,{channel,audience});
  res.status(202).json({broadcast:row});
}));
adminRoutes.get("/v1/admin/broadcasts", requireAdmin, asyncRoute(async (_req,res) => {
  res.json({broadcasts:await db.broadcast.findMany({orderBy:{createdAt:"desc"},take:100})});
}));
adminRoutes.get("/v1/admin/audit", requireAdmin, asyncRoute(async (_req,res) => {
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
adminRoutes.get("/v1/admin/health", requireAdmin, asyncRoute(async (_req,res) => {
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

adminRoutes.get("/v1/admin/live-readiness", requireAdmin, asyncRoute(async (_req,res) => {
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
adminRoutes.post("/v1/admin/live-trading/enable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  const readiness=await computeLiveReadiness();
  if(!readiness.ready) return res.status(409).json({error:"NOT_READY",reasons:readiness.reasons,blockers:readiness.blockers,executionState:readiness});
  await setConfig("liveTrading",{enabled:true,enabledAt:new Date().toISOString(),enabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_ENABLE","liveTrading",{});
  const executionState=await computeLiveReadiness();
  res.json({ok:true,enabled:executionState.newEntriesLive,requested:true,executionState});
}));
adminRoutes.post("/v1/admin/live-trading/disable", adminOnly, asyncRoute(async (req:AuthedRequest,res) => {
  await setConfig("liveTrading",{enabled:false,disabledAt:new Date().toISOString(),disabledBy:req.user.sub},{secret:false,updatedBy:req.user.sub});
  await audit(req.user.sub,"OWNER","LIVE_TRADING_DISABLE","liveTrading",{});
  res.json({ok:true,enabled:false,requested:false,executionState:await computeLiveReadiness()});
}));
