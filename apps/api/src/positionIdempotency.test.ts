// Regression coverage for a real financial-idempotency gap found during this session's database
// invariant sweep: Position/PositionExit had no database-level uniqueness on the real on-chain
// transaction hash at all -- duplicate-prevention in finalizeLiveBuy/executeLiveExit was an
// application-level "findFirst, then create" check, which is a genuine TOCTOU race under
// concurrent execution (crash-restart overlap, retried job racing the original, etc.).
//
// A bare `entryTxHash String? @unique` in schema.prisma looked like the fix, but Prisma's
// MongoDB connector does NOT make a nullable @unique field sparse -- proven here: two SIMULATION
// positions (entryTxHash absent on both) collided under a plain unique index, which would have
// broken every simulation trade after the first had this shipped undetected. The real fix is a
// hand-created sparse unique index (packages/db/scripts/ensure-indexes.mjs), which this test
// proves does both jobs correctly: unlimited nulls, but a genuine duplicate txHash rejected.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

async function makeUserAndTrader() {
  const user = await db.user.create({ data: { email: `t${crypto.randomBytes(6).toString("hex")}@example.com`, passwordHash: "x" } });
  const trader = await db.trader.create({ data: { handle: `t${crypto.randomBytes(6).toString("hex")}`, displayName: "test", category: "MANUAL", kind: "PLATFORM" } });
  return { user, trader };
}
// costUsdMicros: BigInt micro-USD (M-30 -- Decimal is unavailable on Prisma+MongoDB), 1_000_000n = $1.
const basePosition = { chain: "SOLANA" as const, quoteMint: "USDC", entryInputRaw: "1", entryTokenRaw: "1", remainingTokenRaw: "1", costUsdMicros: 1_000_000n, takeProfitPct: 200, status: "OPEN" as const };

test("multiple simulation positions (no real txHash) can coexist", async () => {
  const { user, trader } = await makeUserAndTrader();
  const a = await db.position.create({ data: { ...basePosition, userId: user.id, sourceTraderId: trader.id, mode: "SIMULATION", mint: "mintA" } });
  const b = await db.position.create({ data: { ...basePosition, userId: user.id, sourceTraderId: trader.id, mode: "SIMULATION", mint: "mintB" } });
  assert.ok(a.id && b.id, "both simulation positions must be created despite both having no entryTxHash");

  await db.position.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  await db.trader.delete({ where: { id: trader.id } });
  await db.user.delete({ where: { id: user.id } });
});

test("a real transaction hash cannot back two live positions", async () => {
  const { user, trader } = await makeUserAndTrader();
  const hash = "real_tx_" + crypto.randomBytes(8).toString("hex");
  const first = await db.position.create({ data: { ...basePosition, userId: user.id, sourceTraderId: trader.id, mode: "LIVE", mint: "mintC", entryTxHash: hash } });

  await assert.rejects(
    db.position.create({ data: { ...basePosition, userId: user.id, sourceTraderId: trader.id, mode: "LIVE", mint: "mintC", entryTxHash: hash } }),
    /Unique constraint failed/,
    "a second position must never be recorded against the same real on-chain buy"
  );

  await db.position.delete({ where: { id: first.id } });
  await db.trader.delete({ where: { id: trader.id } });
  await db.user.delete({ where: { id: user.id } });
});

test("a real sell transaction hash cannot back two PositionExit rows", async () => {
  const { user, trader } = await makeUserAndTrader();
  const position = await db.position.create({ data: { ...basePosition, userId: user.id, sourceTraderId: trader.id, mode: "LIVE", mint: "mintD" } });
  const hash = "real_sell_tx_" + crypto.randomBytes(8).toString("hex");
  const first = await db.positionExit.create({ data: { positionId: position.id, reason: "TEST", tokenRaw: "1", txHash: hash } });

  await assert.rejects(
    db.positionExit.create({ data: { positionId: position.id, reason: "TEST", tokenRaw: "1", txHash: hash } }),
    /Unique constraint failed/,
    "a second exit must never be recorded against the same real on-chain sell"
  );

  await db.positionExit.deleteMany({ where: { positionId: position.id } });
  await db.position.delete({ where: { id: position.id } });
  await db.trader.delete({ where: { id: trader.id } });
  await db.user.delete({ where: { id: user.id } });
});
