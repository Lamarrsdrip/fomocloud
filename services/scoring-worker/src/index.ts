import {db} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {scoreWallet,shouldPaperTrack,shouldProve} from "@memecloud/discovery";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";

let scored=0,promotedPaper=0,promotedProven=0,rejected=0,errors=0,running=false;

async function client(){
  const cfg=await getConfig<any>("marketData");
  const key=cfg?.birdeyeApiKey??process.env.BIRDEYE_API_KEY;
  return key?new BirdeyeClient(key,cfg?.birdeyeBaseUrl):null;
}

async function ensurePaperTrader(c:any){
  let traderId=c.traderId as string|undefined;
  if(!traderId){
    const suffix=c.address.slice(0,4)+"…"+c.address.slice(-4);
    const handle=`smart-${c.address.slice(0,12).toLowerCase()}`;
    const t=await db.trader.upsert({
      where:{handle},
      update:{trackingStatus:"PAPER_TRACKING"},
      create:{handle,displayName:`Smart Wallet ${suffix}`,category:"On-chain discovery",verification:"COMMUNITY_VERIFIED",kind:"PLATFORM",enabled:false,featured:false,recommended:false,defaultSelected:false,trackingStatus:"PAPER_TRACKING",bio:"Automatically discovered from public on-chain trading history. Performance is paper-tracked before recommendation."}
    });
    traderId=t.id;
    await db.traderWallet.upsert({
      where:{chain_address:{chain:"SOLANA",address:c.address}},
      update:{traderId:t.id,verified:true,source:"ONCHAIN_DISCOVERY",verificationMethod:"PUBLIC_CHAIN_HISTORY",monitoringStatus:"PAPER_TRACKING"},
      create:{traderId:t.id,chain:"SOLANA",address:c.address,verified:true,source:"ONCHAIN_DISCOVERY",verificationMethod:"PUBLIC_CHAIN_HISTORY",evidenceNote:"Machine-discovered public wallet. Identity is not claimed; wallet activity itself is the source.",verifiedAt:new Date(),monitoringStatus:"PAPER_TRACKING"}
    });
    await db.smartWalletCandidate.update({where:{id:c.id},data:{traderId:t.id,paperStartedAt:new Date()}});
  }
  return traderId;
}

