import { db, walletEventKey } from "@memecloud/db";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { walletTokenActivity } from "./activityParsing.js";

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
    await db.walletActivity.upsert({where:{eventKey},update:{},create:{...fact,eventKey,chain:"SOLANA",traderId,walletAddress:wallet,walletLabel,sourceTx:signature,public:isRealTrade&&isAdminTracked,observedAt,notificationStatus:notify&&isRealTrade&&isAdminTracked?"PENDING":"HISTORICAL"}});
    if(!isRealTrade)continue;
    const snapshot=await db.memeMarketSnapshot.findFirst({where:{chain:"SOLANA",mint:fact.mint,observedAt:{lte:observedAt,gte:new Date(observedAt.getTime()-5*60_000)}},orderBy:{observedAt:"desc"},select:{marketCapUsd:true}}).catch(()=>null);
    if(snapshot?.marketCapUsd!=null)await db.walletActivity.update({where:{eventKey},data:{marketCapUsd:snapshot.marketCapUsd}});
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
