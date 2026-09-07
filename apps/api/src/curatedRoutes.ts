import path from "node:path";
import { Router } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "@memecloud/db";
import { getConfig } from "@memecloud/config";
import { solanaRpcCandidates, pickHealthyRpc, summariseSession, SESSION_IDLE_MS } from "@memecloud/shared";
import { auth, type AuthedRequest } from "./middleware.js";
import { asyncRoute, routeParam } from "./auth.js";

export const curatedRoutes = Router();

const LIVE_LOOKBACK_MS=2*60*60_000;
const DAY_MS=24*60*60_000;
const PROFILE_STATS_MAX=50_000;
const HISTORY_MAX=10_000;
const TOKEN_PROGRAM=new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM=new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const holdingsCache=new Map<string,{at:number,value:any}>();

export function tokenQty(row:any){
  const raw=Number(row.amountRaw??NaN),decimals=Number(row.decimals??0);
  if(!Number.isFinite(raw)||!Number.isFinite(decimals))return null;
  const q=raw/10**decimals;
  return Number.isFinite(q)&&q>=0?q:null;
}
export function execPrice(row:any){
  const q=tokenQty(row),usd=row.amountUsd==null?null:Number(row.amountUsd);
  return q&&q>0&&usd!=null&&Number.isFinite(usd)?usd/q:null;
}
export function adminWalletFields(){
  return {source:"ADMIN",verified:true,chain:"SOLANA" as const,monitoringStatus:"ACTIVE"};
}
export function activeAdminWalletPredicate(){
  return {...adminWalletFields(),trader:{kind:"PLATFORM" as const,enabled:true}};
}

type Perf={pnlUsd:number|null;returnPct:number|null;wins:number;closed:number;trades:number};
export function performance(rows:any[],since:Date):Perf{
  const events=rows.filter(r=>new Date(r.observedAt)>=since).sort((a,b)=>new Date(a.observedAt).getTime()-new Date(b.observedAt).getTime());
  const lots=new Map<string,{qty:number,cost:number}[]>();
  let pnl=0,costClosed=0,wins=0,closed=0,known=0;
  for(const e of events){
    const qty=tokenQty(e); if(qty==null||qty<=0)continue;
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

async function activeAdminWallets(traderId?:string){
  return db.traderWallet.findMany({
    where:{...activeAdminWalletPredicate(),...(traderId?{traderId}:{})},
    select:{id:true,traderId:true,address:true,createdAt:true,verifiedAt:true,trader:{select:{id:true,displayName:true,handle:true,avatarUrl:true,category:true,featured:true,recommended:true}}}
  });
}

async function curatedTraderRows(userId?:string){
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM",enabled:true,wallets:{some:adminWalletFields()}},
    include:{wallets:{where:adminWalletFields()},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"asc"}]
  });
  const ids=traders.map(t=>t.id), since90=new Date(Date.now()-90*DAY_MS),since24=new Date(Date.now()-DAY_MS);
  const [activity,follows]=await Promise.all([
    ids.length?db.walletActivity.findMany({where:{chain:"SOLANA",traderId:{in:ids},action:{in:["BUY","SELL"]},public:true,swapVerified:true,observedAt:{gte:since90}},orderBy:{observedAt:"asc"},take:20_000}):[],
    userId&&ids.length?db.userFollow.findMany({where:{userId,traderId:{in:ids}}}):Promise.resolve([] as any[])
  ]);
  const byTrader=new Map<string,any[]>();for(const r of activity){const a=byTrader.get(r.traderId)||[];a.push(r);byTrader.set(r.traderId,a)}
  const followMap=new Map((follows as any[]).map(f=>[f.traderId,f]));
  return traders.map(t=>{
    const rows=byTrader.get(t.id)||[], latest=[...rows].reverse().find(r=>r.action==="BUY")||null;
    return {id:t.id,displayName:t.displayName,handle:t.handle,avatarUrl:t.avatarUrl,category:t.category,featured:t.featured,recommended:t.recommended,
      wallets:t.wallets.map(w=>({id:w.id,chain:w.chain,address:w.address,verified:w.verified,trackedSince:w.verifiedAt??w.createdAt})),followers:t._count.follows,signals:t._count.signals,
      performance:{d7:performance(rows,new Date(Date.now()-7*DAY_MS)),d30:performance(rows,new Date(Date.now()-30*DAY_MS)),d90:performance(rows,since90)},
      trades24h:rows.filter(r=>r.observedAt>=since24).length,
      latestBuy:latest?{mint:latest.mint,marketCapUsd:latest.marketCapUsd,amountUsd:latest.amountUsd,observedAt:latest.observedAt,sourceTx:latest.sourceTx}:null,
      follow:followMap.get(t.id)||null};
  });
}

