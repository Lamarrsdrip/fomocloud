import {db} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {Redis} from "ioredis";
import {classifyTokenProvenance} from "@memecloud/discovery";

let scans=0,candidatesSeen=0,errors=0,lastRun:string|null=null,running=false,runningSince=0,mode:"WALLET_FIRST"="WALLET_FIRST";
// Same class of bug found and fixed in brain-worker/solana-listener this session: an unbounded
// `if(running)return;running=true` lets one hung await wedge every future scan forever while the
// heartbeat below keeps reporting "healthy" regardless, on its own independent timer.
const SCAN_STALE_MS=30*60_000;
let seedWalletScans=0,seedWalletCandidates=0;
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});

async function getClient(){
  const cfg=await getConfig<any>("marketData");
  const key=cfg?.birdeyeApiKey??process.env.BIRDEYE_API_KEY;
  if(!key) return null;
  return new BirdeyeClient(key,cfg?.birdeyeBaseUrl,{redis,service:"discovery-worker",priority:"P4"});
}

function arr(x:any):any[]{return Array.isArray(x)?x:Array.isArray(x?.items)?x.items:Array.isArray(x?.tokens)?x.tokens:Array.isArray(x?.list)?x.list:[]}

async function ensureConfiguredSeedWallets(){
  const addresses=String(process.env.SMART_WALLET_SEED_ADDRESSES??"").split(",").map(x=>x.trim()).filter(Boolean);
  for(const address of addresses){
    await db.smartWalletCandidate.upsert({
      where:{chain_address:{chain:"SOLANA",address}},
      update:{source:"CONFIGURED_SEED"},
      create:{chain:"SOLANA",address,stage:"DISCOVERED",source:"CONFIGURED_SEED",metadata:{discoveryReason:"Configured public seed wallet. It receives no trust from being seeded; objective scoring and forward observation decide promotion."}}
    }).catch(()=>{});
  }
}

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

// Wallet discovery is intentionally graph-based now: start from wallets MemeCloud already has
// objective reason to watch, inspect only tokens those wallets touched, then discover neighboring
// profitable wallets from those tokens. There is no chain-wide mint crawl or unknown-wallet sweep.

