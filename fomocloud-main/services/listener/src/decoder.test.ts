import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { classifySolanaSwap, JUPITER_V6_PROGRAM, SOLANA_USDC, SOLANA_USDT, WRAPPED_SOL } from "./decoder.js";

const wallet="11111111111111111111111111111111";
const token="DezXAZ8z7PnrnRJjz3wXBoRgixCa6K5B7xZcB1pPB263";

function fixture(options:{
  pre?:Array<{mint:string;amount:string;decimals:number}>;
  post?:Array<{mint:string;amount:string;decimals:number}>;
  preLamports?:number;
  postLamports?:number;
  fee?:number;
  jupiter?:boolean;
  failed?:boolean;
}):ParsedTransactionWithMeta{
  const rows=(values:typeof options.pre)=>values?.map((value,index)=>({
    accountIndex:index+1,mint:value.mint,owner:wallet,programId:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount:{amount:value.amount,decimals:value.decimals,uiAmount:null,uiAmountString:"0"}
  }))??[];
  return {
    blockTime:1,
    meta:{
      computeUnitsConsumed:1,
      costUnits:1,
      err:options.failed?{InstructionError:[0,"Custom"]}:null,
      fee:options.fee??5000,
      innerInstructions:[],
      loadedAddresses:{readonly:[],writable:[]},
      logMessages:options.jupiter?[`Program ${JUPITER_V6_PROGRAM} invoke [1]`]:[],
      postBalances:[options.postLamports??1_000_000_000],
      postTokenBalances:rows(options.post),
      preBalances:[options.preLamports??1_000_000_000],
      preTokenBalances:rows(options.pre),
      rewards:[]
    },
    slot:1,
    transaction:{
      message:{accountKeys:[{pubkey:new PublicKey(wallet),signer:true,writable:true}],instructions:[],recentBlockhash:"11111111111111111111111111111111"},
      signatures:["5HueCGU8rMjxEXxiPuD5BDuRa1m8QYQLEj5Jprw4J8YFQnPX5QmZphHUfAtvtn2xQn2g8xGmVQ9YwYfD4U8fWb8"]
    },
    version:"legacy"
  } as unknown as ParsedTransactionWithMeta;
}

test("decodes a USDC buy with token decimals and exact source price",()=>{
  const result=classifySolanaSwap(fixture({
    pre:[{mint:SOLANA_USDC,amount:"2000000",decimals:6},{mint:token,amount:"0",decimals:5}],
    post:[{mint:SOLANA_USDC,amount:"1000000",decimals:6},{mint:token,amount:"200000",decimals:5}]
  }),wallet);
  assert.equal(result?.action,"BUY");
  assert.equal(result?.sourcePriceUsd,0.5);
});

test("decodes USDT input without pretending it is an exact USD source price",()=>{
  const result=classifySolanaSwap(fixture({
    pre:[{mint:SOLANA_USDT,amount:"2000000",decimals:6},{mint:token,amount:"0",decimals:5}],
    post:[{mint:SOLANA_USDT,amount:"1000000",decimals:6},{mint:token,amount:"200000",decimals:5}]
  }),wallet);
  assert.equal(result?.action,"BUY");
  assert.equal(result?.sourcePriceUsd,undefined);
});

test("decodes WSOL buys",()=>{
  const result=classifySolanaSwap(fixture({
    pre:[{mint:WRAPPED_SOL,amount:"2000000000",decimals:9},{mint:token,amount:"0",decimals:5}],
    post:[{mint:WRAPPED_SOL,amount:"1000000000",decimals:9},{mint:token,amount:"200000",decimals:5}]
  }),wallet);
  assert.equal(result?.inputMint,WRAPPED_SOL);
  assert.equal(result?.action,"BUY");
});

test("decodes a Jupiter native SOL buy but rejects the same balances without a swap program",()=>{
  const swap=fixture({pre:[{mint:token,amount:"0",decimals:5}],post:[{mint:token,amount:"200000",decimals:5}],preLamports:2_000_000_000,postLamports:999_995_000,fee:5000,jupiter:true});
  const transfer=fixture({pre:[{mint:token,amount:"0",decimals:5}],post:[{mint:token,amount:"200000",decimals:5}],preLamports:2_000_000_000,postLamports:999_995_000,fee:5000,jupiter:false});
  assert.deepEqual(classifySolanaSwap(swap,wallet)?.inputMethod,"NATIVE_SOL_BALANCE");
  assert.equal(classifySolanaSwap(transfer,wallet),null);
});

test("decodes partial and full sells",()=>{
  const partial=classifySolanaSwap(fixture({
    pre:[{mint:token,amount:"1000000",decimals:5},{mint:SOLANA_USDC,amount:"0",decimals:6}],
    post:[{mint:token,amount:"750000",decimals:5},{mint:SOLANA_USDC,amount:"2000000",decimals:6}]
  }),wallet);
  const full=classifySolanaSwap(fixture({
    pre:[{mint:token,amount:"1000000",decimals:5},{mint:SOLANA_USDC,amount:"0",decimals:6}],
    post:[{mint:token,amount:"0",decimals:5},{mint:SOLANA_USDC,amount:"8000000",decimals:6}]
  }),wallet);
  assert.equal(partial?.sourceSoldPct,25);
  assert.equal(full?.sourceSoldPct,100);
});

test("accepts a net multi-hop swap but rejects token transfers, token-to-token ambiguity, and failed transactions",()=>{
  const multiHop=fixture({
    pre:[{mint:SOLANA_USDC,amount:"1000000",decimals:6},{mint:WRAPPED_SOL,amount:"50",decimals:9},{mint:token,amount:"0",decimals:5}],
    post:[{mint:SOLANA_USDC,amount:"0",decimals:6},{mint:WRAPPED_SOL,amount:"50",decimals:9},{mint:token,amount:"200000",decimals:5}]
  });
  const transfer=fixture({pre:[{mint:token,amount:"0",decimals:5}],post:[{mint:token,amount:"200000",decimals:5}]});
  const tokenToToken=fixture({pre:[{mint:token,amount:"200000",decimals:5}],post:[{mint:token,amount:"0",decimals:5},{mint:"7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",amount:"100",decimals:8}]});
  assert.equal(classifySolanaSwap(multiHop,wallet)?.action,"BUY");
  assert.equal(classifySolanaSwap(transfer,wallet),null);
  assert.equal(classifySolanaSwap(tokenToToken,wallet),null);
  assert.equal(classifySolanaSwap(fixture({failed:true,pre:multiHop.meta?.preTokenBalances?.map(row=>({mint:row.mint,amount:row.uiTokenAmount.amount,decimals:row.uiTokenAmount.decimals})),post:multiHop.meta?.postTokenBalances?.map(row=>({mint:row.mint,amount:row.uiTokenAmount.amount,decimals:row.uiTokenAmount.decimals}))}),wallet),null);
});