async function curatedFlowRows(){
  const since=new Date(Date.now()-LIVE_LOOKBACK_MS);
  const rows=await db.walletActivity.findMany({where:{chain:"SOLANA",public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:since}},orderBy:{observedAt:"desc"},take:1500});
  const traderIds=[...new Set(rows.map(r=>r.traderId))],mints=[...new Set(rows.map(r=>r.mint))];
  const [traders,tokens]=await Promise.all([
    traderIds.length?db.trader.findMany({where:{id:{in:traderIds},kind:"PLATFORM",enabled:true,wallets:{some:adminWalletFields()}},select:{id:true,displayName:true,handle:true,avatarUrl:true}}):[],
    mints.length?db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,liquidityUsd:true,metadata:true}}):[]
  ]);
  const tm=new Map(traders.map(t=>[t.id,t])),mm=new Map(tokens.map(t=>[t.mint,t]));
  const visible=rows.filter(r=>tm.has(r.traderId));
  const streams=new Map<string,any[]>();
  for(const r of [...visible].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime())){const k=`${r.walletAddress}:${r.mint}`;const arr=streams.get(k)||[];arr.push(r);streams.set(k,arr);}
  const cards:any[]=[];
  for(const [key,stream] of streams){let current:any[]=[];const flush=()=>{if(current.length)cards.push({key,rows:current});current=[];};for(const r of stream){const prev=current[current.length-1];if(prev&&r.observedAt.getTime()-prev.observedAt.getTime()>=SESSION_IDLE_MS)flush();current.push(r);if(r.action==="SELL"&&r.balanceAfterRaw==="0")flush();}flush();}
  return cards.map(({key,rows:group})=>{
    const s=summariseSession(group.map((r:any)=>({action:r.action,state:r.state,quoteAmount:r.quoteAmount??r.amountUsd,quoteSymbol:r.quoteSymbol,amountUsd:r.amountUsd,amountRaw:r.amountRaw,decimals:r.decimals,marketCapUsd:r.marketCapUsd,observedAt:r.observedAt,balanceBeforeRaw:r.balanceBeforeRaw,balanceAfterRaw:r.balanceAfterRaw})));
    const head=group[group.length-1],first=group[0],token=mm.get(head.mint)||null,lastBuy=[...group].reverse().find((r:any)=>r.action==="BUY")??null;
    return {id:`${key}:${first.id}`,sessionKey:key,action:head.action,state:head.state,behaviour:s.behaviour,isLive:s.isLive,trader:tm.get(head.traderId),walletAddress:head.walletAddress,mint:head.mint,token,
      marketCapAtBuy:s.initialMarketCapUsd,currentMarketCapUsd:token?.marketCapUsd??s.latestMarketCapUsd??null,amountUsd:head.amountUsd,quoteAmount:head.quoteAmount,quoteSymbol:head.quoteSymbol,quoteMint:head.quoteMint,
      latestBuyAt:lastBuy?.observedAt??s.firstBuyAt,latestBuyAmountUsd:lastBuy?.amountUsd??null,latestBuyQuoteAmount:lastBuy?.quoteAmount??null,latestBuyQuoteSymbol:lastBuy?.quoteSymbol??null,latestBuyQuoteMint:lastBuy?.quoteMint??null,
      netUsdFlow:s.netUsdFlow,grossBoughtUsd:s.grossBoughtUsd,grossSoldUsd:s.grossSoldUsd,grossQuoteBought:s.grossQuoteBought,grossQuoteSold:s.grossQuoteSold,netQuoteFlow:s.netQuoteFlow,sessionQuoteSymbol:s.quoteSymbol,
      swaps:s.tradeCount,buyCount:s.buyCount,sellCount:s.sellCount,remainingPositionPct:s.remainingPositionPct,spanMs:s.spanMs,firstBuyAt:s.firstBuyAt,observedAt:head.observedAt,sourceTx:head.sourceTx};
  }).filter(e=>e.isLive&&Number(e.buyCount)>0&&e.state!=="EXITED").sort((a,b)=>new Date(b.observedAt).getTime()-new Date(a.observedAt).getTime()).slice(0,250);
}

