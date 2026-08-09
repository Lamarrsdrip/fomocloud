import crypto from "node:crypto";

export type ChainName = "solana"|"base"|"ethereum"|"bsc"|"arbitrum"|"avalanche";

function qs(params:Record<string,string|number|boolean|undefined>){
  const u=new URLSearchParams();
  for(const [k,v] of Object.entries(params)) if(v!==undefined) u.set(k,String(v));
  return u.toString();
}
async function jsonFetch(url:string,init:RequestInit={},timeout=8000){
  const res=await fetch(url,{...init,signal:AbortSignal.timeout(timeout)});
  const text=await res.text();
  let body:any; try{body=JSON.parse(text)}catch{body={raw:text}}
  if(!res.ok){const e:any=new Error(`HTTP_${res.status}:${url}`);e.status=res.status;e.body=body;throw e;}
  return body;
}
const dataOf=(x:any)=>x?.data?.data??x?.data??x;
function n(x:any,...paths:string[]):number|undefined{
  for(const p of paths){let v=x;for(const part of p.split("."))v=v?.[part];const z=Number(v);if(Number.isFinite(z))return z;}
}
function str(x:any,...paths:string[]):string|undefined{
  for(const p of paths){let v=x;for(const part of p.split("."))v=v?.[part];if(typeof v==="string"&&v)return v;}
}

export class BirdeyeClient{
  constructor(private apiKey:string,private base="https://public-api.birdeye.so"){}
  private headers(chain:ChainName="solana"){return {"accept":"application/json","X-API-KEY":this.apiKey,"x-chain":chain}}
  private async get(path:string,params:Record<string,any>,chain:ChainName="solana"){
    return jsonFetch(`${this.base}${path}?${qs(params)}`,{headers:this.headers(chain)});
  }
  async trending(chain:ChainName="solana",limit=50){
    return dataOf(await this.get("/defi/token_trending",{sort_by:"rank",sort_type:"asc",interval:"1h",offset:0,limit},chain));
  }
  async tokenListSolana(opts:{minLiquidity?:number;maxMarketCap?:number;minMarketCap?:number;limit?:number}={}){
    return dataOf(await this.get("/defi/v3/token/list",{sort_by:"volume_1h_usd",sort_type:"desc",offset:0,limit:opts.limit??50,min_liquidity:opts.minLiquidity??15000,max_market_cap:opts.maxMarketCap??50000000,min_market_cap:opts.minMarketCap??50000},"solana"));
  }
  async topTraders(token:string,timeFrame="30d",limit=50){
    return dataOf(await this.get("/defi/v2/tokens/top_traders",{address:token,time_frame:timeFrame,sort_by:"total_pnl",sort_type:"desc",offset:0,limit},"solana"));
  }
  async walletPnlSummary(address:string,duration="30d",chain:ChainName="solana"){
    return dataOf(await this.get("/wallet/v2/pnl/summary",{wallet:address,duration},chain));
  }
  async marketData(token:string,chain:ChainName="solana"){return dataOf(await this.get("/defi/v3/token/market-data",{address:token,ui_amount_mode:"scaled"},chain))}
  async tradeData(token:string,chain:ChainName="solana"){return dataOf(await this.get("/defi/v3/token/trade-data/single",{address:token,frames:"1m,5m,15m",ui_amount_mode:"scaled"},chain))}
  async exitLiquidity(token:string,chain:ChainName="solana"){return dataOf(await this.get("/defi/v3/token/exit-liquidity",{address:token},chain))}
  async holderProfile(token:string){return dataOf(await this.get("/token/v1/holder-profile",{address:token,include_zero_balance:false,ui_amount_mode:"scaled"},"solana"))}

