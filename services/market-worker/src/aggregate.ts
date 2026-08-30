// Extracted from index.ts (a service entrypoint with real top-level side effects -- Redis
// connection, RpcBudget construction on import) so this pure aggregation logic can be unit tested
// without triggering any of that. Real gap found by forensic audit (M-51): this service's test
// script was `echo market-worker tests`, despite volumeAcceleration1m being a real, direct input
// to Brain's evaluateOpportunity scoring -- a bug here would silently mis-score every token.

export type FlowRow = { side: "BUY" | "SELL"; amountUsd: number | null; walletAddress: string; observedAt: Date };

export function aggregateChainFlow(rows: FlowRow[], since1m: Date) {
  let buyVolume5mUsd = 0, sellVolume5mUsd = 0, buyVolume1mUsd = 0, buys1m = 0, sells1m = 0, buys5m = 0, sells5m = 0;
  const buyers1m = new Set<string>(), buyers5m = new Set<string>(), sellers5m = new Set<string>();
  for (const r of rows) {
    const usd = Number(r.amountUsd ?? 0), within1m = r.observedAt >= since1m;
    if (r.side === "BUY") {
      buyVolume5mUsd += usd; buys5m++; buyers5m.add(r.walletAddress);
      if (within1m) { buyVolume1mUsd += usd; buys1m++; buyers1m.add(r.walletAddress); }
    } else {
      sellVolume5mUsd += usd; sells5m++; sellers5m.add(r.walletAddress);
      if (within1m) sells1m++;
    }
  }
  const avgPerMin = buyVolume5mUsd / 5;
  // Neutral (1.0 = no acceleration), not 0, when there's no 5-minute baseline to compare against --
  // 0 would read as "volume collapsing" when the real answer is "not enough data yet."
  const volumeAcceleration1m = avgPerMin > 0 ? buyVolume1mUsd / avgPerMin : 1;
  return { buys1m, sells1m, buys5m, sells5m, buyVolume5mUsd, sellVolume5mUsd, volume1mUsd: buyVolume1mUsd, volume5mUsd: buyVolume5mUsd + sellVolume5mUsd, uniqueBuyers1m: buyers1m.size, uniqueBuyers5m: buyers5m.size, uniqueSellers5m: sellers5m.size, volumeAcceleration1m };
}
