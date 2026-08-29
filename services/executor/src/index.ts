import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "@memecloud/db";
import { calculateExitAccounting, decideCopy, walletChasePct, cachedTokenDecimals } from "@memecloud/shared";
import { JupiterExecution } from "@memecloud/execution";
import { evaluateEntry } from "@memecloud/strategy";
import { PrivySolanaSigner } from "@memecloud/providers";
import { startHeartbeat } from "@memecloud/ops";
import { getConfig, isLiveTradingEnabled } from "@memecloud/config";

const connection=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const notificationQueue=new Queue("user-notifications",{connection});
const decimalsCache=new Map<string,{decimals:number,at:number}>();
const usdcSol=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// This worker signs and submits real transactions — it must never keep operating on Jupiter/RPC/
// Privy credentials that Admin has since changed or rotated. Previously read once at process
// startup and cached forever, identically to the bug already fixed in listener/flow-worker/
// market-worker this session. Reloaded on a timer (not per-job) so job latency doesn't pay an
// AppConfig read on every signal.
let jupiter:JupiterExecution,solanaRpc:string|undefined,solanaConnection:Connection|null,privy:PrivySolanaSigner|null,exitSlippageBps=700,maxExecutablePriceImpactPct=35;
async function reloadConfig(){
  const execCfg=await getConfig<any>("execution");
  const marketCfg=await getConfig<any>("marketData");
  const riskCfg=await getConfig<any>("risk");
  jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
  solanaRpc=marketCfg?.heliusRpc||marketCfg?.solanaRpc||process.env.SOLANA_RPC_HTTP;
  solanaConnection=solanaRpc?new Connection(solanaRpc,"confirmed"):null;
  exitSlippageBps=Number(execCfg?.exitSlippageBps??700);
  maxExecutablePriceImpactPct=Math.max(1,Math.min(50,Number(riskCfg?.maxExecutablePriceImpactPct??35)));
  const signerCfg=await getConfig<any>("signer");
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID;
  const privyAppSecret=signerCfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const privyAuthorizationPrivateKey=signerCfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  privy=privyAppId&&privyAppSecret?new PrivySolanaSigner({appId:privyAppId,appSecret:privyAppSecret,authorizationPrivateKey:privyAuthorizationPrivateKey,sponsorGas:Boolean(signerCfg?.sponsorGas)}):null;
}
await reloadConfig();
setInterval(()=>void reloadConfig().catch(e=>console.error("[executor] config reload failed, keeping previous clients",e)),60_000);

let processed=0,allowedCount=0,skippedCount=0,errors=0;


async function tokenDecimals(mint:string){
  // Two tiers: an in-process Map is the fastest path for this process's own hot mints; a shared
  // Redis cache (a mint's decimals never change) is checked before ever hitting RPC, since
  // exits/executor/market-worker/paper-worker were each independently re-fetching the exact same
  // immutable fact for the same mints.
  const cached=decimalsCache.get(mint);
  if(cached&&Date.now()-cached.at<60*60_000)return cached.decimals;
  if(!solanaConnection)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  const decimals=await cachedTokenDecimals(connection,mint,async()=>(await solanaConnection!.getTokenSupply(new PublicKey(mint),"confirmed")).value.decimals);
  decimalsCache.set(mint,{decimals,at:Date.now()});
  return decimals;
}

async function resolveSourceBuyPriceUsd(signal:any){
  if(signal.sourcePriceUsd&&Number(signal.sourcePriceUsd)>0)return {price:Number(signal.sourcePriceUsd),method:signal.sourcePriceMethod||"TX_RECORDED"};
  if(signal.chain!=="SOLANA"||signal.action!=="BUY")return null;
  const outputDecimals=await tokenDecimals(signal.outputMint);
  const tokenAmount=Number(BigInt(signal.outputRaw))/(10**outputDecimals);
  if(!Number.isFinite(tokenAmount)||tokenAmount<=0)return null;
  let inputUsd:number;
  if(signal.inputMint===usdcSol){
    inputUsd=Number(BigInt(signal.inputRaw))/1_000_000;
  }else{
    // Source wallets commonly buy memes with WSOL/USDT rather than USDC. Normalize the exact
    // transaction-visible source quote amount into USDC through a genuine Jupiter quote at
    // detection time. This is auditable and far better than treating the token's 24h move as
    // chase. It is intentionally labeled as a detection-time normalization, not an exact
    // historical USD oracle for the source block.
    const usdQuote=await jupiter.quote({inputMint:signal.inputMint,outputMint:usdcSol,amountRaw:String(signal.inputRaw),slippageBps:50});
    inputUsd=Number(BigInt(usdQuote.outAmount))/1_000_000;
  }
  if(!Number.isFinite(inputUsd)||inputUsd<=0)return null;
  return {price:inputUsd/tokenAmount,method:signal.inputMint===usdcSol?"TX_USDC_RATIO":"SOURCE_QUOTE_ASSET_TO_USDC_AT_DETECTION"};
}

async function userEvent(userId:string,type:string,title:string,body:string,data:Record<string,unknown>={}){
  const event=await db.userActivityEvent.create({data:{userId,type,title,body,data:data as any}});
  // The activity row is the durable event identity. Reusing it as BullMQ jobId +
  // Notification.deliveryKey prevents DB notification duplicates when a worker retries.
  await notificationQueue.add("notify",{userId,type,title,body,data,deliveryKey:event.id},{jobId:event.id,removeOnComplete:1000,attempts:3,backoff:{type:"exponential",delay:1000}});
}


async function recoverPrivyHash(referenceId:string){
  if(!privy)return null;
  try{
    const tx:any=await privy.transactionByReferenceId(referenceId);
    const status=String(tx?.status??"").toLowerCase();
    if(["failed","reverted","provider_error"].includes(status))return null;
    return String(tx?.transaction_hash??tx?.hash??"")||null;
  }catch(e){console.warn("[executor] Privy reference recovery unavailable",referenceId,e);return null}
}

