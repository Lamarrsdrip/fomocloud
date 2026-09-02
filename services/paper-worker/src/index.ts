import {Worker} from "bullmq";
import { Redis } from "ioredis";
import {Connection,PublicKey} from "@solana/web3.js";
import {db} from "@memecloud/db";
import {JupiterExecution} from "@memecloud/execution";
import {evaluateEntry,evaluateExit,priceDrawdownFromPeakPct,type MarketSnapshot} from "@memecloud/strategy";
import {startHeartbeat} from "@memecloud/ops";
import {getConfig} from "@memecloud/config";
import {cachedTokenDecimals,solanaRpcCandidates,pickHealthyRpc} from "@memecloud/shared";

const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
// Same startup-only-config bug fixed elsewhere this session. Reloaded on a slow independent
// timer rather than every 5s mark() tick, to avoid an AppConfig read on every cycle.
let connection:Connection,jupiter:JupiterExecution,snapshotAge:number;
async function reloadConfig(){
  const marketCfg=await getConfig<any>("marketData"),execCfg=await getConfig<any>("execution"),riskCfg=await getConfig<any>("risk");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[paper-worker]");
  connection=new Connection(rpc,"confirmed");
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  snapshotAge=Math.max(5_000,Number(riskCfg?.maxIntelligenceAgeMs??30_000));
}
await reloadConfig();
setInterval(()=>void reloadConfig().catch(e=>console.error("[paper-worker] config reload failed, keeping previous clients",e)),60_000);
const usdc=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const paperUsd=Math.max(10,Number(process.env.DISCOVERY_PAPER_TRADE_USD??100));
const decimals=new Map<string,number>();let entries=0,skips=0,marks=0,exits=0,errors=0,ticking=false,tickingSince=0;
// Same class of bug found and fixed in brain-worker/solana-listener/exits this session: an
// unbounded `if(ticking)return;ticking=true` lets one hung await wedge every future mark() call
// forever while the heartbeat keeps reporting "healthy" regardless.
const MARK_STALE_MS=5*60_000;
async function dec(mint:string){
  if(decimals.has(mint))return decimals.get(mint)!;
  const d=await cachedTokenDecimals(redis,mint,async()=>(await connection.getTokenSupply(new PublicKey(mint),"confirmed")).value.decimals);
  decimals.set(mint,d);return d;
}
async function sourcePrice(signal:any){
  if(signal.sourcePriceUsd&&signal.sourcePriceUsd>0)return Number(signal.sourcePriceUsd);
  if(signal.action!=="BUY")return null;
  const d=await dec(signal.outputMint),tokens=Number(BigInt(signal.outputRaw))/(10**d);if(tokens<=0)return null;
  let usd:number;
  if(signal.inputMint===usdc)usd=Number(BigInt(signal.inputRaw))/1e6;
  else{const q=await jupiter.quote({inputMint:signal.inputMint,outputMint:usdc,amountRaw:signal.inputRaw,slippageBps:100});usd=Number(BigInt(q.outAmount))/1e6}
  return usd>0?usd/tokens:null;
}
async function market(mint:string,entry:number,current:number,peak:number,sourceMove?:number):Promise<MarketSnapshot|null>{
  const x=await db.memeMarketSnapshot.findFirst({where:{chain:"SOLANA",mint},orderBy:{observedAt:"desc"}});if(!x||Date.now()-x.observedAt.getTime()>snapshotAge)return null;
  const profit=(current-entry)/entry*100,peakProfit=(peak-entry)/entry*100;
  return {ageMinutes:x.ageMinutes,liquidityUsd:x.liquidityUsd,marketCapUsd:x.marketCapUsd??undefined,priceFromSourcePct:sourceMove,priceFromEntryPct:profit,peakProfitPct:peakProfit,drawdownFromPeakPct:priceDrawdownFromPeakPct(peak,current),volume1mUsd:x.volume1mUsd,volume5mUsd:x.volume5mUsd,volume15mUsd:x.volume15mUsd,volumeAcceleration1m:x.volumeAcceleration1m,volumeAcceleration5m:x.volumeAcceleration5m,buys1m:x.buys1m,sells1m:x.sells1m,buys5m:x.buys5m,sells5m:x.sells5m,buyVolume5mUsd:x.buyVolume5mUsd,sellVolume5mUsd:x.sellVolume5mUsd,uniqueBuyers1m:x.uniqueBuyers1m,uniqueBuyers5m:x.uniqueBuyers5m,uniqueSellers5m:x.uniqueSellers5m,holderCount:x.holderCount??undefined,holderGrowth5mPct:x.holderGrowth5mPct??undefined,top10EffectivePct:x.top10EffectivePct??undefined,bundledSupplyPct:x.bundledSupplyPct??undefined,creatorHoldingPct:x.creatorHoldingPct??undefined,creatorNetSell5mPct:x.creatorNetSell5mPct??undefined,smartMoneyNetFlow5mUsd:x.smartMoneyNetFlow5mUsd??undefined,mintAuthorityActive:x.mintAuthorityActive??undefined,freezeAuthorityActive:x.freezeAuthorityActive??undefined,token2022DangerousExtension:x.dangerousExtension??undefined,sellRouteAvailable:true,executablePriceImpactPct:0,exitLiquidityForPositionUsd:x.exitLiquidityUsd??undefined,liquidityChange5mPct:x.liquidityChange5mPct??undefined,lpRiskScore:x.lpRiskScore??undefined,socialMentions5m:x.socialMentions5m??undefined,socialUniqueAuthors5m:x.socialUniqueAuthors5m??undefined,socialVelocity:x.socialVelocity??undefined,socialSentiment:x.socialSentiment??undefined,socialSpamRatio:x.socialSpamRatio??undefined,influencerQualityScore:x.influencerQualityScore??undefined,narrativeScore:x.narrativeScore??undefined};
}
const worker=new Worker("discovery-paper",async job=>{
  const signal=await db.signal.findUnique({where:{id:job.data.signalId},include:{trader:true}});if(!signal||signal.action!=="BUY"||signal.chain!=="SOLANA")return;
  if(await db.paperCopyTrade.findUnique({where:{signalId:signal.id}}))return;
  const sp=await sourcePrice(signal);if(!sp){skips++;await db.paperCopyTrade.create({data:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:"SOLANA",mint:signal.outputMint,sourcePriceUsd:0,amountUsd:paperUsd,status:"SKIPPED",entryAction:"WAIT_DATA",entryReason:"SOURCE_PRICE_UNAVAILABLE"}});return}
  const amountRaw=String(Math.round(paperUsd*1e6)),q=await jupiter.quote({inputMint:usdc,outputMint:signal.outputMint,amountRaw,slippageBps:700});
  const d=await dec(signal.outputMint),token=Number(BigInt(q.outAmount))/(10**d),ep=paperUsd/token,chase=(ep-sp)/sp*100;
  let reverse=false,reverseImpact=0;try{const r=await jupiter.quote({inputMint:signal.outputMint,outputMint:usdc,amountRaw:q.outAmount,slippageBps:700});reverse=BigInt(r.outAmount)>0n;reverseImpact=Math.abs(Number(r.priceImpactPct??0))}catch{}
  const m=await market(signal.outputMint,ep,ep,ep,chase);if(!m){skips++;await db.paperCopyTrade.create({data:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:"SOLANA",mint:signal.outputMint,sourcePriceUsd:sp,entryPriceUsd:ep,walletChasePct:chase,amountUsd:paperUsd,status:"SKIPPED",entryAction:"WAIT_DATA",entryReason:"RICH_MARKET_DATA_UNAVAILABLE"}});return}
  m.sellRouteAvailable=reverse;m.executablePriceImpactPct=Math.max(Math.abs(Number(q.priceImpactPct??0)),reverseImpact);
  const candidate=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:signal.sourceWallet}}});
  const decision=evaluateEntry(m,Number(candidate?.sourceQualityScore??70));
  if(!["BUY_NOW","BUY_SMALLER"].includes(decision.action)){skips++;await db.paperCopyTrade.create({data:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:"SOLANA",mint:signal.outputMint,sourcePriceUsd:sp,entryPriceUsd:ep,walletChasePct:chase,amountUsd:paperUsd,status:"SKIPPED",confidence:decision.confidence,entryAction:decision.action,entryReason:[...decision.reasons,...decision.warnings].join(" · ")}});return}
  const actualUsd=decision.action==="BUY_SMALLER"?paperUsd*decision.sizeMultiplier:paperUsd;
  let finalQ=q,finalEp=ep,finalChase=chase;
  if(actualUsd!==paperUsd){finalQ=await jupiter.quote({inputMint:usdc,outputMint:signal.outputMint,amountRaw:String(Math.round(actualUsd*1e6)),slippageBps:700});finalEp=actualUsd/(Number(BigInt(finalQ.outAmount))/(10**d));finalChase=(finalEp-sp)/sp*100}
  await db.paperCopyTrade.create({data:{signalId:signal.id,traderId:signal.traderId,sourceWallet:signal.sourceWallet,chain:"SOLANA",mint:signal.outputMint,sourcePriceUsd:sp,entryPriceUsd:finalEp,walletChasePct:finalChase,amountUsd:actualUsd,tokenRaw:finalQ.outAmount,remainingTokenRaw:finalQ.outAmount,tokenDecimals:d,status:"OPEN",confidence:decision.confidence,entryAction:decision.action,entryReason:decision.reasons.join(" · "),peakPriceUsd:finalEp,enteredAt:new Date(),lastMarkedAt:new Date()}});entries++;
},{connection:redis,concurrency:4});
worker.on("failed",(_j,e)=>{errors++;console.error("[paper-worker] entry",e)});

