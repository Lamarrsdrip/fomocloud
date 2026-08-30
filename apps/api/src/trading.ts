import { db } from "@memecloud/db";
import { getConfig } from "@memecloud/config";
import { PrivySolanaSigner } from "@memecloud/providers";
import { Connection } from "@solana/web3.js";

export const USDC_SOL="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function manualTradeTrader(){
  const handle="memecloud-manual-trade";
  const existing=await db.trader.findUnique({where:{handle}});
  if(existing) return existing;
  return db.trader.create({data:{handle,displayName:"Manual trade",bio:"Trades a user places directly from Discover.",category:"MANUAL",verification:"VERIFIED",kind:"PLATFORM",enabled:true,trackingStatus:"TRACKING"}});
}
export async function reconcileConfirmedManualSwap(rpc:string,signature:string,owner:string,inputMint:string,outputMint:string){
  const conn=new Connection(rpc,"confirmed");
  const tx=await conn.getParsedTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!tx||tx.meta?.err)throw Object.assign(new Error("CONFIRMED_TRANSACTION_UNAVAILABLE"),{code:"RECONCILIATION_FAILED"});
  const bal=(side:"pre"|"post",mint:string)=>((side==="pre"?tx.meta?.preTokenBalances:tx.meta?.postTokenBalances)??[]).filter((x:any)=>x.owner===owner&&x.mint===mint).reduce((a:bigint,x:any)=>a+BigInt(x.uiTokenAmount?.amount??"0"),0n);
  const inPre=bal("pre",inputMint),inPost=bal("post",inputMint),outPre=bal("pre",outputMint),outPost=bal("post",outputMint);
  const actualInput=inPre>inPost?inPre-inPost:0n, actualOutput=outPost>outPre?outPost-outPre:0n;
  if(actualInput<=0n||actualOutput<=0n)throw Object.assign(new Error("CONFIRMED_SWAP_DELTAS_INVALID"),{code:"RECONCILIATION_FAILED"});
  return {actualInputRaw:actualInput.toString(),actualOutputRaw:actualOutput.toString()};
}
export async function recoverManualPrivyHash(privy:PrivySolanaSigner,referenceId:string){
  try{
    const tx:any=await privy.transactionByReferenceId(referenceId);
    const status=String(tx?.status??"").toLowerCase();
    if(["failed","reverted","provider_error"].includes(status))return null;
    return String(tx?.transaction_hash??tx?.hash??"")||null;
  }catch(e){console.warn("[manual-trade] Privy reference recovery unavailable",referenceId,e);return null}
}

// ------------------------ DELEGATED TRADING PERMISSION ------------------------
// Shared by both the existing "delegate an already-connected external wallet" flow and the new
// "create a MemeCloud embedded wallet" flow. Never trust the client's claim that delegation
// succeeded -- independently re-fetch the wallet from Privy's own API and check the actual
// additional_signers/policy_ids grants server-side before ever marking tradingEnabled:true. This is
// the same verification the delegated-execution path (executor/exits' signAndSend) implicitly
// depends on being correct, so it must never be weakened for either caller.
export type PrivyDelegationCheck =
  | { ok:true; provider:PrivySolanaSigner; remote:any }
  | { ok:false; status:number; error:string };
export async function verifyPrivyDelegation(privyWalletId:string, expectedAddress?:string):Promise<PrivyDelegationCheck>{
  const cfg=await getConfig<any>("signer");
  const appId=cfg?.privyAppId||process.env.PRIVY_APP_ID,appSecret=cfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const authKey=cfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const expectedSigner=cfg?.privySignerId||process.env.PRIVY_SIGNER_ID;
  const expectedPolicy=cfg?.privyPolicyId||process.env.PRIVY_POLICY_ID;
  if(!appId||!appSecret||!authKey||!expectedSigner||!expectedPolicy)return {ok:false,status:503,error:"DELEGATED_SIGNER_NOT_CONFIGURED"};
  const provider=new PrivySolanaSigner({appId,appSecret,authorizationPrivateKey:authKey,sponsorGas:Boolean(cfg?.sponsorGas)});
  const remote:any=await provider.getWallet(privyWalletId);
  if(String(remote?.chain_type??"").toLowerCase()!=="solana")return {ok:false,status:400,error:"PRIVY_WALLET_NOT_SOLANA"};
  if(expectedAddress&&String(remote?.address??"")!==expectedAddress)return {ok:false,status:400,error:"PRIVY_WALLET_ADDRESS_MISMATCH"};
  const signers=Array.isArray(remote?.additional_signers)?remote.additional_signers:[];
  const signer=signers.find((x:any)=>String(x?.signer_id??x?.id??"")===expectedSigner);
  const policies=[...(Array.isArray(remote?.policy_ids)?remote.policy_ids:[]),...(Array.isArray(signer?.override_policy_ids)?signer.override_policy_ids:[])].map(String);
  if(!signer)return {ok:false,status:400,error:"RESTRICTED_SIGNER_NOT_GRANTED_BY_USER"};
  if(!policies.includes(String(expectedPolicy)))return {ok:false,status:400,error:"REQUIRED_TRADING_POLICY_NOT_GRANTED"};
  return {ok:true,provider,remote};
}