async function finalizeLiveBuy(order:any,attemptKey:string,txHash:string,permitted:any,signal:any,follow:any,decimals:number){
  if(!solanaRpc)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  await jupiter.waitConfirmed(solanaRpc,txHash,60_000);
  const fill=await reconcileConfirmedSwap(txHash,permitted.address,usdcSol,signal.outputMint);
  const actualUsd=Number(BigInt(fill.actualInputRaw))/1_000_000;
  const actualTokens=Number(BigInt(fill.actualOutputRaw))/(10**decimals);
  if(!Number.isFinite(actualTokens)||actualTokens<=0)throw Object.assign(new Error("INVALID_CONFIRMED_TOKEN_AMOUNT"),{code:"INVALID_CONFIRMED_TOKEN_AMOUNT"});
  const actualEntry=actualUsd/actualTokens;
  const already=await db.position.findFirst({where:{userId:follow.userId,mode:"LIVE",entryTxHash:txHash}});
  await db.$transaction([
    db.order.update({where:{id:order.id},data:{status:"CONFIRMED",txHash,actualInputRaw:fill.actualInputRaw,actualOutputRaw:fill.actualOutputRaw,confirmedAt:new Date()}}),
    ...(already?[]:[db.position.create({data:{userId:follow.userId,sourceTraderId:signal.traderId,chain:"SOLANA",mode:"LIVE",mint:signal.outputMint,quoteMint:usdcSol,entryTxHash:txHash,entryInputRaw:fill.actualInputRaw,entryTokenRaw:fill.actualOutputRaw,remainingTokenRaw:fill.actualOutputRaw,costUsd:actualUsd,avgEntryPriceUsd:actualEntry,currentPriceUsd:actualEntry,peakPriceUsd:actualEntry,takeProfitPct:follow.takeProfitPct,stopLossPct:follow.stopLossPct,status:"OPEN",lastMarkedAt:new Date()}})]),
    db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"CONFIRMED",txHash}})
  ]);
  if(!already)await userEvent(follow.userId,"TRADE_COPIED",`${signal.trader.displayName}: live trade confirmed`,`Bought $${actualUsd.toFixed(2)} of the token. The transaction is confirmed on Solana.`,{signalId:signal.id,orderId:order.id,txHash,mode:"LIVE"});
  return {actualUsd,actualEntry};
}

function decisionKey(signalId:string,userId:string){
  return crypto.createHash("sha256").update(`${signalId}:${userId}:copy-v2`).digest("hex");
}

function remainingCostBasisUsd(p:{costUsd:number;remainingTokenRaw:string;entryTokenRaw:string}){
  try{
    const remaining=BigInt(p.remainingTokenRaw), original=BigInt(p.entryTokenRaw);
    if(original<=0n||remaining<=0n)return 0;
    const ratio=Number((remaining*1_000_000n)/original)/1_000_000;
    return Math.max(0,p.costUsd*ratio);
  }catch{return Math.max(0,p.costUsd)}
}



function tokenBalanceRaw(tx:any,owner:string,mint:string,side:"pre"|"post"){
  const rows=side==="pre"?(tx?.meta?.preTokenBalances??[]):(tx?.meta?.postTokenBalances??[]);
  return rows.filter((x:any)=>x.owner===owner&&x.mint===mint).reduce((a:bigint,x:any)=>a+BigInt(x.uiTokenAmount?.amount??"0"),0n);
}
async function reconcileConfirmedSwap(signature:string,owner:string,inputMint:string,outputMint:string){
  if(!solanaConnection)throw new Error("SOLANA_RPC_REQUIRED");
  const tx=await solanaConnection.getParsedTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx||tx.meta?.err)throw Object.assign(new Error("CONFIRMED_TRANSACTION_UNAVAILABLE"),{code:"RECONCILIATION_FAILED"});
  const inPre=tokenBalanceRaw(tx,owner,inputMint,"pre"),inPost=tokenBalanceRaw(tx,owner,inputMint,"post");
  const outPre=tokenBalanceRaw(tx,owner,outputMint,"pre"),outPost=tokenBalanceRaw(tx,owner,outputMint,"post");
  const actualInput=inPre>inPost?inPre-inPost:0n;
  const actualOutput=outPost>outPre?outPost-outPre:0n;
  if(actualInput<=0n||actualOutput<=0n)throw Object.assign(new Error("CONFIRMED_SWAP_DELTAS_INVALID"),{code:"RECONCILIATION_FAILED"});
  return {actualInputRaw:actualInput.toString(),actualOutputRaw:actualOutput.toString(),feeLamports:tx.meta?.fee??0};
}

// Confirms a live source-sell-mirror SELL, reconciles it against the real on-chain balance deltas
// (never trusts the pre-sign quote as the realized amount), and records the exit using the same
// calculateExitAccounting formula the SIMULATION mirror already uses -- just fed a real,
// evidence-derived execution price instead of a stale mark. Mirrors finalizeLiveBuy's shape.
async function finalizeLiveSell(order:any,attemptKey:string,txHash:string,permitted:any,position:any){
  if(!solanaRpc)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  await jupiter.waitConfirmed(solanaRpc,txHash,60_000);
  const fill=await reconcileConfirmedSwap(txHash,permitted.address,position.mint,usdcSol);
  const actualTokensSoldRaw=BigInt(fill.actualInputRaw);
  const actualProceedsUsd=Number(BigInt(fill.actualOutputRaw))/1_000_000;
  if(actualTokensSoldRaw<=0n||!Number.isFinite(actualProceedsUsd)||actualProceedsUsd<0)throw Object.assign(new Error("INVALID_CONFIRMED_SELL_AMOUNTS"),{code:"INVALID_CONFIRMED_SELL_AMOUNTS"});
  const decimals=await tokenDecimals(position.mint);
  const actualTokenAmount=Number(actualTokensSoldRaw)/(10**decimals);
  if(!Number.isFinite(actualTokenAmount)||actualTokenAmount<=0)throw Object.assign(new Error("INVALID_CONFIRMED_TOKEN_AMOUNT"),{code:"INVALID_CONFIRMED_TOKEN_AMOUNT"});
  const actualExecutionPriceUsd=actualProceedsUsd/actualTokenAmount;
  const fresh=await db.position.findUnique({where:{id:position.id}});
  if(!fresh)throw Object.assign(new Error("POSITION_MISSING_ON_RECONCILE"),{code:"POSITION_MISSING_ON_RECONCILE"});
  const freshRemaining=BigInt(fresh.remainingTokenRaw);
  const cappedSoldRaw=actualTokensSoldRaw>freshRemaining?freshRemaining:actualTokensSoldRaw;
  if(cappedSoldRaw<=0n||!fresh.avgEntryPriceUsd)throw Object.assign(new Error("POSITION_ALREADY_FULLY_EXITED"),{code:"POSITION_ALREADY_FULLY_EXITED"});
  const accounting=calculateExitAccounting({entryTokenRaw:fresh.entryTokenRaw,remainingTokenRaw:fresh.remainingTokenRaw,tokenRaw:cappedSoldRaw.toString(),costUsd:fresh.costUsd,avgEntryPriceUsd:fresh.avgEntryPriceUsd,executionPriceUsd:actualExecutionPriceUsd});
  const nextRaw=BigInt(accounting.remainingTokenRaw);
  const isClosed=nextRaw<=0n;
  await db.$transaction([
    db.positionExit.create({data:{positionId:position.id,reason:"SOURCE_SELL_MIRROR_LIVE",tokenRaw:cappedSoldRaw.toString(),proceedsUsd:accounting.netProceedsUsd,pnlUsd:accounting.realizedPnlUsd,txHash}}),
    db.position.update({where:{id:position.id},data:{remainingTokenRaw:isClosed?"0":nextRaw.toString(),realizedPnlUsd:{increment:accounting.realizedPnlUsd},profitTakenUsd:{increment:Math.max(0,accounting.realizedPnlUsd)},unrealizedPnlUsd:isClosed?0:undefined,status:isClosed?"CLOSED":"PARTIALLY_CLOSED",closedAt:isClosed?new Date():undefined}}),
    db.order.update({where:{id:order.id},data:{status:"CONFIRMED",txHash,actualInputRaw:fill.actualInputRaw,actualOutputRaw:fill.actualOutputRaw,confirmedAt:new Date()}}),
    db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"CONFIRMED",txHash}})
  ]);
  return {isClosed,proceedsUsd:accounting.netProceedsUsd,pnlUsd:accounting.realizedPnlUsd};
}