async function mark(){if(ticking&&Date.now()-tickingSince<MARK_STALE_MS)return;ticking=true;tickingSince=Date.now();try{
  const ps=await db.paperCopyTrade.findMany({where:{status:{in:["OPEN","PARTIAL"]}},take:500});
  for(const p of ps){try{
    if(!p.entryPriceUsd||!p.remainingTokenRaw||!p.tokenRaw||!p.tokenDecimals)continue;
    const mp=await db.marketPrice.findFirst({where:{chain:"SOLANA",mint:p.mint},orderBy:{observedAt:"desc"}});if(!mp||Date.now()-mp.observedAt.getTime()>60_000)continue;
    const current=mp.priceUsd,peak=Math.max(p.peakPriceUsd??p.entryPriceUsd,current),m=await market(p.mint,p.entryPriceUsd,current,peak);if(!m)continue;
    // Prove a real current sell route before any paper exit decision claims sellability.
    try{const rr=await jupiter.quote({inputMint:p.mint,outputMint:usdc,amountRaw:p.remainingTokenRaw,slippageBps:700});m.sellRouteAvailable=Boolean(rr.outAmount&&BigInt(rr.outAmount)>0n);m.executablePriceImpactPct=Math.abs(Number(rr.priceImpactPct??0))}catch{m.sellRouteAvailable=false;m.executablePriceImpactPct=100}
    const original=BigInt(p.tokenRaw),remaining=BigInt(p.remainingTokenRaw),instruction=evaluateExit(m,{tp1Taken:p.tp1Taken,tp2Taken:p.tp2Taken,tp3Taken:p.tp3Taken,principalRecoveredPct:p.profitTakenUsd/Math.max(.01,p.amountUsd)*100,peakProfitPct:(peak-p.entryPriceUsd)/p.entryPriceUsd*100,remainingPct:Number(remaining*10000n/original)/100});
    let next=remaining,realized=p.realizedPnlUsd,profitTaken=p.profitTakenUsd,status=p.status,tp1=p.tp1Taken,tp2=p.tp2Taken,tp3=p.tp3Taken,exitReason=p.exitReason;
    if(instruction.action!=="HOLD"){
      const sellPct=instruction.action==="EXIT"?100:Number(instruction.sellPct??0);let sell=(remaining*BigInt(Math.round(sellPct*100)))/10000n;if(sell<=0n)sell=1n;if(sell>remaining)sell=remaining;
      const portion=Number(sell*1_000_000n/original)/1_000_000,cost=p.amountUsd*portion,proceeds=cost*(current/p.entryPriceUsd),pnl=proceeds-cost;realized+=pnl;profitTaken+=Math.max(0,pnl);next=remaining-sell;status=next<=0n?"CLOSED":"PARTIAL";exitReason=instruction.reason;exits++;
      if(instruction.action==="PARTIAL_TP"){if(!tp1)tp1=true;else if(!tp2)tp2=true;else tp3=true}
    }
    const remainingCost=p.amountUsd*(Number(next*1_000_000n/original)/1_000_000),unrealized=next<=0n?0:remainingCost*(current/p.entryPriceUsd)-remainingCost;
    await db.paperCopyTrade.update({where:{id:p.id},data:{remainingTokenRaw:next.toString(),status,tp1Taken:tp1,tp2Taken:tp2,tp3Taken:tp3,profitTakenUsd:profitTaken,peakPriceUsd:peak,peakReturnPct:Math.max(p.peakReturnPct,(peak-p.entryPriceUsd)/p.entryPriceUsd*100),realizedPnlUsd:realized,unrealizedPnlUsd:unrealized,maxDrawdownPct:Math.max(p.maxDrawdownPct,Math.max(0,(peak-current)/peak*100)),exitReason,lastMarkedAt:new Date(),closedAt:next<=0n?new Date():undefined}});marks++;
  }catch(e){errors++;console.error("[paper-worker] mark",p.id,e)}}
}finally{ticking=false}}
setInterval(()=>void mark(),5000);void mark();
startHeartbeat("paper-worker",()=>({entries,skips,marks,exits,errors,ticking,mode:"REAL_QUOTES_PAPER_MONEY"}));
console.log("[paper-worker] real-data copyability replay active");
