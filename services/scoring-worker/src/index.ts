import {db} from "@memecloud/db";
import {BirdeyeClient} from "@memecloud/providers";
import {classifyWalletRole,isProviderQuotaExhausted,providerEvidenceDue,scoreWallet,shouldPaperTrack,shouldProve} from "@memecloud/discovery";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {Redis} from "ioredis";

let scored=0,promotedPaper=0,promotedProven=0,rejected=0,errors=0,running=false,runningSince=0;
// Same class of bug found and fixed in brain-worker/solana-listener this session: an unbounded
// `if(running)return;running=true` lets one hung await wedge every future cycle forever while
// the heartbeat keeps reporting "healthy" regardless, on its own independent timer.
const TICK_STALE_MS=15*60_000;
let providerRequests=0,providerQuotaStops=0,providerStatus="UNKNOWN",lastCycleAt:string|null=null,lastSuccessfulCycleAt:string|null=null;
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const CIRCUIT_KEY="provider:circuit:BIRDEYE:wallet-scoring";

async function client(){const cfg=await getConfig<any>("marketData");const key=cfg?.birdeyeApiKey??process.env.BIRDEYE_API_KEY;return key?new BirdeyeClient(key,cfg?.birdeyeBaseUrl,{redis,service:"scoring-worker",priority:"P3"}):null}

async function ensurePaperTrader(c:any){
  let traderId=c.traderId as string|undefined;
  if(!traderId){
    const suffix=c.address.slice(0,4)+"…"+c.address.slice(-4),handle=`smart-${c.address.slice(0,12).toLowerCase()}`;
    const t=await db.trader.upsert({where:{handle},update:{trackingStatus:"PAPER_TRACKING"},create:{handle,displayName:`Smart Wallet ${suffix}`,category:"On-chain discovery",verification:"UNVERIFIED",kind:"PLATFORM",enabled:false,featured:false,recommended:false,defaultSelected:false,trackingStatus:"PAPER_TRACKING",bio:"Public on-chain wallet. Objectively scored and paper-tracked before recommendation."}});
    traderId=t.id;
    await db.traderWallet.upsert({where:{chain_address:{chain:"SOLANA",address:c.address}},update:{traderId:t.id,verified:true,source:"ONCHAIN_DISCOVERY",verificationMethod:"PUBLIC_CHAIN_HISTORY",monitoringStatus:"PAPER_TRACKING"},create:{traderId:t.id,chain:"SOLANA",address:c.address,verified:true,source:"ONCHAIN_DISCOVERY",verificationMethod:"PUBLIC_CHAIN_HISTORY",evidenceNote:"Public wallet activity is the evidence; identity is not claimed.",verifiedAt:new Date(),monitoringStatus:"PAPER_TRACKING"}});
    await db.smartWalletCandidate.update({where:{id:c.id},data:{traderId:t.id,paperStartedAt:new Date()}});
  }
  return traderId;
}

