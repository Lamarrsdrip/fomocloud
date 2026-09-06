import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {classifyTokenProvenance} from "@memecloud/discovery";

let scans=0,errors=0,lastRun:string|null=null,running=false,runningSince=0;
// Same class of bug found and fixed in brain-worker/solana-listener this session: an unbounded
// `if(running)return;running=true` lets one hung await wedge every future scan forever while the
// heartbeat below keeps reporting "healthy" regardless, on its own independent timer.
const SCAN_STALE_MS=30*60_000;

async function repairLegacyPlatformProvenance(){
  // The historical Admin form wrote ADMIN_MANUAL for every owner-added wallet. That is reliable
  // evidence that MemeCloud added it, but not evidence of where the research came from. Preserve
  // the wallet and its scores, promote monitoring priority, and keep the unknown source explicit.
  const rows=await db.smartWalletCandidate.findMany({where:{source:"ADMIN_MANUAL"},take:500});
  for(const row of rows){const m=(row.metadata??{}) as any;await db.smartWalletCandidate.update({where:{id:row.id},data:{source:"PLATFORM_ADDED",adminWatched:true,adminWatchedAt:row.adminWatchedAt??row.createdAt,metadata:{...m,curatedByPlatform:true,adminDesignation:m.adminDesignation??"PLATFORM_ADDED_LEGACY",monitoringPriority:m.monitoringPriority??"P1",researchSource:m.researchSource??null,researchReason:m.researchReason??null,researchAddedAt:m.researchAddedAt??row.createdAt.toISOString(),researchProvenanceStatus:m.researchSource?"RECORDED":"UNKNOWN_LEGACY_SOURCE",discoveryReason:m.discoveryReason??"Legacy MemeCloud platform-added wallet. Objective scoring still decides skill and copy eligibility."}}})}
}

async function backfillDeterministicTokenProvenance(){
  const rows=await db.discoveryToken.findMany({where:{chain:"SOLANA"},orderBy:{lastSeenAt:"desc"},take:500,select:{id:true,mint:true,metadata:true}});
  for(const row of rows){const m=(row.metadata??{}) as any;if(m.tokenProvenance)continue;const tokenProvenance=classifyTokenProvenance({mint:row.mint});await db.discoveryToken.update({where:{id:row.id},data:{metadata:{...m,tokenProvenance,provenanceObservedAt:new Date().toISOString(),migrationStatus:m.migrationStatus??"UNKNOWN"}}}).catch(()=>{})}
}

// ONLY ADMIN-ADDED WALLETS ARE SIGNAL SOURCES. This worker's entire wallet-discovery function --
// seeding candidates from an env-configured address list (ensureConfiguredSeedWallets), and paid
// Birdeye topTraders() lookups to find brand-new "profitable counterparty" wallets nobody asked
// about (bootstrapWalletsFromTrustedActivity) -- was permanently removed (2026-09-06 forensic
// audit). Neither path ever required an admin action; both kept burning real provider budget and
// populating the admin discovery panel with wallets no one added. What remains here is pure data
// hygiene on already-existing rows, not wallet discovery: repairing legacy provenance labels and
// backfilling token-launchpad classification metadata for tokens already seen elsewhere.
async function scan(){
  if(running&&Date.now()-runningSince<SCAN_STALE_MS)return;running=true;runningSince=Date.now();
  try{
    await repairLegacyPlatformProvenance();
    await backfillDeterministicTokenProvenance();
    scans++;lastRun=new Date().toISOString();
  }catch(e){errors++;console.error("[discovery]",e)}
  finally{running=false}
}

startHeartbeat("discovery-worker",()=>({scans,errors,lastRun,running,mode:"TOKEN_METADATA_HYGIENE_ONLY",walletDiscovery:"PERMANENTLY_DISABLED"}));
setInterval(()=>void scan(),Math.max(15*60_000,Number(process.env.DISCOVERY_SCAN_INTERVAL_MS??process.env.DISCOVERY_INTERVAL_MS??60*60_000)));
void scan();
console.log("[discovery-worker] running (token metadata hygiene only -- wallet discovery permanently disabled)");
