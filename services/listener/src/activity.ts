import { db, walletEventKey } from "@memecloud/db";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { walletTokenActivity } from "./activityParsing.js";

export async function persistWalletActivity(traderId:string,wallet:string,signature:string,tx:ParsedTransactionWithMeta,notify=true){
  const facts=walletTokenActivity(tx,wallet);
  if(!facts.length)return;
  const [trader,candidate]=await Promise.all([
    db.trader.findUniqueOrThrow({where:{id:traderId}}),
    db.smartWalletCandidate.findUnique({where:{chain_address:{chain:"SOLANA",address:wallet}}})
  ]);
  const walletLabel=candidate?.label||(trader.handle!=="memecloud-observation"?trader.displayName||`@${trader.handle}`:wallet);
  const observedAt=tx.blockTime?new Date(tx.blockTime*1000):new Date();
  for(const fact of facts){
    const eventKey=walletEventKey("SOLANA",signature,wallet,fact.mint,fact.action);
    // No provider, scoring, research or notification dependency before the durable fact.
    await db.walletActivity.upsert({where:{eventKey},update:{},create:{...fact,eventKey,chain:"SOLANA",traderId,walletAddress:wallet,walletLabel,sourceTx:signature,public:trader.kind==="PLATFORM"||Boolean(candidate?.adminWatched),observedAt,notificationStatus:notify?"PENDING":"HISTORICAL"}});
    const snapshot=await db.memeMarketSnapshot.findFirst({where:{chain:"SOLANA",mint:fact.mint,observedAt:{lte:observedAt,gte:new Date(observedAt.getTime()-5*60_000)}},orderBy:{observedAt:"desc"},select:{marketCapUsd:true}}).catch(()=>null);
    if(snapshot?.marketCapUsd!=null)await db.walletActivity.update({where:{eventKey},data:{marketCapUsd:snapshot.marketCapUsd}});
    await db.discoveryToken.upsert({where:{chain_mint:{chain:"SOLANA",mint:fact.mint}},update:{},create:{chain:"SOLANA",mint:fact.mint,source:"WALLET_ACTIVITY",discoveredAt:observedAt,lastSeenAt:observedAt,metadata:{decimals:fact.decimals}}});
  }
}

// One bounded metadata request per missing mint, independent of paid deep research.
// Success is cached durably; failures are retried in the background at most hourly.
export async function enrichWalletToken(mint:string){
  const token=await db.discoveryToken.findUnique({where:{chain_mint:{chain:"SOLANA",mint}}});
  if(!token || (token.symbol&&token.name))return;
  const meta=(token.metadata??{}) as any;
  if(meta.identityAttemptAt&&Date.now()-new Date(meta.identityAttemptAt).getTime()<3600_000)return;
  await db.discoveryToken.update({where:{id:token.id},data:{metadata:{...meta,identityAttemptAt:new Date().toISOString()}}});
  const response=await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`,{signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error(`Token metadata HTTP ${response.status}`);
  const pairs=await response.json() as any[];
  const pair=Array.isArray(pairs)?pairs.find(p=>p.chainId==="solana"&&p.baseToken?.address===mint):null;
  const identity=pair?.baseToken;
  if(!identity?.symbol&&!identity?.name)return;
  // Read again to preserve concurrent research metadata writes.
  const current=await db.discoveryToken.findUniqueOrThrow({where:{id:token.id}});
  await db.discoveryToken.update({where:{id:token.id},data:{symbol:identity.symbol||current.symbol,name:identity.name||current.name,metadata:{...((current.metadata??{}) as any),imageUrl:pair.info?.imageUrl,identitySource:"DEXSCREENER_EXACT_MINT",identityResolvedAt:new Date().toISOString()}}});
}
let enriching=false;
export async function enrichPendingWalletTokens(){
  if(enriching)return;enriching=true;
  try{
    const rows=await db.walletActivity.findMany({orderBy:{observedAt:"desc"},take:500});
    for(const mint of [...new Set(rows.map(r=>r.mint))])await enrichWalletToken(mint).catch(e=>console.warn("[listener] token identity",mint,e.message));
  }finally{enriching=false;}
}
