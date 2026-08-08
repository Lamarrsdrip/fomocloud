import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import crypto from "node:crypto";
import { db } from "@fomocloud/db";

const rpc = process.env.SOLANA_RPC_HTTP;
if (!rpc) throw new Error("SOLANA_RPC_HTTP is required for listener");
const conn = new Connection(rpc, process.env.SOLANA_COMMITMENT as any || "confirmed");
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("signals", { connection: redis });
const subscriptions = new Map<string, number>();

function classifySwap(tx: ParsedTransactionWithMeta, wallet: string) {
  // Robust generic fallback based on owner token-balance deltas.
  // Production deployments should add protocol-specific decoders for Jupiter/Raydium/etc.
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const deltas = new Map<string, bigint>();
  const apply = (rows: typeof pre, sign: bigint) => {
    for (const r of rows) {
      if (r.owner !== wallet) continue;
      const amt = BigInt(r.uiTokenAmount.amount || "0");
      deltas.set(r.mint, (deltas.get(r.mint) ?? 0n) + sign * amt);
    }
  };
  apply(post, 1n); apply(pre, -1n);
  const positives = [...deltas.entries()].filter(([, v]) => v > 0n).sort((a,b)=> a[1] > b[1] ? -1 : 1);
  const negatives = [...deltas.entries()].filter(([, v]) => v < 0n).sort((a,b)=> a[1] < b[1] ? -1 : 1);
  if (!positives.length || !negatives.length) return null;
  return { inputMint: negatives[0][0], outputMint: positives[0][0], inputRaw: (-negatives[0][1]).toString(), outputRaw: positives[0][1].toString() };
}

async function handleSignature(traderId: string, wallet: string, signature: string) {
  const existing = await db.sourceTransaction.findUnique({
    where: { chain_txHash_walletAddress: { chain: "SOLANA", txHash: signature, walletAddress: wallet } }
  });
  if (existing) return;

  const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || tx.meta?.err) return;

  await db.sourceTransaction.create({
    data: {
      chain: "SOLANA",
      txHash: signature,
      walletAddress: wallet,
      slot: BigInt(tx.slot),
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
      rawJson: JSON.parse(JSON.stringify(tx))
    }
  });

  const swap = classifySwap(tx, wallet);
  if (!swap) return;

  const idempotencyKey = crypto.createHash("sha256")
    .update(["SOLANA", signature, wallet, swap.outputMint, "BUY"].join(":")).digest("hex");

  const signal = await db.signal.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      idempotencyKey,
      chain: "SOLANA",
      traderId,
      sourceWallet: wallet,
      sourceTx: signature,
      action: "BUY",
      inputMint: swap.inputMint,
      outputMint: swap.outputMint,
      inputRaw: swap.inputRaw,
      outputRaw: swap.outputRaw,
      observedAt: new Date()
    }
  });
  await queue.add("source-buy", { signalId: signal.id }, { jobId: signal.id, attempts: 5, backoff: { type: "exponential", delay: 500 } });
}

async function refreshWatchlist() {
  const wallets = await db.traderWallet.findMany({
    where: { verified: true, trader: { enabled: true, follows: { some: { mode: "AUTO_COPY" } } } },
    include: { trader: true }
  });
  const wanted = new Set(wallets.map(w => w.address));

  for (const [address, id] of subscriptions) {
    if (!wanted.has(address)) {
      await conn.removeOnLogsListener(id);
      subscriptions.delete(address);
    }
  }

  for (const tw of wallets) {
    if (subscriptions.has(tw.address)) continue;
    const pubkey = new PublicKey(tw.address);
    const id = conn.onLogs(pubkey, async logs => {
      try { await handleSignature(tw.traderId, tw.address, logs.signature); }
      catch (e) { console.error("[listener] tx error", logs.signature, e); }
    }, "confirmed");
    subscriptions.set(tw.address, id);
    console.log("[listener] watching", tw.trader.handle, tw.address);
  }
}

await refreshWatchlist();
setInterval(() => refreshWatchlist().catch(console.error), 30_000);
console.log("[listener] running");
