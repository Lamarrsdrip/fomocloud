export type WalletEvidence = {
  skillScore?: number | null; copyabilityScore?: number | null; realizedPnlUsd?: number | null;
  winRatePct?: number | null; sampleTrades?: number | null; distinctTokens30d?: number | null;
  lastActivityHours?: number | null; typicalMemePositionUsd?: number | null;
  largestMemePositionUsd?: number | null; memeBuyVolume30dUsd?: number | null;
  freshCapitalLowerBoundUsd?: number | null; source?: string | null;
};

export type WalletRole = "MEME_WHALE" | "SMART_DEGEN" | "CURATED_TRADER" | "GENERAL_TRADER" | "INSUFFICIENT_EVIDENCE";
const curatedSources = new Set(["MEMECLOUD_CURATED", "PLATFORM_ADDED", "ADMIN_MANUAL"]);

/** Capital and skill are deliberately independent: this function never promotes PROVEN/ELITE. */
export function classifyWalletRole(e: WalletEvidence) {
  const active = e.lastActivityHours != null && e.lastActivityHours <= 7 * 24;
  const largest = Math.max(0, Number(e.largestMemePositionUsd ?? 0));
  const memeVolume = Math.max(0, Number(e.memeBuyVolume30dUsd ?? 0));
  const typical = Math.max(0, Number(e.typicalMemePositionUsd ?? 0));
  const capital = Math.max(0, Number(e.freshCapitalLowerBoundUsd ?? 0));
  const skill = Math.max(0, Number(e.skillScore ?? e.copyabilityScore ?? 0));
  const trades = Math.max(0, Number(e.sampleTrades ?? 0));
  const winRate = Math.max(0, Number(e.winRatePct ?? 0));
  const diversity = Math.max(0, Number(e.distinctTokens30d ?? 0));
  const whale = active && (largest >= 50_000 || (memeVolume >= 250_000 && diversity >= 3) || (capital >= 250_000 && largest >= 20_000 && diversity >= 2));
  const smartDegen = active && trades >= 20 && diversity >= 5 && skill >= 72 && winRate >= 52 && (typical >= 5_000 || largest >= 10_000 || memeVolume >= 50_000);
  const role: WalletRole = whale ? "MEME_WHALE" : smartDegen ? "SMART_DEGEN" : curatedSources.has(String(e.source ?? "")) ? "CURATED_TRADER" : trades >= 10 ? "GENERAL_TRADER" : "INSUFFICIENT_EVIDENCE";
  const capitalScore = Math.min(100, Math.round(Math.log10(1 + largest) * 11 + Math.log10(1 + memeVolume) * 7 + Math.log10(1 + capital) * 3));
  return { role, isMemeWhale: whale, isSmartDegen: smartDegen, capitalScore, evidence: { active, largestMemePositionUsd: largest, memeBuyVolume30dUsd: memeVolume, typicalMemePositionUsd: typical, freshCapitalLowerBoundUsd: capital } };
}

export type TokenOrigin = "VERIFIED_LAUNCHPAD" | "KNOWN_DEX_MIGRATION" | "UNKNOWN_ORIGIN" | "DIRECT_RANDOM_MINT";
export function classifyTokenProvenance(input: { mint: string; programIds?: string[]; pairSource?: string | null }) {
  const configuredPump = new Set(String(process.env.PUMPFUN_PROGRAM_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean));
  const configuredBonk = new Set(String(process.env.BONK_LAUNCHPAD_PROGRAM_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean));
  const programs = new Set(input.programIds ?? []);
  const pumpProgram = [...programs].find(x => configuredPump.has(x));
  const bonkProgram = [...programs].find(x => configuredBonk.has(x));
  if (pumpProgram || input.mint.toLowerCase().endsWith("pump")) return { origin: "VERIFIED_LAUNCHPAD" as TokenOrigin, launchpad: "PUMP_FUN", confidence: pumpProgram ? 100 : 92, evidence: pumpProgram ? ["CREATION_PROGRAM_MATCH"] : ["PUMP_FUN_MINT_SUFFIX"] };
  if (bonkProgram) return { origin: "VERIFIED_LAUNCHPAD" as TokenOrigin, launchpad: "BONK_LAUNCHPAD", confidence: 100, evidence: ["CREATION_PROGRAM_MATCH"] };
  if (/raydium|orca|meteora/i.test(String(input.pairSource ?? ""))) return { origin: "KNOWN_DEX_MIGRATION" as TokenOrigin, launchpad: null, confidence: 60, evidence: ["KNOWN_DEX_PAIR_SOURCE"] };
  return { origin: "UNKNOWN_ORIGIN" as TokenOrigin, launchpad: null, confidence: 0, evidence: [] };
}

export function deepResearchEligible(input: { origin: TokenOrigin; distinctQualifiedWallets: number; provenWallets: number; curatedWallets: number; memeWhales: number; materialCapitalUsd: number; openPosition?: boolean }) {
  if (input.openPosition) return true;
  const exceptional = input.distinctQualifiedWallets >= 5 || input.provenWallets >= 1 || input.memeWhales >= 1 || input.materialCapitalUsd >= 50_000;
  if (input.origin === "UNKNOWN_ORIGIN" || input.origin === "DIRECT_RANDOM_MINT") return exceptional;
  return input.distinctQualifiedWallets >= 3 || input.curatedWallets >= 1 || exceptional;
}

export function providerEvidenceDue(input: { source?: string | null; stage: string; lastProviderAt?: string | Date | null }, now = Date.now()) {
  const last = input.lastProviderAt ? new Date(input.lastProviderAt).getTime() : 0;
  const priority = curatedSources.has(String(input.source ?? "")) || input.stage === "PROVEN" ? "P1" : input.stage === "PAPER_TRACKING" ? "P2" : "P3";
  const ttlMs = priority === "P1" ? 6 * 3600_000 : priority === "P2" ? 12 * 3600_000 : 24 * 3600_000;
  return { priority, due: !last || now - last >= ttlMs, ttlMs };
}

export function isProviderQuotaExhausted(error: unknown) {
  const e = error as { status?: number; message?: string; body?: { message?: string } };
  return e?.status === 429 || /quota|compute units usage limit|rate limit/i.test(`${e?.message ?? ""} ${e?.body?.message ?? ""}`);
}

// Real gap found by audit: every isProviderQuotaExhausted() hit opened the same hour-long circuit,
// whether it was a genuine sustained quota/compute-units exhaustion or just a bare 429 from
// ordinary momentary traffic congestion (confirmed live: a direct call to the wallet-scoring
// endpoint succeeded seconds after a *different*, unrelated Birdeye call on the same shared API
// key returned "Too many requests" -- the account's rate limit is shared and bursty across every
// consumer of the key, not a sustained per-endpoint block). A plain 429 with no quota/compute-units
// wording is exactly that kind of short burst and clears again within seconds to a couple of
// minutes; treating it the same as a real quota exhaustion was blocking ALL wallet evidence
// gathering -- the only path a wallet can ever leave ANALYZING through -- for a full hour at a
// time, repeatedly, which is why 240+ actively-trading candidates never accumulated enough
// evidence to promote. Only a message that actually names quota/compute-units exhaustion still
// gets the long circuit; a bare 429 gets a short one so real evidence keeps accumulating.
export function providerQuotaCircuitMs(error: unknown) {
  const e = error as { status?: number; message?: string; body?: { message?: string } };
  const text = `${e?.message ?? ""} ${e?.body?.message ?? ""}`;
  if (/quota|compute units usage limit/i.test(text)) return 60 * 60_000;
  return 2 * 60_000;
}
