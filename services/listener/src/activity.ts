import { db, walletEventKey } from "@memecloud/db";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { walletTokenActivity } from "./activityParsing.js";
import { resolveQuoteLeg } from "./quotePrice.js";
import { isPublicTradeEvent, SESSION_IDLE_MS, type SessionTrade } from "./publicActivity.js";
import { usdcMint, usdtMint } from "./parsing.js";

export async function persistWalletActivity(traderId:string,wallet:string,signature:string,tx:ParsedTransactionWithMeta,notify=true){
  const facts=walletTokenActivity(tx,wallet); if(!facts.length)return;
  const [trader,traderWalletRow]=await Promise.all([
    db.trader.findUniqueOrThrow({where:{id:traderId}}),
    db.traderWallet.findUnique({where:{chain_address:{chain:"SOLANA",address:wallet}}})
  ]);
  // Admin-added verified platform wallets are the only public platform signal source.
  const isAdminTracked=trader.kind==="PLATFORM"&&trader.enabled&&traderWalletRow?.source==="ADMIN"&&traderWalletRow.verified;
  const walletLabel=trader.displayName||`@${trader.handle}`; const observedAt=tx.blockTime?new Date(tx.blockTime*1000):new Date();
  for(const fact of facts){
    const eventKey=walletEventKey("SOLANA",signature,wallet,fact.mint,fact.action);
    const isRealTrade=fact.action==="BUY"||fact.action==="SELL";

    // What the wallet actually spent/received, in its real asset, with a USD value when knowable.
    // This is why a SOL buy no longer renders with a null amount.
    const leg=isRealTrade&&fact.quote
      ? await resolveQuoteLeg({quoteMint:fact.quote.quoteMint,rawAmount:BigInt(fact.quote.quoteRaw),decimals:fact.quote.quoteDecimals,usdcMint,usdtMint}).catch(()=>null)
      : null;
    const amountUsd=fact.amountUsd??leg?.amountUsd??undefined;

    // A verified swap is always recorded. Whether it also becomes a PUSH is a separate decision --
    // transaction idempotency (eventKey) and public aggregation are deliberately different keys.
    let publicDecision={push:false,reason:"NOT_A_TRADE_ACTION",aggregate:false};
    if(isRealTrade&&isAdminTracked){
      const since=new Date(observedAt.getTime()-SESSION_IDLE_MS);
      const [priorRows,otherTraders]=await Promise.all([
        db.walletActivity.findMany({where:{chain:"SOLANA",walletAddress:wallet,mint:fact.mint,action:{in:["BUY","SELL"]},observedAt:{gte:since,lt:observedAt}},orderBy:{observedAt:"asc"},take:200}),
        db.walletActivity.findMany({where:{chain:"SOLANA",mint:fact.mint,action:"BUY",public:true,walletAddress:{not:wallet},observedAt:{gte:since}},select:{walletAddress:true},take:50})
      ]);
      const priorTrades:SessionTrade[]=priorRows.map(r=>({action:r.action,state:r.state,quoteAmount:r.amountUsd,amountUsd:r.amountUsd,observedAt:r.observedAt,balanceBeforeRaw:r.balanceBeforeRaw,balanceAfterRaw:r.balanceAfterRaw}));
      publicDecision=isPublicTradeEvent({
        walletIsAdminTracked:true,swapVerified:true,
        incoming:{action:fact.action,state:fact.state,quoteAmount:leg?.quoteAmount??amountUsd,amountUsd,observedAt,balanceBeforeRaw:fact.balanceBeforeRaw,balanceAfterRaw:fact.balanceAfterRaw},
        priorTrades,
        otherTrackedTradersOnMint:new Set(otherTraders.map(o=>o.walletAddress)).size
      });
    }

    await db.walletActivity.upsert({where:{eventKey},update:{},create:{
      mint:fact.mint,action:fact.action,state:fact.state,amountRaw:fact.amountRaw,decimals:fact.decimals,
      balanceBeforeRaw:fact.balanceBeforeRaw,balanceAfterRaw:fact.balanceAfterRaw,amountUsd,
      eventKey,chain:"SOLANA",traderId,walletAddress:wallet,walletLabel,sourceTx:signature,
      public:isRealTrade&&isAdminTracked,observedAt,
      // Only a genuinely newsworthy event enters the notification pipeline. Churn inside a live
      // session is still stored and still counts toward PNL -- it just updates the existing card.
      notificationStatus:notify&&publicDecision.push?"PENDING":"HISTORICAL"
    }});
    if(!isRealTrade)continue;

    // Entry market cap is captured once, at detection, and never overwritten with the current MC.
    const existing=await db.walletActivity.findUnique({where:{eventKey},select:{marketCapUsd:true}});
    if(existing?.marketCapUsd==null){
      const snapshot=await db.memeMarketSnapshot.findFirst({where:{chain:"SOLANA",mint:fact.mint,observedAt:{lte:observedAt,gte:new Date(observedAt.getTime()-5*60_000)}},orderBy:{observedAt:"desc"},select:{marketCapUsd:true}}).catch(()=>null);
      if(snapshot?.marketCapUsd!=null)await db.walletActivity.update({where:{eventKey},data:{marketCapUsd:snapshot.marketCapUsd}});
    }
    await db.discoveryToken.upsert({where:{chain_mint:{chain:"SOLANA",mint:fact.mint}},update:{lastSeenAt:observedAt},create:{chain:"SOLANA",mint:fact.mint,source:"ADMIN_WALLET_SWAP",discoveredAt:observedAt,lastSeenAt:observedAt,metadata:{decimals:fact.decimals}}});
  }
}

export async function enrichWalletToken(mint:string){
  const token=await db.discoveryToken.findUnique({where:{chain_mint:{chain:"SOLANA",mint}}}); if(!token||(token.symbol&&token.name))return;
  const meta=(token.metadata??{}) as any,retry=meta.identityAttemptAt&&Date.now()-new Date(meta.identityAttemptAt).getTime()<5*60_000;if(retry)return;
  await db.discoveryToken.update({where:{id:token.id},data:{metadata:{...meta,identityAttemptAt:new Date().toISOString()}}});
  const response=await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`,{signal:AbortSignal.timeout(6000)});if(!response.ok)return;
  const pairs=await response.json() as any[];const pair=Array.isArray(pairs)?pairs.find(p=>p.chainId==="solana"&&p.baseToken?.address===mint):null;if(!pair?.baseToken)return;
  const current=await db.discoveryToken.findUniqueOrThrow({where:{id:token.id}});
  await db.discoveryToken.update({where:{id:token.id},data:{symbol:pair.baseToken.symbol||current.symbol,name:pair.baseToken.name||current.name,marketCapUsd:Number(pair.marketCap||pair.fdv)||current.marketCapUsd,liquidityUsd:Number(pair.liquidity?.usd)||current.liquidityUsd,metadata:{...((current.metadata??{}) as any),imageUrl:pair.info?.imageUrl,identitySource:"DEXSCREENER_EXACT_MINT",identityResolvedAt:new Date().toISOString()}}});
}
let enriching=false;
export async function enrichPendingWalletTokens(){if(enriching)return;enriching=true;try{const rows=await db.walletActivity.findMany({where:{public:true,action:{in:["BUY","SELL"]}},orderBy:{observedAt:"desc"},take:250});for(const mint of [...new Set(rows.map(r=>r.mint))])await enrichWalletToken(mint).catch(()=>{});}finally{enriching=false}}
