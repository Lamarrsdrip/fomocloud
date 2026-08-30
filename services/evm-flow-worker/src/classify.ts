export type EvmDefaults = { native: string; stables: string[] };
export const EVM_DEFAULTS: Record<string, EvmDefaults> = {
  BNB: { native: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", stables: ["0x55d398326f99059fF775485246999027B3197955", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"] },
  ETHEREUM: { native: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stables: ["0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdAC17F958D2ee523a2206206994597C13D831ec7"] },
};

export function isQuote(chain: string, address: string): boolean {
  const d = EVM_DEFAULTS[chain];
  if (!d) return false;
  const a = address.toLowerCase();
  return a === d.native.toLowerCase() || d.stables.some(x => x.toLowerCase() === a);
}

export type PairMeta = { token0: string; token1: string; d0: number; d1: number };
export type ClassifiedSwap = { side: "BUY" | "SELL"; mint: string; quoteToken: string; quoteRaw: bigint; quoteDec: number };

// A V2 Swap event is a buy/sell of "mint" only when exactly one side of the pair is a
// known quote asset (native or a listed stable) and the other is not -- a quote/quote or
// non-quote/non-quote pair (e.g. two unrelated tokens, or two stables) can't be classified
// as a directional trade of a single mint, so this returns null rather than guessing.
export function classifySwapSide(chain: string, pm: PairMeta, amount0In: bigint, amount1In: bigint, amount0Out: bigint, amount1Out: bigint): ClassifiedSwap | null {
  const t0IsQuote = isQuote(chain, pm.token0), t1IsQuote = isQuote(chain, pm.token1);
  if (t0IsQuote && !t1IsQuote) {
    const mint = pm.token1, quoteToken = pm.token0, quoteDec = pm.d0;
    if (amount0In > 0n && amount1Out > 0n) return { side: "BUY", mint, quoteToken, quoteRaw: amount0In, quoteDec };
    if (amount0Out > 0n && amount1In > 0n) return { side: "SELL", mint, quoteToken, quoteRaw: amount0Out, quoteDec };
    return null;
  }
  if (t1IsQuote && !t0IsQuote) {
    const mint = pm.token0, quoteToken = pm.token1, quoteDec = pm.d1;
    if (amount1In > 0n && amount0Out > 0n) return { side: "BUY", mint, quoteToken, quoteRaw: amount1In, quoteDec };
    if (amount1Out > 0n && amount0In > 0n) return { side: "SELL", mint, quoteToken, quoteRaw: amount1Out, quoteDec };
    return null;
  }
  return null;
}

// quoteAmount is already the human-readable decimal amount (post formatUnits), not raw.
export function quoteAmountUsd(chain: string, quoteToken: string, quoteAmount: number, nativeUsd: number): number | undefined {
  const d = EVM_DEFAULTS[chain];
  if (!d) return undefined;
  if (d.stables.some(x => x.toLowerCase() === quoteToken.toLowerCase())) return quoteAmount;
  if (quoteToken.toLowerCase() === d.native.toLowerCase() && nativeUsd > 0) return quoteAmount * nativeUsd;
  return undefined;
}
