import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "@memecloud/db";
import { calculateExitAccounting, cachedTokenDecimals, solanaRpcCandidates, pickHealthyRpc, chainSupports, usdToMicros } from "@memecloud/shared";
import { startHeartbeat } from "@memecloud/ops";
import { evaluateExit, type MarketSnapshot } from "@memecloud/strategy";
import { JupiterExecution } from "@memecloud/execution";
import { PrivySolanaSigner } from "@memecloud/providers";
import { getConfig } from "@memecloud/config";

const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const notificationQueue=new Queue("user-notifications",{connection:redis});

// This worker signs and submits real SELL transactions for already-open real positions — it must
// never keep operating on stale Jupiter/RPC/Privy/risk config after Admin changes it. Previously
// read once at process startup and cached forever, the same bug already fixed elsewhere this
// session. Reloaded on a slow timer, independent of the 3s position tick, so config staleness
// can't exceed ~60s without adding an AppConfig read to every tick.
let execCfg:any,riskCfg:any,jupiter:JupiterExecution,rpc:string|undefined,chain:Connection|null,signer:PrivySolanaSigner|null,maxSnapshotAge:number;
async function reloadConfig(){
  execCfg=await getConfig<any>("execution");
  const marketCfg=await getConfig<any>("marketData");
  const signerCfg=await getConfig<any>("signer");
  riskCfg=await getConfig<any>("risk");
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[exits]");
  chain=rpc?new Connection(rpc,"confirmed"):null;
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID;
  const privyAppSecret=signerCfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const privyAuthorizationPrivateKey=signerCfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  signer=privyAppId&&privyAppSecret?new PrivySolanaSigner({appId:privyAppId,appSecret:privyAppSecret,authorizationPrivateKey:privyAuthorizationPrivateKey,sponsorGas:Boolean(signerCfg?.sponsorGas)}):null;
  maxSnapshotAge=Math.max(5_000,Number(riskCfg?.maxIntelligenceAgeMs??30_000));
}
await reloadConfig();
setInterval(()=>void reloadConfig().catch(e=>console.error("[exits] config reload failed, keeping previous clients",e)),60_000);
const usdc=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let scanned=0,marked=0,stale=0,errors=0,profitEvents=0,liveSubmitted=0,liveConfirmed=0,ticking=false;

async function userEvent(userId:string,type:string,title:string,body:string,data:Record<string,unknown>={}){
  const event=await db.userActivityEvent.create({data:{userId,type,title,body,data:data as any}});
  await notificationQueue.add("notify",{userId,type,title,body,data,deliveryKey:event.id},{jobId:event.id,removeOnComplete:1000,attempts:3,backoff:{type:"exponential",delay:1000}});
}
function frac(raw:bigint,base:bigint){if(base<=0n)return 0;return Number((raw*1_000_000n)/base)/1_000_000}
function pctRaw(raw:bigint,pct:number){
  if(raw<=0n||pct<=0)return 0n;
  let out=(raw*BigInt(Math.round(Math.min(100,pct)*10_000)))/1_000_000n;
  if(out<=0n)out=1n;if(out>raw)out=raw;return out;
}
function exitKey(positionId:string,remaining:string,action:string,sellPct:number){return crypto.createHash("sha256").update(`EXIT:${positionId}:${remaining}:${action}:${sellPct.toFixed(4)}`).digest("hex")}

async function tokenDecimals(mint:string){
  if(!chain)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  // Shared across every service via Redis -- a mint's decimals never change, so this eliminates
  // redundant getTokenSupply RPC calls that exits/executor/market-worker/paper-worker were each
  // making independently for the same mints.
  return cachedTokenDecimals(redis,mint,async()=>(await chain!.getTokenSupply(new PublicKey(mint),"confirmed")).value.decimals);
}

