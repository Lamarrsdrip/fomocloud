import { Router } from "express";
import { db } from "@memecloud/db";
import { auth, type AuthedRequest } from "./middleware.js";
import { asyncRoute } from "./auth.js";

export const curatedRoutes = Router();

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
      while(remaining>0&&arr.length){const lot=arr[0];const q=Math.min(remaining,lot.qty);matchedCost+=lot.cost*(q/lot.qty);matchedQty+=q;lot.cost-=lot.cost*(q/lot.qty);lot.qty-=q;remaining-=q;if(lot.qty<=1e-12)arr.shift();}
      lots.set(e.mint,arr);
      if(matchedQty>0){const proceeds=Number(e.amountUsd)*(matchedQty/qty),tradePnl=proceeds-matchedCost;pnl+=tradePnl;costClosed+=matchedCost;closed++;if(tradePnl>0)wins++;known++;}
    }
  }
  return {pnlUsd:known&&costClosed>0?pnl:null,returnPct:costClosed>0?pnl/costClosed*100:null,wins,closed,trades:events.filter(e=>e.action==="BUY"||e.action==="SELL").length};
}

async function curatedTraderRows(userId?:string){
  const traders=await db.trader.findMany({
    where:{kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true,chain:"SOLANA"}}},
    include:{wallets:{where:{source:"ADMIN",verified:true,chain:"SOLANA"}},_count:{select:{follows:true,signals:true}}},
    orderBy:[{featured:"desc"},{recommended:"desc"},{createdAt:"asc"}]
  });
  const ids=traders.map(t=>t.id), since90=new Date(Date.now()-90*86400_000);
  const [activity,follows]=await Promise.all([
    ids.length?db.walletActivity.findMany({where:{traderId:{in:ids},action:{in:["BUY","SELL"]},public:true,observedAt:{gte:since90}},orderBy:{observedAt:"asc"},take:20000}):[],
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

curatedRoutes.get("/v1/curated/traders",auth,asyncRoute(async(req:AuthedRequest,res)=>{
  res.json({traders:await curatedTraderRows(req.user.sub),sourcePolicy:"ADMIN_VERIFIED_WALLETS_ONLY"});
}));

curatedRoutes.get("/v1/curated/flow",auth,asyncRoute(async(_req:AuthedRequest,res)=>{
  const since=new Date(Date.now()-24*3600_000);
  const rows=await db.walletActivity.findMany({where:{public:true,action:{in:["BUY","SELL"]},observedAt:{gte:since}},orderBy:{observedAt:"desc"},take:250});
  const traderIds=[...new Set(rows.map(r=>r.traderId))],mints=[...new Set(rows.map(r=>r.mint))];
  const [traders,tokens]=await Promise.all([
    traderIds.length?db.trader.findMany({where:{id:{in:traderIds},kind:"PLATFORM",enabled:true,wallets:{some:{source:"ADMIN",verified:true}}},select:{id:true,displayName:true,handle:true,avatarUrl:true}}):[],
    mints.length?db.discoveryToken.findMany({where:{chain:"SOLANA",mint:{in:mints}},select:{mint:true,symbol:true,name:true,marketCapUsd:true,liquidityUsd:true,metadata:true}}):[]
  ]);
  const tm=new Map(traders.map(t=>[t.id,t])),mm=new Map(tokens.map(t=>[t.mint,t]));
  const events=rows.filter(r=>tm.has(r.traderId)).map(r=>({id:r.id,action:r.action,state:r.state,trader:tm.get(r.traderId),walletAddress:r.walletAddress,mint:r.mint,token:mm.get(r.mint)||null,amountUsd:r.amountUsd,marketCapUsd:r.marketCapUsd??mm.get(r.mint)?.marketCapUsd??null,observedAt:r.observedAt,sourceTx:r.sourceTx}));
  res.json({events,sourcePolicy:"REAL_SWAP_ADMIN_WALLETS_ONLY"});
}));
