import { Router } from "express";
import crypto from "node:crypto";
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {associatedTokenAddress,createAssociatedTokenAccountInstruction,createTokenTransferInstruction} from "./solanaToken.js";
import { db } from "@memecloud/db";
import { solanaRpcCandidates, pickHealthyRpc } from "@memecloud/shared";
import { getConfig } from "@memecloud/config";
import { PrivySolanaSigner } from "@memecloud/providers";
import { JupiterExecution } from "@memecloud/execution";
import { asyncRoute, routeParam, audit } from "./auth.js";
import { auth, tradeLimiter, type AuthedRequest } from "./middleware.js";
import { verifyPrivyDelegation, recoverManualPrivyHash } from "./trading.js";
import { notificationQueue } from "./queues.js";

export const walletRoutes = Router();

// ------------------------ DELEGATED TRADING PERMISSION ------------------------
// Shared by both the existing "delegate an already-connected external wallet" flow and the new
// "create a MemeCloud embedded wallet" flow below. verifyPrivyDelegation independently re-fetches
// the wallet from Privy's own API and checks the actual additional_signers/policy_ids grants
// server-side before ever marking tradingEnabled:true (see apps/api/src/trading.ts).
walletRoutes.post("/v1/me/wallets/:id/enable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  if(wallet.chain!=="SOLANA")return res.status(400).json({error:"AUTOMATION_CHAIN_NOT_IMPLEMENTED"});
  const privyWalletId=String(req.body?.privyWalletId??"").trim();
  if(!privyWalletId)return res.status(400).json({error:"PRIVY_WALLET_ID_REQUIRED"});
  const check=await verifyPrivyDelegation(privyWalletId,wallet.address);
  if(!check.ok)return res.status(check.status).json({error:check.error});
  const expiryRaw=req.body?.permissionExpiry;const expiry=expiryRaw?new Date(String(expiryRaw)):new Date(Date.now()+30*24*60*60_000);
  if(!Number.isFinite(expiry.getTime())||expiry<=new Date())return res.status(400).json({error:"INVALID_PERMISSION_EXPIRY"});
  const updated=await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry}});
  await audit(req.user.sub,"USER","ENABLE_DELEGATED_TRADING",wallet.id,{provider:"PRIVY",permissionExpiry:expiry.toISOString()});
  res.json({wallet:{id:updated.id,chain:updated.chain,address:updated.address,tradingEnabled:true,permissionExpiry:updated.permissionExpiry}});
}));
// ------------------------ EMBEDDED WALLET (created + delegated client-side via Privy, never a
// plaintext key/seed touching this backend) ------------------------
// The client already: (1) created a Privy embedded Solana wallet for the logged-in user via
// useCreateWallet, (2) granted MemeCloud's restricted signer+policy via useSigners().addSigners.
// This endpoint independently re-verifies both facts against Privy's own API (verifyPrivyDelegation
// above) before ever creating a Wallet row or marking it tradingEnabled -- the client's report of
// its own success is never trusted on its own.
walletRoutes.post("/v1/me/wallets/embedded", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const privyWalletId=String(req.body?.privyWalletId??"").trim();
  const address=String(req.body?.address??"").trim();
  if(!privyWalletId||!address)return res.status(400).json({error:"PRIVY_WALLET_ID_AND_ADDRESS_REQUIRED"});
  const check=await verifyPrivyDelegation(privyWalletId,address);
  if(!check.ok)return res.status(check.status).json({error:check.error});
  // Ownership must be checked BEFORE any write -- upserting straight through would silently
  // re-point another user's existing wallet row at this request's delegation if the address
  // somehow already belonged to someone else (practically unreachable for a freshly Privy-
  // generated keypair, but a real cross-account correctness bug if it were ever possible).
  const existing=await db.wallet.findUnique({where:{chain_address:{chain:"SOLANA",address}}});
  if(existing&&existing.userId!==req.user.sub)return res.status(409).json({error:"WALLET_ALREADY_LINKED_TO_ANOTHER_ACCOUNT"});
  const expiry=new Date(Date.now()+30*24*60*60_000);
  const count=await db.wallet.count({where:{userId:req.user.sub}});
  const wallet=await db.wallet.upsert({
    where:{chain_address:{chain:"SOLANA",address}},
    create:{userId:req.user.sub,chain:"SOLANA",address,isPrimary:count===0,label:"MemeCloud wallet",tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry},
    update:{tradingEnabled:true,permissionRef:privyWalletId,permissionExpiry:expiry}
  });
  await audit(req.user.sub,"USER","CREATE_EMBEDDED_WALLET",wallet.id,{provider:"PRIVY",permissionExpiry:expiry.toISOString()});
  res.status(201).json({wallet:{id:wallet.id,chain:wallet.chain,address:wallet.address,isPrimary:wallet.isPrimary,tradingEnabled:true,permissionExpiry:wallet.permissionExpiry}});
}));
walletRoutes.post("/v1/me/wallets/:id/disable-automation", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  await db.wallet.update({where:{id:wallet.id},data:{tradingEnabled:false,permissionRef:null,permissionExpiry:null}});
  await db.globalTradingSettings.updateMany({where:{userId:req.user.sub},data:{autoCopyEnabled:false}});
  await audit(req.user.sub,"USER","REVOKE_DELEGATED_TRADING",wallet.id);res.json({ok:true});
}));