async function handleSourceSell(signal:any){
  const mode=(process.env.EXECUTION_MODE??"simulation").toUpperCase() as "SIMULATION"|"LIVE";
  const positions=await db.position.findMany({
    where:{sourceTraderId:signal.traderId,mode,mint:signal.inputMint,status:{in:["OPEN","PARTIALLY_CLOSED"]}},
    include:{sourceTrader:true}
  });
  const byUser=new Map<string,typeof positions>();
  for(const p of positions){const list=byUser.get(p.userId)??[];list.push(p);byUser.set(p.userId,list)}
  for(const [userId,userPositions] of byUser){
    const existing=await db.copyDecision.findUnique({where:{signalId_userId:{signalId:signal.id,userId}}});
    if(existing) continue;
    const soldPct=Number(signal.sourceSoldPct??NaN);
    if(!Number.isFinite(soldPct)||soldPct<=0){
      await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_SOURCE_EXIT_CONTEXT",reason:"SOURCE_SELL_PERCENT_UNKNOWN",explanation:"The trader sold, but MemeCloud could not verify what percentage of the source position was sold. It will not invent an exit size."}});
      await userEvent(userId,"SOURCE_SELL",`${signal.trader.displayName} sold`,"The source sale was detected, but the sold percentage could not be verified, so no automatic mirror exit was invented.",{signalId:signal.id});
      continue;
    }
    const fraction=Math.min(1,soldPct/100);
    if(mode==="LIVE"){
      const permitted=await db.wallet.findFirst({where:{userId,chain:signal.chain,tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}});
      if(!permitted){
        await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"SKIP",reason:"TRADING_PERMISSION_REQUIRED",explanation:`Source trader sold ${soldPct.toFixed(1)}%, but this account has no active delegated trading permission for this chain. No funds were moved.`}});
        continue;
      }
      // This is the one case where WAIT_SIGNER is actually correct: no delegated signer is
      // connected, so there is nothing that can sign a real sell. Once signer config exists
      // (checked fresh via reloadConfig, never cached across an Admin change), fall through to a
      // genuine on-chain mirror sell below -- this must never be an unconditional placeholder.
      if(!privy){
        await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_SIGNER",reason:"SIGNER_PROVIDER_REQUIRED",explanation:`Source trader sold ${soldPct.toFixed(1)}%. Live mirror exits remain disabled until the reviewed delegated signer is connected.`}});
        await userEvent(userId,"SOURCE_SELL",`${signal.trader.displayName} sold ${soldPct.toFixed(1)}%`,`A live source exit was detected. Your position remains protected by fail-closed mode until the delegated signer is configured.`,{signalId:signal.id,sourceSoldPct:soldPct});
        continue;
      }
      const liveDecision=await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:true,action:"SOURCE_SELL_MIRROR",sourcePriceUsd:signal.sourcePriceUsd,explanation:`Source trader sold ${soldPct.toFixed(1)}%; mirroring that verified fraction with a real on-chain sell.`}});
      let liveClosed=0,livePartial=0,liveFailed=0,liveSkipped=0;
      for(const p of userPositions){
        try{
          if(!p.avgEntryPriceUsd||p.avgEntryPriceUsd<=0)continue;
          const remaining=BigInt(p.remainingTokenRaw);
          if(remaining<=0n)continue;
          let rawToExit=(remaining*BigInt(Math.round(fraction*1_000_000)))/1_000_000n;
          if(rawToExit<=0n&&fraction>0)rawToExit=1n;
          if(rawToExit>remaining)rawToExit=remaining;
          if(rawToExit<=0n)continue;

          const positionOrderKey=crypto.createHash("sha256").update(`SOURCE_SELL:${signal.id}:${p.id}`).digest("hex");
          let order=await db.order.findUnique({where:{idempotencyKey:positionOrderKey}});
          if(order){
            if(order.status==="CONFIRMED"){continue}
            const attempt=await db.liveExecutionAttempt.findFirst({where:{orderId:order.id,purpose:"SOURCE_SELL"},orderBy:{createdAt:"desc"}});
            if(!attempt)throw Object.assign(new Error("LIVE_SOURCE_SELL_ATTEMPT_MISSING"),{code:"LIVE_SOURCE_SELL_ATTEMPT_MISSING"});
            const ref=attempt.idempotencyKey.slice(0,64);
            const hash=attempt.txHash||order.txHash||await recoverPrivyHash(ref);
            if(hash){
              await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:hash,submittedAt:order.submittedAt??new Date()}});
              await db.liveExecutionAttempt.update({where:{id:attempt.id},data:{status:"SUBMITTED",txHash:hash}});
              const outcome=await finalizeLiveSell(order,attempt.idempotencyKey,hash,permitted,p);
              if(outcome.isClosed)liveClosed++;else livePartial++;
            }else{
              // Ambiguous prior attempt with no recoverable provider hash. Never auto-resubmit a
              // real sell; leave it for reconciliation exactly like the BUY path does.
              liveSkipped++;
            }
            continue;
          }

          const quote=await jupiter.quote({inputMint:p.mint,outputMint:usdcSol,amountRaw:rawToExit.toString(),slippageBps:exitSlippageBps});
          const impact=Math.abs(Number(quote.priceImpactPct??0));
          if(!quote.outAmount||BigInt(quote.outAmount)<=0n||!Number.isFinite(impact)||impact>maxExecutablePriceImpactPct){
            liveSkipped++;continue;
          }
          const built=await jupiter.buildSwap(quote,permitted.address);
          order=await db.order.create({data:{idempotencyKey:positionOrderKey,decisionId:liveDecision.id,userId,chain:"SOLANA",mode:"LIVE",side:"SELL",inputMint:p.mint,outputMint:usdcSol,requestedInputRaw:rawToExit.toString(),expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"SIGNING",venue:"JUPITER",quoteJson:{quote:quote.raw,sourceSoldPct:soldPct} as any}});
          const attemptKey=crypto.createHash("sha256").update(`SOURCE_SELL:${order.id}`).digest("hex");
          await db.liveExecutionAttempt.create({data:{idempotencyKey:attemptKey,userId,orderId:order.id,positionId:p.id,purpose:"SOURCE_SELL",chain:"SOLANA",walletAddress:permitted.address,provider:"PRIVY",providerRef:permitted.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
          try{
            const sent=await privy.signAndSend(permitted.permissionRef!,built,attemptKey.slice(0,64));
            await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:sent.hash,submittedAt:new Date()}});
            await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:sent.hash}});
            const outcome=await finalizeLiveSell(order,attemptKey,sent.hash,permitted,p);
            if(outcome.isClosed)liveClosed++;else livePartial++;
          }catch(e:any){
            const recovered=await recoverPrivyHash(attemptKey.slice(0,64));
            if(recovered){
              await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:recovered,submittedAt:new Date()}}).catch(()=>{});
              await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:recovered}}).catch(()=>{});
              const outcome=await finalizeLiveSell(order,attemptKey,recovered,permitted,p);
              if(outcome.isClosed)liveClosed++;else livePartial++;
              continue;
            }
            await db.order.update({where:{id:order.id},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_SOURCE_SELL_ATTEMPT")}}).catch(()=>{});
            await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_SOURCE_SELL_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
            await db.riskIncident.create({data:{severity:"CRITICAL",scope:"LIVE_EXECUTION",userId,chain:"SOLANA",mint:p.mint,positionId:p.id,code:String(e?.code??"AMBIGUOUS_LIVE_SOURCE_SELL_ATTEMPT"),detail:{orderId:order.id,message:String(e?.message??e),referenceId:attemptKey.slice(0,64)}}}).catch(()=>{});
            liveFailed++;
          }
        }catch(e:any){
          console.error("[executor] live source-sell mirror failed for position",p.id,e);
          liveFailed++;
        }
      }
      await userEvent(userId,liveFailed?"TRADE_SKIPPED":(liveClosed&&!livePartial?"POSITION_CLOSED":"PROFIT_TAKEN"),
        `${signal.trader.displayName} source sell mirrored live`,
        `Verified source sale ${soldPct.toFixed(1)}% mirrored with real on-chain sells across ${userPositions.length} position(s). Closed ${liveClosed}, partially exited ${livePartial}${liveSkipped?`, ${liveSkipped} left open pending a genuine executable route/reconciliation`:""}${liveFailed?`, ${liveFailed} failed and were left open (protected by fail-safe reconciliation, no funds double-moved)`:""}.`,
        {signalId:signal.id,decisionId:liveDecision.id,sourceSoldPct:soldPct,mode:"LIVE",closed:liveClosed,partial:livePartial,skipped:liveSkipped,failed:liveFailed});
      continue;
    }
    const market=await db.marketPrice.findFirst({where:{chain:signal.chain,mint:signal.inputMint},orderBy:{observedAt:"desc"}});
    if(!market || Date.now()-market.observedAt.getTime()>60_000){
      await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_MARKET_DATA",reason:"SOURCE_EXIT_PRICE_UNAVAILABLE",explanation:"The source sell was detected, but a fresh genuine market price is unavailable."}});
      continue;
    }
    const decision=await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:true,action:"SOURCE_SELL_MIRROR",sourcePriceUsd:signal.sourcePriceUsd,executablePriceUsd:market.priceUsd,explanation:`Source trader sold ${soldPct.toFixed(1)}%; simulation mirrors that verified fraction using the latest genuine price mark.`}});
    let totalPnl=0,totalProceeds=0,closed=0,partial=0;
    for(const p of userPositions){
      if(!p.avgEntryPriceUsd||p.avgEntryPriceUsd<=0) continue;
      const remaining=BigInt(p.remainingTokenRaw), original=BigInt(p.entryTokenRaw);
      if(remaining<=0n||original<=0n) continue;
      let rawToExit=(remaining*BigInt(Math.round(fraction*1_000_000)))/1_000_000n;
      if(rawToExit<=0n&&fraction>0) rawToExit=1n;
      if(rawToExit>remaining) rawToExit=remaining;
      const accounting=calculateExitAccounting({entryTokenRaw:p.entryTokenRaw,remainingTokenRaw:p.remainingTokenRaw,tokenRaw:rawToExit.toString(),costUsd:p.costUsd,avgEntryPriceUsd:p.avgEntryPriceUsd,executionPriceUsd:market.priceUsd});
      const proceeds=accounting.netProceedsUsd;
      const pnl=accounting.realizedPnlUsd;
      const nextRaw=BigInt(accounting.remainingTokenRaw);
      const isClosed=nextRaw<=0n||soldPct>=99.9;
      await db.$transaction([
        db.positionExit.create({data:{positionId:p.id,reason:"SOURCE_SELL_MIRROR_SIMULATION",tokenRaw:rawToExit.toString(),proceedsUsd:proceeds,pnlUsd:pnl}}),
        db.position.update({where:{id:p.id},data:{remainingTokenRaw:isClosed?"0":nextRaw.toString(),realizedPnlUsd:{increment:pnl},profitTakenUsd:{increment:Math.max(0,pnl)},unrealizedPnlUsd:isClosed?0:undefined,status:isClosed?"CLOSED":"PARTIALLY_CLOSED",closedAt:isClosed?new Date():undefined}})
      ]);
      totalPnl+=pnl;totalProceeds+=proceeds;if(isClosed)closed++;else partial++;
    }
    await userEvent(userId,closed&&partial===0?"POSITION_CLOSED":"PROFIT_TAKEN",`${signal.trader.displayName} source sell mirrored in simulation`,`Verified source sale ${soldPct.toFixed(1)}% · simulated proceeds $${totalProceeds.toFixed(2)} · realized P&L ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}.`,{signalId:signal.id,decisionId:decision.id,sourceSoldPct:soldPct,mode:"SIMULATION"});
  }
}

