import {db,type Chain} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";

let scans=0,tokensSeen=0,candidatesSeen=0,errors=0,lastRun:string|null=null,running=false,mode:"BIRDEYE"|"CHAIN_FLOW"="CHAIN_FLOW";
let walletFirstScans=0,walletFirstCandidates=0;

async function getClient(){
  const cfg=await getConfig<any>("marketData");
  const key=cfg?.birdeyeApiKey??process.env.BIRDEYE_API_KEY;
  if(!key) return null;
  return new BirdeyeClient(key,cfg?.birdeyeBaseUrl);
}

function arr(x:any):any[]{return Array.isArray(x)?x:Array.isArray(x?.items)?x.items:Array.isArray(x?.tokens)?x.tokens:Array.isArray(x?.list)?x.list:[]}

// Real fallback when Birdeye isn't configured: derive tokens and known-wallet candidates directly
// from the chain-wide flow observations already being collected, instead of sitting idle. Only
// mints crossing a real minimum buyer/volume bar get surfaced — nothing here is fabricated.
async function scanFromChainFlow(){
  const cfg=await getConfig<any>("discovery");
  const windowMin=Math.max(5,Number(cfg?.chainFlowWindowMinutes??15));
  const since=new Date(Date.now()-windowMin*60_000);
  const minBuyers=Math.max(1,Number(cfg?.minChainFlowBuyers??2));
  const minBuyUsd=Math.max(10,Number(cfg?.minChainFlowBuyUsd??50));
  const rows=await db.chainFlowObservation.findMany({where:{side:"BUY",observedAt:{gte:since}},select:{chain:true,mint:true,walletAddress:true,knownWallet:true,amountUsd:true},take:5000});
  const byMint=new Map<string,{chain:Chain;mint:string;buyUsd:number;wallets:Map<string,boolean>}>();
  for(const r of rows){
    const key=`${r.chain}:${r.mint}`;
    let g=byMint.get(key);
    if(!g){g={chain:r.chain,mint:r.mint,buyUsd:0,wallets:new Map()};byMint.set(key,g)}
    g.buyUsd+=Number(r.amountUsd??0);
    if(!g.wallets.has(r.walletAddress))g.wallets.set(r.walletAddress,Boolean(r.knownWallet));
  }
  for(const g of byMint.values()){
    if(g.buyUsd<minBuyUsd||g.wallets.size<minBuyers)continue;
    tokensSeen++;
    await db.discoveryToken.upsert({
      where:{chain_mint:{chain:g.chain,mint:g.mint}},
      update:{lastSeenAt:new Date(),volume24hUsd:g.buyUsd},
      create:{chain:g.chain,mint:g.mint,source:"CHAIN_FLOW_DISCOVERY",volume24hUsd:g.buyUsd}
    }).catch(()=>{});
    for(const [address,known] of g.wallets){
      if(!known)continue;
      candidatesSeen++;
      await db.smartWalletCandidate.upsert({
        where:{chain_address:{chain:g.chain,address}},
        update:{sourceToken:g.mint},
        create:{chain:g.chain,address,stage:"DISCOVERED",source:"CHAIN_FLOW_KNOWN_WALLET",sourceToken:g.mint}
      }).catch(()=>{});
    }
  }
  scans++;lastRun=new Date().toISOString();
}

