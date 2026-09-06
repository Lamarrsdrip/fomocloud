import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { tokenDeltas, ownerMintBalanceRaw, quoteMints, usdcMint, usdtMint } from "./parsing.js";

/** Observation only: never use this broader balance classifier to authorize a trade. */
export function walletTokenActivity(tx:ParsedTransactionWithMeta,wallet:string){
  if(!tx.meta || tx.meta.err)return [];
  const deltas=tokenDeltas(tx,wallet);
  const tokens=deltas.filter(d=>!quoteMints.has(d.mint));
  return tokens.map(d=>{
    const before=ownerMintBalanceRaw(tx,wallet,d.mint,"pre");
    const after=ownerMintBalanceRaw(tx,wallet,d.mint,"post");
    const buy=d.raw>0n;
    const sameSide=tokens.filter(t=>(t.raw>0n)===buy);
    const stable=deltas.filter(t=>(t.mint===usdcMint||t.mint===usdtMint)&&(buy?t.raw<0n:t.raw>0n));
    // Multiple received tokens cannot each be assigned the entire funding leg.
    const amountUsd=sameSide.length===1&&stable.length===1?Number(stable[0].raw<0n?-stable[0].raw:stable[0].raw)/10**stable[0].decimals:undefined;
    return {mint:d.mint,action:buy?"BUY":"SELL",state:buy?(before>0n?"ADDED":"BOUGHT"):(after===0n?"EXITED":before>0n&&after*10n<=before?"MOSTLY_EXITED":"TRIMMED"),amountRaw:(buy?d.raw:-d.raw).toString(),decimals:d.decimals,amountUsd,balanceBeforeRaw:before.toString(),balanceAfterRaw:after.toString()};
  });
}
