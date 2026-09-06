import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { tokenDeltas, ownerMintBalanceRaw, quoteMints, usdcMint, usdtMint, hasRecognizedSwapProgram, nativeSolDelta, walletIsSigner } from "./parsing.js";

export type WalletActivityAction="BUY"|"SELL"|"TRANSFER_IN"|"TRANSFER_OUT";

/**
 * Feeds the PUBLIC activity feed and push alerts.
 *
 * A token balance increase alone is NOT evidence of a buy: a dev/rug wallet can send tokens
 * directly to a tracked wallet to fake a "whale bought" endorsement. BUY/SELL therefore require
 * both (a) the tracked wallet actually signing the transaction, and (b) real trade evidence in it
 * -- an opposite-signed quote-asset delta, a native-SOL leg through a recognized DEX/launchpad
 * program, or a token-for-token swap through such a program. Anything else is TRANSFER_IN /
 * TRANSFER_OUT: stored for audit, never alerted, never counted as smart money.
 */
export function walletTokenActivity(tx:ParsedTransactionWithMeta,wallet:string){
  if(!tx.meta||tx.meta.err||!walletIsSigner(tx,wallet))return [];
  const deltas=tokenDeltas(tx,wallet),tokens=deltas.filter(d=>!quoteMints.has(d.mint)),quoteDeltas=deltas.filter(d=>quoteMints.has(d.mint));
  const lamportDelta=nativeSolDelta(tx,wallet),swapProgram=hasRecognizedSwapProgram(tx);
  return tokens.map(d=>{
    const before=ownerMintBalanceRaw(tx,wallet,d.mint,"pre"),after=ownerMintBalanceRaw(tx,wallet,d.mint,"post"),buy=d.raw>0n;
    const sameSide=tokens.filter(t=>(t.raw>0n)===buy);
    const stable=deltas.filter(t=>(t.mint===usdcMint||t.mint===usdtMint)&&(buy?t.raw<0n:t.raw>0n));
    const quoteEvidence=quoteDeltas.some(q=>buy?q.raw<0n:q.raw>0n);
    // Native SOL only counts when no explicit quote-token leg exists (avoids double-counting a
    // wrap/unwrap that already shows up as a WSOL delta) and only through a real swap program --
    // a plain incoming transfer never moves the tracked wallet's own SOL balance down.
    const nativeEvidence=swapProgram&&quoteDeltas.length===0&&(buy?lamportDelta<0n:lamportDelta>0n);
    // A token-for-token swap routed through a recognized program is still a real trade.
    const tokenSwapEvidence=swapProgram&&tokens.some(t=>t.mint!==d.mint&&(buy?t.raw<0n:t.raw>0n));
    const hasEvidence=quoteEvidence||nativeEvidence||tokenSwapEvidence;
    // Multiple tokens acquired in one transaction cannot each be assigned the entire funding leg --
    // reporting the full stable amount against every one of them would inflate every buy size.
    const amountUsd=hasEvidence&&sameSide.length===1&&stable.length===1?Number(stable[0].raw<0n?-stable[0].raw:stable[0].raw)/10**stable[0].decimals:undefined;
    const action:WalletActivityAction=hasEvidence?(buy?"BUY":"SELL"):(buy?"TRANSFER_IN":"TRANSFER_OUT");
    const state=hasEvidence?(buy?(before>0n?"ADDED":"BOUGHT"):(after===0n?"EXITED":before>0n&&after*10n<=before?"MOSTLY_EXITED":"TRIMMED")):action;
    return {mint:d.mint,action,state,amountRaw:(buy?d.raw:-d.raw).toString(),decimals:d.decimals,amountUsd,balanceBeforeRaw:before.toString(),balanceAfterRaw:after.toString()};
  });
}