// Real gap found by forensic audit: every existing discovery channel was TOKEN-first (pick a token,
// then look at its traders) or, in scanFromChainFlow's case, only re-tagged wallets ALREADY known
// (`if(!known)continue` -- it never discovers a brand-new address). A genuinely skilled small wallet
// that has never been a top-10-by-PnL trader of any single token, but repeatedly buys early into
// DIFFERENT tokens that go on to qualify as real flow, was structurally invisible to this system.
// This is real WALLET-FIRST/CONVERGENCE-FIRST discovery: it profiles addresses by their own
// cross-token behavior, independent of any pre-selected token's trader list. It costs no extra
// provider calls -- it's a second pass over the same chainFlowObservation rows scanFromChainFlow
// already reads, just grouped by wallet instead of by mint, over a longer lookback window (repeated
// behavior needs history; a single 15-minute window can't show a pattern).
async function scanWalletFirst(){
  const cfg=await getConfig<any>("discovery");
  const windowHours=Math.max(6,Number(cfg?.walletFirstWindowHours??72));
  const since=new Date(Date.now()-windowHours*3600_000);
  const minBuyers=Math.max(1,Number(cfg?.minChainFlowBuyers??2));
  const minBuyUsd=Math.max(10,Number(cfg?.minChainFlowBuyUsd??50));
  const minDistinctTokens=Math.max(2,Number(cfg?.walletFirstMinDistinctTokens??3));
  const earlyWindowMin=Math.max(1,Number(cfg?.walletFirstEarlyEntryMinutes??10));
  const rows=await db.chainFlowObservation.findMany({where:{side:"BUY",observedAt:{gte:since}},select:{chain:true,mint:true,walletAddress:true,knownWallet:true,amountUsd:true,observedAt:true},take:20000});

  // Which mints actually qualified as real flow (same evidence bar scanFromChainFlow uses), and each
  // one's earliest observed buy -- "early entry" means concretely "within N minutes of this token's
  // own first qualifying flow," not an arbitrary global clock.
  const byMint=new Map<string,{buyUsd:number;wallets:Set<string>;firstAt:Date}>();
  for(const r of rows){
    const key=`${r.chain}:${r.mint}`;
    let g=byMint.get(key);
    if(!g){g={buyUsd:0,wallets:new Set(),firstAt:r.observedAt};byMint.set(key,g)}
    g.buyUsd+=Number(r.amountUsd??0);
    g.wallets.add(r.walletAddress);
    if(r.observedAt<g.firstAt)g.firstAt=r.observedAt;
  }
  const qualified=new Set([...byMint.entries()].filter(([,g])=>g.buyUsd>=minBuyUsd&&g.wallets.size>=minBuyers).map(([k])=>k));

  // For each address NOT already flagged known, count distinct qualified tokens it entered early.
  // Repeated early entry across genuinely different, independently-qualifying tokens is real,
  // on-chain, unfabricated evidence of skill -- it does not require the wallet to be wealthy, nor to
  // have ever appeared on any single token's top-traders list.
  const byWallet=new Map<string,{chain:Chain;address:string;earlyHits:Set<string>}>();
  for(const r of rows){
    if(r.knownWallet)continue;
    const mintKey=`${r.chain}:${r.mint}`;
    if(!qualified.has(mintKey))continue;
    const g=byMint.get(mintKey)!;
    if((r.observedAt.getTime()-g.firstAt.getTime())/60_000>earlyWindowMin)continue;
    const wKey=`${r.chain}:${r.walletAddress}`;
    let w=byWallet.get(wKey);
    if(!w){w={chain:r.chain,address:r.walletAddress,earlyHits:new Set()};byWallet.set(wKey,w)}
    w.earlyHits.add(mintKey);
  }
  for(const w of byWallet.values()){
    if(w.earlyHits.size<minDistinctTokens)continue;
    walletFirstCandidates++;
    await db.smartWalletCandidate.upsert({
      where:{chain_address:{chain:w.chain,address:w.address}},
      update:{metadata:{walletFirstEarlyHitTokens:w.earlyHits.size,walletFirstLastScoredWindowHours:windowHours}},
      create:{chain:w.chain,address:w.address,stage:"DISCOVERED",source:"CHAIN_FLOW_WALLET_FIRST",metadata:{walletFirstEarlyHitTokens:w.earlyHits.size,discoveryReason:`Repeated early entry into ${w.earlyHits.size} distinct tokens that each independently qualified as real flow, within ${earlyWindowMin} minutes of each token's own first qualifying buy -- discovered from its own behavior, not a pre-selected token's trader list.`}}
    }).catch(()=>{});
  }
  walletFirstScans++;
}

