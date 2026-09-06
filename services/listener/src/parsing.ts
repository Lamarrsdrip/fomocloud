import type { ParsedTransactionWithMeta } from "@solana/web3.js";

// Extracted from index.ts (a service entrypoint with real top-level side effects -- config
// fetch, Solana RPC connection, Redis/BullMQ queues on import) so this pure parsing logic can be
// unit tested without triggering any of that. Real gap found by forensic audit (M-51): this
// service's test script was `echo listener tests`, despite classifySwap being directly
// responsible for sourcePriceUsd and sourceSoldPct -- the exact numbers that drive copy-trade
// chase % and mirror-sell sizing for real followers' money. A misclassified BUY/SELL or a wrong
// sourceSoldPct here would size or time a real copy trade incorrectly.

const DEFAULT_QUOTES = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // WSOL
];
export const quoteMints = new Set((process.env.SOLANA_QUOTE_MINTS ?? DEFAULT_QUOTES.join(",")).split(",").map((x) => x.trim()).filter(Boolean));
export const usdcMint = process.env.USDC_MINT_SOLANA ?? DEFAULT_QUOTES[0];
export const usdtMint = DEFAULT_QUOTES[1];
export const wrappedSolMint = DEFAULT_QUOTES[2];

// Every real Solana DEX/launchpad program a tracked-wallet swap can route through. Deliberately
// NOT used to gate the quote-asset path above -- that path is quote-mint-balance evidence alone,
// already sufficient. This list only backs the native-SOL fallback below: the Solana runtime logs
// "Program <id> invoke [depth]" for every CPI at any depth, so substring-matching logMessages
// catches a swap routed as an inner instruction of an aggregator (e.g. Jupiter -> Pump.fun/Raydium)
// as well as a direct call. A plain SPL transfer or airdrop never invokes any of these.
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const RAYDIUM_AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAYDIUM_LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"; // bonk.fun launches
export const BONK_FUN_PROGRAM = "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1";
export const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const DEFAULT_SWAP_PROGRAMS = [
  JUPITER_V6_PROGRAM, PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM, RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CPMM_PROGRAM, RAYDIUM_CLMM_PROGRAM, RAYDIUM_LAUNCHLAB_PROGRAM, BONK_FUN_PROGRAM, ORCA_WHIRLPOOL_PROGRAM,
];
export const swapProgramIds = new Set((process.env.SOLANA_SWAP_PROGRAM_IDS ?? DEFAULT_SWAP_PROGRAMS.join(",")).split(",").map((x) => x.trim()).filter(Boolean));

export function hasRecognizedSwapProgram(tx: ParsedTransactionWithMeta) {
  const logs = tx.meta?.logMessages ?? [];
  for (const line of logs) for (const id of swapProgramIds) if (line.includes(id)) return true;
  return false;
}

export function nativeSolDelta(tx: ParsedTransactionWithMeta, wallet: string) {
  const keys = tx.transaction?.message?.accountKeys as any[] | undefined;
  if (!keys || !tx.meta?.preBalances || !tx.meta.postBalances) return 0n;
  const index = keys.findIndex((k) => (k?.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k?.pubkey ?? k)) === wallet);
  if (index < 0) return 0n;
  const pre = BigInt(tx.meta.preBalances[index] ?? 0);
  const post = BigInt(tx.meta.postBalances[index] ?? 0);
  const fee = index === 0 ? BigInt(tx.meta.fee ?? 0) : 0n;
  return post - pre + fee;
}

export type Delta = { mint: string; raw: bigint; decimals: number };

export function tokenDeltas(tx: ParsedTransactionWithMeta, wallet: string): Delta[] {
  const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
  const map = new Map<string, { raw: bigint; decimals: number }>();
  const apply = (rows: typeof pre, sign: bigint) => {
    for (const r of rows) {
      const peer=[...pre,...post].find(p=>p.accountIndex!=null&&p.accountIndex===r.accountIndex&&p.mint===r.mint);
      if ((r.owner||peer?.owner) !== wallet) continue;
      const cur = map.get(r.mint) ?? { raw: 0n, decimals: r.uiTokenAmount.decimals };
      cur.raw += sign * BigInt(r.uiTokenAmount.amount || "0"); cur.decimals = r.uiTokenAmount.decimals;
      map.set(r.mint, cur);
    }
  };
  apply(post, 1n); apply(pre, -1n);
  return [...map].map(([mint, v]) => ({ mint, ...v })).filter((x) => x.raw !== 0n);
}

export function ownerMintBalanceRaw(tx: ParsedTransactionWithMeta, wallet: string, mint: string, side: "pre" | "post") {
  const rows = side === "pre" ? (tx.meta?.preTokenBalances ?? []) : (tx.meta?.postTokenBalances ?? []);
  return rows.filter((r) => (r.owner||[...(tx.meta?.preTokenBalances??[]),...(tx.meta?.postTokenBalances??[])].find(p=>p.accountIndex!=null&&p.accountIndex===r.accountIndex&&p.mint===r.mint)?.owner) === wallet && r.mint === mint).reduce((a, r) => a + BigInt(r.uiTokenAmount.amount || "0"), 0n);
}

