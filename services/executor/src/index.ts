import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "@fomocloud/db";
import { decideCopy, walletChasePct } from "@fomocloud/shared";
import { JupiterExecution } from "@fomocloud/execution";
import { startHeartbeat } from "@fomocloud/ops";
import { getConfig } from "@fomocloud/config";

const connection=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const notificationQueue=new Queue("user-notifications",{connection});
const execCfg=await getConfig<any>("execution");
const marketCfg=await getConfig<any>("marketData");
const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
const solanaRpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
const solanaConnection=solanaRpc?new Connection(solanaRpc,"confirmed"):null;
const decimalsCache=new Map<string,{decimals:number,at:number}>();
const usdcSol=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let processed=0,allowedCount=0,skippedCount=0,errors=0;


async function tokenDecimals(mint:string){
  const cached=decimalsCache.get(mint);
  if(cached&&Date.now()-cached.at<60*60_000)return cached.decimals;
  if(!solanaConnection)throw Object.assign(new Error("SOLANA_RPC_REQUIRED"),{code:"SOLANA_RPC_REQUIRED"});
  const supply=await solanaConnection.getTokenSupply(new PublicKey(mint),"confirmed");
  const decimals=supply.value.decimals;decimalsCache.set(mint,{decimals,at:Date.now()});return decimals;
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
      await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_SOURCE_EXIT_CONTEXT",reason:"SOURCE_SELL_PERCENT_UNKNOWN",explanation:"The trader sold, but FomoCloud could not verify what percentage of the source position was sold. It will not invent an exit size."}});
      await userEvent(userId,"SOURCE_SELL",`${signal.trader.displayName} sold`,"The source sale was detected, but the sold percentage could not be verified, so no automatic mirror exit was invented.",{signalId:signal.id});
      continue;
    }
    if(mode==="LIVE"){
      await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_SIGNER",reason:"SIGNER_PROVIDER_REQUIRED",explanation:`Source trader sold ${soldPct.toFixed(1)}%. Live mirror exits remain disabled until the reviewed delegated signer is connected.`}});
      await userEvent(userId,"SOURCE_SELL",`${signal.trader.displayName} sold ${soldPct.toFixed(1)}%`,`A live source exit was detected. Your position remains protected by fail-closed mode until the delegated signer is configured.`,{signalId:signal.id,sourceSoldPct:soldPct});
      continue;
    }
    const market=await db.marketPrice.findFirst({where:{chain:signal.chain,mint:signal.inputMint},orderBy:{observedAt:"desc"}});
    if(!market || Date.now()-market.observedAt.getTime()>60_000){
      await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:false,action:"WAIT_MARKET_DATA",reason:"SOURCE_EXIT_PRICE_UNAVAILABLE",explanation:"The source sell was detected, but a fresh genuine market price is unavailable."}});
      continue;
    }
    const fraction=Math.min(1,soldPct/100);
    const decision=await db.copyDecision.create({data:{signalId:signal.id,userId,allowed:true,action:"SOURCE_SELL_MIRROR",sourcePriceUsd:signal.sourcePriceUsd,executablePriceUsd:market.priceUsd,explanation:`Source trader sold ${soldPct.toFixed(1)}%; simulation mirrors that verified fraction using the latest genuine price mark.`}});
    let totalPnl=0,totalProceeds=0,closed=0,partial=0;
    for(const p of userPositions){
      if(!p.avgEntryPriceUsd||p.avgEntryPriceUsd<=0) continue;
      const remaining=BigInt(p.remainingTokenRaw), original=BigInt(p.entryTokenRaw);
      if(remaining<=0n||original<=0n) continue;
      let rawToExit=(remaining*BigInt(Math.round(fraction*1_000_000)))/1_000_000n;
      if(rawToExit<=0n&&fraction>0) rawToExit=1n;
      if(rawToExit>remaining) rawToExit=remaining;
      const remainingFraction=Number(remaining*1_000_000n/original)/1_000_000;
      const exitFractionOfRemaining=Number(rawToExit*1_000_000n/remaining)/1_000_000;
      const remainingCostBasis=p.costUsd*remainingFraction;
      const exitCostBasis=remainingCostBasis*exitFractionOfRemaining;
      const remainingMarketValue=p.costUsd*(market.priceUsd/p.avgEntryPriceUsd)*remainingFraction;
      const proceeds=remainingMarketValue*exitFractionOfRemaining;
      const pnl=proceeds-exitCostBasis;
      const nextRaw=remaining-rawToExit;
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
  const globalChaseCap=Math.max(0,Math.min(55,Number(riskCfg?.hyperMaxChasePct??55)));

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
    if(open.length>=global.maxConcurrentPositions){
      await saveDecision({allowed:false,action:"SKIP",reason:"MAX_CONCURRENT_POSITIONS",explanation:"Your open-position limit is currently reached."});
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
    const maxChase=Math.min(follow.maxChasePct,globalChaseCap);
    const base=decideCopy({
      settings:{
        enabled:true,sizingMode:"FIXED",
        fixedAmountUsd:Math.min(follow.fixedAmountUsd,global.maxAmountPerTradeUsd),
        percentBalance:2,takeProfitPct:follow.takeProfitPct,stopLossPct:follow.stopLossPct,
        maxChasePct:maxChase,maxSlippageBps:follow.maxSlippageBps,maxPositionUsd:follow.maxPositionUsd,
        maxTotalExposureUsd:Math.min(follow.maxTotalExposureUsd,global.maxTotalExposureUsd),
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
        reason==="WAIT_PULLBACK"?"The price moved quickly after the trader bought it. FomoCloud is watching for a cleaner pullback.":base.reason,
        {signalId:signal.id,traderId:signal.traderId,walletChasePct:chase});
      skippedCount++; continue;
    }

    const amountUsd=Number(base.amountUsd);

    // Every Solana copy decision -- simulation or future LIVE -- uses the user's actual
    // requested size to obtain the authoritative executable quote. A cached market mark may help
    // liquidity/sizing checks, but it is never the final chase value.
    const executionMode=(process.env.EXECUTION_MODE??"simulation").toLowerCase();
    if(signal.chain!=="SOLANA"){
      await saveDecision({allowed:false,action:"WAIT_ROUTE",reason:"EXECUTION_ADAPTER_NOT_CONFIGURED",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd:currentPriceUsd,walletChasePct:chase,explanation:"This chain is adapter-ready but does not yet have a verified execution route in this build."});
      skippedCount++; continue;
    }
    if(!sourceExecutionPriceUsd){
      await saveDecision({allowed:false,action:"WAIT_DATA",reason:"SOURCE_EXECUTION_PRICE_MISSING",explanation:"The source wallet transaction was detected, but its genuine execution price is not available yet. FomoCloud will not invent a chase value."});
      skippedCount++; continue;
    }

    const amountRaw=String(Math.round(amountUsd*1_000_000));
    try{
      const quote=await jupiter.quote({inputMint:usdcSol,outputMint:signal.outputMint,amountRaw,slippageBps:follow.maxSlippageBps});
      const decimals=await tokenDecimals(signal.outputMint);
      const tokenAmount=Number(BigInt(quote.outAmount))/(10**decimals);
      if(!Number.isFinite(tokenAmount)||tokenAmount<=0)throw Object.assign(new Error("INVALID_EXECUTABLE_QUOTE"),{code:"INVALID_EXECUTABLE_QUOTE"});
      const executablePriceUsd=amountUsd/tokenAmount;
      const actualChase=walletChasePct(sourceExecutionPriceUsd,executablePriceUsd);
      const priceImpactPct=Math.abs(Number(quote.priceImpactPct??0));
      const hardImpactLimit=Math.max(1,Math.min(50,Number(riskCfg?.maxExecutablePriceImpactPct??35)));

      if(actualChase>maxChase){
        await saveDecision({allowed:false,action:"WAIT_PULLBACK",reason:"PRICE_MOVED_TOO_FAR",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:`Your real $${amountUsd.toFixed(2)} executable quote is ${actualChase.toFixed(1)}% above the followed wallet's buy. The token's 24h move is irrelevant; FomoCloud is waiting for a cleaner entry.`});
        await userEvent(follow.userId,"WAIT_PULLBACK",`${signal.trader.displayName}: waiting for a better entry`,`Your actual-size executable quote moved ${actualChase.toFixed(1)}% from the source wallet's buy, beyond your ${maxChase.toFixed(1)}% chase window.`,{signalId:signal.id,walletChasePct:actualChase,amountUsd});
        skippedCount++; continue;
      }
      if(Number.isFinite(priceImpactPct)&&priceImpactPct>hardImpactLimit){
        await saveDecision({allowed:false,action:"SKIP",reason:"EXECUTION_PRICE_IMPACT_TOO_HIGH",amountUsd,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,explanation:`The real executable quote has ${priceImpactPct.toFixed(2)}% price impact, above the platform hard limit of ${hardImpactLimit.toFixed(2)}%.`});
        await userEvent(follow.userId,"TRADE_SKIPPED",`${signal.trader.displayName}: execution quality too poor`,`The route's real price impact was ${priceImpactPct.toFixed(2)}%, so FomoCloud did not create a fill.`,{signalId:signal.id,priceImpactPct});
        skippedCount++; continue;
      }

      const decision=await saveDecision({
        allowed:true,action:"BUY",amountUsd,reason:null,sourcePriceUsd:sourceExecutionPriceUsd,executablePriceUsd,walletChasePct:actualChase,
        explanation:`Eligible copy from ${signal.trader.displayName}. Actual-size wallet chase ${actualChase.toFixed(1)}%; executable price impact ${priceImpactPct.toFixed(2)}%.`
      });

      if(executionMode==="live"){
        if(process.env.LIVE_EXECUTION_ENABLED!=="true"){
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"SKIP",reason:"LIVE_EXECUTION_NOT_ENABLED",explanation:"Live execution is intentionally disabled. The executable quote was verified, but no funds were moved."}});
          skippedCount++; continue;
        }
        const permitted=await db.wallet.findFirst({where:{userId:follow.userId,chain:signal.chain,tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:null},{permissionExpiry:{gt:new Date()}}]}});
        if(!permitted){
          await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"SKIP",reason:"TRADING_PERMISSION_REQUIRED",explanation:"This account has no active delegated trading permission for this chain."}});
          skippedCount++; continue;
        }
        // Deliberate fail-closed boundary. There is no seed/private-key fallback. A reviewed
        // SignerProvider must submit the exact allowed swap and confirm it on-chain before a LIVE
        // Order/Position may be created.
        await db.copyDecision.update({where:{id:decision.id},data:{allowed:false,action:"WAIT_SIGNER",reason:"SIGNER_PROVIDER_REQUIRED",explanation:"The executable route and wallet chase passed, but the reviewed server-side delegated signer adapter is not configured in this build."}});
        skippedCount++; continue;
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
      await saveDecision({allowed:false,action:"WAIT_ROUTE",reason:e?.code==="SOLANA_RPC_REQUIRED"?"MARKET_DATA_INCOMPLETE":"QUOTE_UNAVAILABLE",amountUsd,explanation:"A genuine executable quote and token precision could not be verified, so FomoCloud did not fabricate a fill."});
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
