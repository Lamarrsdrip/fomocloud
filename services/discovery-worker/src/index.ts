import {db} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";

let scans=0,tokensSeen=0,candidatesSeen=0,errors=0,lastRun:string|null=null,running=false;

async function getClient(){
  const cfg=await getConfig<any>("marketData");
  const key=cfg?.birdeyeApiKey??process.env.BIRDEYE_API_KEY;
  if(!key) return null;
  return new BirdeyeClient(key,cfg?.birdeyeBaseUrl);
}

function arr(x:any):any[]{return Array.isArray(x)?x:Array.isArray(x?.items)?x.items:Array.isArray(x?.tokens)?x.tokens:Array.isArray(x?.list)?x.list:[]}

async function scan(){
  if(running)return;running=true;
  try{
    const client=await getClient();
    if(!client){console.log("[discovery] Birdeye not configured; worker is idle, not fabricating candidates");return}
    const cfg=await getConfig<any>("discovery");
    const minLiq=Math.max(5000,Number(cfg?.minLiquidityUsd??20000));
    const maxMc=Math.max(100000,Number(cfg?.maxMarketCapUsd??25_000_000));
    const minMc=Math.max(10000,Number(cfg?.minMarketCapUsd??75_000));
    const tokenLimit=Math.max(10,Math.min(100,Number(cfg?.tokenScanLimit??40)));
    const traderLimit=Math.max(5,Math.min(50,Number(cfg?.topTradersPerToken??20)));
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
          tokenRisk={bundledSupplyPct:hm.bundledSupplyPct??0,creatorHoldingPct:hm.creatorHoldingPct??0,top10EffectivePct:hm.top10EffectivePct??0};
        }catch(e){console.warn("[discovery] holder profile unavailable",mint,String((e as any)?.message??e))}
        const top=arr(await client.topTraders(mint,"30d",traderLimit));
        for(const row of top){
          const w=client.normalizeTrader(row);if(!w.address)continue;
          candidatesSeen++;
          await db.smartWalletCandidate.upsert({
            where:{chain_address:{chain:"SOLANA",address:w.address}},
            update:{sourceToken:mint,totalPnlUsd:w.totalPnlUsd??undefined,realizedPnlUsd:w.realizedPnlUsd??undefined,volumeUsd:w.volumeUsd??undefined,sampleTrades:w.tradeCount?Math.round(w.tradeCount):undefined,metadata:{lastDiscoveryToken:mint,lastTopTrader:row,tokenRisk,insiderRiskPct:Math.min(100,Number(tokenRisk.creatorHoldingPct??0)*1.5),rugExposurePct:Math.min(100,Number(tokenRisk.bundledSupplyPct??0)+Math.max(0,Number(tokenRisk.top10EffectivePct??0)-70))}},
            create:{chain:"SOLANA",address:w.address,stage:"DISCOVERED",source:"BIRDEYE_TOP_TRADER",sourceToken:mint,totalPnlUsd:w.totalPnlUsd??0,realizedPnlUsd:w.realizedPnlUsd??0,volumeUsd:w.volumeUsd??0,sampleTrades:w.tradeCount?Math.round(w.tradeCount):0,metadata:{lastDiscoveryToken:mint,lastTopTrader:row,tokenRisk,insiderRiskPct:Math.min(100,Number(tokenRisk.creatorHoldingPct??0)*1.5),rugExposurePct:Math.min(100,Number(tokenRisk.bundledSupplyPct??0)+Math.max(0,Number(tokenRisk.top10EffectivePct??0)-70))}}
          });
        }
      }catch(e){errors++;console.error("[discovery] top traders",mint,e)}
    }
    scans++;lastRun=new Date().toISOString();
  }catch(e){errors++;console.error("[discovery]",e)}
  finally{running=false}
}

startHeartbeat("discovery-worker",()=>({scans,tokensSeen,candidatesSeen,errors,lastRun,running,mode:"REAL_DATA_ONLY"}));
setInterval(()=>void scan(),Math.max(60_000,Number(process.env.DISCOVERY_SCAN_INTERVAL_MS??process.env.DISCOVERY_INTERVAL_MS??15*60_000)));
void scan();
console.log("[discovery-worker] running");