// ------------------------ WALLET TRANSACTION HISTORY (real on-chain reads) ------------------------
// Real gap found by forensic audit (M-33): services/balance-worker has synced real on-chain
// USDC/SOL balances into WalletAssetBalance every cycle since commit 8eae454, but nothing ever
// read it back out -- WalletDetailSheet.tsx's own comment documents deliberately showing NO
// balance at all client-side because the only data it had access to was USD-denominated
// TradingCashAllocation, not real on-chain SOL/USDC amounts, and displaying that would have looked
// fabricated. This route closes that gap with what was already being computed correctly.
walletRoutes.get("/v1/me/wallets/:id/balances", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const rows=await db.walletAssetBalance.findMany({where:{walletId:wallet.id},orderBy:{lastSyncedAt:"desc"}});
  // Real amount as a decimal string (not Number, to avoid precision loss on large-decimals tokens)
  // is computed server-side once here rather than asking every consumer to redo BigInt/decimals
  // math -- same rationale as rawToDecimalString in services/balance-worker/src/deposits.ts.
  const balances=rows.map(r=>{
    const raw=BigInt(r.rawBalance),base=10n**BigInt(r.decimals);
    const whole=raw/base,frac=(raw%base).toString().padStart(r.decimals,"0").replace(/0+$/,"");
    return {assetMint:r.assetMint,symbol:r.symbol,decimals:r.decimals,amount:frac?`${whole}.${frac}`:whole.toString(),supported:r.supported,lastSyncedAt:r.lastSyncedAt};
  });
  // Freshness signal so the UI can distinguish "synced moments ago" from "this hasn't updated in a
  // while" (balance-worker outage) -- never silently show a stale number as if it were live.
  const mostRecentSync=rows.length?rows.reduce((a,r)=>r.lastSyncedAt>a?r.lastSyncedAt:a,rows[0].lastSyncedAt):null;
  res.json({balances,dataFreshnessSec:mostRecentSync?Math.round((Date.now()-mostRecentSync.getTime())/1000):null});
}));
// Real gap found by forensic audit: a private-key export is the single most sensitive action a
// wallet supports, and nothing anywhere recorded that one had happened -- no audit trail, no
// user-visible record, no security notification. The export itself already goes through Privy's
// own secure, MemeCloud-inaccessible modal (see SecurityTab in WalletDetailSheet.tsx); this route
// only records the fact that the user completed it, called from the client immediately after
// Privy's exportWallet() call resolves. Deliberately does NOT and CANNOT know the key itself.
walletRoutes.post("/v1/me/wallets/:id/exported", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const title="Wallet private key exported";
  const body=`Your private key for ${wallet.address.slice(0,6)}…${wallet.address.slice(-5)} was exported to an external wallet app. If this wasn't you, your device or account may be compromised -- contact support immediately.`;
  await audit(req.user.sub,"USER","WALLET_KEY_EXPORTED",wallet.id,{address:wallet.address});
  await db.userActivityEvent.create({data:{userId:req.user.sub,type:"SECURITY_ALERT",title,body,data:{walletId:wallet.id,address:wallet.address} as any}}).catch(()=>{});
  // Security notifications are enqueued the same way every other real-time user notification is
  // (see brain-worker/executor/exits) rather than sent synchronously here, so a transient
  // push/email provider hiccup can't fail this request or, worse, silently drop the alert with no
  // retry -- notification-worker's BullMQ attempts/backoff cover that.
  const deliveryKey=`wallet-export:${wallet.id}:${Date.now()}`;
  await notificationQueue.add("notify",{userId:req.user.sub,type:"SECURITY_ALERT",title,body,data:{url:"/app/?view=profile"},deliveryKey},{jobId:deliveryKey,removeOnComplete:1000,attempts:3,backoff:{type:"exponential",delay:1000}}).catch(()=>{});
  res.json({ok:true});
}));
walletRoutes.get("/v1/me/wallets/:id/history", auth, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub,chain:"SOLANA"}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const marketCfg=await getConfig<any>("marketData");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[api]");
  if(!rpc)return res.json({transactions:[],rpcConfigured:false});
  const conn=new Connection(rpc,"confirmed");
  const usdcMint=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  let sigs;
  try{
    sigs=await conn.getSignaturesForAddress(new PublicKey(wallet.address),{limit:20});
  }catch(e:any){
    // The RPC IS configured (checked above) -- this is a live call failing, most likely the
    // documented Helius rate-limit/quota exhaustion. Distinct from "not configured" so the client
    // shows an honest "temporarily unavailable" state instead of a misleading configuration error,
    // and distinct from a raw 500 so a genuine backend bug isn't masked as an external outage.
    return res.json({transactions:[],rpcConfigured:true,rpcError:String(e?.message??e)});
  }
  const transactions=await Promise.all(sigs.map(async s=>{
    if(s.err)return {signature:s.signature,blockTime:s.blockTime,status:"FAILED" as const};
    try{
      const tx=await conn.getParsedTransaction(s.signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
      if(!tx||!tx.meta)return {signature:s.signature,blockTime:s.blockTime,status:"UNKNOWN" as const};
      const idx=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey.toBase58()===wallet.address);
      const solDeltaSol=idx>=0?(tx.meta.postBalances[idx]-tx.meta.preBalances[idx])/1e9:0;
      const usdcOf=(rows:typeof tx.meta.preTokenBalances)=>(rows??[]).filter(b=>b.owner===wallet.address&&b.mint===usdcMint).reduce((a,b)=>a+Number(b.uiTokenAmount.amount||0),0);
      const usdcDelta=(usdcOf(tx.meta.postTokenBalances)-usdcOf(tx.meta.preTokenBalances))/1e6;
      return {signature:s.signature,blockTime:s.blockTime,status:"CONFIRMED" as const,solDeltaSol,usdcDelta,feeSol:(tx.meta.fee??0)/1e9};
    }catch{
      // A transaction this old may have fallen out of the RPC's retained history, or the RPC
      // itself may be rate-limited (documented external Helius blocker) -- surface it honestly as
      // unresolved rather than silently dropping the row or fabricating a delta.
      return {signature:s.signature,blockTime:s.blockTime,status:"UNKNOWN" as const};
    }
  }));
  res.json({transactions,rpcConfigured:true});
}));

