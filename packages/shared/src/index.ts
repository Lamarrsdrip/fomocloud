import { z } from "zod";

export type Chain = "SOLANA" | "BASE" | "ETHEREUM" | "BNB" | "ARBITRUM" | "AVALANCHE" | "SUI" | "HYPERLIQUID";
export type SignalAction = "BUY" | "SELL";
export type ExecutionMode = "simulation" | "live";

export const CopySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  sizingMode: z.enum(["FIXED", "PERCENT"]).default("FIXED"),
  fixedAmountUsd: z.number().positive().max(100_000_000).default(100),
  percentBalance: z.number().positive().max(100).default(2),
  takeProfitPct: z.number().positive().max(1_000_000).default(200),
  stopLossPct: z.number().min(0).max(100).nullable().default(null),
  maxChasePct: z.number().min(0).max(1_000_000).default(0), // 0 = no user chase ceiling
  maxSlippageBps: z.number().int().min(1).max(10000).default(1500),
  maxPositionUsd: z.number().min(0).max(100_000_000).default(0), // 0 = unlimited
  maxTotalExposureUsd: z.number().min(0).max(100_000_000).default(0), // 0 = unlimited
  minLiquidityUsd: z.number().min(0).default(0),
  exitMode: z.enum(["TP", "MIRROR", "HYBRID"]).default("HYBRID")
});
export type CopySettings = z.infer<typeof CopySettingsSchema>;

export type TradeSignal = {
  idempotencyKey: string;
  chain: Chain;
  sourceTraderId: string;
  sourceWallet: string;
  sourceTx: string;
  action: SignalAction;
  inputMint: string;
  outputMint: string;
  inputRaw: string;
  outputRaw: string;
  effectivePriceUsd?: string;
  sourceMarketCapUsd?: string;
  observedAt: string;
  slot?: string;
};

export type Decision =
  | { allowed: true; amountUsd: string }
  | { allowed: false; reason: string };

export function percentMove(source: number, current: number): number {
  if (!Number.isFinite(source) || source <= 0 || !Number.isFinite(current)) return Infinity;
  return ((current - source) / source) * 100;
}

export function decideCopy(params: {
  settings: CopySettings;
  sourcePriceUsd?: number;
  currentPriceUsd?: number;
  availableUsd: number;
  currentExposureUsd: number;
  tokenExposureUsd: number;
  liquidityUsd?: number;
}): Decision {
  const { settings } = params;
  if (!settings.enabled) return { allowed: false, reason: "AUTO_COPY_DISABLED" };
  if (params.availableUsd <= 0) return { allowed: false, reason: "INSUFFICIENT_BALANCE" };
  if (settings.maxTotalExposureUsd > 0 && params.currentExposureUsd >= settings.maxTotalExposureUsd)
    return { allowed: false, reason: "MAX_TOTAL_EXPOSURE_REACHED" };
  if (settings.maxPositionUsd > 0 && params.tokenExposureUsd >= settings.maxPositionUsd)
    return { allowed: false, reason: "MAX_POSITION_REACHED" };
  if (params.liquidityUsd !== undefined && params.liquidityUsd < settings.minLiquidityUsd)
    return { allowed: false, reason: "LIQUIDITY_TOO_LOW" };

  if (params.sourcePriceUsd && params.currentPriceUsd) {
    const chase = percentMove(params.sourcePriceUsd, params.currentPriceUsd);

    // Percentage calculations such as 1 -> 1.55 may produce
    // 55.00000000000001 because of IEEE-754 floating-point math.
    // Treat mathematically equal boundary values as equal rather than
    // incorrectly rejecting an exact user-configured chase limit.
    const boundaryTolerance =
      Number.EPSILON *
      Math.max(1, Math.abs(chase), Math.abs(settings.maxChasePct)) *
      16;

    if (settings.maxChasePct > 0 && chase > settings.maxChasePct + 1e-9)
      return { allowed: false, reason: "PRICE_MOVED_TOO_FAR" };
  }

  const wanted = settings.sizingMode === "FIXED"
    ? settings.fixedAmountUsd
    : params.availableUsd * (settings.percentBalance / 100);

  const remainingTotal = settings.maxTotalExposureUsd > 0 ? Math.max(0, settings.maxTotalExposureUsd - params.currentExposureUsd) : Number.POSITIVE_INFINITY;
  const remainingToken = settings.maxPositionUsd > 0 ? Math.max(0, settings.maxPositionUsd - params.tokenExposureUsd) : Number.POSITIVE_INFINITY;
  const amount = Math.min(wanted, params.availableUsd, remainingTotal, remainingToken);

  if (amount <= 0) return { allowed: false, reason: "ALLOCATION_EXHAUSTED" };
  return { allowed: true, amountUsd: amount.toFixed(2) };
}