  normalizeToken(row:any){return {mint:str(row,"address","token_address","mint"),symbol:str(row,"symbol","token_symbol"),name:str(row,"name","token_name"),liquidityUsd:n(row,"liquidity","liquidity_usd","liquidityUsd"),marketCapUsd:n(row,"market_cap","marketcap","market_cap_usd","marketCap","mc"),volume24hUsd:n(row,"volume_24h_usd","volume24hUSD","v24hUSD","volume24h"),priceChange1h:n(row,"price_change_1h_percent","price_change_1h","priceChange1hPercent"),priceChange24h:n(row,"price_change_24h_percent","price_change_24h","priceChange24hPercent")}}
  normalizeTrader(row:any){return {address:str(row,"owner","wallet","address","wallet_address"),totalPnlUsd:n(row,"totalPnl","total_pnl","total_pnl_usd","pnl"),realizedPnlUsd:n(row,"realizedPnl","realized_pnl","realized_pnl_usd"),volumeUsd:n(row,"volumeUsd","volume_usd","volume"),buyVolumeUsd:n(row,"volumeBuyUSD","volume_buy_usd"),sellVolumeUsd:n(row,"volumeSellUSD","volume_sell_usd"),tradeCount:n(row,"trade_count","tradeCount","trades")}}
  normalizeWalletPnl(x:any){return {totalPnlUsd:n(x,"total_pnl","totalPnl","pnl","pnl_usd")??0,realizedPnlUsd:n(x,"realized_pnl","realizedPnl","realized_pnl_usd")??0,unrealizedPnlUsd:n(x,"unrealized_pnl","unrealizedPnl","unrealized_pnl_usd")??0,volumeUsd:n(x,"volume_usd","total_volume","volumeUsd","volume")??0,tradeCount:n(x,"trade_count","total_trades","tradeCount","trades")??0,profitableTrades:n(x,"win_count","profitable_trades","wins")??0,winRate:n(x,"win_rate","winRate","win_rate_percent")}}
  normalizeMarket(m:any,t:any,h:any,l:any){
    const frame=(o:any,k:string)=>o?.[k]??o?.[`trade_${k}`]??o?.[`data_${k}`]??{};
    const f1=frame(t,"1m"),f5=frame(t,"5m"),f15=frame(t,"15m");
    const v=(f:any)=>n(f,"volume_usd","volumeUSD","volume")??0;
    const bv=(f:any)=>n(f,"buy_volume_usd","volume_buy_usd","buyVolumeUSD")??0;
    const sv=(f:any)=>n(f,"sell_volume_usd","volume_sell_usd","sellVolumeUSD")??0;
    const buys=(f:any)=>Math.round(n(f,"buy","buys","buy_count","buyCount")??0);
    const sells=(f:any)=>Math.round(n(f,"sell","sells","sell_count","sellCount")??0);
    const ubw=(f:any)=>Math.round(n(f,"unique_buy_wallet","unique_buyers","uniqueBuyer","unique_buy_wallets")??0);
    const usw=(f:any)=>Math.round(n(f,"unique_sell_wallet","unique_sellers","uniqueSeller","unique_sell_wallets")??0);
    const holders=n(h,"holder_count","holderCount","holders");
    const top10=n(h,"top10_holder_percent","top10HolderPercent","top_10_percent");
    const bundler=n(h,"tags.bundler.supply_percent","holder_tags.bundler.percent","bundler_percent");
    const insider=n(h,"tags.insider.supply_percent","holder_tags.insider.percent","insider_percent");
    const dev=n(h,"tags.dev.supply_percent","holder_tags.dev.percent","dev_percent");
    const liquidity=n(m,"liquidity","liquidity_usd","liquidityUsd")??0;
    const price=n(m,"price","price_usd","priceUsd")??0;
    const marketCap=n(m,"market_cap","marketcap","market_cap_usd","marketCap");
    const created=n(m,"created_at","listing_time","createdAt","listed_at");
    const ageMinutes=created?Math.max(0,(Date.now()-(created<2e10?created*1000:created))/60000):24*60;
    const exitLiq=n(l,"exit_liquidity","exitLiquidity","liquidity","liquidity_usd");
    const a1=v(f5)>0?v(f1)/(v(f5)/5):1,a5=v(f15)>0?v(f5)/(v(f15)/3):1;
    return {priceUsd:price,marketCapUsd:marketCap,liquidityUsd:liquidity,exitLiquidityUsd:exitLiq,ageMinutes,volume1mUsd:v(f1),volume5mUsd:v(f5),volume15mUsd:v(f15),volumeAcceleration1m:Number.isFinite(a1)?a1:1,volumeAcceleration5m:Number.isFinite(a5)?a5:1,buys1m:buys(f1),sells1m:sells(f1),buys5m:buys(f5),sells5m:sells(f5),buyVolume5mUsd:bv(f5),sellVolume5mUsd:sv(f5),uniqueBuyers1m:ubw(f1),uniqueBuyers5m:ubw(f5),uniqueSellers5m:usw(f5),holderCount:holders,top10EffectivePct:top10,bundledSupplyPct:bundler,creatorHoldingPct:Math.max(insider??0,dev??0),holderGrowth5mPct:n(f5,"holder_change_percent","holder_growth_pct"),liquidityChange5mPct:n(f5,"liquidity_change_percent","liquidityChangePct")}
  }
}

export class HeliusClient{
  constructor(private rpcUrl:string){}
  async rpc<T=any>(method:string,params:any[]):Promise<T>{
    const body=await jsonFetch(this.rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method,params})});
    if(body?.error)throw Object.assign(new Error(body.error.message||"HELIUS_RPC_ERROR"),{detail:body.error});
    return body.result as T;
  }
  getTransaction(signature:string){return this.rpc("getTransaction",[signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}])}
  getSignaturesForAddress(address:string,limit=100,before?:string){return this.rpc<any[]>("getSignaturesForAddress",[address,{limit,...(before?{before}:{})}])}
}

export type PrivyConfig={appId:string;appSecret:string;authorizationPrivateKey?:string;sponsorGas?:boolean};
export class PrivySolanaSigner{
  private client:any;
  constructor(private cfg:PrivyConfig){}
  private async getClient(){if(this.client)return this.client;const mod:any=await import("@privy-io/node");this.client=new mod.PrivyClient({appId:this.cfg.appId,appSecret:this.cfg.appSecret});return this.client}
  async getWallet(walletId:string){const client=await this.getClient();return client.wallets().get(walletId)}
  async transactionByReferenceId(referenceId:string){
    const auth=Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString("base64");
    const body=await jsonFetch(`https://api.privy.io/v1/transactions?${qs({reference_id:referenceId})}`,{headers:{Authorization:`Basic ${auth}`,"privy-app-id":this.cfg.appId,"content-type":"application/json"}});
    const rows=Array.isArray(body)?body:(Array.isArray(body?.data)?body.data:(Array.isArray(body?.transactions)?body.transactions:[]));
    return rows[0]??null;
  }
  async signAndSend(walletId:string,transactionBase64:string,referenceId?:string){
    const client=await this.getClient();
    const result=await client.wallets().solana().signAndSendTransaction(walletId,{caip2:"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",transaction:transactionBase64,sponsor:Boolean(this.cfg.sponsorGas),...(referenceId?{reference_id:referenceId}: {}),...(this.cfg.authorizationPrivateKey?{authorization_context:{authorization_private_keys:[this.cfg.authorizationPrivateKey]}}:{})});
    const hash=result?.hash??result?.signature;if(!hash)throw new Error("PRIVY_MISSING_TX_HASH");
    return {hash:String(hash),transactionId:result?.transaction_id};
  }
}