export function classifySwap(tx: ParsedTransactionWithMeta, wallet: string) {
  if (tx.meta?.err) return null;
  const deltas = tokenDeltas(tx, wallet);
  const positives = deltas.filter((x) => x.raw > 0n).sort((a, b) => (a.raw > b.raw ? -1 : 1));
  const negatives = deltas.filter((x) => x.raw < 0n).sort((a, b) => (a.raw < b.raw ? -1 : 1));

  // Prefer a clear quote-asset <-> token leg. This prevents treating every token transfer as a buy.
  const spentQuote = negatives.find((x) => quoteMints.has(x.mint));
  const receivedQuote = positives.find((x) => quoteMints.has(x.mint));
  const boughtToken = positives.find((x) => !quoteMints.has(x.mint));
  const soldToken = negatives.find((x) => !quoteMints.has(x.mint));
  let input: Delta | undefined, output: Delta | undefined, action: "BUY" | "SELL";
  let inputMethod: "TOKEN_BALANCE" | "NATIVE_SOL_BALANCE" = "TOKEN_BALANCE";
  if (spentQuote && boughtToken) {
    input = spentQuote; output = boughtToken; action = "BUY";
  } else if (receivedQuote && soldToken) {
    input = soldToken; output = receivedQuote; action = "SELL";
  } else {
    // No SPL quote leg (e.g. a Pump.fun buy paid in native SOL, never touching a WSOL token
    // account). Only trust this when a real swap/launchpad program was actually invoked --
    // otherwise a plain inbound token transfer plus unrelated fee/rent lamport drift would
    // masquerade as a "BUY", which is exactly the fake-endorsement gap this guards against.
    const lamportDelta = nativeSolDelta(tx, wallet);
    if (hasRecognizedSwapProgram(tx) && lamportDelta < 0n && boughtToken && !spentQuote) {
      input = { mint: wrappedSolMint, raw: lamportDelta, decimals: 9 }; output = boughtToken; action = "BUY"; inputMethod = "NATIVE_SOL_BALANCE";
    } else if (hasRecognizedSwapProgram(tx) && lamportDelta > 0n && soldToken && !receivedQuote) {
      input = soldToken; output = { mint: wrappedSolMint, raw: lamportDelta, decimals: 9 }; action = "SELL"; inputMethod = "NATIVE_SOL_BALANCE";
    } else {
      // Token-to-token with no recognized quote, or no real trade evidence at all; don't invent a copy signal.
      return null;
    }
  }
  if (!input || !output) return null;

  const inputRaw = (input.raw < 0n ? -input.raw : input.raw).toString();
  const outputRaw = (output.raw < 0n ? -output.raw : output.raw).toString();
  let sourcePriceUsd: number | undefined;
  if (action === "BUY" && input.mint === usdcMint) {
    const dollars = Number(inputRaw) / 10 ** input.decimals;
    const tokens = Number(outputRaw) / 10 ** output.decimals;
    if (Number.isFinite(dollars) && Number.isFinite(tokens) && tokens > 0) sourcePriceUsd = dollars / tokens;
  } else if (action === "SELL" && output.mint === usdcMint) {
    const dollars = Number(outputRaw) / 10 ** output.decimals;
    const tokens = Number(inputRaw) / 10 ** input.decimals;
    if (Number.isFinite(dollars) && Number.isFinite(tokens) && tokens > 0) sourcePriceUsd = dollars / tokens;
  }
  let sourceTokenBalanceBeforeRaw: string | undefined, sourceTokenBalanceAfterRaw: string | undefined, sourceSoldPct: number | undefined;
  if (action === "SELL") {
    const before = ownerMintBalanceRaw(tx, wallet, input.mint, "pre"), after = ownerMintBalanceRaw(tx, wallet, input.mint, "post");
    sourceTokenBalanceBeforeRaw = before.toString(); sourceTokenBalanceAfterRaw = after.toString();
    if (before > 0n) {
      const sold = before > after ? before - after : 0n;
      sourceSoldPct = Math.max(0, Math.min(100, Number((sold * 10000n) / before) / 100));
    }
  }
  const quoteLeg=action==="BUY"?input:output;
  const quoteRaw=BigInt(action==="BUY"?inputRaw:outputRaw);
  const quoteAmount=Number(quoteRaw)/10**quoteLeg.decimals;
  const amountUsd=(quoteLeg.mint===usdcMint||quoteLeg.mint===usdtMint)&&Number.isFinite(quoteAmount)?quoteAmount:undefined;
  return { action, inputMint: input.mint, outputMint: output.mint, inputRaw, outputRaw, sourcePriceUsd, sourceTokenBalanceBeforeRaw, sourceTokenBalanceAfterRaw, sourceSoldPct, amountUsd, inputMethod };
}

// Extracted for the same reason as the rest of this file: the pure "should we tear down and
// reopen the connection" decision, testable without a real Solana Connection. See index.ts's
// pollSlotLiveness -- conn.onLogs websocket subscriptions have no built-in liveness/reconnect, so
// a silent drop (confirmed live: detected/decoded/errors all froze mid-run with no thrown error)
// leaves every subscription id sitting in the map forever with a dead underlying socket unless
// something else notices and forces a reconnect.
export function shouldReconnect(input: {
  now: number;
  lastSlotAt: number;
  lastForcedReconnectAt: number;
  slotStaleMs: number;
  forcedIntervalMs: number;
}): { reconnect: boolean; reason: string | null } {
  const { now, lastSlotAt, lastForcedReconnectAt, slotStaleMs, forcedIntervalMs } = input;
  if (lastSlotAt && now - lastSlotAt > slotStaleMs) {
    return { reconnect: true, reason: `slot poll stale for ${Math.round((now - lastSlotAt) / 1000)}s` };
  }
  if (now - lastForcedReconnectAt > forcedIntervalMs) {
    return { reconnect: true, reason: "periodic refresh" };
  }
  return { reconnect: false, reason: null };
}