// ------------------------ WALLET SEND (real on-chain transfer, signed via the same delegated
// Privy signer already used for trade execution) ------------------------
walletRoutes.post("/v1/me/wallets/:id/send", auth, tradeLimiter, asyncRoute(async (req:AuthedRequest,res) => {
  const wallet=await db.wallet.findFirst({where:{id:routeParam(req.params.id),userId:req.user.sub,chain:"SOLANA"}});
  if(!wallet)return res.status(404).json({error:"WALLET_NOT_FOUND"});
  const permitted=wallet.tradingEnabled&&wallet.permissionRef&&(!wallet.permissionExpiry||wallet.permissionExpiry>new Date());
  if(!permitted)return res.status(409).json({error:"TRADING_PERMISSION_REQUIRED",message:"This wallet has no active delegated signing permission, so MemeCloud cannot sign a send on its behalf."});

  const asset=String(req.body?.asset??"").toUpperCase();
  if(asset!=="SOL"&&asset!=="USDC")return res.status(400).json({error:"INVALID_ASSET"});
  const toAddressRaw=String(req.body?.toAddress??"").trim();
  const amount=Number(req.body?.amount??0);
  const clientRequestId=String(req.body?.clientRequestId??"").trim();
  if(!clientRequestId||!/^[a-zA-Z0-9-]{8,64}$/.test(clientRequestId))return res.status(400).json({error:"CLIENT_REQUEST_ID_REQUIRED"});
  if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"INVALID_AMOUNT"});
  if(toAddressRaw===wallet.address)return res.status(400).json({error:"CANNOT_SEND_TO_SELF"});
  let toPubkey:PublicKey;
  try{toPubkey=new PublicKey(toAddressRaw)}catch{return res.status(400).json({error:"INVALID_DESTINATION_ADDRESS"})}

  const marketCfg=await getConfig<any>("marketData");
  const rpc=await pickHealthyRpc(solanaRpcCandidates(marketCfg),"[api]");
  if(!rpc)return res.status(409).json({error:"SOLANA_RPC_REQUIRED"});
  const signerCfg=await getConfig<any>("signer");
  const privyAppId=signerCfg?.privyAppId||process.env.PRIVY_APP_ID,privyAppSecret=signerCfg?.privyAppSecret||process.env.PRIVY_APP_SECRET;
  const privyAuthKey=signerCfg?.privyAuthorizationPrivateKey||process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  if(!privyAppId||!privyAppSecret)return res.status(503).json({error:"DELEGATED_SIGNER_NOT_CONFIGURED"});
  const sponsorGas=Boolean(signerCfg?.sponsorGas);
  const privy=new PrivySolanaSigner({appId:privyAppId,appSecret:privyAppSecret,authorizationPrivateKey:privyAuthKey,sponsorGas});
  // Only used for its generic waitConfirmed() (a plain signature-status poll, no Jupiter API call
  // involved) -- same shared execution utility the manual-trade route already constructs, not a
  // Jupiter-specific step for a plain transfer.
  const execCfg=await getConfig<any>("execution");
  const jupiter=new JupiterExecution(execCfg?.jupiterBaseUrl||process.env.JUPITER_API_BASE,execCfg?.jupiterApiKey||process.env.JUPITER_API_KEY);

  const key=`send:${req.user.sub}:${clientRequestId}`;
  const fromPubkey=new PublicKey(wallet.address);
  const usdcMint=process.env.USDC_MINT_SOLANA??"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  try{
    const conn=new Connection(rpc,"confirmed");

    // Idempotent resume: an existing attempt for this exact client request either already has a
    // hash (return it) or is ambiguous and must be reconciled via Privy's own reference lookup
    // before ever considering a resubmit -- never a blind retry of a real-money transfer.
    const existing=await db.liveExecutionAttempt.findUnique({where:{idempotencyKey:key}});
    if(existing){
      if(existing.status==="CONFIRMED"&&existing.txHash)return res.status(200).json({ok:true,txHash:existing.txHash});
      const ref=existing.idempotencyKey.slice(0,64);
      const recovered=existing.txHash||await recoverManualPrivyHash(privy,ref);
      if(!recovered)return res.status(409).json({error:"AMBIGUOUS_PRIOR_SEND_ATTEMPT",message:"A previous send for this exact request has no confirmed result yet and cannot be safely resubmitted. Try again shortly."});
      await db.liveExecutionAttempt.update({where:{id:existing.id},data:{status:"SUBMITTED",txHash:recovered}});
      await jupiter.waitConfirmed(rpc,recovered,60_000);
      await db.liveExecutionAttempt.update({where:{id:existing.id},data:{status:"CONFIRMED",txHash:recovered}});
      await audit(req.user.sub,"USER","WALLET_SEND",wallet.id,{asset,toAddress:toAddressRaw,amount,txHash:recovered});
      return res.status(200).json({ok:true,txHash:recovered});
    }

    const instructions=[];
    if(asset==="SOL"){
      const lamports=Math.round(amount*1_000_000_000);
      const balance=await conn.getBalance(fromPubkey,"confirmed");
      const feeReserveLamports=sponsorGas?0:10_000;
      if(lamports+feeReserveLamports>balance)return res.status(409).json({error:"INSUFFICIENT_BALANCE",message:"This wallet does not have enough SOL to cover the amount plus network fees."});
      // Real gap found by audit: a partial send that leaves the source account below Solana's
      // rent-exempt minimum (~0.00089 SOL) isn't caught up front -- it either fails on-chain with a
      // confusing error, or silently gets rejected by the RPC. Leaving exactly 0 (a full sweep) is
      // fine; anything else below the minimum is refused clearly before ever building the tx.
      const remainingLamports=balance-lamports-feeReserveLamports;
      const RENT_EXEMPT_MIN_LAMPORTS=890_880;
      if(remainingLamports>0&&remainingLamports<RENT_EXEMPT_MIN_LAMPORTS)return res.status(409).json({error:"LEAVES_DUST_BELOW_RENT_EXEMPTION",message:`Sending this amount would leave a tiny leftover balance Solana doesn't allow (below the rent-exempt minimum). Send the full balance instead, or a smaller amount.`});
      instructions.push(SystemProgram.transfer({fromPubkey,toPubkey,lamports}));
    }else{
      const amountRaw=BigInt(Math.round(amount*1_000_000));
      const mint=new PublicKey(usdcMint);
      const sourceAta=associatedTokenAddress(mint,fromPubkey);
      const destAta=associatedTokenAddress(mint,toPubkey);
      // Real bug found by a full-platform audit: catching every failure here as null (-> treated
      // as a genuine $0 balance) conflated two very different facts -- "this wallet's USDC token
      // account has never been created, so it really does hold zero" (legitimate, common, safe to
      // treat as 0) vs. "the RPC call itself failed" (rate-limit/timeout/network -- balance is
      // UNKNOWN, not zero). The second case was silently telling real, funded users they had
      // insufficient balance. Only a genuine "account does not exist" response means real zero.
      let sourceRaw:bigint;
      let destInfo:Awaited<ReturnType<typeof conn.getAccountInfo>>;
      try{
        const [sourceBalance,dest]=await Promise.all([
          conn.getTokenAccountBalance(sourceAta,"confirmed").catch((e:any)=>{
            const msg=String(e?.message??e??"");
            if(/could not find account|invalid param|account.*not.*found/i.test(msg))return {value:{amount:"0"}} as any;
            throw e;
          }),
          conn.getAccountInfo(destAta,"confirmed")
        ]);
        sourceRaw=BigInt(sourceBalance?.value?.amount??"0");
        destInfo=dest;
      }catch(e:any){
        return res.status(503).json({error:"BALANCE_CHECK_FAILED",message:"MemeCloud could not verify this wallet's USDC balance right now (the Solana RPC provider may be rate-limited). Please try again shortly."});
      }
      if(amountRaw>sourceRaw)return res.status(409).json({error:"INSUFFICIENT_BALANCE",message:"This wallet does not have enough USDC to cover this amount."});
      if(!destInfo){
        // Recipient has no USDC token account yet -- this wallet pays to create it (standard
        // practice; costs a small amount of rent-exempt SOL), same as any real Solana wallet app.
        const solBalance=await conn.getBalance(fromPubkey,"confirmed");
        if(solBalance<3_000_000)return res.status(409).json({error:"INSUFFICIENT_SOL_FOR_ATA",message:"The recipient has no USDC account yet and this wallet needs a small amount of SOL to create one."});
        instructions.push(createAssociatedTokenAccountInstruction(fromPubkey,destAta,toPubkey,mint));
      }
      instructions.push(createTokenTransferInstruction(sourceAta,destAta,fromPubkey,amountRaw));
    }

    const {blockhash}=await conn.getLatestBlockhash("confirmed");
    const message=new TransactionMessage({payerKey:fromPubkey,recentBlockhash:blockhash,instructions}).compileToV0Message();
    const built=Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

    await db.liveExecutionAttempt.create({data:{idempotencyKey:key,userId:req.user.sub,purpose:"SEND",chain:"SOLANA",walletAddress:wallet.address,provider:"PRIVY",providerRef:wallet.permissionRef!,status:"SIGNING",requestHash:crypto.createHash("sha256").update(built).digest("hex")}});
    let hash:string;
    try{
      const sent=await privy.signAndSend(wallet.permissionRef!,built,key.slice(0,64));
      hash=sent.hash;
      await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"SUBMITTED",txHash:hash}});
    }catch(e:any){
      const recovered=await recoverManualPrivyHash(privy,key.slice(0,64));
      if(!recovered){
        await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"FAILED",errorCode:String(e?.code??"AMBIGUOUS_SEND_ATTEMPT"),errorMessage:String(e?.message??e)}}).catch(()=>{});
        await db.riskIncident.create({data:{severity:"CRITICAL",scope:"LIVE_EXECUTION",userId:req.user.sub,chain:"SOLANA",code:String(e?.code??"AMBIGUOUS_SEND_ATTEMPT"),detail:{message:String(e?.message??e),referenceId:key.slice(0,64),asset,toAddress:toAddressRaw,amount}}}).catch(()=>{});
        return res.status(502).json({error:"SEND_SUBMIT_FAILED",message:"MemeCloud could not confirm whether this send reached Solana. It has not been retried automatically."});
      }
      hash=recovered;
      await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"SUBMITTED",txHash:hash}}).catch(()=>{});
    }
    await jupiter.waitConfirmed(rpc,hash,60_000);
    await db.liveExecutionAttempt.update({where:{idempotencyKey:key},data:{status:"CONFIRMED",txHash:hash}});
    await audit(req.user.sub,"USER","WALLET_SEND",wallet.id,{asset,toAddress:toAddressRaw,amount,txHash:hash});
    res.status(200).json({ok:true,txHash:hash});
  }catch(e:any){
    res.status(409).json({error:e?.code||"SEND_FAILED",message:e?.message||"This send could not be completed."});
  }
}));
