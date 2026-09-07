// THE single decision point for "does this verified swap become a public alert, or does it fold
// into an existing live card?" -- see isPublicTradeEvent() at the bottom.
//
// Why this exists: a verified swap is not automatically newsworthy. Production evidence
// (MARTINSHKRELI, 2026-09-06 23:09-23:16) showed 40 genuine, wallet-signed Pump.fun swaps on one
// mint inside seven minutes -- buy, trim, buy, trim -- each of which produced its own push. Every
// one was real; the classifier was right. Sending 40 notifications for it was still wrong.
//
// Rules implemented here, deliberately behaviour-based and never market-cap-based (a real degen
// entering at $4K MC is legitimate; churn is what makes something noise):
//   * the first verified buy of a wallet+mint session always alerts immediately,
//   * repeated churn inside a live session folds into that session's card,
//   * materially important changes always break through the throttle,
//   * every verified swap is still persisted and still counts toward PNL/performance.
//
// Sessions are DERIVED from durable WalletActivity rows rather than a new table: this database
// cannot take a `prisma db push` (pre-existing duplicate Deposit.idempotencyKey rows block it), and
// deriving keeps transaction idempotency and public aggregation as the two separate concerns the
// spec calls for -- `chain:signature:wallet:mint:action` stays the dedup key, untouched.

export type BehaviourState="NORMAL"|"ACTIVE_ACCUMULATION"|"SCALPING"|"DISTRIBUTING"|"EXITED";

export type SessionTrade={
  action:string;            // BUY | SELL
  state:string;             // BOUGHT | ADDED | TRIMMED | MOSTLY_EXITED | EXITED
  quoteAmount?:number|null;  // in the quote asset actually spent/received
  quoteSymbol?:string|null;
  amountUsd?:number|null;
  amountRaw?:string|null;    // token amount moved, raw units
  decimals?:number|null;
  marketCapUsd?:number|null;
  observedAt:Date;
  balanceBeforeRaw?:string;
  balanceAfterRaw?:string;
};

export const SESSION_IDLE_MS=15*60_000;

/** A wallet+mint "activity session": the live trading burst a single public card represents. */
export function summariseSession(trades:SessionTrade[],now:Date=new Date()){
  const sorted=[...trades].sort((a,b)=>a.observedAt.getTime()-b.observedAt.getTime());
  const buys=sorted.filter(t=>t.action==="BUY"),sells=sorted.filter(t=>t.action==="SELL");
  const grossBought=buys.reduce((n,t)=>n+Math.abs(Number(t.quoteAmount??0)),0);
  const grossSold=sells.reduce((n,t)=>n+Math.abs(Number(t.quoteAmount??0)),0);
  const grossBoughtUsd=buys.reduce((n,t)=>n+Math.abs(Number(t.amountUsd??0)),0);
  const grossSoldUsd=sells.reduce((n,t)=>n+Math.abs(Number(t.amountUsd??0)),0);
  const last=sorted[sorted.length-1];
  const exited=Boolean(last&&last.action==="SELL"&&last.balanceAfterRaw==="0");
  // Round trips are the honest churn signal: how many times the wallet flipped side.
  let roundTrips=0;for(let i=1;i<sorted.length;i++)if(sorted[i].action!==sorted[i-1].action)roundTrips++;
  const spanMs=sorted.length>1?sorted[sorted.length-1].observedAt.getTime()-sorted[0].observedAt.getTime():0;
  const netQuote=grossBought-grossSold, grossQuote=grossBought+grossSold;
  // Net conviction vs gross activity: 20 SOL in / 19.5 SOL out is 0.5 SOL of conviction, not 20.
  const netRatio=grossQuote>0?Math.abs(netQuote)/grossQuote:1;
  let behaviour:BehaviourState="NORMAL";
  if(exited)behaviour="EXITED";
  else if(sorted.length>=4&&roundTrips>=2&&netRatio<0.5)behaviour="SCALPING";
  else if(grossSold>grossBought&&sells.length>=2)behaviour="DISTRIBUTING";
  else if(buys.length>=2&&netQuote>0)behaviour="ACTIVE_ACCUMULATION";
  // Token quantities and the position that is actually still held -- the difference between
  // "traded a lot" and "is holding something".
  const tok=(t:SessionTrade)=>{const raw=Number(t.amountRaw??0),d=Number(t.decimals??0);return Number.isFinite(raw)&&d>=0?Math.abs(raw)/10**d:0};
  const tokenBought=buys.reduce((n,t)=>n+tok(t),0),tokenSold=sells.reduce((n,t)=>n+tok(t),0);
  const firstBuy=buys[0];
  const openingBalance=firstBuy?.balanceBeforeRaw!=null?BigInt(firstBuy.balanceBeforeRaw):0n;
  const currentBalance=last?.balanceAfterRaw!=null?BigInt(last.balanceAfterRaw):0n;
  const peakBalance=sorted.reduce((mx,t)=>{const v=t.balanceAfterRaw!=null?BigInt(t.balanceAfterRaw):0n;return v>mx?v:mx},openingBalance);
  const remainingPositionPct=peakBalance>0n?Math.max(0,Math.min(100,Number((currentBalance*10000n)/peakBalance)/100)):null;
  const withMc=sorted.filter(t=>t.marketCapUsd!=null);
  return {
    firstTradeAt:sorted[0]?.observedAt??null,firstBuyAt:firstBuy?.observedAt??null,lastTradeAt:last?.observedAt??null,
    buyCount:buys.length,sellCount:sells.length,tradeCount:sorted.length,
    grossQuoteBought:grossBought,grossQuoteSold:grossSold,netQuoteFlow:netQuote,
    quoteSymbol:sorted.find(t=>t.quoteSymbol)?.quoteSymbol??null,
    grossBoughtUsd,grossSoldUsd,netUsdFlow:grossBoughtUsd-grossSoldUsd,
    tokenBought,tokenSold,remainingPositionPct,
    initialMarketCapUsd:withMc[0]?.marketCapUsd??null,latestMarketCapUsd:withMc[withMc.length-1]?.marketCapUsd??null,
    roundTrips,spanMs,netRatio,behaviour,exited,
    isLive:Boolean(last&&now.getTime()-last.observedAt.getTime()<SESSION_IDLE_MS)
  };
}

