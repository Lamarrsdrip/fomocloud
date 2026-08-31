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
      create:{handle,displayName:`Smart Wallet ${suffix}`,category:"On-chain discovery",verification:"UNVERIFIED",kind:"PLATFORM",enabled:false,featured:false,recommended:false,defaultSelected:false,trackingStatus:"PAPER_TRACKING",bio:"Automatically discovered from public on-chain trading history. Performance is paper-tracked before recommendation."}
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
    const paperMin=Math.max(65,Number(dc?.paperMinScore??process.env.DISCOVERY_PAPER_MIN_SCORE??68));
    const provenMin=Math.max(80,Number(dc?.provenMinScore??process.env.DISCOVERY_PROVEN_MIN_SCORE??80));
    const provenSamples=Math.max(20,Number(dc?.provenMinForwardSamples??process.env.DISCOVERY_PROVEN_MIN_FORWARD_SAMPLES??20));
    const provenMean=Math.max(5,Number(dc?.provenMinForwardMeanPct??process.env.DISCOVERY_PROVEN_MIN_FORWARD_MEAN_PCT??5));
    // Real bug found by audit: PROVEN was excluded from this filter, so once a wallet was proven
    // it was NEVER re-scored again -- its scores froze permanently at promotion-time values, any
    // subsequent performance/risk deterioration was invisible, and there was no automatic way to
    // pull a degraded trader out of real copy-trading. PROVEN now stays in the loop; the demotion
    // branch below is what actually acts on a real decline.
    const candidates=await db.smartWalletCandidate.findMany({where:{chain:"SOLANA",stage:{in:["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN","PAUSED"]}},orderBy:[{lastScoredAt:"asc"},{createdAt:"asc"}],take:50});
    for(const c of candidates){
      try{
        const raw=await b.walletPnlSummary(c.address,"30d","solana");
        const p=b.normalizeWalletPnl(raw);
        // Real gap found by forensic audit: only the 30d window above was ever fetched anywhere.
        // 7D is separate, additional evidence (a wallet cooling off this week but still showing a
        // strong 30d number, or vice versa, is real and different) -- deliberately NOT fed into
        // scoreWallet/shouldProve, which stay tied to the 30d window already proven correct. A
        // failure here must never break the real 30d-driven scoring pass below.
        const raw7d=await b.walletPnlSummary(c.address,"7d","solana").catch(()=>null);
        const p7d=raw7d?b.normalizeWalletPnl(raw7d):null;
        // Forward proof is usable only when the market mark genuinely landed inside the requested
        // one-hour horizon. A delayed worker's bounded historical observation remains inspectable
        // as LATE, but cannot promote a wallet to PROVEN as if it were timely evidence.
        const obs=await db.sourceSignalObservation.findMany({where:{sourceWallet:c.address,horizonSeconds:3600,status:"OK",returnPct:{not:null}},orderBy:{observedAt:"desc"},take:100});
        const paper=await db.paperCopyTrade.findMany({where:{sourceWallet:c.address,status:{in:["OPEN","PARTIAL","CLOSED"]}},orderBy:{createdAt:"desc"},take:100});
        const [userChases,recentFlow]=await Promise.all([
          db.copyDecision.findMany({where:{signal:{sourceWallet:c.address},walletChasePct:{not:null}},select:{walletChasePct:true},take:100,orderBy:{createdAt:"desc"}}),
          db.chainFlowObservation.findMany({where:{chain:c.chain,walletAddress:c.address,observedAt:{gte:new Date(Date.now()-30*24*60*60_000)}},select:{mint:true,observedAt:true,side:true,amountUsd:true,walletTier:true,walletBalanceUsd:true},orderBy:{observedAt:"desc"},take:500})
        ]);
        const paperChases=paper.filter(x=>x.walletChasePct!=null).map(x=>Number(x.walletChasePct));
        const chaseValues=[...paperChases,...userChases.map(x=>Number(x.walletChasePct??0))];
        const avgChase=chaseValues.length?chaseValues.reduce((a,x)=>a+x,0)/chaseValues.length:undefined;
        // Copyability uses OUR paper fills/exits when available, not only the source wallet's PnL.
        // Real bug found by audit: this used to include OPEN/PARTIAL trades and their
        // unrealizedPnlUsd, so a paper position sitting on a temporary +600% unrealized moonbag
        // counted as forward-proof evidence identically to a completed, realized outcome -- directly
        // feeding shouldProve()'s forwardMean threshold below. PROVEN eligibility must use mature,
        // objective evidence: only fully CLOSED paper trades (realized, final) count toward
        // forwardMean now. An open moonbag still shows up in paper.length/exposure tracking; it just
        // can't manufacture PROVEN status until it actually closes.
        const closedPaper=paper.filter(x=>x.status==="CLOSED");
        const paperReturns=closedPaper.map(x=>Number(x.realizedPnlUsd)/Math.max(.01,Number(x.amountUsd))*100);
        const forwardReturns=paperReturns.length>=20?paperReturns:obs.map(o=>Number(o.returnPct));
        const priorMeta=(c.metadata??{}) as any;
        // Real bug found by forensic audit: this used to collapse a genuinely missing risk reading
        // (provider fetch never succeeded, both sources null/undefined) to 0 BEFORE scoreWallet ever
        // saw it -- indistinguishable from a verified 0%-risk result. Pass real absence through as
        // `undefined` so scoreWallet's own UNKNOWN-evidence handling (evidenceCompleteness, a
        // conservative non-zero default penalty) actually applies instead of being short-circuited.
        const insiderRaw=priorMeta?.insiderRiskPct??c.insiderRiskPct;
        const rugRaw=priorMeta?.rugExposurePct??c.rugExposurePct;
        const insider=insiderRaw==null?undefined:Number(insiderRaw);
        // If no provider risk profile exists, mature forward outcomes still give us objective rug
        // exposure evidence: repeated -70% or worse outcomes are exactly the behavior a smart-wallet
        // system must punish. Require at least five mature samples before treating this as known.
        const derivedRugExposure=forwardReturns.length>=5?forwardReturns.filter(x=>x<=-70).length/forwardReturns.length*100:undefined;
        const rug=rugRaw==null?derivedRugExposure:Number(rugRaw);
        const distinctTokens30d=new Set(recentFlow.map(x=>x.mint)).size;
        const lastActivityAt=recentFlow[0]?.observedAt;
        const lastActivityHours=lastActivityAt?Math.max(0,(Date.now()-lastActivityAt.getTime())/3600_000):undefined;
        const whaleObs=recentFlow.find((x:any)=>String(x.walletTier??"").startsWith("WHALE_"));
        const whaleTier=whaleObs?.walletTier??priorMeta?.whaleTier;
        const walletBalanceUsd=whaleObs?.walletBalanceUsd??priorMeta?.walletBalanceUsd;
        const walletBalanceObservedAt=whaleObs?.walletBalanceUsd!=null
          ? whaleObs.observedAt.toISOString()
          : priorMeta?.walletBalanceObservedAt;
        const earlyEntryEdgePct=priorMeta?.earlyEntryEdgePct==null?undefined:Number(priorMeta.earlyEntryEdgePct);
        const s=scoreWallet({
          totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,tradeCount:Math.round(p.tradeCount),
          profitableTrades:Math.round(p.profitableTrades),winRatePct:p.winRate,recentSignalReturnsPct:forwardReturns,averageObservedChasePct:avgChase,insiderRiskPct:insider,rugExposurePct:rug,
          realizedPnl7dUsd:p7d?.realizedPnlUsd,winRate7dPct:p7d?.winRate,distinctTokens30d,lastActivityHours,earlyEntryEdgePct,providerEvidenceCompletenessPct:p.evidenceCompletenessPct
        });
        const forwardMean=s.forwardMeanPct;
        let stage=c.stage;
        let demoted=false,autoRejected=false;
        const wasPaperAtStart=stage==="PAPER_TRACKING";
        const autoPaused=stage==="PAUSED"&&Boolean((priorMeta as any)?.autoPausedAt);
        // Manual PAUSED remains a human override. Only an automatically-paused wallet may re-enter
        // the objective pipeline by itself after it becomes healthy again.
        if(autoPaused&&shouldPaperTrack(s,p.tradeCount)&&s.copyabilityScore>=paperMin&&s.riskScore<=45){stage="PAPER_TRACKING";demoted=false}
        if((stage==="DISCOVERED"||stage==="ANALYZING")&&shouldPaperTrack(s,p.tradeCount)&&s.copyabilityScore>=paperMin){stage="PAPER_TRACKING";promotedPaper++;await ensurePaperTrader(c)}
        else if(stage==="DISCOVERED"){stage="ANALYZING"}
        // Never jump DISCOVERED -> PAPER -> PROVEN in one scoring pass. Paper observation is a real
        // stage, not a label. A candidate must already have been paper-tracked before this tick.
        if(wasPaperAtStart&&shouldProve({...s,evidenceCompleteness:s.evidenceCompleteness},forwardReturns.length,forwardMean,s.evidenceCompleteness,closedPaper.length)&&s.copyabilityScore>=provenMin&&forwardReturns.length>=provenSamples&&forwardMean>=provenMean){stage="PROVEN";promotedProven++}
        // A PROVEN trader is live-copyable real money. A meaningful, not-noise-level decline (15pt
        // buffer below the bar that promoted them, or risk well past shouldProve's own 42 cap) must
        // pull them out of real trading automatically rather than sit frozen at promotion-time
        // trust forever -- mirrors the admin's own manual "Pause" action (same trader/traderWallet
        // side effects) so this reads identically whether a human or the scorer did it.
        if(stage==="PROVEN"&&(s.riskScore>65||s.evidenceCompleteness<55)){stage="PAUSED";demoted=true}
        else if(stage==="PROVEN"&&(s.copyabilityScore<provenMin-10||s.sourceQualityScore<68||s.currentFormScore<38||s.activityScore<30)){stage="PAPER_TRACKING";demoted=true}
        // REJECTED is a dead end (excluded from the query above) by design -- only apply it to a
        // candidate that's had at least one full scoring pass already (never on the very first
        // read) and clearly, not marginally, fails to qualify, so a wallet oscillating near the
        // paper-tracking bar isn't permanently locked out by one noisy sample.
        else if(stage==="ANALYZING"&&c.lastScoredAt&&p.tradeCount>=15&&s.copyabilityScore<paperMin-15){stage="REJECTED";autoRejected=true;rejected++}
        await db.smartWalletCandidate.update({where:{id:c.id},data:{stage,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,riskScore:s.riskScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),realizedPnlUsd:p.realizedPnlUsd,totalPnlUsd:p.totalPnlUsd,volumeUsd:p.volumeUsd,realizedPnl7dUsd:p7d?p7d.realizedPnlUsd:undefined,winRate7dPct:p7d?.winRate,sampleTrades7d:p7d?Math.round(p7d.tradeCount):undefined,averageChasePct:avgChase,lastScoredAt:new Date(),provenAt:stage==="PROVEN"?(c.provenAt??new Date()):undefined,rejectedReason:autoRejected?`AUTO_REJECTED: copyability ${Math.round(s.copyabilityScore)} below floor after ${Math.round(p.tradeCount)} trades`:c.rejectedReason,metadata:{...(priorMeta||{}),walletPnl:raw,forwardSignals:forwardReturns.length,closedPaperTrades:closedPaper.length,paperTrades:paper.length,forwardMeanPct:forwardMean,evidenceCompleteness:s.evidenceCompleteness,riskEvidenceCompleteness:s.riskEvidenceCompleteness,providerEvidenceCompletenessPct:p.evidenceCompletenessPct,derivedRugExposurePct:derivedRugExposure,skillScore:s.skillScore,currentFormScore:s.currentFormScore,activityScore:s.activityScore,forwardHitRatePct:s.forwardHitRatePct,unrealizedReliancePct:s.unrealizedReliancePct,distinctTokens30d,lastObservedTradeAt:lastActivityAt?.toISOString()??priorMeta?.lastObservedTradeAt,whaleTier,walletBalanceUsd,walletBalanceObservedAt,...(demoted?{autoPausedAt:stage==="PAUSED"?new Date().toISOString():priorMeta?.autoPausedAt??null,autoPausedReason:`copyability ${Math.round(s.copyabilityScore)} / risk ${Math.round(s.riskScore)} / evidence ${Math.round(s.evidenceCompleteness)} fell below live-trading floor`}:stage==="PAPER_TRACKING"&&autoPaused?{autoPausedAt:null,autoPausedReason:null}:{})}}});
        if(demoted){
          const traderId=c.traderId??(await db.smartWalletCandidate.findUnique({where:{id:c.id},select:{traderId:true}}))?.traderId;
          if(traderId){
            await db.trader.update({where:{id:traderId},data:{enabled:false,trackingStatus:stage==="PAUSED"?"PAUSED":"PAPER_TRACKING",recommended:false}}).catch(()=>{});
            await db.traderWallet.updateMany({where:{traderId},data:{monitoringStatus:stage==="PAUSED"?"PAUSED":"PAPER_TRACKING"}}).catch(()=>{});
          }
        }
        await db.walletScoreSnapshot.create({data:{chain:"SOLANA",address:c.address,candidateId:c.id,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,riskScore:s.riskScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,metadata:{forwardSignals:forwardReturns.length,paperTrades:paper.length,forwardMeanPct:forwardMean,skillScore:s.skillScore,currentFormScore:s.currentFormScore,activityScore:s.activityScore,forwardHitRatePct:s.forwardHitRatePct,distinctTokens30d}}});
        if(!demoted&&(c.traderId||stage==="PROVEN")){
          // Skipped when demoted -- the block above already set the correct PAUSED status; this
          // one only understands PROVEN vs PAPER_TRACKING and would otherwise silently overwrite
          // PAUSED back to PAPER_TRACKING, losing the distinction between "still building evidence"
          // and "was proven, then pulled from real trading for a real reason."
          const traderId=c.traderId??(await db.smartWalletCandidate.findUnique({where:{id:c.id},select:{traderId:true}}))?.traderId;
          if(traderId){
            await db.trader.update({where:{id:traderId},data:{enabled:stage==="PROVEN",trackingStatus:stage==="PROVEN"?"PROVEN":"PAPER_TRACKING",recommended:stage==="PROVEN"&&s.copyabilityScore>=85}});
            await db.traderWallet.updateMany({where:{traderId},data:{monitoringStatus:stage==="PROVEN"?"PROVEN":"PAPER_TRACKING"}}).catch(()=>{});
          }
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
