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

export type Delta = { mint: string; raw: bigint; decimals: number };

export function tokenDeltas(tx: ParsedTransactionWithMeta, wallet: string): Delta[] {
  const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
  const map = new Map<string, { raw: bigint; decimals: number }>();
  const apply = (rows: typeof pre, sign: bigint) => {
    for (const r of rows) {
      if (r.owner !== wallet) continue;
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
  return rows.filter((r) => r.owner === wallet && r.mint === mint).reduce((a, r) => a + BigInt(r.uiTokenAmount.amount || "0"), 0n);
}

export function classifySwap(tx: ParsedTransactionWithMeta, wallet: string) {
  const deltas = tokenDeltas(tx, wallet);
  const positives = deltas.filter((x) => x.raw > 0n).sort((a, b) => (a.raw > b.raw ? -1 : 1));
  const negatives = deltas.filter((x) => x.raw < 0n).sort((a, b) => (a.raw < b.raw ? -1 : 1));
  if (!positives.length || !negatives.length) return null;

  // Prefer a clear quote-asset <-> token leg. This prevents treating every token transfer as a buy.
  const spentQuote = negatives.find((x) => quoteMints.has(x.mint));
  const receivedQuote = positives.find((x) => quoteMints.has(x.mint));
  let input: Delta | undefined, output: Delta | undefined, action: "BUY" | "SELL";
  if (spentQuote) {
    input = spentQuote; output = positives.find((x) => !quoteMints.has(x.mint)); action = "BUY";
  } else if (receivedQuote) {
    input = negatives.find((x) => !quoteMints.has(x.mint)); output = receivedQuote; action = "SELL";
  } else {
    // Token-to-token with no recognized quote is ambiguous; don't invent a copy signal.
    return null;
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
  return { action, inputMint: input.mint, outputMint: output.mint, inputRaw, outputRaw, sourcePriceUsd, sourceTokenBalanceBeforeRaw, sourceTokenBalanceAfterRaw, sourceSoldPct, amountUsd };
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
