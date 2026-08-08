import { Connection, PublicKey } from "@solana/web3.js";
import { Redis } from "ioredis";
import { db } from "@fomocloud/db";
import { JupiterExecution } from "@fomocloud/execution";
import { startHeartbeat } from "@fomocloud/ops";
import { getConfig } from "@fomocloud/config";

const marketCfg=await getConfig<any>("marketData");
const execCfg=await getConfig<any>("execution");
const rpc=marketCfg?.solanaRpc||marketCfg?.heliusRpc||process.env.SOLANA_RPC_HTTP;
if(!rpc) throw new Error("SOLANA_RPC_HTTP / Admin marketData.solanaRpc is required");
const conn=new Connection(rpc,"confirmed");
const redis=new Redis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);
const usdc=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quoteUsd=Math.max(1,Number(process.env.MARKET_QUOTE_USD??10));
const decimalsCache=new Map<string,{decimals:number,supply:number,at:number}>();
let tracked=0,updates=0,quoteErrors=0;

async function tokenMeta(mint:string){
  const c=decimalsCache.get(mint);
  if(c&&Date.now()-c.at<60*60_000) return c;
  const supply=await conn.getTokenSupply(new PublicKey(mint),"confirmed");
  const v={
    decimals:supply.value.decimals,
    supply:Number(supply.value.uiAmountString??0),
    at:Date.now()
  };
  decimalsCache.set(mint,v); return v;
}

async function trackedMints(){
  const since=new Date(Date.now()-24*60*60_000);
  const [signals,positions]=await Promise.all([
    db.signal.findMany({where:{chain:"SOLANA",action:"BUY",observedAt:{gte:since}},select:{outputMint:true},take:1000}),
    db.position.findMany({where:{chain:"SOLANA",status:{in:["OPEN","PARTIALLY_CLOSED"]}},select:{mint:true},take:1000})
  ]);
  return [...new Set([...signals.map(s=>s.outputMint),...positions.map(p=>p.mint)])].slice(0,250);
}

async function updateMint(mint:string){
  try{
    const meta=await tokenMeta(mint);
    const amountRaw=String(Math.round(quoteUsd*1_000_000));
    const q=await jupiter.quote({inputMint:usdc,outputMint:mint,amountRaw,slippageBps:1500});
    const tokens=Number(q.outAmount)/(10**meta.decimals);
    if(!Number.isFinite(tokens)||tokens<=0) return;
    const priceUsd=quoteUsd/tokens;
    const marketCapUsd=meta.supply>0?meta.supply*priceUsd:undefined;
    const observedAt=new Date();
    await db.marketPrice.create({data:{chain:"SOLANA",mint,priceUsd,marketCapUsd,source:"JUPITER_EXECUTABLE_QUOTE",observedAt}});
    await redis.set(`price:SOLANA:${mint}`,JSON.stringify({priceUsd,marketCapUsd,source:"JUPITER_EXECUTABLE_QUOTE",observedAt:observedAt.toISOString()}),"EX",90);
    updates++;
    // Keep raw history bounded per mint.
    const old=await db.marketPrice.findMany({where:{chain:"SOLANA",mint},orderBy:{observedAt:"desc"},skip:720,take:200,select:{id:true}});
    if(old.length) await db.marketPrice.deleteMany({where:{id:{in:old.map(x=>x.id)}}});
  }catch(e){quoteErrors++;console.error("[market-worker]",mint,e);}
}

let running=false;
async function tick(){
  if(running) return;
  running=true;
  try{
    const mints=await trackedMints(); tracked=mints.length;
    for(let i=0;i<mints.length;i+=10){
      await Promise.all(mints.slice(i,i+10).map(updateMint));
      await new Promise(r=>setTimeout(r,250));
    }
  }finally{running=false;}
}
startHeartbeat("market-worker",()=>({tracked,updates,quoteErrors,source:"Jupiter executable quotes"}));
setInterval(()=>void tick(),5000);
void tick();
console.log("[market-worker] running");