async function reconcile(signature:string,owner:string,inputMint:string,outputMint:string){
  if(!chain)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  const tx=await chain.getParsedTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx||tx.meta?.err)throw Object.assign(new Error("CONFIRMED_TX_UNAVAILABLE"),{code:"CONFIRMED_TX_UNAVAILABLE"});
  const keys=tx.transaction.message.accountKeys.map((k:any)=>typeof k.pubkey?.toBase58==="function"?k.pubkey.toBase58():String(k.pubkey??k));
  const ownerIndex=new Set(keys.map((k,i)=>k===owner?i:-1).filter(i=>i>=0));
  const delta=(mint:string)=>{
    let d=0n;
    for(const b of tx.meta?.preTokenBalances??[])if(b.mint===mint&&(b.owner===owner||ownerIndex.has(b.accountIndex)))d-=BigInt(b.uiTokenAmount.amount);
    for(const b of tx.meta?.postTokenBalances??[])if(b.mint===mint&&(b.owner===owner||ownerIndex.has(b.accountIndex)))d+=BigInt(b.uiTokenAmount.amount);
    return d;
  };
  const input=delta(inputMint),output=delta(outputMint);
  if(input>=0n||output<=0n)throw Object.assign(new Error("CONFIRMED_SWAP_DELTAS_INVALID"),{code:"CONFIRMED_SWAP_DELTAS_INVALID",input:input.toString(),output:output.toString()});
  return {actualInputRaw:(-input).toString(),actualOutputRaw:output.toString()};
}

async function richMarket(p:any,current:number):Promise<MarketSnapshot|null>{
  const rich=await db.memeMarketSnapshot.findFirst({where:{chain:p.chain,mint:p.mint},orderBy:{observedAt:"desc"}});
  if(!rich||Date.now()-rich.observedAt.getTime()>maxSnapshotAge)return null;
  const entry=Number(p.avgEntryPriceUsd);
  const peak=Math.max(Number(p.peakPriceUsd??entry),current);
  const profit=((current-entry)/entry)*100;
  const peakProfit=((peak-entry)/entry)*100;
  const recentSourceSell=await db.signal.findFirst({where:{traderId:p.sourceTraderId,chain:p.chain,action:"SELL",inputMint:p.mint,observedAt:{gt:new Date(Date.now()-15*60_000)}},orderBy:{observedAt:"desc"},select:{sourceSoldPct:true}});
  const sourceSold=recentSourceSell?.sourceSoldPct==null?undefined:Number(recentSourceSell.sourceSoldPct);
  return {
    ageMinutes:rich.ageMinutes,liquidityUsd:rich.liquidityUsd,marketCapUsd:rich.marketCapUsd??undefined,
    priceFromEntryPct:profit,peakProfitPct:peakProfit,drawdownFromPeakPct:Math.max(0,peakProfit-profit),
    volume1mUsd:rich.volume1mUsd,volume5mUsd:rich.volume5mUsd,volume15mUsd:rich.volume15mUsd,
    volumeAcceleration1m:rich.volumeAcceleration1m,volumeAcceleration5m:rich.volumeAcceleration5m,
    buys1m:rich.buys1m,sells1m:rich.sells1m,buys5m:rich.buys5m,sells5m:rich.sells5m,
    buyVolume5mUsd:rich.buyVolume5mUsd,sellVolume5mUsd:rich.sellVolume5mUsd,
    uniqueBuyers1m:rich.uniqueBuyers1m,uniqueBuyers5m:rich.uniqueBuyers5m,uniqueSellers5m:rich.uniqueSellers5m,
    holderCount:rich.holderCount??undefined,holderGrowth5mPct:rich.holderGrowth5mPct??undefined,
    top10EffectivePct:rich.top10EffectivePct??undefined,bundledSupplyPct:rich.bundledSupplyPct??undefined,
    creatorHoldingPct:rich.creatorHoldingPct??undefined,creatorNetSell5mPct:rich.creatorNetSell5mPct??undefined,
    smartMoneyNetFlow5mUsd:rich.smartMoneyNetFlow5mUsd??undefined,mintAuthorityActive:rich.mintAuthorityActive??undefined,
    freezeAuthorityActive:rich.freezeAuthorityActive??undefined,token2022DangerousExtension:rich.dangerousExtension??undefined,
    sellRouteAvailable:true,executablePriceImpactPct:0,exitLiquidityForPositionUsd:rich.exitLiquidityUsd??undefined,
    liquidityChange5mPct:rich.liquidityChange5mPct??undefined,lpRiskScore:rich.lpRiskScore??undefined,
    socialMentions5m:rich.socialMentions5m??undefined,socialUniqueAuthors5m:rich.socialUniqueAuthors5m??undefined,
    socialVelocity:rich.socialVelocity??undefined,socialSentiment:rich.socialSentiment??undefined,socialSpamRatio:rich.socialSpamRatio??undefined,
    influencerQualityScore:rich.influencerQualityScore??undefined,narrativeScore:rich.narrativeScore??undefined,
    sourceTraderStillHolding:sourceSold==null?undefined:sourceSold<90,sourceTraderSoldPct:sourceSold
  };
}

