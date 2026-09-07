import path from "node:path";
import { Router } from "express";
import { db } from "@memecloud/db";
import { auth, type AuthedRequest } from "./middleware.js";
import { asyncRoute } from "./auth.js";
import { summariseSession, SESSION_IDLE_MS } from "@memecloud/shared";

export const curatedRoutes = Router();

const LIVE_LOOKBACK_MS=2*60*60_000;

type Perf={pnlUsd:number|null;returnPct:number|null;wins:number;closed:number;trades:number};
function performance(rows:any[],since:Date):Perf{
  const events=rows.filter(r=>new Date(r.observedAt)>=since).sort((a,b)=>new Date(a.observedAt).getTime()-new Date(b.observedAt).getTime());
  const lots=new Map<string,{qty:number,cost:number}[]>();
  let pnl=0,costClosed=0,wins=0,closed=0,known=0;
  for(const e of events){
    const qty=Number(e.amountRaw)/10**Number(e.decimals||0); if(!Number.isFinite(qty)||qty<=0)continue;
    if(e.action==="BUY"){
      if(e.amountUsd==null)continue;
      const arr=lots.get(e.mint)||[];arr.push({qty,cost:Number(e.amountUsd)});lots.set(e.mint,arr);known++;
    } else if(e.action==="SELL"&&e.amountUsd!=null){
      const arr=lots.get(e.mint)||[]; let remaining=qty, matchedCost=0,matchedQty=0;
      while(remaining>0&&arr.length){const lot=arr[0];const q=Math.min(remaining,lot.qty);const part=lot.cost*(q/lot.qty);matchedCost+=part;matchedQty+=q;lot.cost-=part;lot.qty-=q;remaining-=q;if(lot.qty<=1e-12)arr.shift();}
      lots.set(e.mint,arr);
      if(matchedQty>0){const proceeds=Number(e.amountUsd)*(matchedQty/qty),tradePnl=proceeds-matchedCost;pnl+=tradePnl;costClosed+=matchedCost;closed++;if(tradePnl>0)wins++;known++;}
    }
  }
  return {pnlUsd:known&&costClosed>0?pnl:null,returnPct:costClosed>0?pnl/costClosed*100:null,wins,closed,trades:events.filter(e=>e.action==="BUY"||e.action==="SELL").length};
}

async function curatedTraderRows(userId?:string){
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},
    include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"asc"}]
  });
  const ids=traders.map(t=>t.id), since90=new Date(Date.now()-90*86400_000);
  const [activity,follows]=await Promise.all([
    ids.length?db.walletActivity.findMany({where:{chain:"SOLANA",traderId:{in:ids},action:{in:["BUY","SELL"]},public:true,swapVerified:true,observedAt:{gte:since90}},orderBy:{observedAt:"asc"},take:20000}):[],
    userId&&ids.length?db.userFollow.findMany({where:{userId,traderId:{in:ids}}}):Promise.resolve([] as any[])
  ]);
  const byTrader=new Map<string,any[]>();for(const r of activity){const a=byTrader.get(r.traderId)||[];a.push(r);byTrader.set(r.traderId,a)}
  const followMap=new Map((follows as any[]).map(f=>[f.traderId,f]));
  return traders.map(t=>{
    const rows=byTrader.get(t.id)||[], latest=[...rows].reverse().find(r=>r.action==="BUY")||null;
    return {id:t.id,displayName:t.displayName,handle:t.handle,avatarUrl:t.avatarUrl,category:t.category,featured:t.featured,recommended:t.recommended,
      wallets:t.wallets.map(w=>({id:w.id,chain:w.chain,address:w.address,verified:w.verified})),followers:t._count.follows,signals:t._count.signals,
      performance:{d7:performance(rows,new Date(Date.now()-7*86400_000)),d30:performance(rows,new Date(Date.now()-30*86400_000)),d90:performance(rows,since90)},
      latestBuy:latest?{mint:latest.mint,marketCapUsd:latest.marketCapUsd,amountUsd:latest.amountUsd,observedAt:latest.observedAt,sourceTx:latest.sourceTx}:null,
      follow:followMap.get(t.id)||null};
  });
}

