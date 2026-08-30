export const SOL_NATIVE_MINT = "SOL_NATIVE";

export type DepositCandidate = {
  assetMint: string;
  symbol: string | null;
  decimals: number;
  amountRaw: string;
  supported: boolean;
};

function keyAddress(key: any): string {
  return String(key?.pubkey?.toBase58?.() ?? key?.pubkey ?? key?.toBase58?.() ?? key ?? "");
}

function tokenAmountMap(rows: any[], walletAddress: string) {
  const amounts = new Map<string, { raw: bigint; decimals: number }>();
  for (const row of rows ?? []) {
    if (String(row?.owner ?? "") !== walletAddress || !row?.mint) continue;
    const mint = String(row.mint);
    const current = amounts.get(mint) ?? { raw: 0n, decimals: Number(row?.uiTokenAmount?.decimals ?? 0) };
    const raw = String(row?.uiTokenAmount?.amount ?? "0");
    if (!/^\d+$/.test(raw)) continue;
    current.raw += BigInt(raw);
    current.decimals = Number(row?.uiTokenAmount?.decimals ?? current.decimals);
    amounts.set(mint, current);
  }
  return amounts;
}

/**
 * Extract only externally-originated positive deltas. If the wallet signed the transaction it is
 * a swap/send/self-initiated operation, not a deposit, even when one output asset increased.
 */
export function extractInboundDeposits(tx: any, walletAddress: string, usdcMint: string): DepositCandidate[] {
  if (!tx?.meta || tx.meta.err) return [];
  const accountKeys = tx?.transaction?.message?.accountKeys ?? [];
  if (accountKeys.some((key: any) => keyAddress(key) === walletAddress && Boolean(key?.signer))) return [];

  const out: DepositCandidate[] = [];
  const walletIndex = accountKeys.findIndex((key: any) => keyAddress(key) === walletAddress);
  if (walletIndex >= 0) {
    const before = BigInt(tx.meta.preBalances?.[walletIndex] ?? 0);
    const after = BigInt(tx.meta.postBalances?.[walletIndex] ?? 0);
    if (after > before) out.push({assetMint: SOL_NATIVE_MINT, symbol: "SOL", decimals: 9, amountRaw: (after - before).toString(), supported: true});
  }

  const pre = tokenAmountMap(tx.meta.preTokenBalances ?? [], walletAddress);
  const post = tokenAmountMap(tx.meta.postTokenBalances ?? [], walletAddress);
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint)?.raw ?? 0n;
    const after = post.get(mint)?.raw ?? 0n;
    if (after <= before) continue;
    const decimals = post.get(mint)?.decimals ?? pre.get(mint)?.decimals ?? 0;
    out.push({assetMint: mint, symbol: mint === usdcMint ? "USDC" : null, decimals, amountRaw: (after - before).toString(), supported: mint === usdcMint});
  }
  return out;
}

export function rawToDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error("INVALID_RAW_AMOUNT");
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function depositStatus(confirmationStatus: string | null | undefined) {
  return confirmationStatus === "finalized" ? "FINALIZED" as const : "CONFIRMED" as const;
}