async function positionState(p:any){
  const exits=await db.positionExit.findMany({where:{positionId:p.id},select:{reason:true,proceedsUsd:true}});
  const has=(x:string)=>exits.some(e=>e.reason.includes(x));
  const original=BigInt(p.entryTokenRaw),remaining=BigInt(p.remainingTokenRaw);
  const recovered=Math.max(0,exits.reduce((a,e)=>a+Number(e.proceedsUsd??0),0))/Math.max(0.01,p.costUsd)*100;
  const entry=Number(p.avgEntryPriceUsd),peak=Number(p.peakPriceUsd??entry);
  return {tp1Taken:has("TP1"),tp2Taken:has("TP2"),tp3Taken:has("TP3"),principalRecoveredPct:recovered,peakProfitPct:((peak-entry)/entry)*100,remainingPct:frac(remaining,original)*100};
}

async function applySimulationExit(p:any,current:number,instruction:any){
  if(instruction.action==="HOLD")return BigInt(p.remainingTokenRaw);
  const remaining=BigInt(p.remainingTokenRaw),original=BigInt(p.entryTokenRaw);
  if(remaining<=0n)return remaining;
  const sellPct=instruction.action==="EXIT"?100:Number(instruction.sellPct??0);
  const rawToExit=pctRaw(remaining,sellPct);
  if(rawToExit<=0n)return remaining;
  const entry=Number(p.avgEntryPriceUsd);
  const accounting=calculateExitAccounting({entryTokenRaw:p.entryTokenRaw,remainingTokenRaw:p.remainingTokenRaw,tokenRaw:rawToExit.toString(),costUsd:p.costUsd,avgEntryPriceUsd:entry,executionPriceUsd:current});
  const proceeds=accounting.netProceedsUsd,pnl=accounting.realizedPnlUsd,next=BigInt(accounting.remainingTokenRaw);
  const reason=`${instruction.action}_${instruction.reason.replace(/[^A-Za-z0-9]+/g,"_").slice(0,70)}_SIMULATION`;
  await db.$transaction([
    db.positionExit.create({data:{positionId:p.id,reason,tokenRaw:rawToExit.toString(),proceedsUsd:proceeds,pnlUsd:pnl}}),
    db.position.update({where:{id:p.id},data:{remainingTokenRaw:next.toString(),realizedPnlUsd:{increment:pnl},profitTakenUsd:{increment:Math.max(0,pnl)},unrealizedPnlUsd:next<=0n?0:undefined,status:next<=0n?"CLOSED":"PARTIALLY_CLOSED",closedAt:next<=0n?new Date():undefined}})
  ]);
  profitEvents++;
  await userEvent(p.userId,next<=0n?"POSITION_CLOSED":"PROFIT_TAKEN",next<=0n?"Position closed in simulation":"Profit protected in simulation",instruction.reason,{positionId:p.id,sellPct,pnlUsd:pnl,mode:"SIMULATION"});
  return next;
}

