import {db} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {Redis} from "ioredis";

let scans=0,candidatesSeen=0,errors=0,lastRun:string|null=null,running=false,mode:"WALLET_FIRST"="WALLET_FIRST";
let seedWalletScans=0,seedWalletCandidates=0,leaderboardScans=0,leaderboardCandidates=0;
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

// Wallet discovery is intentionally graph-based now: start from wallets MemeCloud already has
// objective reason to watch, inspect only tokens those wallets touched, then discover neighboring
// profitable wallets from those tokens. There is no chain-wide mint crawl or unknown-wallet sweep.

// Primary wallet-first discovery: use the provider's global trader PnL leaderboard directly.
// This costs a bounded number of provider calls and does not require MemeCloud to scan random mints.
async function discoverLeaderboardWallets(client:BirdeyeClient,cfg:any){
  const limit=Math.max(10,Math.min(100,Number(cfg?.leaderboardWalletLimit??50)));
  const windows:["30d"|"1W", "realized_pnl"|"PnL"][]=[["30d","realized_pnl"],["1W","realized_pnl"]];
  for(const [window,sortBy] of windows){
    try{
      const rows=arr(await client.traderGainersLosers(window,sortBy,limit,"solana"));
      for(const row of rows){
        const w=client.normalizeTrader(row); if(!w.address)continue;
        leaderboardCandidates++;candidatesSeen++;
        const riskyTags=w.tags.filter(t=>["dev","developer","bundler","sniper","insider"].includes(t.toLowerCase()));
        const insiderRiskPct=w.tags.length?(riskyTags.length?80:0):undefined;
        await db.smartWalletCandidate.upsert({
          where:{chain_address:{chain:"SOLANA",address:w.address}},
          update:{totalPnlUsd:w.totalPnlUsd??undefined,realizedPnlUsd:w.realizedPnlUsd??undefined,volumeUsd:w.volumeUsd??undefined,sampleTrades:w.tradeCount?Math.round(w.tradeCount):undefined,insiderRiskPct},
          create:{chain:"SOLANA",address:w.address,stage:"DISCOVERED",source:"TRADER_LEADERBOARD",totalPnlUsd:w.totalPnlUsd??0,realizedPnlUsd:w.realizedPnlUsd??0,volumeUsd:w.volumeUsd??0,sampleTrades:w.tradeCount?Math.round(w.tradeCount):0,insiderRiskPct,metadata:{leaderboardWindow:window,providerTags:w.tags,riskyProviderTags:riskyTags,discoveryReason:`Found on the provider's ${window} realized-PnL trader leaderboard. Leaderboard rank grants no trust; MemeCloud independently profiles, observes and paper-proves the wallet.`}}
        }).catch(()=>{});
      }
      leaderboardScans++;
      await new Promise(r=>setTimeout(r,250));
    }catch(e){errors++;console.warn("[discovery] trader leaderboard",window,String((e as any)?.message??e))}
  }
}

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
  const seedLimit=Math.max(1,Math.min(12,Number(cfg?.walletSeedTokenLimit??6)));
  const traderLimit=Math.max(1,Math.min(10,Number(cfg?.walletSeedTopTradersPerToken??10)));
  const seeds=[...byMint.entries()].sort((a,b)=>b[1].usd-a[1].usd).slice(0,seedLimit);
  for(const [mint] of seeds){
    try{
      const top=arr(await client.topTraders(mint,"30d",traderLimit));
      for(const row of top){
        const w=client.normalizeTrader(row); if(!w.address)continue;
        seedWalletCandidates++; candidatesSeen++;
        const riskyTags=w.tags.filter(t=>["dev","developer","bundler","sniper","insider"].includes(t.toLowerCase()));
        const insiderRiskPct=w.tags.length? (riskyTags.length?80:0) : undefined;
        await db.smartWalletCandidate.upsert({
          where:{chain_address:{chain:"SOLANA",address:w.address}},
          update:{sourceToken:mint,totalPnlUsd:w.totalPnlUsd??undefined,realizedPnlUsd:w.realizedPnlUsd??undefined,volumeUsd:w.volumeUsd??undefined,sampleTrades:w.tradeCount?Math.round(w.tradeCount):undefined,insiderRiskPct},
          create:{chain:"SOLANA",address:w.address,stage:"DISCOVERED",source:"TRUSTED_WALLET_NEIGHBORHOOD",sourceToken:mint,totalPnlUsd:w.totalPnlUsd??0,realizedPnlUsd:w.realizedPnlUsd??0,volumeUsd:w.volumeUsd??0,sampleTrades:w.tradeCount?Math.round(w.tradeCount):0,insiderRiskPct,metadata:{providerTags:w.tags,riskyProviderTags:riskyTags,discoveryReason:`Found among the top profitable traders of ${mint}, which was first surfaced by MemeCloud's trusted-wallet network. This wallet must still pass independent scoring before it becomes Proven.`}}
        }).catch(()=>{});
      }
      seedWalletScans++;
      await new Promise(r=>setTimeout(r,350));
    }catch(e){errors++;console.warn("[discovery] trusted-wallet bootstrap",mint,String((e as any)?.message??e))}
  }
}

async function scan(){
  if(running)return;running=true;
  try{
    const cfg=await getConfig<any>("discovery");
    mode="WALLET_FIRST";

    // Cold start can use a small owner-configured public-wallet seed list. Seed status gives no trust;
    // it only tells the profiler which addresses are worth evaluating without crawling all of Solana.
    await ensureConfiguredSeedWallets();
    // BOUNDED GRAPH EXPANSION: expand only from tokens already touched by trusted/watched wallets.
    // This is the whole discovery path; there is no background token firehose underneath it.
    const client=await getClient();
    if(client){
      await discoverLeaderboardWallets(client,cfg);
      await bootstrapWalletsFromTrustedActivity(client,cfg);
    }

    scans++;lastRun=new Date().toISOString();
  }catch(e){errors++;console.error("[discovery]",e)}
  finally{running=false}
}

startHeartbeat("discovery-worker",()=>({scans,candidatesSeen,errors,lastRun,running,mode,leaderboardScans,leaderboardCandidates,seedWalletScans,seedWalletCandidates}));
setInterval(()=>void scan(),Math.max(60_000,Number(process.env.DISCOVERY_SCAN_INTERVAL_MS??process.env.DISCOVERY_INTERVAL_MS??15*60_000)));
void scan();
console.log("[discovery-worker] running");
