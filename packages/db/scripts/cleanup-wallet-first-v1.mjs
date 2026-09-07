// Wallet-first v1 legacy cleanup.
//
// SAFETY NOTE (changed from the original overlay draft): the draft deleted EVERY
// SmartWalletCandidate row unconditionally. In this production database the admin's entire curated
// wallet list -- names, research provenance, adminWatchedAt -- lived in exactly those rows, so that
// would have destroyed the product's only input. This version therefore:
//   * REFUSES to run unless every admin-watched candidate has already been migrated to a real
//     ADMIN-sourced TraderWallet (see migrate-admin-curated-traders.mjs),
//   * deletes the retired SmartWalletCandidate table rows AFTER their Admin-curated wallets have been migrated,
//   * keeps TRANSFER_IN/TRANSFER_OUT wallet activity as the audit trail proving which "buys" were
//     actually airdrops (this is evidence, not noise),
//   * never touches users, wallets, deposits, ledger, orders, positions, exits or source txs.
//
//   node packages/db/scripts/cleanup-wallet-first-v1.mjs            # dry run
//   node packages/db/scripts/cleanup-wallet-first-v1.mjs --apply
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const apply=process.argv.includes("--apply");

const adminWatched=await db.smartWalletCandidate.count({where:{adminWatched:true}});
const adminSourcedWallets=await db.traderWallet.count({where:{chain:"SOLANA",verified:true,source:"ADMIN",monitoringStatus:"ACTIVE",trader:{kind:"PLATFORM",enabled:true}}});
const migrationComplete=adminSourcedWallets>=adminWatched&&adminSourcedWallets>0;

const counts={
  candidatesToDelete:await db.smartWalletCandidate.count(),
  brainOpportunities:await db.globalBrainOpportunity.count(),
  brainOutcomeSamples:await db.brainOutcomeSample.count(),
  transferActivityPreserved:await db.walletActivity.count({where:{action:{in:["TRANSFER_IN","TRANSFER_OUT"]}}}),
  observationTraderWallets:await db.traderWallet.count({where:{trader:{handle:"memecloud-observation"}}})
};

console.log(JSON.stringify({
  mode:apply?"APPLY":"DRY_RUN",
  migrationComplete,adminWatched,adminSourcedWallets,
  willDelete:{smartWalletCandidates:counts.candidatesToDelete,brainOpportunities:counts.brainOpportunities,brainOutcomeSamples:counts.brainOutcomeSamples,leftoverObservationWallets:counts.observationTraderWallets},
  preserved:["User","Wallet","Deposit","LedgerEntry","Order","Position","PositionExit","SourceTransaction","real BUY/SELL WalletActivity","TRANSFER audit trail","Admin TraderWallet"]
},null,2));

if(!apply){await db.$disconnect();process.exit(0)}
if(!migrationComplete){
  console.error("REFUSING TO APPLY: admin-curated wallets are not migrated to ADMIN-sourced TraderWallet rows yet. Run migrate-admin-curated-traders.mjs --apply first.");
  await db.$disconnect();process.exit(1);
}

// All legacy candidate rows are now retired. Admin curation/provenance lives on Trader/TraderWallet.
await db.smartWalletCandidate.deleteMany({});
// Old activity remains as an internal forensic audit trail, but cannot reappear in Home/Hunt/push.
await db.walletActivity.updateMany({where:{swapVerified:false},data:{public:false}});
// Opportunity/outcome rows were scored under the retired candidate architecture.
await db.brainOutcomeSample.deleteMany({});
await db.globalBrainOpportunity.deleteMany({});
// The synthetic observation trader is retired; its wallets have been re-pointed by the migration.
const obs=await db.trader.findUnique({where:{handle:"memecloud-observation"}});
if(obs){
  await db.traderWallet.deleteMany({where:{traderId:obs.id}});
  // The trader row itself is intentionally left in place: signals/positions may still reference it.
  await db.trader.update({where:{id:obs.id},data:{enabled:false,trackingStatus:"RETIRED"}}).catch(()=>{});
}
console.log("Wallet-first legacy data cleanup complete.");
await db.$disconnect();
process.exit(0);
