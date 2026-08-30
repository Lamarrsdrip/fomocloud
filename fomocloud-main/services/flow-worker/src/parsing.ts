import type { ParsedTransactionWithMeta } from "@solana/web3.js";

// Extracted from index.ts (a service entrypoint with real top-level side effects -- Redis
// connection, WebSocket subscription start on import) so this pure parsing logic can be unit
// tested without triggering any of that. Real gap found by forensic audit (M-51): this service's
// test script was `echo flow-worker tests`, and pre/post token-balance diffing is exactly the
// class of easy-to-get-subtly-wrong logic worth testing directly.
export function ownerDeltas(tx: ParsedTransactionWithMeta) {
  const m = new Map<string, Map<string, { raw: bigint; dec: number }>>();
  const apply = (rows: any[], sgn: bigint) => {
    for (const r of rows) {
      if (!r.owner) continue;
      let w = m.get(r.owner);
      if (!w) m.set(r.owner, (w = new Map()));
      const c = w.get(r.mint) ?? { raw: 0n, dec: r.uiTokenAmount.decimals };
      c.raw += sgn * BigInt(r.uiTokenAmount.amount || "0");
      c.dec = r.uiTokenAmount.decimals;
      w.set(r.mint, c);
    }
  };
  apply(tx.meta?.postTokenBalances ?? [], 1n);
  apply(tx.meta?.preTokenBalances ?? [], -1n);
  return m;
}
