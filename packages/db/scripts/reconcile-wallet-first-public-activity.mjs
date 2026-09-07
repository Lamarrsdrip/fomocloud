// Non-financial public-feed reconciliation for the wallet-first cutover.
// It never deletes WalletActivity. It only removes PUBLIC visibility / pending push status from
// historical rows that are not owned by the wallet's CURRENT enabled+verified+ACTIVE Admin trader.
// This prevents the old synthetic/candidate architecture from leaking into Home/Hunt after deploy.
//
// node packages/db/scripts/reconcile-wallet-first-public-activity.mjs          # dry run
// node packages/db/scripts/reconcile-wallet-first-public-activity.mjs --apply
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const apply=process.argv.includes("--apply");

const active=await db.traderWallet.findMany({
  where:{chain:"SOLANA",source:"ADMIN",verified:true,monitoringStatus:"ACTIVE",trader:{kind:"PLATFORM",enabled:true}},
  select:{address:true,traderId:true}
});
const ownerByAddress=new Map(active.map(w=>[w.address,w.traderId]));
const publicRows=await db.walletActivity.findMany({
  where:{public:true},
  select:{id:true,chain:true,traderId:true,walletAddress:true,mint:true,action:true,swapVerified:true,notificationStatus:true,observedAt:true},
  take:100000
});

const invalid=publicRows.filter(r=>
  r.chain!=="SOLANA" ||
  !r.swapVerified ||
  !["BUY","SELL"].includes(r.action) ||
  ownerByAddress.get(r.walletAddress)!==r.traderId
);

console.log(JSON.stringify({
  mode:apply?"APPLY":"DRY_RUN",
  activeAdminWallets:active.length,
  publicRows:publicRows.length,
  rowsToHide:invalid.length,
  pendingPushesToCancel:invalid.filter(r=>r.notificationStatus==="PENDING").length,
  sample:invalid.slice(0,20)
},null,2));

if(apply&&invalid.length){
  const ids=invalid.map(r=>r.id);
  // Preserve the rows for audit/performance forensics; only remove public authority from them.
  await db.walletActivity.updateMany({where:{id:{in:ids}},data:{public:false}});
  await db.walletActivity.updateMany({where:{id:{in:ids},notificationStatus:"PENDING"},data:{notificationStatus:"HISTORICAL"}});
  console.log(`Reconciled ${ids.length} historical non-canonical public WalletActivity rows.`);
}

await db.$disconnect();
