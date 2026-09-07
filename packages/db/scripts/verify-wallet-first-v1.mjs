// Read-only production verification for MemeCloud wallet-first v1.
// It never writes. The purpose is to prove the live source invariant after deployment:
// enabled + verified + ACTIVE Admin Solana wallets are the only platform intelligence sources.
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();

const activeWalletRows=await db.traderWallet.findMany({
  where:{chain:"SOLANA",verified:true,source:"ADMIN",monitoringStatus:"ACTIVE",trader:{kind:"PLATFORM",enabled:true}},
  select:{address:true,traderId:true,trader:{select:{displayName:true,handle:true}}}
});
const activeAddresses=new Set(activeWalletRows.map(w=>w.address));
const activeTraderIds=new Set(activeWalletRows.map(w=>w.traderId));

const [legacyCandidates,observationTrader,listenerBeat,recentPublic,recentTransfers,pendingPushes]=await Promise.all([
  db.smartWalletCandidate.count(),
  db.trader.findUnique({where:{handle:"memecloud-observation"},select:{id:true,enabled:true,trackingStatus:true,_count:{select:{wallets:true}}}}).catch(()=>null),
  db.workerHeartbeat.findUnique({where:{name:"solana-listener"}}).catch(()=>null),
  db.walletActivity.findMany({
    where:{public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:new Date(Date.now()-24*60*60_000)}},
    select:{id:true,traderId:true,walletAddress:true,mint:true,action:true,observedAt:true},take:10000
  }),
  db.walletActivity.count({where:{public:true,action:{in:["TRANSFER_IN","TRANSFER_OUT"]}}}),
  db.walletActivity.count({where:{notificationStatus:"PENDING"}})
]);

const invalidPublic=recentPublic.filter(r=>!activeAddresses.has(r.walletAddress)||!activeTraderIds.has(r.traderId));
const detail=(listenerBeat?.detail??{});
const listenerSubscriptions=Number(detail?.subscriptions??NaN);
const listenerFresh=Boolean(listenerBeat&&Date.now()-listenerBeat.lastBeatAt.getTime()<60_000);
const sourceCountMatches=listenerFresh&&Number.isFinite(listenerSubscriptions)
  ? listenerSubscriptions===activeWalletRows.length
  : null;

const out={
  mode:"READ_ONLY_VERIFY",
  activeAdminTraders:new Set(activeWalletRows.map(w=>w.traderId)).size,
  activeAdminWallets:activeWalletRows.length,
  listener:{
    heartbeatFresh:listenerFresh,
    lastBeatAt:listenerBeat?.lastBeatAt??null,
    subscriptions:Number.isFinite(listenerSubscriptions)?listenerSubscriptions:null,
    sourceCountMatches
  },
  legacyCandidateRows:legacyCandidates,
  observationTrader:observationTrader??null,
  publicVerifiedSwapRows24h:recentPublic.length,
  invalidPublicSourceRows24h:invalidPublic.length,
  invalidPublicSample:invalidPublic.slice(0,10),
  publicTransferRows:recentTransfers,
  pendingWalletPushEvents:pendingPushes,
  invariantPass:activeWalletRows.length>0&&sourceCountMatches===true&&invalidPublic.length===0&&recentTransfers===0&&legacyCandidates===0,
  activeWallets:activeWalletRows.map(w=>({address:w.address,trader:w.trader.displayName,handle:w.trader.handle}))
};
console.log(JSON.stringify(out,null,2));
await db.$disconnect();
if(!out.invariantPass)process.exitCode=2;
