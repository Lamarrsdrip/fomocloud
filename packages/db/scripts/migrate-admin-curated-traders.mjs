// Wallet-first v1 migration: make Admin-curated wallets real platform traders.
//
// Why this exists: the rebuild makes `TraderWallet.source="ADMIN"` on an enabled PLATFORM trader
// the ONE authoritative definition of a monitored wallet. Production reached that rebuild with 21
// admin-curated wallets living in the OLD shape instead -- `SmartWalletCandidate.adminWatched=true`,
// mirrored onto a synthetic "memecloud-observation" trader. Switching the listener to the new
// predicate without this migration would silently drop the watchlist to ZERO wallets.
//
// This converts each admin-watched candidate into a real, named platform trader and re-points its
// wallet, carrying the admin's own label and research provenance across. It never deletes traders
// (they are referenced by signals/positions/orders) and never touches financial records.
//
//   node packages/db/scripts/migrate-admin-curated-traders.mjs            # dry run
//   node packages/db/scripts/migrate-admin-curated-traders.mjs --apply
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const apply=process.argv.includes("--apply");

function slug(text){return String(text??"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,32)}

async function uniqueHandle(base,address){
  const fallback=`w-${address.slice(0,8).toLowerCase()}`;
  let candidate=slug(base)||fallback;
  for(let i=0;i<50;i++){
    const taken=await db.trader.findUnique({where:{handle:candidate},select:{id:true}});
    if(!taken)return candidate;
    candidate=`${slug(base)||fallback}-${i+2}`;
  }
  return `${fallback}-${Date.now()}`;
}

const candidates=await db.smartWalletCandidate.findMany({where:{chain:"SOLANA",adminWatched:true},orderBy:{adminWatchedAt:"asc"}});
const plan=[];

for(const c of candidates){
  const meta=(c.metadata??{});
  const existingWallet=await db.traderWallet.findUnique({where:{chain_address:{chain:"SOLANA",address:c.address}},include:{trader:true}});
  const alreadyDone=existingWallet&&existingWallet.source==="ADMIN"&&existingWallet.trader.kind==="PLATFORM"&&existingWallet.trader.enabled;
  const followsToMove=existingWallet&&existingWallet.trader.kind==="CUSTOM"
    ? await db.userFollow.findMany({where:{traderId:existingWallet.traderId}})
    : [];
  plan.push({
    address:c.address,
    label:c.label??null,
    action:alreadyDone?"ALREADY_ADMIN":existingWallet?"REPOINT_WALLET":"CREATE_WALLET",
    currentTrader:existingWallet?{handle:existingWallet.trader.handle,kind:existingWallet.trader.kind,source:existingWallet.source}:null,
    followsToMigrate:followsToMove.length,
    researchSource:meta.researchSource??null,
    designation:meta.adminDesignation??null
  });

  if(!apply||alreadyDone)continue;

  const displayName=c.label||`Tracked wallet ${c.address.slice(0,4)}…${c.address.slice(-4)}`;
  const handle=existingWallet&&existingWallet.trader.kind==="PLATFORM"&&existingWallet.trader.handle!=="memecloud-observation"
    ? existingWallet.trader.handle
    : await uniqueHandle(c.label||`wallet-${c.address.slice(0,8)}`,c.address);

  const bioParts=[meta.discoveryReason,meta.researchReason].filter(Boolean);
  const trader=await db.trader.upsert({
    where:{handle},
    update:{displayName,enabled:true,kind:"PLATFORM",trackingStatus:"TRACKING"},
    create:{
      handle,displayName,kind:"PLATFORM",enabled:true,
      category:meta.adminDesignation==="MEMECLOUD_PICK"?"MemeCloud Pick":"Admin curated trader",
      bio:bioParts.length?bioParts.join(" — ").slice(0,500):"Admin-curated meme trader. Monitored for verified on-chain swaps.",
      verification:"UNVERIFIED",featured:false,recommended:false,defaultSelected:false,trackingStatus:"TRACKING"
    }
  });

  if(existingWallet){
    await db.traderWallet.update({where:{id:existingWallet.id},data:{traderId:trader.id,source:"ADMIN",verified:true,monitoringStatus:"ACTIVE",verificationMethod:existingWallet.verificationMethod??"ADMIN_CURATED_PUBLIC_ADDRESS",verifiedAt:existingWallet.verifiedAt??new Date(),evidenceNote:"Admin-curated public wallet. Monitored for verified swaps; identity is not asserted."}});
    // A user who had personally followed this address keeps their follow (and their copy settings)
    // by moving it onto the admin trader that now owns the wallet. Traders themselves are never
    // deleted here -- signals, orders and positions still reference them.
    for(const follow of followsToMove){
      const clash=await db.userFollow.findUnique({where:{userId_traderId:{userId:follow.userId,traderId:trader.id}}});
      if(clash){await db.userFollow.delete({where:{id:follow.id}}).catch(()=>{});continue}
      await db.userFollow.update({where:{id:follow.id},data:{traderId:trader.id}}).catch(()=>{});
    }
  }else{
    await db.traderWallet.create({data:{traderId:trader.id,chain:"SOLANA",address:c.address,verified:true,source:"ADMIN",monitoringStatus:"ACTIVE",verificationMethod:"ADMIN_CURATED_PUBLIC_ADDRESS",verifiedAt:new Date(),evidenceNote:"Admin-curated public wallet. Monitored for verified swaps; identity is not asserted."}});
  }
  await db.smartWalletCandidate.update({where:{id:c.id},data:{traderId:trader.id}}).catch(()=>{});
}

const adminWalletsAfter=await db.traderWallet.count({where:{chain:"SOLANA",verified:true,source:"ADMIN",trader:{kind:"PLATFORM",enabled:true}}});
console.log(JSON.stringify({mode:apply?"APPLY":"DRY_RUN",adminWatchedCandidates:candidates.length,plan,adminSourcedWalletsAfter:adminWalletsAfter},null,2));
await db.$disconnect();
process.exit(0);
