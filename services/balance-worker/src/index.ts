import {Connection,PublicKey} from "@solana/web3.js";
import {Redis} from "ioredis";
import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {getConfig} from "@memecloud/config";
import {RpcBudget} from "@memecloud/shared";

const rpcRedis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
// Shared, cross-process Solana RPC budget -- same account, same bucket, as flow-worker and
// market-worker. Real users' spendable-cash figure (availableUsd, which gates whether a copy-trade
// or manual buy is even allowed to size itself) is derived directly from this worker's reads, so it
// draws at P1: one notch below the true real-money execution paths in exits/executor, but ahead of
// every background discovery/enrichment consumer.
const sharedRpcBudget=new RpcBudget(rpcRedis,"rpc-budget:solana",{
  capacity:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_CAPACITY??50)),
  ratePerSec:Math.max(1,Number(process.env.RPC_ACCOUNT_BUDGET_RATE_PER_SEC??25))
});
let sharedBudgetDenied=0,lastSharedBudgetDenyAt:number|null=null;

// Same startup-only-config bug already fixed elsewhere this session: reload each cycle (cycle()
// already only runs every 60s, so this doesn't add extra AppConfig load).
let conn:Connection,rpc:string;
async function reloadConfig(){
  const marketCfg=await getConfig<any>("marketData");
  const freshRpc=marketCfg?.heliusRpc||marketCfg?.solanaRpc||process.env.SOLANA_RPC_HTTP;
  if(!freshRpc) throw new Error("SOLANA_RPC_HTTP / Admin marketData.solanaRpc is required");
  rpc=freshRpc;
  conn=new Connection(rpc,"confirmed");
}
await reloadConfig();
const usdc=new PublicKey(process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
let walletsScanned=0,allocationsUpdated=0,allocationsSkippedUnresolved=0,errors=0,lastCycleMs=0,rateLimited=false,lastRateLimitAt:number|null=null,fallbackSkippedForRateLimit=0;

let running=false;

// Returns null for an address whenever its real balance genuinely could not be determined this
// cycle (RPC denial/429/timeout/error) -- never a fabricated 0n. A real bug this shipped in
// production: every failure path used to write balances.set(address, 0n), which cycle() then
// wrote straight into TradingCashAllocation.availableUsd as if it were the user's real balance.
// Since decideCopy() refuses any trade when availableUsd<=0, an ordinary rate-limit event (now
// routine given the shared RPC budget system) could silently zero out a fully-funded user's real
// balance and block their real trades -- found by a full-platform audit, not a live report, but a
// real and currently-live bug given the ongoing provider pressure. cycle() now skips the
// TradingCashAllocation write entirely for any user with an unresolved address this cycle, leaving
// their last-known-real balance in place rather than overwriting it with a wrong number.
async function batchUsdcBalances(addresses:string[]){
  const balances=new Map<string,bigint|null>();
  const unique=[...new Set(addresses)];
  for(let offset=0;offset<unique.length;offset+=40){
    const chunk=unique.slice(offset,offset+40);
    const shared=await sharedRpcBudget.tryAcquire("P1");
    if(!shared.granted){
      // This worker correctly yielding to a higher-priority consumer of the shared account budget,
      // not the provider itself failing -- either way, the real balance is unknown this cycle.
      sharedBudgetDenied+=chunk.length;lastSharedBudgetDenyAt=Date.now();
      for(const address of chunk)balances.set(address,null);
      if(offset+40<unique.length)await new Promise(r=>setTimeout(r,75));
      continue;
    }
    try{
      const requests=chunk.map((address,i)=>({jsonrpc:"2.0",id:i+1,method:"getTokenAccountsByOwner",params:[address,{mint:usdc.toBase58()},{encoding:"jsonParsed",commitment:"confirmed"}]}));
      const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(requests),signal:AbortSignal.timeout(12_000)});
      if(response.status===429){rateLimited=true;lastRateLimitAt=Date.now();throw Object.assign(new Error("RPC_BATCH_429"),{rateLimited:true})}
      if(!response.ok)throw new Error(`RPC_BATCH_${response.status}`);
      rateLimited=false;
      const body:any=await response.json();
      if(!Array.isArray(body))throw new Error("RPC_BATCH_UNSUPPORTED");
      const byId=new Map(body.map((x:any)=>[Number(x.id),x]));
      for(let i=0;i<chunk.length;i++){
        const row:any=byId.get(i+1); let raw=0n;
        for(const item of row?.result?.value??[]){const amount=item?.account?.data?.parsed?.info?.tokenAmount?.amount;if(typeof amount==="string")raw+=BigInt(amount)}
        balances.set(chunk[i],raw);
      }
    }catch(batchError:any){
      // A 429 on the batch call must NEVER fall back to per-wallet requests -- that turns one
      // rate-limited call into up to 40 individual RPC calls per chunk, every single 60s cycle,
      // which is exactly the retry-storm-during-an-outage anti-pattern that (confirmed in
      // production) was amplifying load precisely when the provider was already exhausted. Only
      // fall back for a genuine non-rate-limit failure (e.g. a provider that plain rejects JSON-RPC
      // batching, which is what this fallback was originally built for).
      if(batchError?.rateLimited){
        fallbackSkippedForRateLimit+=chunk.length;
        errors+=chunk.length;
        for(const address of chunk)balances.set(address,null);
        continue;
      }
      console.warn("[balance-worker] RPC batch fallback (non-rate-limit failure)",String(batchError?.message??batchError));
      for(let i=0;i<chunk.length;i+=8){
        await Promise.all(chunk.slice(i,i+8).map(async address=>{
          try{
            const accounts=await conn.getParsedTokenAccountsByOwner(new PublicKey(address),{mint:usdc},"confirmed");
            let raw=0n; for(const a of accounts.value){const amt=(a.account.data as any)?.parsed?.info?.tokenAmount?.amount;if(typeof amt==="string")raw+=BigInt(amt)}
            balances.set(address,raw);
          }catch(e:any){
            errors++;
            if(isRateLimitErr(e)){rateLimited=true;lastRateLimitAt=Date.now()}
            else console.error("[balance-worker] wallet",address,e);
            balances.set(address,null);
          }
        }));
      }
    }
    if(offset+40<unique.length)await new Promise(r=>setTimeout(r,75));
  }
  return balances;
}
function isRateLimitErr(e:any):boolean{return /429|too many requests|rate.?limit/i.test(String(e?.message??e??""))}
async function cycle(){
  if(running)return; running=true; const started=Date.now();
  try{
    await reloadConfig().catch(e=>console.error("[balance-worker] config reload failed, keeping previous connection",e));
    const wallets=await db.wallet.findMany({where:{chain:"SOLANA"},select:{userId:true,address:true},take:10_000});
    // A user may link multiple Solana wallets. Sum is handled by grouping before syncing.
    const byUser=new Map<string,string[]>();
    for(const w of wallets){const a=byUser.get(w.userId)??[];a.push(w.address);byUser.set(w.userId,a)}
    walletsScanned+=wallets.length;
    const addressBalances=await batchUsdcBalances(wallets.map(w=>w.address));
    for(const [userId,addresses] of byUser){
      try{
        // If ANY of this user's addresses couldn't be resolved this cycle (rate-limited, denied by
        // the shared budget, or a genuine RPC error), their real total balance is unknown -- never
        // write a partial/zeroed sum over their last-known-real TradingCashAllocation row. Skipping
        // leaves the previous real value in place; a stale-but-real number is honest, a fresh-but-
        // fabricated zero is not, and decideCopy() would incorrectly refuse a fully-funded user's
        // real trade against a zero this worker itself invented.
        if(addresses.some(address=>addressBalances.get(address)===null)){allocationsSkippedUnresolved++;continue}
        const totalRaw=addresses.reduce((sum,address)=>sum+(addressBalances.get(address)??0n),0n);
        const liveOpen=await db.position.findMany({where:{userId,chain:"SOLANA",mode:"LIVE",status:{in:["OPEN","PARTIALLY_CLOSED"]}},select:{costUsd:true,entryTokenRaw:true,remainingTokenRaw:true}});
        const inTradesUsd=liveOpen.reduce((sum,p)=>{
          try{const original=BigInt(p.entryTokenRaw),remaining=BigInt(p.remainingTokenRaw);const f=original>0n?Number((remaining*1_000_000n)/original)/1_000_000:0;return sum+p.costUsd*f}catch{return sum}
        },0);
        // The wallet's current USDC already reflects confirmed buys, so do not subtract open
        // position cost a second time. `availableUsd` is genuine spendable USDC; `inTradesUsd`
        // is the remaining deployed principal tracked separately for the unified account view.
        const walletUsd=Number(totalRaw)/1_000_000;
        await db.tradingCashAllocation.upsert({where:{userId_chain:{userId,chain:"SOLANA"}},create:{userId,chain:"SOLANA",asset:"USDC",usdcRaw:totalRaw.toString(),availableUsd:walletUsd,inTradesUsd,lastSyncedAt:new Date(),source:"SOLANA_RPC"},update:{usdcRaw:totalRaw.toString(),availableUsd:walletUsd,inTradesUsd,lastSyncedAt:new Date(),source:"SOLANA_RPC"}});
        allocationsUpdated++;
      }catch(e){errors++;console.error("[balance-worker] user",userId,e)}
    }
  }finally{lastCycleMs=Date.now()-started;running=false}
}
startHeartbeat("balance-worker",()=>({walletsScanned,allocationsUpdated,allocationsSkippedUnresolved,errors,lastCycleMs,rateLimited,lastRateLimitAgoSec:lastRateLimitAt?Math.round((Date.now()-lastRateLimitAt)/1000):null,fallbackSkippedForRateLimit,chain:"SOLANA",asset:"USDC",
  sharedRpcBudgetPriority:"P1",sharedRpcBudgetDenied:sharedBudgetDenied,
  lastSharedRpcBudgetDenyAgoSec:lastSharedBudgetDenyAt?Math.round((Date.now()-lastSharedBudgetDenyAt)/1000):null
}));
setInterval(()=>void cycle(),60_000); void cycle();
console.log("[balance-worker] syncing genuine Solana USDC balances");