async function tick(){
  if(running)return;running=true;
  try{
    const b=await client();if(!b){console.log("[scoring] Birdeye not configured; idle");return}
    const dc=await getConfig<any>("discovery");
    const paperMin=Math.max(50,Number(dc?.paperMinScore??process.env.DISCOVERY_PAPER_MIN_SCORE??68));
    const provenMin=Math.max(paperMin,Number(dc?.provenMinScore??process.env.DISCOVERY_PROVEN_MIN_SCORE??78));
    const provenSamples=Math.max(5,Number(dc?.provenMinForwardSamples??process.env.DISCOVERY_PROVEN_MIN_FORWARD_SAMPLES??20));
    const provenMean=Math.max(0,Number(dc?.provenMinForwardMeanPct??process.env.DISCOVERY_PROVEN_MIN_FORWARD_MEAN_PCT??5));
    const candidates=await db.smartWalletCandidate.findMany({where:{stage:{in:["DISCOVERED","ANALYZING","PAPER_TRACKING"]}},orderBy:[{lastScoredAt:"asc"},{createdAt:"asc"}],take:50});
    for(const c of candidates){
      try{
        const raw=await b.walletPnlSummary(c.address,"30d","solana");
        const p=b.normalizeWalletPnl(raw);
        const obs=await db.sourceSignalObservation.findMany({where:{sourceWallet:c.address,horizonSeconds:3600,returnPct:{not:null}},orderBy:{observedAt:"desc"},take:100});
        const paper=await db.paperCopyTrade.findMany({where:{sourceWallet:c.address,status:{in:["OPEN","PARTIAL","CLOSED"]}},orderBy:{createdAt:"desc"},take:100});
        const userChases=await db.copyDecision.findMany({where:{signal:{sourceWallet:c.address},walletChasePct:{not:null}},select:{walletChasePct:true},take:100,orderBy:{createdAt:"desc"}});
        const paperChases=paper.filter(x=>x.walletChasePct!=null).map(x=>Number(x.walletChasePct));
        const chaseValues=[...paperChases,...userChases.map(x=>Number(x.walletChasePct??0))];
        const avgChase=chaseValues.length?chaseValues.reduce((a,x)=>a+x,0)/chaseValues.length:undefined;
        // Copyability uses OUR paper fills/exits when available, not only the source wallet's PnL.
        const paperReturns=paper.map(x=>(Number(x.realizedPnlUsd)+Number(x.unrealizedPnlUsd))/Math.max(.01,Number(x.amountUsd))*100);
        const forwardReturns=paperReturns.length>=5?paperReturns:obs.map(o=>Number(o.returnPct));
        const priorMeta=(c.metadata??{}) as any;
        const insider=Number(priorMeta?.insiderRiskPct??c.insiderRiskPct??0);
        const rug=Number(priorMeta?.rugExposurePct??c.rugExposurePct??0);
        const s=scoreWallet({
          totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,tradeCount:Math.round(p.tradeCount),
          profitableTrades:Math.round(p.profitableTrades),winRatePct:p.winRate,recentSignalReturnsPct:forwardReturns,averageObservedChasePct:avgChase,insiderRiskPct:insider,rugExposurePct:rug
        });
        const forwardMean=forwardReturns.length?forwardReturns.reduce((a,x)=>a+x,0)/forwardReturns.length:0;
        let stage=c.stage;
        if(stage!=="PAPER_TRACKING"&&shouldPaperTrack(s,p.tradeCount)&&s.copyabilityScore>=paperMin){stage="PAPER_TRACKING";promotedPaper++;await ensurePaperTrader(c)}
        if(stage==="PAPER_TRACKING"&&shouldProve(s,forwardReturns.length,forwardMean)&&s.copyabilityScore>=provenMin&&forwardReturns.length>=provenSamples&&forwardMean>=provenMean){stage="PROVEN";promotedProven++}
        await db.smartWalletCandidate.update({where:{id:c.id},data:{stage,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,riskScore:s.riskScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),realizedPnlUsd:p.realizedPnlUsd,totalPnlUsd:p.totalPnlUsd,volumeUsd:p.volumeUsd,averageChasePct:avgChase,lastScoredAt:new Date(),provenAt:stage==="PROVEN"?(c.provenAt??new Date()):undefined,metadata:{...(priorMeta||{}),walletPnl:raw,forwardSignals:forwardReturns.length,paperTrades:paper.length,forwardMeanPct:forwardMean}}});
        await db.walletScoreSnapshot.create({data:{chain:"SOLANA",address:c.address,candidateId:c.id,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,riskScore:s.riskScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,metadata:{forwardSignals:forwardReturns.length,paperTrades:paper.length,forwardMeanPct:forwardMean}}});
        if(c.traderId||stage==="PROVEN"){
          const traderId=c.traderId??(await db.smartWalletCandidate.findUnique({where:{id:c.id},select:{traderId:true}}))?.traderId;
          if(traderId)await db.trader.update({where:{id:traderId},data:{enabled:stage==="PROVEN",trackingStatus:stage==="PROVEN"?"PROVEN":"PAPER_TRACKING",recommended:stage==="PROVEN"&&s.copyabilityScore>=85}});
        }
        scored++;
      }catch(e){errors++;console.error("[scoring]",c.address,e)}
    }
  }finally{running=false}
}
startHeartbeat("scoring-worker",()=>({scored,promotedPaper,promotedProven,rejected,errors,running}));
setInterval(()=>void tick(),Math.max(60_000,Number(process.env.SCORING_INTERVAL_MS??10*60_000)));
void tick();
console.log("[scoring-worker] running");
