import type { ParsedTransactionWithMeta } from "@solana/web3.js";

export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

type Delta = { mint:string; raw:bigint; decimals:number };

export type DecodedSolanaSwap = {
  action:"BUY"|"SELL";
  inputMint:string;
  outputMint:string;
  inputRaw:string;
  outputRaw:string;
  sourcePriceUsd?:number;
  sourceTokenBalanceBeforeRaw?:string;
  sourceTokenBalanceAfterRaw?:string;
  sourceSoldPct?:number;
  inputMethod:"TOKEN_BALANCE"|"NATIVE_SOL_BALANCE";
};

function tokenDeltas(tx:ParsedTransactionWithMeta,wallet:string):Delta[]{
  const pre=tx.meta?.preTokenBalances??[], post=tx.meta?.postTokenBalances??[];
  const map=new Map<string,{raw:bigint;decimals:number}>();
  const apply=(rows:typeof pre,sign:bigint)=>{
    for(const row of rows){
      if(row.owner!==wallet) continue;
      const current=map.get(row.mint)??{raw:0n,decimals:row.uiTokenAmount.decimals};
      current.raw+=sign*BigInt(row.uiTokenAmount.amount||"0");
      current.decimals=row.uiTokenAmount.decimals;
      map.set(row.mint,current);
    }
  };
  apply(post,1n);
  apply(pre,-1n);
  return [...map].map(([mint,value])=>({mint,...value})).filter(delta=>delta.raw!==0n);
}

function ownerMintBalanceRaw(tx:ParsedTransactionWithMeta,wallet:string,mint:string,side:"pre"|"post"){
  const rows=side==="pre"?(tx.meta?.preTokenBalances??[]):(tx.meta?.postTokenBalances??[]);
  return rows.filter(row=>row.owner===wallet&&row.mint===mint).reduce((sum,row)=>sum+BigInt(row.uiTokenAmount.amount||"0"),0n);
}

function nativeSolDelta(tx:ParsedTransactionWithMeta,wallet:string){
  const keys=tx.transaction.message.accountKeys;
  const index=keys.findIndex(key=>key.pubkey.toBase58()===wallet);
  if(index<0||!tx.meta?.preBalances||!tx.meta.postBalances) return 0n;
  const pre=BigInt(tx.meta.preBalances[index]??0);
  const post=BigInt(tx.meta.postBalances[index]??0);
  const fee=index===0?BigInt(tx.meta.fee??0):0n;
  return post-pre+fee;
}

function hasRecognizedSwapProgram(tx:ParsedTransactionWithMeta){
  return (tx.meta?.logMessages??[]).some(message=>message.includes(JUPITER_V6_PROGRAM));
}

function only<T>(values:T[]){
  return values.length===1?values[0]:undefined;
}

export function classifySolanaSwap(
  tx:ParsedTransactionWithMeta,
  wallet:string,
  quoteMints:Set<string>=new Set([SOLANA_USDC,SOLANA_USDT,WRAPPED_SOL]),
  usdStableMint=SOLANA_USDC
):DecodedSolanaSwap|null{
  if(tx.meta?.err) return null;
  const deltas=tokenDeltas(tx,wallet);
  const positives=deltas.filter(delta=>delta.raw>0n);
  const negatives=deltas.filter(delta=>delta.raw<0n);
  const spentQuote=only(negatives.filter(delta=>quoteMints.has(delta.mint)));
  const receivedQuote=only(positives.filter(delta=>quoteMints.has(delta.mint)));
  const boughtToken=only(positives.filter(delta=>!quoteMints.has(delta.mint)));
  const soldToken=only(negatives.filter(delta=>!quoteMints.has(delta.mint)));
  const lamportDelta=nativeSolDelta(tx,wallet);

  let input:Delta|undefined;
  let output:Delta|undefined;
  let action:"BUY"|"SELL"|undefined;
  let inputMethod:DecodedSolanaSwap["inputMethod"]="TOKEN_BALANCE";

  if(spentQuote&&boughtToken){
    input=spentQuote;
    output=boughtToken;
    action="BUY";
  }else if(receivedQuote&&soldToken){
    input=soldToken;
    output=receivedQuote;
    action="SELL";
  }else if(hasRecognizedSwapProgram(tx)&&lamportDelta<0n&&boughtToken&&!spentQuote){
    input={mint:WRAPPED_SOL,raw:lamportDelta,decimals:9};
    output=boughtToken;
    action="BUY";
    inputMethod="NATIVE_SOL_BALANCE";
  }else if(hasRecognizedSwapProgram(tx)&&lamportDelta>0n&&soldToken&&!receivedQuote){
    input=soldToken;
    output={mint:WRAPPED_SOL,raw:lamportDelta,decimals:9};
    action="SELL";
    inputMethod="NATIVE_SOL_BALANCE";
  }else{
    return null;
  }

  const inputRaw=(input.raw<0n?-input.raw:input.raw).toString();
  const outputRaw=(output.raw<0n?-output.raw:output.raw).toString();
  let sourcePriceUsd:number|undefined;
  if(action==="BUY"&&input.mint===usdStableMint){
    const dollars=Number(inputRaw)/(10**input.decimals);
    const tokens=Number(outputRaw)/(10**output.decimals);
    if(Number.isFinite(dollars)&&Number.isFinite(tokens)&&tokens>0) sourcePriceUsd=dollars/tokens;
  }else if(action==="SELL"&&output.mint===usdStableMint){
    const dollars=Number(outputRaw)/(10**output.decimals);
    const tokens=Number(inputRaw)/(10**input.decimals);
    if(Number.isFinite(dollars)&&Number.isFinite(tokens)&&tokens>0) sourcePriceUsd=dollars/tokens;
  }

  let sourceTokenBalanceBeforeRaw:string|undefined;
  let sourceTokenBalanceAfterRaw:string|undefined;
  let sourceSoldPct:number|undefined;
  if(action==="SELL"){
    const before=ownerMintBalanceRaw(tx,wallet,input.mint,"pre");
    const after=ownerMintBalanceRaw(tx,wallet,input.mint,"post");
    sourceTokenBalanceBeforeRaw=before.toString();
    sourceTokenBalanceAfterRaw=after.toString();
    if(before>0n){
      const sold=before>after?before-after:0n;
      sourceSoldPct=Math.max(0,Math.min(100,Number((sold*10000n)/before)/100));
    }
  }

  return {action,inputMint:input.mint,outputMint:output.mint,inputRaw,outputRaw,sourcePriceUsd,sourceTokenBalanceBeforeRaw,sourceTokenBalanceAfterRaw,sourceSoldPct,inputMethod};
}