async function curatedFlowRows(){
  // This lookback exists only to reconstruct a currently-open activity session. The response is
  // filtered to SESSION_IDLE_MS below, so old wallet inventory/replay can never become "LIVE".
  const since=new Date(Date.now()-LIVE_LOOKBACK_MS);
  const rows=await db.walletActivity.findMany({where:{chain:"SOLANA",public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:since}},orderBy:{observedAt:"desc"},take:1500});
  const traderIds=[...new Set(rows.map(r=>r.traderId))],mints=[...new Set(rows.map(r=>r.mint))];
  const [traders,tokens]=await Promise.all([
    traderIds.length?db.trader.findMany({where:{id:{in:traderIds},kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA",monitoringStatus:"ACTIVE"}}},select:{id:true,displayName:true,handle:true,avatarUrl:true}}):[],
    mints.length?db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,liquidityUsd:true,metadata:true}}):[]
  ]);
  const tm=new Map(traders.map(t=>[t.id,t])),mm=new Map(tokens.map(t=>[t.mint,t]));
  const visible=rows.filter(r=>tm.has(r.traderId));

  const streams=new Map<string,any[]>();
  for(const r of [...visible].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime())){
    const k=`${r.walletAddress}:${r.mint}`;const arr=streams.get(k)||[];arr.push(r);streams.set(k,arr);
  }
  const cards:any[]=[];
  for(const [key,stream] of streams){
    let current:any[]=[];
    const flush=()=>{if(current.length)cards.push({key,rows:current});current=[];};
    for(const r of stream){
      const prev=current[current.length-1];
      if(prev&&r.observedAt.getTime()-prev.observedAt.getTime()>=SESSION_IDLE_MS)flush();
      current.push(r);
      if(r.action==="SELL"&&r.balanceAfterRaw==="0")flush();
    }
    flush();
  }

  return cards.map(({key,rows:group})=>{
    const s=summariseSession(group.map((r:any)=>({action:r.action,state:r.state,quoteAmount:r.quoteAmount??r.amountUsd,quoteSymbol:r.quoteSymbol,amountUsd:r.amountUsd,amountRaw:r.amountRaw,decimals:r.decimals,marketCapUsd:r.marketCapUsd,observedAt:r.observedAt,balanceBeforeRaw:r.balanceBeforeRaw,balanceAfterRaw:r.balanceAfterRaw})));
    const head=group[group.length-1],first=group[0],token=mm.get(head.mint)||null;
    const lastBuy=[...group].reverse().find((r:any)=>r.action==="BUY")??null;
    return {
      id:`${key}:${first.id}`,sessionKey:key,action:head.action,state:head.state,behaviour:s.behaviour,isLive:s.isLive,
      trader:tm.get(head.traderId),walletAddress:head.walletAddress,mint:head.mint,token,
      marketCapAtBuy:s.initialMarketCapUsd,currentMarketCapUsd:token?.marketCapUsd??s.latestMarketCapUsd??null,
      amountUsd:head.amountUsd,quoteAmount:head.quoteAmount,quoteSymbol:head.quoteSymbol,quoteMint:head.quoteMint,
      latestBuyAt:lastBuy?.observedAt??s.firstBuyAt,latestBuyAmountUsd:lastBuy?.amountUsd??null,
      latestBuyQuoteAmount:lastBuy?.quoteAmount??null,latestBuyQuoteSymbol:lastBuy?.quoteSymbol??null,latestBuyQuoteMint:lastBuy?.quoteMint??null,
      netUsdFlow:s.netUsdFlow,grossBoughtUsd:s.grossBoughtUsd,grossSoldUsd:s.grossSoldUsd,
      grossQuoteBought:s.grossQuoteBought,grossQuoteSold:s.grossQuoteSold,netQuoteFlow:s.netQuoteFlow,sessionQuoteSymbol:s.quoteSymbol,
      swaps:s.tradeCount,buyCount:s.buyCount,sellCount:s.sellCount,remainingPositionPct:s.remainingPositionPct,
      spanMs:s.spanMs,firstBuyAt:s.firstBuyAt,observedAt:head.observedAt,sourceTx:head.sourceTx
    };
  }).filter(e=>e.isLive&&Number(e.buyCount)>0&&e.state!=="EXITED")
    .sort((a,b)=>new Date(b.observedAt).getTime()-new Date(a.observedAt).getTime()).slice(0,250);
}

function releaseId(){
  return process.env.MEMECLOUD_RELEASE_SHA||process.env.RELEASE_SHA||path.basename(process.cwd());
}

// Canonical snapshot used by Home, Hunt and Traders. A single request means these screens cannot
// disagree because three different API calls landed during a rolling deploy or between two swaps.
curatedRoutes.get("/v1/curated/live",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  const [events,traders]=await Promise.all([curatedFlowRows(),curatedTraderRows(req.user.sub)]);
  res.setHeader("cache-control","no-store");
  res.json({
    events,traders,trackedTraderCount:traders.length,generatedAt:new Date().toISOString(),sessionIdleMs:SESSION_IDLE_MS,
    sourcePolicy:"REAL_SWAP_ADMIN_WALLETS_ONLY",aggregation:"WALLET_MINT_SESSION",release:releaseId()
  });
}));

// Compatibility endpoints share the exact same implementation as /live.
curatedRoutes.get("/v1/curated/traders",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  res.setHeader("cache-control","no-store");
  res.json({traders:await curatedTraderRows(req.user.sub),sourcePolicy:"ADMIN_VERIFIED_WALLETS_ONLY",release:releaseId()});
}));
curatedRoutes.get("/v1/curated/flow",auth,asyncRoute(async(_req:AuthedRequest,res)=>{
  res.setHeader("cache-control","no-store");
  res.json({events:await curatedFlowRows(),sourcePolicy:"REAL_SWAP_ADMIN_WALLETS_ONLY",aggregation:"WALLET_MINT_SESSION",sessionIdleMs:SESSION_IDLE_MS,release:releaseId()});
}));
