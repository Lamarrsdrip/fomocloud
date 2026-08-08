import { z } from "zod";

export type Chain = "SOLANA" | "BASE" | "ETHEREUM" | "BNB" | "ARBITRUM" | "AVALANCHE" | "SUI" | "HYPERLIQUID";
export type SignalAction = "BUY" | "SELL";
export type ExecutionMode = "simulation" | "live";

export const CopySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  sizingMode: z.enum(["FIXED", "PERCENT"]).default("FIXED"),
  fixedAmountUsd: z.number().positive().max(100_000).default(100),
  percentBalance: z.number().positive().max(100).default(2),
  takeProfitPct: z.number().positive().max(10_000).default(30),
  stopLossPct: z.number().min(0).max(100).nullable().default(15),
  maxChasePct: z.number().min(0).max(55).default(40),
  maxSlippageBps: z.number().int().min(1).max(5000).default(500),
  maxPositionUsd: z.number().positive().max(1_000_000).default(500),
  maxTotalExposureUsd: z.number().positive().max(10_000_000).default(2500),
  minLiquidityUsd: z.number().min(0).default(50_000),
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
  if (params.currentExposureUsd >= settings.maxTotalExposureUsd)
    return { allowed: false, reason: "MAX_TOTAL_EXPOSURE_REACHED" };
  if (params.tokenExposureUsd >= settings.maxPositionUsd)
    return { allowed: false, reason: "MAX_POSITION_REACHED" };
  if (params.liquidityUsd !== undefined && params.liquidityUsd < settings.minLiquidityUsd)
    return { allowed: false, reason: "LIQUIDITY_TOO_LOW" };

  if (params.sourcePriceUsd && params.currentPriceUsd) {
    const chase = percentMove(params.sourcePriceUsd, params.currentPriceUsd);
    if (chase > settings.maxChasePct)
      return { allowed: false, reason: "PRICE_MOVED_TOO_FAR" };
  }

  const wanted = settings.sizingMode === "FIXED"
    ? settings.fixedAmountUsd
    : params.availableUsd * (settings.percentBalance / 100);

  const remainingTotal = Math.max(0, settings.maxTotalExposureUsd - params.currentExposureUsd);
  const remainingToken = Math.max(0, settings.maxPositionUsd - params.tokenExposureUsd);
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