export function targetPrice(entry: number, takeProfitPct: number) {
  return entry * (1 + takeProfitPct / 100);
}

export function stopPrice(entry: number, stopLossPct: number) {
  return entry * (1 - stopLossPct / 100);
}

/**
 * Copy-trading chase is measured from the followed wallet's actual execution
 * to our current executable entry. A token's 24h move is intentionally irrelevant.
 */
export function walletChasePct(sourceWalletExecutionPriceUsd:number, currentExecutablePriceUsd:number) {
  return percentMove(sourceWalletExecutionPriceUsd, currentExecutablePriceUsd);
}


function rawFraction(part: bigint, whole: bigint) {
  if (part < 0n || whole <= 0n || part > whole) {
    throw new Error("INVALID_TOKEN_ACCOUNTING");
  }

  return Number((part * 1_000_000_000n) / whole) / 1_000_000_000;
}

export function calculateExitAccounting(params: {
  entryTokenRaw: string;
  remainingTokenRaw: string;
  tokenRaw: string;
  costUsd: number;
  avgEntryPriceUsd: number;
  executionPriceUsd: number;
  feesUsd?: number;
}) {
  const original = BigInt(params.entryTokenRaw);
  const remaining = BigInt(params.remainingTokenRaw);
  const sold = BigInt(params.tokenRaw);

  if (
    sold <= 0n ||
    sold > remaining ||
    !Number.isFinite(params.costUsd) ||
    params.costUsd < 0 ||
    !Number.isFinite(params.avgEntryPriceUsd) ||
    params.avgEntryPriceUsd <= 0 ||
    !Number.isFinite(params.executionPriceUsd) ||
    params.executionPriceUsd < 0
  ) {
    throw new Error("INVALID_EXIT_ACCOUNTING");
  }

  const feesUsd = Math.max(0, Number(params.feesUsd ?? 0));
  const fractionOfOriginal = rawFraction(sold, original);

  const allocatedCostUsd = params.costUsd * fractionOfOriginal;

  const grossProceedsUsd =
    allocatedCostUsd *
    (params.executionPriceUsd / params.avgEntryPriceUsd);

  const netProceedsUsd = Math.max(
    0,
    grossProceedsUsd - feesUsd
  );

  return {
    tokenRaw: sold.toString(),
    remainingTokenRaw: (remaining - sold).toString(),
    allocatedCostUsd,
    grossProceedsUsd,
    feesUsd,
    netProceedsUsd,
    realizedPnlUsd:
      netProceedsUsd - allocatedCostUsd
  };
}

export function calculatePositionMark(params: {
  entryTokenRaw: string;
  remainingTokenRaw: string;
  costUsd: number;
  avgEntryPriceUsd: number;
  currentPriceUsd: number;
}) {
  const original = BigInt(params.entryTokenRaw);
  const remaining = BigInt(params.remainingTokenRaw);

  if (
    remaining < 0n ||
    remaining > original ||
    !Number.isFinite(params.avgEntryPriceUsd) ||
    params.avgEntryPriceUsd <= 0 ||
    !Number.isFinite(params.currentPriceUsd) ||
    params.currentPriceUsd < 0
  ) {
    throw new Error("INVALID_POSITION_MARK");
  }

  const remainingFraction =
    rawFraction(remaining, original);

  const remainingCostBasisUsd =
    params.costUsd * remainingFraction;

  const currentValueUsd =
    remainingCostBasisUsd *
    (params.currentPriceUsd / params.avgEntryPriceUsd);

  return {
    remainingFraction,
    remainingCostBasisUsd,
    currentValueUsd,
    unrealizedPnlUsd:
      currentValueUsd - remainingCostBasisUsd
  };
}