// Wallet-first bootstrap: the provider is used to discover more profitable wallets ONLY from a
// very small set of tokens already surfaced by trusted wallets / whales. It never crawls the broad
// token list. This preserves the ability to discover a new elite wallet without paying to research
// every new mint on Solana.
async function bootstrapWalletsFromTrustedActivity(client:BirdeyeClient,cfg:any){
  const since=new Date(Date.now()-Math.max(1,Number(cfg?.walletSeedLookbackHours??24))*3600_000);
  const quality=await db.smartWalletCandidate.findMany({
    where:{OR:[{stage:{in:["PAPER_TRACKING","PROVEN"]}},{adminWatched:true}]},
    select:{address:true},take:500
  });
  const addresses=[...new Set(quality.map(x=>x.address))];
  if(!addresses.length)return;
  const flows=await db.chainFlowObservation.findMany({
    where:{side:"BUY",walletAddress:{in:addresses},observedAt:{gte:since}},
    select:{mint:true,amountUsd:true,observedAt:true},orderBy:{observedAt:"desc"},take:1000
  });
  const byMint=new Map<string,{usd:number,lastAt:Date}>();
  for(const f of flows){
    const g=byMint.get(f.mint)??{usd:0,lastAt:f.observedAt};
    g.usd+=Number(f.amountUsd??0); if(f.observedAt>g.lastAt)g.lastAt=f.observedAt; byMint.set(f.mint,g);
  }
  const seedLimit=Math.max(1,Math.min(12,Number(cfg?.walletSeedTokenLimit??2)));
  const traderLimit=Math.max(1,Math.min(10,Number(cfg?.walletSeedTopTradersPerToken??10)));
  const tokenRows=byMint.size?await db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:[...byMint.keys()]}},select:{mint:true,metadata:true}}):[];
  const tokenMeta=new Map(tokenRows.map((x:any)=>[x.mint,x.metadata??{}]));
  const seeds=[...byMint.entries()].filter(([mint,e])=>{
    const p=(tokenMeta.get(mint) as any)?.tokenProvenance??classifyTokenProvenance({mint});
    return p.origin==="VERIFIED_LAUNCHPAD"||e.usd>=10_000;
  }).sort((a,b)=>b[1].usd-a[1].usd).slice(0,seedLimit);
  for(const [mint] of seeds){
    // Counterparty discovery is P4 and a daily lookup per qualified token is enough. Claim the
    // key before the call so concurrent/restarted discovery workers cannot duplicate it.
    const dueKey=`discovery:counterparty:SOLANA:${mint}`;
    if(await redis.set(dueKey,new Date().toISOString(),"EX",24*60*60,"NX")!=="OK")continue;
    try{
      const top=arr(await client.topTraders(mint,"30d",traderLimit));
      for(const row of top){
        const w=client.normalizeTrader(row); if(!w.address)continue;
        seedWalletCandidates++; candidatesSeen++;
        const riskyTags=w.tags.filter(t=>["dev","developer","bundler","sniper","insider"].includes(t.toLowerCase()));
        if(riskyTags.length||Number(w.realizedPnlUsd??0)<=0||Number(w.tradeCount??0)<10)continue;
        const insiderRiskPct=w.tags.length? (riskyTags.length?80:0) : undefined;
        await db.smartWalletCandidate.upsert({
          where:{chain_address:{chain:"SOLANA",address:w.address}},
          update:{sourceToken:mint,totalPnlUsd:w.totalPnlUsd??undefined,realizedPnlUsd:w.realizedPnlUsd??undefined,volumeUsd:w.volumeUsd??undefined,sampleTrades:w.tradeCount?Math.round(w.tradeCount):undefined,insiderRiskPct},
          create:{chain:"SOLANA",address:w.address,stage:"DISCOVERED",source:"LAUNCHPAD_COUNTERPARTY",sourceToken:mint,totalPnlUsd:w.totalPnlUsd??0,realizedPnlUsd:w.realizedPnlUsd??0,volumeUsd:w.volumeUsd??0,sampleTrades:w.tradeCount?Math.round(w.tradeCount):0,insiderRiskPct,metadata:{providerTags:w.tags,riskyProviderTags:riskyTags,monitoringPriority:"P4",discoveryReason:`Found as a profitable counterparty on ${mint}, first surfaced by MemeCloud's qualified-wallet network. It must pass independent scoring and forward tracking.`}}
        }).catch(()=>{});
      }
      seedWalletScans++;
      await new Promise(r=>setTimeout(r,350));
    }catch(e){errors++;console.warn("[discovery] trusted-wallet bootstrap",mint,String((e as any)?.message??e))}
  }
}

async function scan(){
  if(running&&Date.now()-runningSince<SCAN_STALE_MS)return;running=true;runningSince=Date.now();
  try{
    const cfg=await getConfig<any>("discovery");
    mode="WALLET_FIRST";

    // Cold start can use a small owner-configured public-wallet seed list. Seed status gives no trust;
    // it only tells the profiler which addresses are worth evaluating without crawling all of Solana.
    await ensureConfiguredSeedWallets();
    await repairLegacyPlatformProvenance();
    await backfillDeterministicTokenProvenance();
    // BOUNDED GRAPH EXPANSION: expand only from tokens already touched by trusted/watched wallets.
    // This is the whole discovery path; there is no background token firehose underneath it.
    const client=await getClient();
    if(client){
      // Global trader-leaderboard polling is deliberately disabled. Discovery expands only from
      // qualified-wallet activity, so a quiet day creates almost no provider discovery traffic.
      await bootstrapWalletsFromTrustedActivity(client,cfg);
    }

    scans++;lastRun=new Date().toISOString();
  }catch(e){errors++;console.error("[discovery]",e)}
  finally{running=false}
}

startHeartbeat("discovery-worker",()=>({scans,candidatesSeen,errors,lastRun,running,mode,globalLeaderboardPolling:"DISABLED",seedWalletScans,seedWalletCandidates}));
setInterval(()=>void scan(),Math.max(15*60_000,Number(process.env.DISCOVERY_SCAN_INTERVAL_MS??process.env.DISCOVERY_INTERVAL_MS??60*60_000)));
void scan();
console.log("[discovery-worker] running");