export type PublicDecision={push:boolean;reason:string;aggregate:boolean};

/**
 * @param priorTrades  verified swaps already recorded for this wallet+mint in the live session
 * @param incoming     the swap just verified
 * @param context.otherTrackedTradersOnMint  distinct OTHER admin traders who bought this mint recently
 */
export function isPublicTradeEvent(input:{
  walletIsAdminTracked:boolean;
  swapVerified:boolean;
  incoming:SessionTrade;
  priorTrades:SessionTrade[];
  otherTrackedTradersOnMint?:number;
  sellAlertsEnabled?:boolean;
}):PublicDecision{
  const {walletIsAdminTracked,swapVerified,incoming,priorTrades}=input;
  // Hard gates first -- these can never be overridden by any aggregation rule.
  if(!walletIsAdminTracked)return {push:false,reason:"WALLET_NOT_ADMIN_TRACKED",aggregate:false};
  if(!swapVerified)return {push:false,reason:"SWAP_NOT_VERIFIED",aggregate:false};
  if(!["BUY","SELL"].includes(incoming.action))return {push:false,reason:"NOT_A_TRADE_ACTION",aggregate:false};

  const live=priorTrades.filter(t=>incoming.observedAt.getTime()-t.observedAt.getTime()<SESSION_IDLE_MS);
  // 1. First verified buy of a session always alerts immediately.
  if(!live.length){
    if(incoming.action==="SELL"&&input.sellAlertsEnabled===false)return {push:false,reason:"SELL_ALERTS_DISABLED",aggregate:true};
    return {push:true,reason:incoming.action==="BUY"?"FIRST_VERIFIED_BUY":"FIRST_VERIFIED_SELL",aggregate:false};
  }

  const prior=summariseSession(live,incoming.observedAt);
  const beforeRaw=BigInt(incoming.balanceBeforeRaw??"0"),afterRaw=BigInt(incoming.balanceAfterRaw??"0");

  // 3. Breakthrough events -- always push even if the previous alert was seconds ago.
  if(incoming.action==="SELL"&&afterRaw===0n)return {push:input.sellAlertsEnabled!==false,reason:"FULL_EXIT",aggregate:input.sellAlertsEnabled===false};
  if(incoming.action==="SELL"&&beforeRaw>0n&&afterRaw*2n<=beforeRaw)
    return {push:input.sellAlertsEnabled!==false,reason:"MAJOR_SELL_50PCT_PLUS",aggregate:input.sellAlertsEnabled===false};
  if((input.otherTrackedTradersOnMint??0)>=2)return {push:true,reason:"MULTI_TRADER_CONVERGENCE",aggregate:false};
  // A genuinely large add: this single buy is bigger than everything bought so far in the session.
  const incomingQuote=Math.abs(Number(incoming.quoteAmount??0));
  if(incoming.action==="BUY"&&incomingQuote>0&&incomingQuote>=prior.grossQuoteBought)
    return {push:true,reason:"LARGE_ADD_DOUBLES_SESSION",aggregate:false};

  // 5. Otherwise fold into the live card. Still recorded, still counted, just not another push.
  return {push:false,reason:prior.behaviour==="SCALPING"?"AGGREGATED_SCALPING":"AGGREGATED_SESSION_CHURN",aggregate:true};
}