async function enrichHistory(rows:any[]){
  const traderIds=[...new Set(rows.map(r=>r.traderId))],mints=[...new Set(rows.map(r=>r.mint))];
  const [traders,tokens]=await Promise.all([
    traderIds.length?db.trader.findMany({where:{id:{in:traderIds}},select:{id:true,displayName:true,handle:true,avatarUrl:true}}):[],
    mints.length?db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,metadata:true}}):[]
  ]);
  const tm=new Map(traders.map(t=>[t.id,t])),mm=new Map(tokens.map(t=>[t.mint,t]));
  return rows.map(r=>({
    id:r.id,action:r.action,state:r.state,trader:tm.get(r.traderId)||null,walletAddress:r.walletAddress,mint:r.mint,token:mm.get(r.mint)||null,
    tokenAmount:tokenQty(r),executionPriceUsd:execPrice(r),amountUsd:r.amountUsd,quoteAmount:r.quoteAmount,quoteSymbol:r.quoteSymbol,quoteMint:r.quoteMint,
    marketCapAtTrade:r.marketCapUsd,balanceBeforeRaw:r.balanceBeforeRaw,balanceAfterRaw:r.balanceAfterRaw,observedAt:r.observedAt,sourceTx:r.sourceTx
  }));
}

async function curatedHistoryRows(opts:{since:Date;traderId?:string;before?:Date;limit:number}){
  const wallets=await activeAdminWallets(opts.traderId); if(!wallets.length)return [];
  const pairs=wallets.map(w=>({traderId:w.traderId,walletAddress:w.address}));
  const rows=await db.walletActivity.findMany({
    where:{chain:"SOLANA",public:true,swapVerified:true,action:{in:["BUY","SELL"]},OR:pairs,observedAt:{gte:opts.since,...(opts.before?{lt:opts.before}:{})}},
    orderBy:{observedAt:"desc"},take:Math.max(1,Math.min(HISTORY_MAX,opts.limit))
  });
  return enrichHistory(rows);
}

export function boughtMintsFrom(rows:any[]):Set<string>{
  return new Set(rows.filter(r=>r.action==="BUY").map(r=>r.mint));
}
export function profileTradeStats(rows:any[],since:Date){
  const r=rows.filter(x=>x.observedAt>=since),known=r.filter(x=>x.amountUsd!=null);
  return {trades:r.length,buys:r.filter(x=>x.action==="BUY").length,sells:r.filter(x=>x.action==="SELL").length,volumeUsd:known.reduce((a,x)=>a+Number(x.amountUsd),0),tokens:new Set(r.map(x=>x.mint)).size};
}