// A token's decimals never change after mint creation -- this is a permanent fact, not a
// time-sensitive one. Before this, exits/executor/market-worker/paper-worker each independently
// called getTokenSupply for the exact same mints, each maintaining its own separate (or, for
// exits, no) in-process cache -- real redundant RPC load across otherwise-unrelated processes for
// an answer that's identical everywhere and never expires. This shares the answer across every
// process via Redis (no TTL, since the fact itself never changes) while each caller keeps its own
// existing Redis connection -- no new connection, no new dependency added to this package.
export interface MinimalRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}
export async function cachedTokenDecimals(
  redis: MinimalRedisClient,
  mint: string,
  fetchFresh: () => Promise<number>
): Promise<number> {
  const key = `token-decimals:${mint}`;
  const cached = await redis.get(key).catch(() => null);
  if (cached !== null && cached !== undefined) {
    const n = Number(cached);
    if (Number.isFinite(n)) return n;
  }
  const decimals = await fetchFresh();
  await redis.set(key, String(decimals)).catch(() => {});
  return decimals;
}

export {
  RpcBudget,
  RPC_PRIORITY,
  RESERVE_FRACTION,
  computeTokenBucket,
  type RpcPriority,
  type RedisEvalClient,
  type RpcBudgetOptions,
  type TokenBucketState,
  type TokenBucketResult,
} from "./rpcBudget.js";

// Real bug found by audit: every Solana-RPC-consuming service (market-worker, exits, balance-
// worker, listener, paper-worker, executor, apps/api) independently did `heliusRpc||solanaRpc||
// process.env.SOLANA_RPC_HTTP` -- a plain fallback CHAIN, not a health CHECK, so an exhausted/dead
// primary (confirmed live: Helius returning 429 "max usage reached") was used anyway rather than
// skipped, and `fallbackRpc` -- already a real, admin-configurable field the Settings UI's own help
// text claims is used ("then MemeCloud's public default") -- was silently never read by any of
// them. Only services/flow-worker had real health-probing (pickHealthyRpc), and only for its own
// two candidates. Generalized here so every consumer gets the same real failover, plus two verified
// (curl-tested against the live network, both getSlot and getHealth) genuinely public, no-signup
// Solana RPC endpoints as a last-resort safety net below whatever the admin has configured.
export const FREE_PUBLIC_SOLANA_RPC_FALLBACKS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

export function solanaRpcCandidates(cfg: { heliusRpc?: string; solanaRpc?: string; fallbackRpc?: string } | null | undefined): string[] {
  const raw = [
    cfg?.heliusRpc,
    cfg?.solanaRpc,
    cfg?.fallbackRpc,
    process.env.SOLANA_RPC_HTTP,
    process.env.SOLANA_RPC_FALLBACK_HTTP,
    ...FREE_PUBLIC_SOLANA_RPC_FALLBACKS,
  ].filter((u): u is string => Boolean(u));
  const seen = new Set<string>();
  return raw.filter(u => {
    const host = (() => { try { return new URL(u).host } catch { return u } })();
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

// Probes each candidate in priority order with a real getHealth call (short timeout, so a dead
// endpoint can't stall startup/reload) and returns the first one that actually responds healthy.
// Falls back to the first candidate (never throws for a non-empty list) so a transient probe
// failure never blocks startup outright -- the caller's own real usage will surface a genuine
// failure if the chosen candidate turns out not to work after all.
async function probeOnce(url: string): Promise<boolean> {
  const res = await Promise.race([
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Timed out")), 5000)),
  ]);
  if (!res.ok) return false;
  const body = await res.json().catch(() => null);
  return body?.result === "ok";
}

export async function pickHealthyRpc(candidates: string[], logPrefix = "[rpc]"): Promise<string> {
  if (candidates.length === 0) throw new Error("SOLANA_RPC_REQUIRED");
  for (const url of candidates) {
    const host = (() => { try { return new URL(url).host } catch { return url } })();
    try {
      // Real bug found while diagnosing the live incident this replaced: this only ran once per
      // full worker cycle (not once per RPC call), so a single transient health-check blip on an
      // otherwise-fine primary (confirmed live: api.mainnet-beta.solana.com genuinely works, but
      // failed one probe under load) locked the entire cycle onto a lower-priority fallback that
      // then failed a DIFFERENT way (PublicNode's free tier blocks "indexed" methods like
      // getTokenSupply even though it passes getHealth). One retry after a short pause is enough to
      // smooth over a one-off blip without meaningfully slowing down the common case.
      let healthy = await probeOnce(url);
      if (!healthy) { await new Promise(r => setTimeout(r, 400)); healthy = await probeOnce(url).catch(() => false); }
      if (healthy) return url;
      console.warn(`${logPrefix} RPC candidate unhealthy after retry, trying next if available`, host);
    } catch (e: any) {
      console.warn(`${logPrefix} RPC candidate unreachable, trying next if available`, host, e?.message);
    }
  }
  return candidates[0];
}
