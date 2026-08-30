import { Connection, PublicKey } from "@solana/web3.js";
import { classifySolanaSwap, JUPITER_V6_PROGRAM } from "../dist/decoder.js";

const rpc=process.env.SOLANA_RPC_HTTP??"https://api.mainnet-beta.solana.com";
const connection=new Connection(rpc,"confirmed");
const signatures=await connection.getSignaturesForAddress(new PublicKey(JUPITER_V6_PROGRAM),{limit:40},"confirmed");
const decoded=[];

for(const row of signatures){
  if(row.err) continue;
  const transaction=await connection.getParsedTransaction(row.signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
  if(!transaction) continue;
  for(const key of transaction.transaction.message.accountKeys.filter(item=>item.signer)){
    const wallet=key.pubkey.toBase58();
    const swap=classifySolanaSwap(transaction,wallet);
    if(swap){decoded.push({signature:row.signature,slot:row.slot,wallet,swap});break;}
  }
  if(decoded.some(item=>item.swap.action==="BUY")&&decoded.some(item=>item.swap.action==="SELL")) break;
  await new Promise(resolve=>setTimeout(resolve,180));
}

const buys=decoded.filter(item=>item.swap.action==="BUY");
const sells=decoded.filter(item=>item.swap.action==="SELL");
console.log(JSON.stringify({rpc:new URL(rpc).host,checked:signatures.length,buys:buys.length,sells:sells.length,samples:decoded.slice(0,6)},null,2));
if(!buys.length||!sells.length) throw new Error("PUBLIC_CHAIN_SMOKE_DID_NOT_FIND_BOTH_BUY_AND_SELL");