export function tokenRoundTrips(rows:any[],holdings:Map<string,any>,tokenMap:Map<string,any>,holdingsKnown:boolean){
  const byMint=new Map<string,any[]>();for(const row of rows){const arr=byMint.get(row.mint)||[];arr.push(row);byMint.set(row.mint,arr)}
  return [...byMint.entries()].map(([mint,events])=>{
    events.sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime());
    let buyUsd=0,sellUsd=0,buyQty=0,sellQty=0,realizedPnl=0;const lots:{qty:number,cost:number}[]=[];
    for(const e of events){const qty=tokenQty(e);if(qty==null||qty<=0)continue;if(e.action==="BUY"){buyQty+=qty;if(e.amountUsd!=null){buyUsd+=Number(e.amountUsd);lots.push({qty,cost:Number(e.amountUsd)})}}else if(e.action==="SELL"){sellQty+=qty;if(e.amountUsd!=null){sellUsd+=Number(e.amountUsd);let rem=qty,matchedCost=0,matchedQty=0;while(rem>0&&lots.length){const lot=lots[0],q=Math.min(rem,lot.qty),part=lot.cost*(q/lot.qty);matchedCost+=part;matchedQty+=q;lot.qty-=q;lot.cost-=part;rem-=q;if(lot.qty<=1e-12)lots.shift()}if(matchedQty>0)realizedPnl+=Number(e.amountUsd)*(matchedQty/qty)-matchedCost}}}
    const holding=holdings.get(mint)||null,token=tokenMap.get(mint)||null;
    return {mint,token,status:holdingsKnown?(holding&&holding.amount>0?"HOLDING":"EXITED_OR_MOVED"):"UNKNOWN",firstEntryAt:events.find(e=>e.action==="BUY")?.observedAt??events[0]?.observedAt,lastTradeAt:events[events.length-1]?.observedAt,
      buys:events.filter(e=>e.action==="BUY").length,sells:events.filter(e=>e.action==="SELL").length,totalBoughtUsd:buyUsd||null,totalSoldUsd:sellUsd||null,avgEntryPriceUsd:buyQty>0&&buyUsd>0?buyUsd/buyQty:null,avgExitPriceUsd:sellQty>0&&sellUsd>0?sellUsd/sellQty:null,
      realizedPnlUsd:buyUsd>0?realizedPnl:null,currentAmount:holding?.amount??null,currentValueUsd:holding?.valueUsd??null};
  }).sort((a,b)=>new Date(b.lastTradeAt).getTime()-new Date(a.lastTradeAt).getTime());
}

async function currentHoldings(wallets:{address:string}[],boughtMints:Set<string>){
  const key=wallets.map(w=>w.address).sort().join(":");const cached=holdingsCache.get(key);if(cached&&Date.now()-cached.at<45_000)return cached.value;
  const marketCfg=await getConfig<any>("marketData");const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[curated-profile]");const conn=new Connection(rpc,"confirmed");
  const byMint=new Map<string,{amount:number,decimals:number}>();let nativeSol=0;
  for(const wallet of wallets){
    const owner=new PublicKey(wallet.address);
    const [sol,classic,t22]=await Promise.all([
      conn.getBalance(owner,"confirmed"),
      conn.getParsedTokenAccountsByOwner(owner,{programId:TOKEN_PROGRAM},"confirmed").catch(()=>({value:[]} as any)),
      conn.getParsedTokenAccountsByOwner(owner,{programId:TOKEN_2022_PROGRAM},"confirmed").catch(()=>({value:[]} as any))
    ]);
    nativeSol+=sol/1e9;
    for(const a of [...classic.value,...t22.value]){
      const info=(a.account.data as any)?.parsed?.info, mint=String(info?.mint??""),ta=info?.tokenAmount;if(!mint||!ta)continue;
      const amount=Number(ta.uiAmountString??ta.uiAmount??0),decimals=Number(ta.decimals??0);if(!Number.isFinite(amount)||amount<=0)continue;
      const prev=byMint.get(mint);byMint.set(mint,{amount:(prev?.amount??0)+amount,decimals});
    }
  }
  const selected=[...byMint.entries()].filter(([mint])=>boughtMints.has(mint));const mints=selected.map(([mint])=>mint);
  const [tokens,prices,snaps]=await Promise.all([
    mints.length?db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,metadata:true}}):[],
    mints.length?db.marketPrice.findMany({where:{chain:"SOLANA",mint:{in:mints},observedAt:{gte:new Date(Date.now()-DAY_MS)}},orderBy:{observedAt:"desc"},take:Math.min(5000,Math.max(100,mints.length*20))}):[],
    mints.length?db.memeMarketSnapshot.findMany({where:{chain:"SOLANA",mint:{in:mints}},orderBy:{observedAt:"desc"},take:Math.min(5000,Math.max(100,mints.length*20))}):[]
  ]);
  const tm=new Map(tokens.map(t=>[t.mint,t])),pm=new Map<string,number>(),sm=new Map<string,any>();for(const p of prices)if(!pm.has(p.mint))pm.set(p.mint,p.priceUsd);for(const s of snaps)if(!sm.has(s.mint))sm.set(s.mint,s);
  const holdings=selected.map(([mint,v])=>{const token=tm.get(mint)||null,snap=sm.get(mint),price=pm.get(mint)??snap?.priceUsd??null;return {mint,amount:v.amount,decimals:v.decimals,priceUsd:price,valueUsd:price!=null?v.amount*Number(price):null,marketCapUsd:snap?.marketCapUsd??token?.marketCapUsd??null,token};})
    .sort((a,b)=>(b.valueUsd??-1)-(a.valueUsd??-1));
  const value={status:"LIVE",source:"SOLANA_RPC",nativeSol,holdings,estimatedHoldingsUsd:holdings.reduce((a,h)=>a+(h.valueUsd??0),0),refreshedAt:new Date().toISOString()};holdingsCache.set(key,{at:Date.now(),value});return value;
}

