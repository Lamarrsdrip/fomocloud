import {Connection,PublicKey} from "@solana/web3.js";
import {db} from "@memecloud/db";
import {startHeartbeat} from "@memecloud/ops";
import {getConfig} from "@memecloud/config";

const marketCfg=await getConfig<any>("marketData");
const rpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
if(!rpc) throw new Error("SOLANA_RPC_HTTP / Admin marketData.solanaRpc is required");
const conn=new Connection(rpc,"confirmed");
const usdc=new PublicKey(process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
let walletsScanned=0,allocationsUpdated=0,errors=0,lastCycleMs=0;

let running=false;

async function batchUsdcBalances(addresses:string[]){
  const balances=new Map<string,bigint>();
  const unique=[...new Set(addresses)];
  for(let offset=0;offset<unique.length;offset+=40){
    const chunk=unique.slice(offset,offset+40);
    try{
      const requests=chunk.map((address,i)=>({jsonrpc:"2.0",id:i+1,method:"getTokenAccountsByOwner",params:[address,{mint:usdc.toBase58()},{encoding:"jsonParsed",commitment:"confirmed"}]}));
      const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(requests),signal:AbortSignal.timeout(12_000)});
      if(!response.ok)throw new Error(`RPC_BATCH_${response.status}`);
      const body:any=await response.json();
      if(!Array.isArray(body))throw new Error("RPC_BATCH_UNSUPPORTED");
      const byId=new Map(body.map((x:any)=>[Number(x.id),x]));
      for(let i=0;i<chunk.length;i++){
        const row:any=byId.get(i+1); let raw=0n;
        for(const item of row?.result?.value??[]){const amount=item?.account?.data?.parsed?.info?.tokenAmount?.amount;if(typeof amount==="string")raw+=BigInt(amount)}
        balances.set(chunk[i],raw);
      }
    }catch(batchError){
      // Some free RPC providers reject JSON-RPC batching. Fall back only for this chunk, with
      // bounded parallelism, rather than failing the entire account sync.
      console.warn("[balance-worker] RPC batch fallback",String((batchError as any)?.message??batchError));
      for(let i=0;i<chunk.length;i+=8){
        await Promise.all(chunk.slice(i,i+8).map(async address=>{
          try{
            const accounts=await conn.getParsedTokenAccountsByOwner(new PublicKey(address),{mint:usdc},"confirmed");
            let raw=0n; for(const a of accounts.value){const amt=(a.account.data as any)?.parsed?.info?.tokenAmount?.amount;if(typeof amt==="string")raw+=BigInt(amt)}
            balances.set(address,raw);
          }catch(e){errors++;console.error("[balance-worker] wallet",address,e);balances.set(address,0n)}
        }));
      }
    }
    if(offset+40<unique.length)await new Promise(r=>setTimeout(r,75));
  }
  return balances;
}
async function cycle(){
  if(running)return; running=true; const started=Date.now();
  try{
    const wallets=await db.wallet.findMany({where:{chain:"SOLANA"},select:{userId:true,address:true},take:10_000});
    // A user may link multiple Solana wallets. Sum is handled by grouping before syncing.
    const byUser=new Map<string,string[]>();
    for(const w of wallets){const a=byUser.get(w.userId)??[];a.push(w.address);byUser.set(w.userId,a)}
    walletsScanned+=wallets.length;
    const addressBalances=await batchUsdcBalances(wallets.map(w=>w.address));
    for(const [userId,addresses] of byUser){
      try{
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
startHeartbeat("balance-worker",()=>({walletsScanned,allocationsUpdated,errors,lastCycleMs,chain:"SOLANA",asset:"USDC"}));
setInterval(()=>void cycle(),60_000); void cycle();
console.log("[balance-worker] syncing genuine Solana USDC balances");