async function scan(){
  if(running)return;running=true;
  try{
    const client=await getClient();
    if(!client){mode="CHAIN_FLOW";console.log("[discovery] Birdeye not configured; discovering from real chain flow instead of sitting idle");await scanFromChainFlow();await scanWalletFirst().catch(e=>console.error("[discovery] wallet-first scan",e));return}
    mode="BIRDEYE";
    const cfg=await getConfig<any>("discovery");
    const minLiq=Math.max(5000,Number(cfg?.minLiquidityUsd??20000));
    const maxMc=Math.max(100000,Number(cfg?.maxMarketCapUsd??25_000_000));
    const minMc=Math.max(10000,Number(cfg?.minMarketCapUsd??75_000));
    const tokenLimit=Math.max(10,Math.min(100,Number(cfg?.tokenScanLimit??40)));
    // Birdeye's top_traders endpoint hard-caps at 10 -- this used to default to 20 and clamp up to
    // 50, so every call failed with HTTP 400 (see BirdeyeClient.topTraders). The client now
    // defends against this too, but the config-facing range should never advertise a value that
    // can't actually work.
    const traderLimit=Math.max(1,Math.min(10,Number(cfg?.topTradersPerToken??10)));
    const [trending,list]=await Promise.allSettled([
      client.trending("solana",Math.min(50,tokenLimit)),
      client.tokenListSolana({minLiquidity:minLiq,maxMarketCap:maxMc,minMarketCap:minMc,limit:tokenLimit})
    ]);
    const rows=[
      ...(trending.status==="fulfilled"?arr(trending.value):[]),
      ...(list.status==="fulfilled"?arr(list.value):[])
    ];
    const unique=new Map<string,any>();
    for(const raw of rows){
      const t=client.normalizeToken(raw);if(!t.mint)continue;
      if((t.liquidityUsd??0)<minLiq)continue;
      if(t.marketCapUsd&&t.marketCapUsd>maxMc)continue;
      unique.set(t.mint,{raw,t});
    }
    tokensSeen+=unique.size;
    for(const [mint,{raw,t}] of [...unique].slice(0,tokenLimit)){
      await db.discoveryToken.upsert({
        where:{chain_mint:{chain:"SOLANA",mint}},update:{symbol:t.symbol,name:t.name,marketCapUsd:t.marketCapUsd,liquidityUsd:t.liquidityUsd,volume24hUsd:t.volume24hUsd,priceChange1h:t.priceChange1h,priceChange24h:t.priceChange24h,lastSeenAt:new Date(),metadata:raw},
        create:{chain:"SOLANA",mint,symbol:t.symbol,name:t.name,source:"BIRDEYE_DISCOVERY",marketCapUsd:t.marketCapUsd,liquidityUsd:t.liquidityUsd,volume24hUsd:t.volume24hUsd,priceChange1h:t.priceChange1h,priceChange24h:t.priceChange24h,metadata:raw}
      });
      try{
        // Token-level holder provenance is used as a conservative risk prior for wallets
        // discovered from this token. It does not label the wallet an insider without wallet-level evidence.
        let tokenRisk:any={};
        try{
          const hp=await client.holderProfile(mint);
          const hm=client.normalizeMarket({}, {}, hp, {});
          tokenRisk={...(hm.bundledSupplyPct!=null?{bundledSupplyPct:hm.bundledSupplyPct}:{}),...(hm.creatorHoldingPct!=null?{creatorHoldingPct:hm.creatorHoldingPct}:{}),...(hm.top10EffectivePct!=null?{top10EffectivePct:hm.top10EffectivePct}:{})};
        }catch(e){console.warn("[discovery] holder profile unavailable",mint,String((e as any)?.message??e))}
        const top=arr(await client.topTraders(mint,"30d",traderLimit));
        for(const row of top){
          const w=client.normalizeTrader(row);if(!w.address)continue;
          candidatesSeen++;
          // Real, direct per-wallet signal Birdeye already returns and was previously discarded: a
          // wallet Birdeye itself tags as the token's deployer or a bundler/sniper is fundamentally
          // different from an organically profitable trader, whatever its PnL curve looks like.
          // Floored at 85 (not 100) since this is Birdeye's own classification, not on-chain proof
          // MemeCloud verified directly -- still a hard, dominant signal, just not asserted as
          // absolute certainty.
          const taggedRisk=w.tags.some(t=>["dev","bundler","sniper"].includes(t.toLowerCase()))?85:null;
          const creatorRisk=tokenRisk.creatorHoldingPct!=null?Math.min(100,Number(tokenRisk.creatorHoldingPct)*1.5):null;
          const insiderRiskPct=taggedRisk!=null||creatorRisk!=null?Math.max(taggedRisk??0,creatorRisk??0):undefined;
          const rugExposurePct=tokenRisk.bundledSupplyPct!=null||tokenRisk.top10EffectivePct!=null?Math.min(100,Number(tokenRisk.bundledSupplyPct??0)+Math.max(0,Number(tokenRisk.top10EffectivePct??0)-70)):undefined;
          await db.smartWalletCandidate.upsert({
            where:{chain_address:{chain:"SOLANA",address:w.address}},
            update:{sourceToken:mint,totalPnlUsd:w.totalPnlUsd??undefined,realizedPnlUsd:w.realizedPnlUsd??undefined,volumeUsd:w.volumeUsd??undefined,sampleTrades:w.tradeCount?Math.round(w.tradeCount):undefined,metadata:{lastDiscoveryToken:mint,lastTopTrader:row,tokenRisk,walletTags:w.tags,insiderRiskPct,rugExposurePct}},
            create:{chain:"SOLANA",address:w.address,stage:"DISCOVERED",source:"BIRDEYE_TOP_TRADER",sourceToken:mint,totalPnlUsd:w.totalPnlUsd??0,realizedPnlUsd:w.realizedPnlUsd??0,volumeUsd:w.volumeUsd??0,sampleTrades:w.tradeCount?Math.round(w.tradeCount):0,metadata:{lastDiscoveryToken:mint,lastTopTrader:row,tokenRisk,walletTags:w.tags,insiderRiskPct,rugExposurePct}}
          });
        }
      }catch(e){errors++;console.error("[discovery] top traders",mint,e)}
      // Two Birdeye calls per token with zero pacing (up to tokenLimit*2 in a tight burst) is
      // enough on its own to trip the shared API key's rate limit, independent of any other
      // service's load. A small fixed delay keeps this scan's own burst well-behaved.
      await new Promise(r=>setTimeout(r,300));
    }
    scans++;lastRun=new Date().toISOString();
    // Wallet-first discovery runs every cycle regardless of Birdeye availability -- it's a second
    // pass over already-collected chainFlowObservation rows, not an extra provider call, so there's
    // no reason to gate real chain-behavior evidence behind Birdeye being configured.
    await scanWalletFirst().catch(e=>console.error("[discovery] wallet-first scan",e));
  }catch(e){errors++;console.error("[discovery]",e)}
  finally{running=false}
}

startHeartbeat("discovery-worker",()=>({scans,tokensSeen,candidatesSeen,errors,lastRun,running,mode,walletFirstScans,walletFirstCandidates}));
setInterval(()=>void scan(),Math.max(60_000,Number(process.env.DISCOVERY_SCAN_INTERVAL_MS??process.env.DISCOVERY_INTERVAL_MS??15*60_000)));
void scan();
console.log("[discovery-worker] running");
