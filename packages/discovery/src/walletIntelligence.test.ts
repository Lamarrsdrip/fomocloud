import test from "node:test";
import assert from "node:assert/strict";
import { classifyTokenProvenance, classifyWalletRole, deepResearchEligible, isProviderQuotaExhausted, providerEvidenceDue, providerQuotaCircuitMs } from "./walletIntelligence.js";

test("a large idle balance is not a meme whale", () => { assert.equal(classifyWalletRole({ freshCapitalLowerBoundUsd: 2_000_000, lastActivityHours: 400 }).isMemeWhale, false); });
test("real fresh meme capital classifies independently from skill", () => { const x = classifyWalletRole({ largestMemePositionUsd: 80_000, memeBuyVolume30dUsd: 180_000, lastActivityHours: 2, skillScore: 20 }); assert.equal(x.role, "MEME_WHALE"); assert.equal(x.isSmartDegen, false); });
test("repeatable medium-capital edge classifies as smart degen", () => { assert.equal(classifyWalletRole({ skillScore: 84, winRatePct: 61, sampleTrades: 65, distinctTokens30d: 14, typicalMemePositionUsd: 8_000, lastActivityHours: 4 }).role, "SMART_DEGEN"); });
test("pump suffix records traceable launchpad evidence without claiming safety", () => { const x = classifyTokenProvenance({ mint: "ExampleMintpump" }); assert.equal(x.origin, "VERIFIED_LAUNCHPAD"); assert.equal(x.launchpad, "PUMP_FUN"); assert.ok(x.confidence < 100); });
test("unknown tokens require exceptional smart-money evidence", () => { assert.equal(deepResearchEligible({ origin: "UNKNOWN_ORIGIN", distinctQualifiedWallets: 3, provenWallets: 0, curatedWallets: 1, memeWhales: 0, materialCapitalUsd: 2_000 }), false); assert.equal(deepResearchEligible({ origin: "UNKNOWN_ORIGIN", distinctQualifiedWallets: 3, provenWallets: 1, curatedWallets: 0, memeWhales: 0, materialCapitalUsd: 2_000 }), true); });
test("provider refresh is bounded by wallet priority", () => { const now = Date.now(); assert.equal(providerEvidenceDue({ source: "MEMECLOUD_CURATED", stage: "ANALYZING", lastProviderAt: new Date(now - 5 * 3600_000) }, now).due, false); assert.equal(providerEvidenceDue({ source: "TRADER_LEADERBOARD", stage: "ANALYZING", lastProviderAt: new Date(now - 23 * 3600_000) }, now).due, false); });
test("provider quota response opens a global circuit", () => { assert.equal(isProviderQuotaExhausted({ status: 400, body: { message: "Compute units usage limit exceeded" } }), true); });
// Real bug found by audit: a bare 429 from ordinary bursty traffic on a shared API key (confirmed
// live -- a direct call to the wallet-scoring endpoint succeeded seconds after an unrelated call on
// the same key hit "Too many requests") was opening the same hour-long circuit as a genuine
// sustained quota/compute-units exhaustion, blocking the only path a wallet can leave ANALYZING
// through for a full hour at a time over and over.
test("a bare 429 with no quota wording gets a short circuit, not the hour-long one", () => { assert.equal(providerQuotaCircuitMs({ status: 429, body: { message: "Too many requests" } }), 2 * 60_000); });
test("a message naming quota/compute-units exhaustion still gets the long circuit", () => { assert.equal(providerQuotaCircuitMs({ status: 400, body: { message: "Compute units usage limit exceeded" } }), 60 * 60_000); });