async function traderProfile(traderId:string,userId:string,before?:Date,limit=100){
  const trader=await db.trader.findFirst({where:{id:traderId,kind:"PLATFORM",enabled:true,wallets:{some:adminWalletFields()}},include:{wallets:{where:adminWalletFields()},_count:{select:{follows:true,signals:true}}}});if(!trader)return null;
  const trackedSince=new Date(Math.min(...trader.wallets.map(w=>(w.verifiedAt??w.createdAt).getTime())));
  const totalTradeCount=await db.walletActivity.count({where:{chain:"SOLANA",traderId,public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:trackedSince}}});
  const statsRows=await db.walletActivity.findMany({where:{chain:"SOLANA",traderId,public:true,swapVerified:true,action:{in:["BUY","SELL"]},observedAt:{gte:trackedSince}},orderBy:{observedAt:"asc"},take:PROFILE_STATS_MAX});
  const boughtMints=boughtMintsFrom(statsRows);let holdings:any;try{holdings=await currentHoldings(trader.wallets,boughtMints)}catch(e:any){holdings={status:"UNAVAILABLE",source:"SOLANA_RPC",nativeSol:null,holdings:[],estimatedHoldingsUsd:null,refreshedAt:null,error:String(e?.message??e).slice(0,180)}}
  const tokenMints=[...new Set(statsRows.map(r=>r.mint))],tokens=tokenMints.length?await db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:tokenMints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,metadata:true}}):[];const tokenMap=new Map(tokens.map(t=>[t.mint,t])),holdingMap=new Map<string,any>((holdings.holdings||[]).map((h:any)=>[h.mint,h] as [string,any]));
  const page=await curatedHistoryRows({since:trackedSince,traderId,before,limit});const follow=await db.userFollow.findUnique({where:{userId_traderId:{userId,traderId}}});
  const allPerf=performance(statsRows,trackedSince),d30=performance(statsRows,new Date(Date.now()-30*DAY_MS));
  return {trader:{id:trader.id,displayName:trader.displayName,handle:trader.handle,avatarUrl:trader.avatarUrl,category:trader.category,featured:trader.featured,recommended:trader.recommended,followers:trader._count.follows,signals:trader._count.signals,wallets:trader.wallets.map(w=>({id:w.id,address:w.address,chain:w.chain,trackedSince:w.verifiedAt??w.createdAt}))},trackedSince,follow,
    summary:{totalTrades:totalTradeCount,tradesLoadedForStats:statsRows.length,statsTruncated:totalTradeCount>PROFILE_STATS_MAX,tokensTraded:new Set(statsRows.map(r=>r.mint)).size,openHoldings:(holdings.holdings||[]).length,holdingsValueUsd:holdings.estimatedHoldingsUsd,realizedPnlUsd:allPerf.pnlUsd,returnPct:allPerf.returnPct,winRatePct:allPerf.closed?allPerf.wins/allPerf.closed*100:null,closedTrades:allPerf.closed,d30,day:profileTradeStats(statsRows,new Date(Date.now()-DAY_MS))},
    holdings,tokenHistory:tokenRoundTrips(statsRows,holdingMap,tokenMap,holdings.status==="LIVE"),history:page,nextBefore:page.length>=limit?page[page.length-1]?.observedAt:null};
}

