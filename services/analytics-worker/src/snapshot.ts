import { microsToUsd } from "@memecloud/shared";

export type PositionRow = {
  costUsdMicros: bigint;
  entryTokenRaw: string;
  remainingTokenRaw: string;
  unrealizedPnlUsdMicros: bigint;
  realizedPnlUsdMicros: bigint;
  status: string;
};
export type CashRow = { availableUsdMicros: bigint; inTradesUsdMicros: bigint };

export type AccountSnapshot = {
  accountValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
};

// M-30: Position/TradingCashAllocation store integer micro-USD (BigInt) now, not Float -- convert
// to plain numbers immediately so every calculation below is byte-for-byte identical to before the
// migration. PnLSnapshot itself stays Float (analytics/historical, not the canonical ledger).
export function computeAccountSnapshot(positionRows: PositionRow[], cashRows: CashRow[]): AccountSnapshot {
  const positions = positionRows.map(p => ({
    ...p,
    costUsd: microsToUsd(p.costUsdMicros),
    unrealizedPnlUsd: microsToUsd(p.unrealizedPnlUsdMicros),
    realizedPnlUsd: microsToUsd(p.realizedPnlUsdMicros),
  }));
  const available = cashRows.reduce((a, x) => a + microsToUsd(x.availableUsdMicros), 0);
  const open = positions.filter(p => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED");
  const realized = positions.reduce((a, p) => a + p.realizedPnlUsd, 0);
  const unrealized = open.reduce((a, p) => a + p.unrealizedPnlUsd, 0);
  // Proportional remaining cost basis (remaining/original token amount) plus unrealized P&L already
  // marked for that position -- a partially-closed position's still-open value is only its
  // remaining fraction of cost, not its full original cost. Falls back to just the unrealized P&L
  // if the raw token amounts are ever malformed, rather than throwing and losing the whole snapshot.
  const openValue = open.reduce((a, p) => {
    try {
      const original = BigInt(p.entryTokenRaw), remaining = BigInt(p.remainingTokenRaw);
      const f = original > 0n ? Number((remaining * 1_000_000n) / original) / 1_000_000 : 0;
      return a + (p.costUsd * f) + p.unrealizedPnlUsd;
    } catch {
      return a + p.unrealizedPnlUsd;
    }
  }, 0);
  return { accountValueUsd: available + openValue, realizedPnlUsd: realized, unrealizedPnlUsd: unrealized, netPnlUsd: realized + unrealized };
}
