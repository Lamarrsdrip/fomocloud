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