async function findEntryDecisionId(p:any){
  if(p.entryTxHash){const o=await db.order.findFirst({where:{userId:p.userId,txHash:p.entryTxHash},select:{decisionId:true}});if(o)return o.decisionId}
  const o=await db.order.findFirst({where:{userId:p.userId,mode:p.mode,side:"BUY",outputMint:p.mint,status:"CONFIRMED"},orderBy:{confirmedAt:"desc"},select:{decisionId:true}});
  return o?.decisionId??null;
}


async function recoverPrivyExitHash(referenceId:string){
  if(!signer)return null;
  try{
    const tx:any=await signer.transactionByReferenceId(referenceId);
    const status=String(tx?.status??"").toLowerCase();
    if(["failed","reverted","provider_error"].includes(status))return null;
    return String(tx?.transaction_hash??tx?.hash??"")||null;
  }catch(e){console.warn("[exits] Privy reference recovery unavailable",referenceId,e);return null}
}

async function executeLiveExit(p:any,instruction:any){
  // Deliberately NOT gated on the owner's live-trading (entries) toggle. That switch controls
  // whether the platform opens NEW real positions; it must never stop the risk engine from
  // managing money that is already at risk. A position already in mode:"LIVE" here has real
  // funds on-chain regardless of the current toggle state, so its exits always run.
  if(!chainSupports(p.chain,"SELL_SUPPORTED")||!rpc||!signer)throw Object.assign(new Error("LIVE_EXIT_INFRASTRUCTURE_NOT_CONFIGURED"),{code:"LIVE_EXIT_INFRASTRUCTURE_NOT_CONFIGURED"});
  const permitted=await db.wallet.findFirst({where:{userId:p.userId,chain:"SOLANA",tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}});
  if(!permitted)throw Object.assign(new Error("TRADING_PERMISSION_REQUIRED"),{code:"TRADING_PERMISSION_REQUIRED"});
  const remaining=BigInt(p.remainingTokenRaw);if(remaining<=0n)return;
  const sellPct=instruction.action==="EXIT"?100:Number(instruction.sellPct??0);
  const rawToSell=pctRaw(remaining,sellPct);if(rawToSell<=0n)return;
  const idem=exitKey(p.id,p.remainingTokenRaw,instruction.action,sellPct);
  const existing=await db.liveExecutionAttempt.findUnique({where:{idempotencyKey:idem}});
  if(existing?.status==="CONFIRMED")return;
  const decisionId=await findEntryDecisionId(p);if(!decisionId)throw Object.assign(new Error("ENTRY_DECISION_NOT_FOUND"),{code:"ENTRY_DECISION_NOT_FOUND"});
  const decimals=await tokenDecimals(p.mint);
  let order=existing?.orderId?await db.order.findUnique({where:{id:existing.orderId}}):null;

  // If a previous worker instance already submitted the exit, never send another transaction.
  if(existing?.txHash&&existing.status==="SUBMITTED"){
    await jupiter.waitConfirmed(rpc,existing.txHash,60_000);
    const fill=await reconcile(existing.txHash,permitted.address,p.mint,usdc);
    const tokenSold=BigInt(fill.actualInputRaw),usdcRaw=BigInt(fill.actualOutputRaw);
    const proceeds=Number(usdcRaw)/1_000_000;
    const costBasis=p.costUsd*frac(tokenSold,BigInt(p.entryTokenRaw));const pnl=proceeds-costBasis;
    const fresh=await db.position.findUnique({where:{id:p.id}});if(!fresh)return;
    const nowRemaining=BigInt(fresh.remainingTokenRaw);const next=nowRemaining>tokenSold?nowRemaining-tokenSold:0n;
    // Pre-generated so the LedgerEntry below can reference this exact PositionExit within the same
    // array-form $transaction (see executor.ts's identical pattern for the SOURCE_SELL mirror).
    const exitId=crypto.randomBytes(12).toString("hex");
    await db.$transaction([
      db.positionExit.create({data:{id:exitId,positionId:p.id,reason:`${instruction.action}_${instruction.reason}`.slice(0,180),tokenRaw:tokenSold.toString(),proceedsUsd:proceeds,pnlUsd:pnl,txHash:existing.txHash}}),
      db.position.update({where:{id:p.id},data:{remainingTokenRaw:next.toString(),realizedPnlUsd:{increment:pnl},profitTakenUsd:{increment:Math.max(0,pnl)},unrealizedPnlUsd:next<=0n?0:undefined,status:next<=0n?"CLOSED":"PARTIALLY_CLOSED",closedAt:next<=0n?new Date():undefined}}),
      db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:"CONFIRMED"}}),
      ...(order?[db.order.update({where:{id:order.id},data:{status:"CONFIRMED",actualInputRaw:fill.actualInputRaw,actualOutputRaw:fill.actualOutputRaw,confirmedAt:new Date()}})]:[]),
      db.ledgerEntry.create({data:{userId:p.userId,type:"SELL_PROCEEDS",amountUsdMicros:usdToMicros(proceeds),chain:"SOLANA",asset:"USDC",referenceType:"PositionExit",referenceId:exitId,note:`Live exit confirmed on-chain, tx ${existing.txHash}`}})
    ]);
    liveConfirmed++;await userEvent(p.userId,next<=0n?"POSITION_CLOSED":"PROFIT_TAKEN",next<=0n?"Live position closed":"Live profit protected",instruction.reason,{positionId:p.id,txHash:existing.txHash,sellPct,pnlUsd:pnl,mode:"LIVE"});return;
  }
  if(existing && ["SIGNING","FAILED"].includes(existing.status)){
    // Real bug found by a full-platform audit: with no throttle here, a genuinely-ambiguous exit
    // (nothing to recover -- e.g. the request never reached Privy at all) got retried every 3s
    // forever, on every tick, for as long as the position stayed open: a real network call to
    // Privy's reference-lookup API every 3s indefinitely, and (see tick()'s catch below) a fresh
    // CRITICAL RiskIncident row every 3s indefinitely, with no terminal state and no distinct
    // signal that this position needs manual attention versus a routine transient error. Only
    // actually re-attempt recovery once a reasonable interval has passed since the last try.
    const secondsSinceLastAttempt=(Date.now()-existing.updatedAt.getTime())/1000;
    if(secondsSinceLastAttempt<60){
      throw Object.assign(new Error("AMBIGUOUS_PRIOR_EXIT_ATTEMPT_REQUIRES_RECONCILIATION"),{code:"AMBIGUOUS_PRIOR_EXIT_ATTEMPT_REQUIRES_RECONCILIATION",throttled:true});
    }
    const recovered=await recoverPrivyExitHash(idem.slice(0,64));
    if(recovered){
      await db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:"SUBMITTED",txHash:recovered}});
      if(order)await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:recovered,submittedAt:order.submittedAt??new Date()}});
      return executeLiveExit(p,instruction);
    }
    // touch updatedAt so the next tick's throttle check above measures from *this* attempt, not
    // the original one -- without this the throttle window above would never actually engage.
    await db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:existing.status}}).catch(()=>{});
    // Never double-submit an ambiguous exit. An operator/next tick can reconcile by provider
    // reference ID; automatic resubmission is intentionally forbidden.
    throw Object.assign(new Error("AMBIGUOUS_PRIOR_EXIT_ATTEMPT_REQUIRES_RECONCILIATION"),{code:"AMBIGUOUS_PRIOR_EXIT_ATTEMPT_REQUIRES_RECONCILIATION"});
  }

  const quote=await jupiter.quote({inputMint:p.mint,outputMint:usdc,amountRaw:rawToSell.toString(),slippageBps:Number(execCfg?.exitSlippageBps??700)});
  const impact=Math.abs(Number(quote.priceImpactPct??0));
  const maxImpact=Math.max(1,Math.min(50,Number(riskCfg?.maxExecutablePriceImpactPct??35)));
  if(!Number.isFinite(impact)||impact>maxImpact)throw Object.assign(new Error("EXIT_PRICE_IMPACT_TOO_HIGH"),{code:"EXIT_PRICE_IMPACT_TOO_HIGH",impact});
  if(!quote.outAmount||BigInt(quote.outAmount)<=0n)throw Object.assign(new Error("NO_EXECUTABLE_SELL_ROUTE"),{code:"NO_EXECUTABLE_SELL_ROUTE"});
  const built=await jupiter.buildSwap(quote,permitted.address);
  try{
    order=await db.order.create({data:{idempotencyKey:idem,decisionId,userId:p.userId,chain:"SOLANA",mode:"LIVE",side:"SELL",inputMint:p.mint,outputMint:usdc,requestedInputRaw:rawToSell.toString(),expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"SIGNING",venue:"JUPITER",quoteJson:{reason:instruction.reason,sellPct,quote:quote.raw} as any}});
  }catch(e:any){
    if(e?.code!=="P2002")throw e;
    // Lost the race: another process instance (e.g. overlapping rolling restart) already created
    // the Order for this idempotency key. Back off rather than throwing into tick()'s catch, which
    // would log a spurious CRITICAL riskIncident for what is actually a handled, non-destructive
    // race. The winner's LiveExecutionAttempt row will exist by the next 3s tick, and the recovery
    // branches at the top of this function (existing?.status handling above) will reconcile against
    // it exactly like a resumed-after-crash attempt. Never proceed to sign/submit here.
    return;
  }
  await db.liveExecutionAttempt.create({data:{idempotencyKey:idem,userId:p.userId,orderId:order.id,positionId:p.id,purpose:"EXIT",chain:"SOLANA",walletAddress:permitted.address,provider:"PRIVY",providerRef:permitted.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
  try{
    const sent=await signer.signAndSend(permitted.permissionRef!,built,idem.slice(0,64));liveSubmitted++;
    await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:sent.hash,submittedAt:new Date()}});
    await db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:"SUBMITTED",txHash:sent.hash}});
    // Re-enter through the recovery-safe path; a crash after this line resumes from SUBMITTED.
    await executeLiveExit(p,instruction);
  }catch(e:any){
    // If the provider accepted the exit before the process/HTTP response failed, recover by the
    // unique reference ID instead of ever submitting a second sell.
    const recovered=await recoverPrivyExitHash(idem.slice(0,64));
    if(recovered){
      await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:recovered,submittedAt:new Date()}}).catch(()=>{});
      await db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:"SUBMITTED",txHash:recovered}}).catch(()=>{});
      return executeLiveExit(p,instruction);
    }
    const attempt=await db.liveExecutionAttempt.findUnique({where:{idempotencyKey:idem}}).catch(()=>null);
    if(attempt?.status!=="SUBMITTED"){
      await db.order.update({where:{id:order.id},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_EXIT_ATTEMPT")}}).catch(()=>{});
      await db.liveExecutionAttempt.update({where:{idempotencyKey:idem},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_EXIT_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
    }
    throw e;
  }
}

async function tick(){
  const positions=await db.position.findMany({where:{status:{in:["OPEN","PARTIALLY_CLOSED"]}},take:1000});scanned+=positions.length;
  for(const p of positions){
    try{
      if(!p.avgEntryPriceUsd||p.avgEntryPriceUsd<=0)continue;
      const mark=await db.marketPrice.findFirst({where:{chain:p.chain,mint:p.mint},orderBy:{observedAt:"desc"}});
      if(!mark||Date.now()-mark.observedAt.getTime()>60_000){stale++;continue}
      const current=mark.priceUsd,entry=p.avgEntryPriceUsd,original=BigInt(p.entryTokenRaw),remaining=BigInt(p.remainingTokenRaw);
      if(original<=0n||remaining<=0n)continue;
      await db.position.update({where:{id:p.id},data:{currentPriceUsd:current,peakPriceUsd:Math.max(p.peakPriceUsd??entry,current),lastMarkedAt:new Date()}});
      const market=await richMarket({...p,peakPriceUsd:Math.max(p.peakPriceUsd??entry,current)},current);
      if(!market){
        // No fabricated flow/holder/liquidity data. Mark-to-market continues, but automatic adaptive
        // exits wait for a fresh rich snapshot. A configured emergency source-sell path remains separate.
        const remainingCost=p.costUsd*frac(remaining,original);const value=remainingCost*(current/entry);
        await db.position.update({where:{id:p.id},data:{unrealizedPnlUsd:value-remainingCost}});stale++;continue;
      }
      const state=await positionState({...p,peakPriceUsd:Math.max(p.peakPriceUsd??entry,current)});
      const userSettings=await db.globalTradingSettings.findUnique({where:{userId:p.userId}});
      const recoveryEnabled=userSettings?.capitalRecoveryEnabled??true;
      const recoveryMultiple=Math.max(1.01,Number(userSettings?.capitalRecoveryMultiple??3));
      const currentMultiple=current/entry;
      let instruction:any;
      if(recoveryEnabled && state.principalRecoveredPct<100 && currentMultiple>=recoveryMultiple){
        const alreadyRecovered=p.costUsd*(state.principalRecoveredPct/100);
        const principalStillNeeded=Math.max(0,p.costUsd-alreadyRecovered);
        const remainingCost=p.costUsd*frac(remaining,original);
        const currentValue=remainingCost*currentMultiple;
        const sellPct=currentValue>0?Math.min(100,(principalStillNeeded/currentValue)*100):0;
        instruction=sellPct>0.0001
          ? {action:"PARTIAL_TP",sellPct,reason:`Recover original capital at ${recoveryMultiple.toFixed(2)}x; keep the rest as the evidence-managed runner`}
          : evaluateExit(market,state);
      }else instruction=evaluateExit(market,state);
      if(p.mode==="SIMULATION")await applySimulationExit(p,current,instruction);
      else if(instruction.action!=="HOLD")await executeLiveExit(p,instruction);
      const fresh=await db.position.findUnique({where:{id:p.id}});if(!fresh)continue;
      const rr=BigInt(fresh.remainingTokenRaw),remainingCost=fresh.costUsd*frac(rr,BigInt(fresh.entryTokenRaw)),value=remainingCost*(current/entry);
      await db.position.update({where:{id:p.id},data:{unrealizedPnlUsd:rr<=0n?0:value-remainingCost,lastMarkedAt:new Date()}});marked++;
    }catch(e:any){
      errors++;console.error("[exits]",p.id,e);
      const code=String(e?.code??"EXIT_ERROR");
      // Real bug found by audit: an ambiguous exit that can't yet be resolved threw on every 3s
      // tick, and this created a fresh CRITICAL RiskIncident row every single time -- unbounded
      // real-time DB growth and unreviewable alert noise for what is, after the first occurrence,
      // the exact same unresolved condition. Only create a new incident if the last unresolved one
      // for this position+code is more than 10 minutes old (still resurfaces if it's genuinely
      // still stuck, without spamming every 3 seconds).
      const recent=await db.riskIncident.findFirst({where:{positionId:p.id,code,resolvedAt:null,createdAt:{gte:new Date(Date.now()-10*60_000)}},select:{id:true}}).catch(()=>null);
      if(!recent)await db.riskIncident.create({data:{severity:"CRITICAL",scope:"EXIT_ENGINE",userId:p.userId,chain:p.chain,mint:p.mint,positionId:p.id,code,detail:{message:String(e?.message??e)}}}).catch(()=>{});
    }
  }
}
async function guardedTick(){if(ticking)return;ticking=true;try{await tick()}catch(e){errors++;console.error("[exits]",e)}finally{ticking=false}}
startHeartbeat("exits",()=>({scanned,marked,stale,errors,profitEvents,liveSubmitted,liveConfirmed,ticking,adaptiveExit:true,signerConfigured:Boolean(signer)}));
setInterval(()=>void guardedTick(),3000);void guardedTick();
console.log("[exits] adaptive position monitor active");