function releaseId(){return process.env.MEMECLOUD_RELEASE_SHA||process.env.RELEASE_SHA||path.basename(process.cwd());}

curatedRoutes.get("/v1/curated/live",auth,asyncRoute(async(req:AuthedRequest,res)=>{const [events,traders]=await Promise.all([curatedFlowRows(),curatedTraderRows(req.user.sub)]);res.setHeader("cache-control","no-store");res.json({events,traders,trackedTraderCount:traders.length,generatedAt:new Date().toISOString(),sessionIdleMs:SESSION_IDLE_MS,sourcePolicy:"REAL_SWAP_ADMIN_WALLETS_ONLY",aggregation:"WALLET_MINT_SESSION",release:releaseId()});}));
curatedRoutes.get("/v1/curated/traders",auth,asyncRoute(async(req:AuthedRequest,res)=>{res.setHeader("cache-control","no-store");res.json({traders:await curatedTraderRows(req.user.sub),sourcePolicy:"ADMIN_VERIFIED_WALLETS_ONLY",release:releaseId()});}));
curatedRoutes.get("/v1/curated/flow",auth,asyncRoute(async(_req:AuthedRequest,res)=>{res.setHeader("cache-control","no-store");res.json({events:await curatedFlowRows(),sourcePolicy:"REAL_SWAP_ADMIN_WALLETS_ONLY",aggregation:"WALLET_MINT_SESSION",sessionIdleMs:SESSION_IDLE_MS,release:releaseId()});}));

curatedRoutes.get("/v1/curated/history",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  const hours=Math.max(1,Math.min(24*30,Number(req.query.hours??24))),limit=Math.max(1,Math.min(HISTORY_MAX,Number(req.query.limit??5000)));const events=await curatedHistoryRows({since:new Date(Date.now()-hours*60*60_000),limit});
  res.setHeader("cache-control","no-store");res.json({events,hours,count:events.length,generatedAt:new Date().toISOString(),sourcePolicy:"VERIFIED_ADMIN_SWAP_HISTORY_ONLY",release:releaseId()});
}));

curatedRoutes.get("/v1/curated/traders/:id/profile",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  const beforeRaw=String(req.query.before??""),before=beforeRaw&&Number.isFinite(Date.parse(beforeRaw))?new Date(beforeRaw):undefined,limit=Math.max(20,Math.min(250,Number(req.query.limit??100)));const profile=await traderProfile(routeParam(req.params.id),req.user.sub,before,limit);if(!profile)return res.status(404).json({error:"CURATED_TRADER_NOT_FOUND"});
  res.setHeader("cache-control","no-store");res.json({...profile,release:releaseId(),sourcePolicy:"ADMIN_VERIFIED_WALLETS_ONLY"});
}));

curatedRoutes.get("/v1/curated/traders/:id/history",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  const traderId=routeParam(req.params.id),wallets=await activeAdminWallets(traderId);if(!wallets.length)return res.status(404).json({error:"CURATED_TRADER_NOT_FOUND"});const trackedSince=new Date(Math.min(...wallets.map(w=>(w.verifiedAt??w.createdAt).getTime()))),beforeRaw=String(req.query.before??""),before=beforeRaw&&Number.isFinite(Date.parse(beforeRaw))?new Date(beforeRaw):undefined,limit=Math.max(20,Math.min(250,Number(req.query.limit??100)));const events=await curatedHistoryRows({since:trackedSince,traderId,before,limit});
  res.setHeader("cache-control","no-store");res.json({events,nextBefore:events.length>=limit?events[events.length-1]?.observedAt:null,trackedSince,release:releaseId()});
}));