function median(xs:number[]){if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function storedPnl(c:any,meta:any){const raw=meta?.walletPnlNormalized30d;if(raw&&typeof raw==="object")return raw;const trades=Number(c.sampleTrades??0),wins=Number(c.profitableTrades??0);return {totalPnlUsd:Number(c.totalPnlUsd??0),realizedPnlUsd:Number(c.realizedPnlUsd??0),unrealizedPnlUsd:Math.max(0,Number(c.totalPnlUsd??0)-Number(c.realizedPnlUsd??0)),volumeUsd:Number(c.volumeUsd??0),tradeCount:trades,profitableTrades:wins,winRate:trades?wins/trades*100:undefined,evidenceCompletenessPct:Number(meta?.providerEvidenceCompletenessPct??0)}}

async function tick(){
 if(running&&Date.now()-runningSince<TICK_STALE_MS)return;running=true;runningSince=Date.now();lastCycleAt=new Date().toISOString();
 try{
  const [b,dc,circuit]=await Promise.all([client(),getConfig<any>("discovery"),redis.get(CIRCUIT_KEY)]);
  const paperMin=Math.max(65,Number(dc?.paperMinScore??process.env.DISCOVERY_PAPER_MIN_SCORE??68)),provenMin=Math.max(80,Number(dc?.provenMinScore??process.env.DISCOVERY_PROVEN_MIN_SCORE??80)),provenSamples=Math.max(20,Number(dc?.provenMinForwardSamples??process.env.DISCOVERY_PROVEN_MIN_FORWARD_SAMPLES??20)),provenMean=Math.max(5,Number(dc?.provenMinForwardMeanPct??process.env.DISCOVERY_PROVEN_MIN_FORWARD_MEAN_PCT??5));
  const maxProviderRequests=Math.max(0,Math.min(12,Number(dc?.walletScoringProviderRequestsPerCycle??process.env.SCORING_PROVIDER_REQUESTS_PER_CYCLE??4)));
  let requestsThisCycle=0,circuitOpen=Boolean(circuit)||!b;providerStatus=!b?"NOT_CONFIGURED":circuit?"QUOTA_CIRCUIT_OPEN":"AVAILABLE";
  const candidates=await db.smartWalletCandidate.findMany({where:{chain:"SOLANA",stage:{in:["DISCOVERED","ANALYZING","PAPER_TRACKING","PROVEN","PAUSED"]}},orderBy:[{lastScoredAt:"asc"},{createdAt:"asc"}],take:100});
  candidates.sort((a:any,b:any)=>{const p=(x:any)=>["MEMECLOUD_CURATED","PLATFORM_ADDED","ADMIN_MANUAL"].includes(x.source)?4:x.stage==="PROVEN"?3:x.stage==="PAPER_TRACKING"?2:1;return p(b)-p(a)||Number(a.lastScoredAt??0)-Number(b.lastScoredAt??0)});
  for(const c of candidates){try{
   const priorMeta=(c.metadata??{}) as any,due=providerEvidenceDue({source:c.source,stage:c.stage,lastProviderAt:priorMeta.providerEvidenceObservedAt});
   let p=storedPnl(c,priorMeta),p7d:any=null,p90d:any=priorMeta.walletPnl90d??null,providerEvidenceObservedAt=priorMeta.providerEvidenceObservedAt as string|undefined,candidateProviderStatus=circuitOpen?providerStatus:"CACHED";
   if(!circuitOpen&&due.due&&requestsThisCycle<maxProviderRequests&&b){try{
    const raw=await b.walletPnlSummary(c.address,"30d","solana");requestsThisCycle++;providerRequests++;p=b.normalizeWalletPnl(raw);providerEvidenceObservedAt=new Date().toISOString();candidateProviderStatus="FRESH";
    if(due.priority==="P1"&&requestsThisCycle<maxProviderRequests&&(!priorMeta.walletPnl7dObservedAt||Date.now()-new Date(priorMeta.walletPnl7dObservedAt).getTime()>24*3600_000)){const raw7d=await b.walletPnlSummary(c.address,"7d","solana");requestsThisCycle++;providerRequests++;p7d=b.normalizeWalletPnl(raw7d)}
    if(due.priority==="P1"&&requestsThisCycle<maxProviderRequests&&(!priorMeta.walletPnl90d?.observedAt||Date.now()-new Date(priorMeta.walletPnl90d.observedAt).getTime()>7*24*3600_000)){const raw90d=await b.walletPnlSummary(c.address,"90d","solana");requestsThisCycle++;providerRequests++;const z=b.normalizeWalletPnl(raw90d);p90d={...z,observedAt:new Date().toISOString(),provider:"BIRDEYE_WALLET_PNL_SUMMARY"}}
   }catch(e){if(isProviderQuotaExhausted(e)){await redis.set(CIRCUIT_KEY,"1","EX",3600);circuitOpen=true;providerQuotaStops++;providerStatus="QUOTA_CIRCUIT_OPEN";candidateProviderStatus=providerStatus;console.warn("[scoring] Birdeye quota circuit opened; continuing from stored and on-chain evidence")}else{candidateProviderStatus="UNAVAILABLE";console.warn("[scoring] provider unavailable",c.address,String((e as any)?.message??e))}}}
   const providerAge=providerEvidenceObservedAt?Date.now()-new Date(providerEvidenceObservedAt).getTime():Infinity,providerFresh=providerAge<=48*3600_000;
   const [obs,paper,userChases,recentFlow]=await Promise.all([
    db.sourceSignalObservation.findMany({where:{sourceWallet:c.address,horizonSeconds:3600,status:"OK",returnPct:{not:null}},orderBy:{observedAt:"desc"},take:100}),
    db.paperCopyTrade.findMany({where:{sourceWallet:c.address,status:{in:["OPEN","PARTIAL","CLOSED"]}},orderBy:{createdAt:"desc"},take:100}),
    db.copyDecision.findMany({where:{signal:{sourceWallet:c.address},walletChasePct:{not:null}},select:{walletChasePct:true},take:100,orderBy:{createdAt:"desc"}}),
    db.chainFlowObservation.findMany({where:{chain:c.chain,walletAddress:c.address,observedAt:{gte:new Date(Date.now()-30*24*3600_000)}},select:{mint:true,observedAt:true,side:true,amountUsd:true},orderBy:{observedAt:"desc"},take:500})]);
   const closedPaper=paper.filter(x=>x.status==="CLOSED"),paperReturns=closedPaper.map(x=>Number(x.realizedPnlUsd)/Math.max(.01,Number(x.amountUsd))*100),forwardReturns=paperReturns.length>=20?paperReturns:obs.map(o=>Number(o.returnPct));
   const chaseValues=[...paper.filter(x=>x.walletChasePct!=null).map(x=>Number(x.walletChasePct)),...userChases.map(x=>Number(x.walletChasePct??0))],avgChase=chaseValues.length?chaseValues.reduce((a,x)=>a+x,0)/chaseValues.length:undefined;
   const buyAmounts=recentFlow.filter(x=>x.side==="BUY"&&Number(x.amountUsd??0)>0).map(x=>Number(x.amountUsd)),distinctTokens30d=new Set(recentFlow.map(x=>x.mint)).size,lastActivityAt=recentFlow[0]?.observedAt,lastActivityHours=lastActivityAt?Math.max(0,(Date.now()-lastActivityAt.getTime())/3600_000):undefined;
   const catastrophicLossRate=forwardReturns.length>=5?forwardReturns.filter(x=>x<=-70).length/forwardReturns.length*100:undefined,insiderRaw=priorMeta.insiderRiskPct??c.insiderRiskPct,rugRaw=priorMeta.verifiedRugExposurePct;
   const s=scoreWallet({totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,tradeCount:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),winRatePct:p.winRate,recentSignalReturnsPct:forwardReturns,averageObservedChasePct:avgChase,insiderRiskPct:insiderRaw==null?undefined:Number(insiderRaw),rugExposurePct:rugRaw==null?undefined:Number(rugRaw),catastrophicLossRatePct:catastrophicLossRate,realizedPnl7dUsd:p7d?.realizedPnlUsd??c.realizedPnl7dUsd,winRate7dPct:p7d?.winRate??c.winRate7dPct,distinctTokens30d,lastActivityHours,earlyEntryEdgePct:priorMeta.earlyEntryProvenance?.sampleSize>=10?Number(priorMeta.earlyEntryEdgePct):undefined,providerEvidenceCompletenessPct:providerFresh?p.evidenceCompletenessPct:0});
   const winRate=p.winRate??(p.tradeCount?p.profitableTrades/p.tradeCount*100:0),classification=classifyWalletRole({source:c.source,skillScore:s.skillScore,copyabilityScore:s.copyabilityScore,realizedPnlUsd:p.realizedPnlUsd,winRatePct:winRate,sampleTrades:p.tradeCount,distinctTokens30d,lastActivityHours,typicalMemePositionUsd:median(buyAmounts),largestMemePositionUsd:Math.max(0,...buyAmounts),memeBuyVolume30dUsd:buyAmounts.reduce((a,x)=>a+x,0),freshCapitalLowerBoundUsd:priorMeta.walletBalanceObservedAt&&Date.now()-new Date(priorMeta.walletBalanceObservedAt).getTime()<7*24*3600_000?Number(priorMeta.walletBalanceUsd??0):0});
   let stage=c.stage,demoted=false,autoRejected=false;const wasPaperAtStart=stage==="PAPER_TRACKING",autoPaused=stage==="PAUSED"&&Boolean(priorMeta.autoPausedAt);
   if(providerFresh&&autoPaused&&shouldPaperTrack(s,p.tradeCount)&&s.copyabilityScore>=paperMin&&s.riskScore<=45)stage="PAPER_TRACKING";
   if(providerFresh&&(stage==="DISCOVERED"||stage==="ANALYZING")&&shouldPaperTrack(s,p.tradeCount)&&s.copyabilityScore>=paperMin){stage="PAPER_TRACKING";promotedPaper++;await ensurePaperTrader(c)}else if(stage==="DISCOVERED")stage="ANALYZING";
   if(providerFresh&&wasPaperAtStart&&shouldProve(s,forwardReturns.length,s.forwardMeanPct,s.evidenceCompleteness,closedPaper.length)&&s.copyabilityScore>=provenMin&&forwardReturns.length>=provenSamples&&s.forwardMeanPct>=provenMean){stage="PROVEN";promotedProven++}
   if(providerFresh&&stage==="PROVEN"&&(s.riskScore>65||s.evidenceCompleteness<55)){stage="PAUSED";demoted=true}else if(providerFresh&&stage==="PROVEN"&&(s.copyabilityScore<provenMin-10||s.sourceQualityScore<68||s.currentFormScore<38||s.activityScore<30)){stage="PAPER_TRACKING";demoted=true}else if(providerFresh&&stage==="ANALYZING"&&c.lastScoredAt&&p.tradeCount>=20&&s.copyabilityScore<paperMin-15&&!c.adminWatched&&!["MEMECLOUD_CURATED","PLATFORM_ADDED","ADMIN_MANUAL"].includes(c.source)){stage="REJECTED";autoRejected=true;rejected++}
   const whaleTier=classification.isMemeWhale?(classification.evidence.largestMemePositionUsd>=1_000_000?"WHALE_MEME_1M":classification.evidence.largestMemePositionUsd>=250_000?"WHALE_MEME_250K":classification.evidence.largestMemePositionUsd>=100_000?"WHALE_MEME_100K":"WHALE_MEME_50K"):null;
   const meta:any={...priorMeta,walletPnlNormalized30d:p,walletPnl90d:p90d,providerEvidenceObservedAt,providerStatus:candidateProviderStatus,providerEvidenceFresh:providerFresh,localScoredAt:new Date().toISOString(),walletPnl7dObservedAt:p7d?new Date().toISOString():priorMeta.walletPnl7dObservedAt,forwardSignals:forwardReturns.length,closedPaperTrades:closedPaper.length,paperTrades:paper.length,forwardMeanPct:s.forwardMeanPct,evidenceCompleteness:s.evidenceCompleteness,riskEvidenceCompleteness:s.riskEvidenceCompleteness,providerEvidenceCompletenessPct:p.evidenceCompletenessPct,catastrophicLossRatePct:catastrophicLossRate,skillScore:s.skillScore,currentFormScore:s.currentFormScore,activityScore:s.activityScore,forwardHitRatePct:s.forwardHitRatePct,unrealizedReliancePct:s.unrealizedReliancePct,distinctTokens30d,lastObservedTradeAt:lastActivityAt?.toISOString()??priorMeta.lastObservedTradeAt,walletType:classification.role,isMemeWhale:classification.isMemeWhale,isSmartDegen:classification.isSmartDegen,capitalScore:classification.capitalScore,whaleTier,typicalMemePositionUsd:classification.evidence.typicalMemePositionUsd,largestMemePositionUsd:classification.evidence.largestMemePositionUsd,memeBuyVolume30dUsd:classification.evidence.memeBuyVolume30dUsd,capitalEvidence:classification.evidence};
   await db.smartWalletCandidate.update({where:{id:c.id},data:{stage,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,riskScore:s.riskScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),realizedPnlUsd:p.realizedPnlUsd,totalPnlUsd:p.totalPnlUsd,volumeUsd:p.volumeUsd,realizedPnl7dUsd:p7d?.realizedPnlUsd??c.realizedPnl7dUsd,winRate7dPct:p7d?.winRate??c.winRate7dPct,sampleTrades7d:p7d?Math.round(p7d.tradeCount):c.sampleTrades7d,averageChasePct:avgChase,lastScoredAt:new Date(),provenAt:stage==="PROVEN"?(c.provenAt??new Date()):undefined,rejectedReason:autoRejected?`AUTO_REJECTED: copyability ${Math.round(s.copyabilityScore)} below floor after ${Math.round(p.tradeCount)} trades`:c.rejectedReason,metadata:meta}});
   await db.walletScoreSnapshot.create({data:{chain:"SOLANA",address:c.address,candidateId:c.id,sourceQualityScore:s.sourceQualityScore,copyabilityScore:s.copyabilityScore,consistencyScore:s.consistencyScore,entryQualityScore:s.entryQualityScore,riskScore:s.riskScore,sampleTrades:Math.round(p.tradeCount),profitableTrades:Math.round(p.profitableTrades),totalPnlUsd:p.totalPnlUsd,realizedPnlUsd:p.realizedPnlUsd,volumeUsd:p.volumeUsd,metadata:{providerStatus:candidateProviderStatus,providerEvidenceObservedAt:providerEvidenceObservedAt??null,walletType:classification.role,capitalScore:classification.capitalScore,skillScore:s.skillScore,forwardSignals:forwardReturns.length}}});
   if((demoted||c.traderId)&&c.traderId){await db.trader.update({where:{id:c.traderId},data:{enabled:stage==="PROVEN",trackingStatus:stage==="PAUSED"?"PAUSED":stage==="PROVEN"?"PROVEN":"PAPER_TRACKING",recommended:stage==="PROVEN"&&s.copyabilityScore>=85}}).catch(()=>{});await db.traderWallet.updateMany({where:{traderId:c.traderId},data:{monitoringStatus:stage==="PAUSED"?"PAUSED":stage==="PROVEN"?"PROVEN":"PAPER_TRACKING"}}).catch(()=>{})}
   scored++;
  }catch(e){errors++;console.error("[scoring] local cycle",c.address,e)}}
  lastSuccessfulCycleAt=new Date().toISOString();
 }finally{running=false}
}

startHeartbeat("scoring-worker",()=>({scored,promotedPaper,promotedProven,rejected,errors,running,providerRequests,providerQuotaStops,providerStatus,lastCycleAt,lastSuccessfulCycleAt,mode:"LOCAL_CONTINUOUS_PROVIDER_BOUNDED"}));
setInterval(()=>void tick(),Math.max(60_000,Number(process.env.SCORING_INTERVAL_MS??10*60_000)));
void tick();
console.log("[scoring-worker] running — local scoring continuous, provider enrichment bounded");