const worker=new Worker("signals",async job=>{
  const signal=await db.signal.findUnique({where:{id:job.data.signalId},include:{trader:true}});
  if(!signal) return;
  processed++;
  if(signal.action==="SELL"){
    await handleSourceSell(signal);
    await db.signal.update({where:{id:signal.id},data:{status:"COMPLETED"}}).catch(()=>{});
    return;
  }
  let sourceExecutionPriceUsd=signal.sourcePriceUsd?Number(signal.sourcePriceUsd):undefined;
  if(!sourceExecutionPriceUsd&&signal.chain==="SOLANA"){
    try{
      const normalized=await resolveSourceBuyPriceUsd(signal);
      if(normalized){
        sourceExecutionPriceUsd=normalized.price;
        await db.signal.update({where:{id:signal.id},data:{sourcePriceUsd:normalized.price,sourcePriceMethod:normalized.method}});
      }
    }catch(e){console.warn("[executor] source price normalization unavailable",signal.id,e)}
  }
  const riskCfg=await getConfig<any>("risk");
  const globalChaseCap=Math.max(0,Number(riskCfg?.hyperMaxChasePct??0)); // 0 = no platform chase ceiling

  const follows=await db.userFollow.findMany({
    where:{traderId:signal.traderId,mode:{in:["AUTO_COPY","WATCH_ONLY"]}},
    include:{user:{include:{tradingSettings:true,cashAllocations:true}}}
  });

  for(const follow of follows){
    const existing=await db.copyDecision.findUnique({
      where:{signalId_userId:{signalId:signal.id,userId:follow.userId}},
      include:{orders:{select:{id:true}}}
    });
    // A worker crash can happen after an eligible decision is stored but before the order/position
    // transaction commits. In that one state, retry the execution path instead of silently dropping
    // the trade forever. Any terminal/skipped decision or a decision that already owns an order is
    // idempotently ignored.
    const resumablePendingBuy=Boolean(existing?.allowed&&existing.action==="BUY"&&existing.orders.length===0);
    if(existing&&!resumablePendingBuy) continue;
    const saveDecision=async(data:any)=>existing
      ? db.copyDecision.update({where:{id:existing.id},data})
      : db.copyDecision.create({data:{signalId:signal.id,userId:follow.userId,...data}});

    if(follow.mode==="WATCH_ONLY"){
      await saveDecision({allowed:false,action:"WATCH",reason:"WATCH_ONLY",explanation:"You follow this trader in Watch mode."});
      await userEvent(follow.userId,"TRADER_SIGNAL",`${signal.trader.displayName} ${signal.action==="BUY"?"bought":"sold"} a token`,
        "Watch mode is on, so no automatic trade was placed.",{signalId:signal.id,traderId:signal.traderId});
      skippedCount++; continue;
    }

    const global=follow.user.tradingSettings;
    if(riskCfg?.emergencyNewEntriesPaused===true){
      await saveDecision({allowed:false,action:"SKIP",reason:"PLATFORM_NEW_ENTRIES_PAUSED",explanation:"The platform emergency new-entry switch is active. Existing positions can still be monitored."});
      await userEvent(follow.userId,"TRADE_SKIPPED",`${signal.trader.displayName}: new entries temporarily paused`,`The platform emergency new-entry switch is active.`,{signalId:signal.id});
      skippedCount++; continue;
    }
    if(!global?.autoCopyEnabled){
      await saveDecision({allowed:false,action:"SKIP",reason:"GLOBAL_AUTO_COPY_DISABLED",explanation:"Your global Auto Copy switch is off."});
      skippedCount++; continue;
    }
    if(!global.allowedChains.includes(signal.chain)){
      await saveDecision({allowed:false,action:"SKIP",reason:"CHAIN_DISABLED",explanation:`${signal.chain} is disabled in your trading settings.`});
      skippedCount++; continue;
    }

    const mode=(process.env.EXECUTION_MODE??"simulation").toUpperCase() as "SIMULATION"|"LIVE";
    const open=await db.position.findMany({where:{userId:follow.userId,mode,status:{in:["OPEN","PARTIALLY_CLOSED"]}}});
    if(global.maxConcurrentPositions>0 && open.length>=global.maxConcurrentPositions){
      await saveDecision({allowed:false,action:"SKIP",reason:"MAX_CONCURRENT_POSITIONS",explanation:"Your own open-position limit is currently reached."});
      skippedCount++; continue;
    }

    const allocation=follow.user.cashAllocations.find(a=>a.chain===signal.chain);
    const availableUsd=allocation?.availableUsd??0;
    const currentExposureUsd=open.reduce((a,p)=>a+remainingCostBasisUsd(p),0);
    const tokenMint=signal.outputMint;
    const sameOpen=open.filter(p=>p.mint===tokenMint&&p.sourceTraderId===signal.traderId);
    const tokenExposureUsd=open.filter(p=>p.mint===tokenMint).reduce((a,p)=>a+remainingCostBasisUsd(p),0);
    if(sameOpen.length && !follow.copyAdditionalBuys){
      await saveDecision({allowed:false,action:"SKIP",reason:"ADDITIONAL_BUY_DISABLED",explanation:"You disabled additional buys for this trader."});
      skippedCount++; continue;
    }
    if(!sameOpen.length && !follow.copyReentries){
      const prior=await db.position.findFirst({where:{userId:follow.userId,mode,sourceTraderId:signal.traderId,mint:tokenMint,status:"CLOSED"},select:{id:true}});
      if(prior){
        await saveDecision({allowed:false,action:"SKIP",reason:"REENTRY_DISABLED",explanation:"You disabled re-entry copies for this trader."});
        skippedCount++; continue;
      }
    }
    const market=await db.marketPrice.findFirst({where:{chain:signal.chain,mint:tokenMint},orderBy:{observedAt:"desc"}});
    const currentPriceUsd=market?.priceUsd;
    const chase=(sourceExecutionPriceUsd&&currentPriceUsd)?walletChasePct(sourceExecutionPriceUsd,currentPriceUsd):undefined;

    // Daily move is intentionally not used here. Chase = source wallet execution -> our executable entry.
    const positiveMin=(...xs:number[])=>{const on=xs.filter(x=>Number.isFinite(x)&&x>0);return on.length?Math.min(...on):0};
    const maxChase=positiveMin(Number(follow.maxChasePct??0),globalChaseCap);
    const globalTradeCap=Number(global.maxAmountPerTradeUsd??0);
    const fixedAmount=globalTradeCap>0?Math.min(follow.fixedAmountUsd,globalTradeCap):follow.fixedAmountUsd;
    const base=decideCopy({
      settings:{
        enabled:true,sizingMode:(global.sizingMode==="FIXED"?"FIXED":"PERCENT") as any,
        fixedAmountUsd:fixedAmount,
        percentBalance:Number(global.percentBalance??2),takeProfitPct:follow.takeProfitPct,stopLossPct:follow.stopLossPct,
        maxChasePct:maxChase,maxSlippageBps:follow.maxSlippageBps,maxPositionUsd:positiveMin(Number(follow.maxPositionUsd??0),Number(global.maxAmountPerTradeUsd??0)),
        maxTotalExposureUsd:positiveMin(Number(follow.maxTotalExposureUsd??0),Number(global.maxTotalExposureUsd??0)),
        minLiquidityUsd:follow.minLiquidityUsd,exitMode:(follow.exitMode==="ADAPTIVE"?"HYBRID":follow.exitMode) as any
      },
      // Sizing/risk checks happen here, but chase is deliberately evaluated separately.
      // The authoritative simulation chase comes from the user's actual-size executable quote.
      sourcePriceUsd:undefined,
      currentPriceUsd:undefined,
      availableUsd,currentExposureUsd,tokenExposureUsd,liquidityUsd:market?.liquidityUsd??undefined
    });

    if(!base.allowed){
      const reason=base.reason;
      await saveDecision({
        allowed:false,action:reason==="WAIT_PULLBACK"?"WAIT_PULLBACK":"SKIP",
        reason,explanation:reason==="WAIT_PULLBACK"?"The coin moved beyond your current chase window. We are not using its 24h move; we are waiting for a cleaner entry.":base.reason,
        sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd:currentPriceUsd,walletChasePct:chase
      });
      await userEvent(follow.userId,reason==="WAIT_PULLBACK"?"WAIT_PULLBACK":"TRADE_SKIPPED",
        reason==="WAIT_PULLBACK"?`${signal.trader.displayName}: waiting for a better entry`:`${signal.trader.displayName}: trade skipped`,
        reason==="WAIT_PULLBACK"?"The price moved quickly after the trader bought it. MemeCloud is watching for a cleaner pullback.":base.reason,
        {signalId:signal.id,traderId:signal.traderId,walletChasePct:chase});
      skippedCount++; continue;
    }

    let amountUsd=Number(base.amountUsd);

    // Every Solana copy decision -- simulation or future LIVE -- uses the user's actual
    // requested size to obtain the authoritative executable quote. A cached market mark may help
    // liquidity/sizing checks, but it is never the final chase value.
    const executionMode=(process.env.EXECUTION_MODE??"simulation").toLowerCase();
    if(signal.chain!=="SOLANA"){
      await saveDecision({allowed:false,action:"WAIT_ROUTE",reason:"EXECUTION_ADAPTER_NOT_CONFIGURED",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd:currentPriceUsd,walletChasePct:chase,explanation:"This chain is adapter-ready but does not yet have a verified execution route in this build."});
      skippedCount++; continue;
    }
    if(!sourceExecutionPriceUsd){
      await saveDecision({allowed:false,action:"WAIT_DATA",reason:"SOURCE_EXECUTION_PRICE_MISSING",explanation:"The source wallet transaction was detected, but its genuine execution price is not available yet. MemeCloud will not invent a chase value."});
      skippedCount++; continue;
    }

    let amountRaw=String(Math.round(amountUsd*1_000_000));
    try{
      let quote=await jupiter.quote({inputMint:usdcSol,outputMint:signal.outputMint,amountRaw,slippageBps:follow.maxSlippageBps});
      const decimals=await tokenDecimals(signal.outputMint);
      let tokenAmount=Number(BigInt(quote.outAmount))/(10**decimals);
      if(!Number.isFinite(tokenAmount)||tokenAmount<=0)throw Object.assign(new Error("INVALID_EXECUTABLE_QUOTE"),{code:"INVALID_EXECUTABLE_QUOTE"});
      let executablePriceUsd=amountUsd/tokenAmount;
      let actualChase=walletChasePct(sourceExecutionPriceUsd,executablePriceUsd);
      let priceImpactPct=Math.abs(Number(quote.priceImpactPct??0));
      const hardImpactLimit=Math.max(1,Math.min(50,Number(riskCfg?.maxExecutablePriceImpactPct??35)));
      // A buy route alone is not enough. Before allowing entry, prove that the expected token
      // amount can also be routed back to USDC. This catches many unusable/one-way markets before
      // funds move. The live exits worker re-quotes again at the actual exit size/time.
      let sellRouteAvailable=false;
      let reverseImpactPct: number|undefined;
      try{
        const reverse=await jupiter.quote({inputMint:signal.outputMint,outputMint:usdcSol,amountRaw:quote.outAmount,slippageBps:follow.maxSlippageBps});
        sellRouteAvailable=Boolean(reverse.outAmount&&BigInt(reverse.outAmount)>0n);
        reverseImpactPct=Math.abs(Number(reverse.priceImpactPct??0));
      }catch{}
      if(!sellRouteAvailable){
        await saveDecision({allowed:false,action:"SKIP",reason:"NO_EXECUTABLE_SELL_ROUTE",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:"The buy quote exists, but MemeCloud could not verify an executable route back to USDC for the expected position. No trade was created."});
        skippedCount++;continue;
      }

      // Rich intelligence is mandatory for an automatic live entry. We never invent missing volume,
      // liquidity, holder, creator or social values.
      const rich=await db.memeMarketSnapshot.findFirst({where:{chain:"SOLANA",mint:signal.outputMint},orderBy:{observedAt:"desc"}});
      const richFresh=rich&&Date.now()-rich.observedAt.getTime()<=Number(riskCfg?.maxIntelligenceAgeMs??30_000);
      if(!richFresh){
        await saveDecision({allowed:false,action:"WAIT_DATA",reason:"RICH_INTELLIGENCE_UNAVAILABLE",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:"The executable quote is real, but the liquidity/flow/holder intelligence snapshot is missing or stale. MemeCloud will not invent those inputs."});
        skippedCount++;continue;
      }
      const candidate=await db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:signal.sourceWallet}}}).catch(()=>null);
      const sourceQuality=Number(candidate?.sourceQualityScore??65);
      const intelligence=evaluateEntry({
        ageMinutes:rich.ageMinutes,liquidityUsd:rich.liquidityUsd,marketCapUsd:rich.marketCapUsd??undefined,sourceMarketCapUsd:signal.sourceMarketCapUsd??undefined,
        priceFromSourcePct:actualChase,priceFromEntryPct:0,peakProfitPct:0,drawdownFromPeakPct:0,
        volume1mUsd:rich.volume1mUsd,volume5mUsd:rich.volume5mUsd,volume15mUsd:rich.volume15mUsd,
        volumeAcceleration1m:rich.volumeAcceleration1m,volumeAcceleration5m:rich.volumeAcceleration5m,
        buys1m:rich.buys1m,sells1m:rich.sells1m,buys5m:rich.buys5m,sells5m:rich.sells5m,
        buyVolume5mUsd:rich.buyVolume5mUsd,sellVolume5mUsd:rich.sellVolume5mUsd,
        uniqueBuyers1m:rich.uniqueBuyers1m,uniqueBuyers5m:rich.uniqueBuyers5m,uniqueSellers5m:rich.uniqueSellers5m,
        holderCount:rich.holderCount??undefined,holderGrowth5mPct:rich.holderGrowth5mPct??undefined,top10EffectivePct:rich.top10EffectivePct??undefined,
        bundledSupplyPct:rich.bundledSupplyPct??undefined,creatorHoldingPct:rich.creatorHoldingPct??undefined,creatorNetSell5mPct:rich.creatorNetSell5mPct??undefined,
        smartMoneyNetFlow5mUsd:rich.smartMoneyNetFlow5mUsd??undefined,mintAuthorityActive:rich.mintAuthorityActive??undefined,freezeAuthorityActive:rich.freezeAuthorityActive??undefined,
        token2022DangerousExtension:rich.dangerousExtension??undefined,sellRouteAvailable,executablePriceImpactPct:Math.max(priceImpactPct,reverseImpactPct??0),
        exitLiquidityForPositionUsd:rich.exitLiquidityUsd??undefined,liquidityChange5mPct:rich.liquidityChange5mPct??undefined,lpRiskScore:rich.lpRiskScore??undefined,
        socialMentions5m:rich.socialMentions5m??undefined,socialUniqueAuthors5m:rich.socialUniqueAuthors5m??undefined,socialVelocity:rich.socialVelocity??undefined,
        socialSentiment:rich.socialSentiment??undefined,socialSpamRatio:rich.socialSpamRatio??undefined,influencerQualityScore:rich.influencerQualityScore??undefined,narrativeScore:rich.narrativeScore??undefined,
        sourceTraderStillHolding:true,sourceTraderSoldPct:0
      },sourceQuality);
      const effectiveChase=maxChase; // 0 means no user/platform chase ceiling; strategy chase is evidence, not authority
      if(intelligence.action==="SKIP"){
        await saveDecision({allowed:false,action:"SKIP",reason:"MEME_INTELLIGENCE_REJECTED",sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,confidence:intelligence.confidence,explanation:[...intelligence.reasons,...intelligence.warnings].join(" · ")||"The current market evidence is not strong enough."});
        skippedCount++;continue;
      }
      if(intelligence.action==="WAIT_PULLBACK"){
        await saveDecision({allowed:false,action:"WAIT_PULLBACK",reason:"INTELLIGENCE_WAIT_PULLBACK",sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,confidence:intelligence.confidence,explanation:[...intelligence.reasons,...intelligence.warnings].join(" · ")});
        skippedCount++;continue;
      }

      // BUY_SMALLER is an actual execution instruction, not a cosmetic label. Re-quote the
      // reduced user size because a different size changes output, price impact and chase.
      if(intelligence.action==="BUY_SMALLER"&&intelligence.sizeMultiplier>0&&intelligence.sizeMultiplier<1){
        amountUsd=Math.max(1,Math.round(amountUsd*intelligence.sizeMultiplier*100)/100);
        amountRaw=String(Math.round(amountUsd*1_000_000));
        quote=await jupiter.quote({inputMint:usdcSol,outputMint:signal.outputMint,amountRaw,slippageBps:follow.maxSlippageBps});
        tokenAmount=Number(BigInt(quote.outAmount))/(10**decimals);
        if(!Number.isFinite(tokenAmount)||tokenAmount<=0)throw Object.assign(new Error("INVALID_REDUCED_EXECUTABLE_QUOTE"),{code:"INVALID_REDUCED_EXECUTABLE_QUOTE"});
        executablePriceUsd=amountUsd/tokenAmount;
        actualChase=walletChasePct(sourceExecutionPriceUsd,executablePriceUsd);
        priceImpactPct=Math.abs(Number(quote.priceImpactPct??0));
        try{
          const reverse=await jupiter.quote({inputMint:signal.outputMint,outputMint:usdcSol,amountRaw:quote.outAmount,slippageBps:follow.maxSlippageBps});
          sellRouteAvailable=Boolean(reverse.outAmount&&BigInt(reverse.outAmount)>0n);
          reverseImpactPct=Math.abs(Number(reverse.priceImpactPct??0));
        }catch{sellRouteAvailable=false}
        if(!sellRouteAvailable){
          await saveDecision({allowed:false,action:"SKIP",reason:"NO_EXECUTABLE_SELL_ROUTE",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,confidence:intelligence.confidence,explanation:"The reduced entry size still has no verified executable route back to USDC."});
          skippedCount++;continue;
        }
      }

      if(effectiveChase>0 && actualChase>effectiveChase){
        await saveDecision({allowed:false,action:"WAIT_PULLBACK",reason:"PRICE_MOVED_TOO_FAR",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:`Your own chase ceiling is ${effectiveChase.toFixed(1)}%; the executable quote is ${actualChase.toFixed(1)}% above the source buy.`});
        await userEvent(follow.userId,"WAIT_PULLBACK",`${signal.trader.displayName}: your chase ceiling was reached`,`The real executable quote moved ${actualChase.toFixed(1)}% from the source wallet's buy, beyond your own ${effectiveChase.toFixed(1)}% setting.`,{signalId:signal.id,walletChasePct:actualChase,amountUsd});
        skippedCount++; continue;
      }
      if(Number.isFinite(priceImpactPct)&&priceImpactPct>hardImpactLimit){
        await saveDecision({allowed:false,action:"SKIP",reason:"EXECUTION_PRICE_IMPACT_TOO_HIGH",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:`The real executable quote has ${priceImpactPct.toFixed(2)}% price impact, above the platform hard limit of ${hardImpactLimit.toFixed(2)}%.`});
        await userEvent(follow.userId,"TRADE_SKIPPED",`${signal.trader.displayName}: execution quality too poor`,`The route's real price impact was ${priceImpactPct.toFixed(2)}%, so MemeCloud did not create a fill.`,{signalId:signal.id,priceImpactPct});
        skippedCount++; continue;
      }

      const decision=await saveDecision({
        allowed:true,action:"BUY",amountUsd,reason:null,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,
        confidence:intelligence.confidence,
        explanation:`Eligible copy from ${signal.trader.displayName}. Intelligence ${intelligence.confidence}/100; actual-size wallet chase ${actualChase.toFixed(1)}%; executable price impact ${priceImpactPct.toFixed(2)}%. ${intelligence.reasons.join(" · ")}`
      });

      if(executionMode==="live"){
        // The real, owner-controlled gate — read fresh from the database on every decision, so
        // the Admin toggle takes effect immediately with no env file edit or service restart.
        if(!(await isLiveTradingEnabled())){
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"SKIP",reason:"LIVE_EXECUTION_NOT_ENABLED",explanation:"Live execution is intentionally disabled. The executable quote was verified, but no funds were moved."}});
          skippedCount++; continue;
        }
        const permitted=await db.wallet.findFirst({where:{userId:follow.userId,chain:signal.chain,tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}});
        if(!permitted){
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"SKIP",reason:"TRADING_PERMISSION_REQUIRED",explanation:"This account has no active delegated trading permission for this chain."}});
          skippedCount++; continue;
        }
        if(!privy){
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"WAIT_SIGNER",reason:"SIGNER_PROVIDER_REQUIRED",explanation:"The trade passed intelligence, but Privy delegated signing is not configured. No funds were moved."}});
          skippedCount++;continue;
        }
        const orderKey=decisionKey(signal.id,follow.userId);
        let order=await db.order.findUnique({where:{idempotencyKey:orderKey}});
        if(order){
          if(order.status==="CONFIRMED")continue;
          const attempt=await db.liveExecutionAttempt.findFirst({where:{orderId:order.id,purpose:"BUY"},orderBy:{createdAt:"desc"}});
          if(!attempt)throw Object.assign(new Error("LIVE_BUY_ATTEMPT_MISSING"),{code:"LIVE_BUY_ATTEMPT_MISSING"});
          const ref=attempt.idempotencyKey.slice(0,64);
          const hash=attempt.txHash||order.txHash||await recoverPrivyHash(ref);
          if(hash){
            await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:hash,submittedAt:order.submittedAt??new Date()}});
            await db.liveExecutionAttempt.update({where:{id:attempt.id},data:{status:"SUBMITTED",txHash:hash}});
            await finalizeLiveBuy(order,attempt.idempotencyKey,hash,permitted,signal,follow,decimals);
            allowedCount++;continue;
          }
          // A SIGNING request without a recoverable provider transaction is ambiguous. Never
          // re-submit automatically; that could duplicate a real buy after a network/process crash.
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"WAIT_RECONCILIATION",reason:"AMBIGUOUS_PRIOR_BUY_ATTEMPT",explanation:"A previous live buy attempt has no locally stored hash and cannot yet be reconciled through the provider reference ID. MemeCloud will not submit a duplicate."}});
          skippedCount++;continue;
        }
        const built=await jupiter.buildSwap(quote,permitted.address);
        order=await db.order.create({data:{idempotencyKey:orderKey,decisionId:decision.id,userId:follow.userId,chain:"SOLANA",mode:"LIVE",side:"BUY",inputMint:usdcSol,outputMint:signal.outputMint,requestedInputRaw:amountRaw,expectedOutputRaw:quote.outAmount,minOutputRaw:quote.otherAmountThreshold,status:"SIGNING",venue:"JUPITER",quoteJson:{quote:quote.raw,intelligence:{confidence:intelligence.confidence,reasons:intelligence.reasons,warnings:intelligence.warnings}} as any}});
        const attemptKey=crypto.createHash("sha256").update(`BUY:${order.id}`).digest("hex");
        await db.liveExecutionAttempt.create({data:{idempotencyKey:attemptKey,userId:follow.userId,orderId:order.id,purpose:"BUY",chain:"SOLANA",walletAddress:permitted.address,provider:"PRIVY",providerRef:permitted.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
        try{
          const sent=await privy.signAndSend(permitted.permissionRef!,built,attemptKey.slice(0,64));
          await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:sent.hash,submittedAt:new Date()}});
          await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:sent.hash}});
          await finalizeLiveBuy(order,attemptKey,sent.hash,permitted,signal,follow,decimals);
          allowedCount++;continue;
        }catch(e:any){
          // Recover a transaction that Privy accepted even if the HTTP response/process died before
          // the hash reached MongoDB. reference_id is the durable reconciliation bridge.
          const recovered=await recoverPrivyHash(attemptKey.slice(0,64));
          if(recovered){
            await db.order.update({where:{id:order.id},data:{status:"SUBMITTED",txHash:recovered,submittedAt:new Date()}}).catch(()=>{});
            await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"SUBMITTED",txHash:recovered}}).catch(()=>{});
            await finalizeLiveBuy(order,attemptKey,recovered,permitted,signal,follow,decimals);
            allowedCount++;continue;
          }
          await db.order.update({where:{id:order.id},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT")}}).catch(()=>{});
          await db.liveExecutionAttempt.update({where:{idempotencyKey:attemptKey},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
          await db.riskIncident.create({data:{severity:"CRITICAL",scope:"LIVE_EXECUTION",userId:follow.userId,chain:"SOLANA",mint:signal.outputMint,code:String(e?.code??"AMBIGUOUS_LIVE_BUY_ATTEMPT"),detail:{orderId:order.id,message:String(e?.message??e),referenceId:attemptKey.slice(0,64)}}}).catch(()=>{});
          throw e;
        }
      }

      const orderKey=decisionKey(signal.id,follow.userId);
      const [order]=await db.$transaction([
        db.order.create({
          data:{
            idempotencyKey:orderKey,decisionId:decision.id,userId:follow.userId,chain:signal.chain,mode:"SIMULATION",side:"BUY",
            inputMint:usdcSol,outputMint:signal.outputMint,requestedInputRaw:amountRaw,expectedOutputRaw:quote.outAmount,
            minOutputRaw:quote.otherAmountThreshold,status:"CONFIRMED",confirmedAt:new Date(),venue:"JUPITER_QUOTE",
            quoteJson:{simulation:true,realQuote:true,priceImpactPct:quote.priceImpactPct,quote:quote.raw} as any
          }
        }),
        db.position.create({
          data:{
            userId:follow.userId,sourceTraderId:signal.traderId,chain:signal.chain,mode:"SIMULATION",mint:signal.outputMint,quoteMint:usdcSol,
            entryInputRaw:amountRaw,entryTokenRaw:quote.outAmount,remainingTokenRaw:quote.outAmount,costUsd:amountUsd,
            avgEntryPriceUsd:executablePriceUsd,currentPriceUsd:executablePriceUsd,peakPriceUsd:executablePriceUsd,takeProfitPct:follow.takeProfitPct,stopLossPct:follow.stopLossPct,
            status:"OPEN",lastMarkedAt:new Date()
          }
        })
      ]);
      await userEvent(follow.userId,"TRADE_COPIED",`${signal.trader.displayName} copied in simulation`,
        `$${amountUsd.toFixed(2)} simulation order created from a real executable quote. Wallet chase ${actualChase.toFixed(1)}%. No live funds moved.`,
        {signalId:signal.id,orderId:order.id,walletChasePct:actualChase,priceImpactPct,mode:"SIMULATION"});
      allowedCount++;
    }catch(e:any){
      // If a duplicate order was committed by another retry/worker, business state already exists.
      const orderKey=decisionKey(signal.id,follow.userId);
      const committed=await db.order.findUnique({where:{idempotencyKey:orderKey},select:{id:true}}).catch(()=>null);
      if(committed)continue;
      await saveDecision({allowed:false,action:"WAIT_ROUTE",reason:e?.code==="SOLANA_RPC_REQUIRED"?"MARKET_DATA_INCOMPLETE":"QUOTE_UNAVAILABLE",amountUsd,explanation:"A genuine executable quote and token precision could not be verified, so MemeCloud did not fabricate a fill."});
      await userEvent(follow.userId,"TRADE_SKIPPED",`${signal.trader.displayName}: no reliable quote`,
        "A genuine executable quote could not be fully verified, so no simulation or live fill was invented.",{signalId:signal.id});
      skippedCount++;
    }

  }
  await db.signal.update({where:{id:signal.id},data:{status:"COMPLETED"}}).catch(()=>{});
},{connection,concurrency:20});

worker.on("failed",(job,err)=>{errors++;console.error("[executor] failed",job?.id,err)});
startHeartbeat("executor",()=>({processed,allowed:allowedCount,skipped:skippedCount,errors,concurrency:20}));
console.log("[executor] running");
