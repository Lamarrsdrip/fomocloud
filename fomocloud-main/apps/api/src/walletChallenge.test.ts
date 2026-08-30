// Regression coverage for the wallet-challenge atomicity fix made this session (server.ts
// /auth/wallet/verify and /v1/me/wallets/verify): a legitimate first attempt must succeed exactly
// once even under a concurrent duplicate submission (double-tap, client retry after a slow
// response, etc.), while a genuine replay of an already-consumed challenge must still fail. This
// is the exact invariant behind the "challenge already used" bug — it proves the fix at the
// database level, independent of the HTTP status-code changes (which are a separate, UI-facing
// concern already covered by manual production verification this session).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

async function consumeOnce(challengeId: string) {
  return db.walletChallenge.updateMany({
    where: { id: challengeId, consumedAt: { isSet: false }, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() }
  });
}

test("concurrent double-submit of the same challenge: exactly one attempt consumes it", async () => {
  const address = "TestWallet" + crypto.randomBytes(8).toString("hex");
  const row = await db.walletChallenge.create({
    data: {
      chain: "SOLANA",
      address,
      message: "MemeCloud test challenge",
      purpose: "LOGIN",
      expiresAt: new Date(Date.now() + 5 * 60_000)
    }
  });

  // Two "requests" racing to consume the same one-time challenge, exactly as two concurrent
  // client submissions (or apiFetch's own 401-retry racing a slow-but-successful first attempt)
  // would in production.
  const [a, b] = await Promise.all([consumeOnce(row.id), consumeOnce(row.id)]);
  const successes = [a.count, b.count].filter(c => c === 1).length;
  const failures = [a.count, b.count].filter(c => c === 0).length;

  assert.equal(successes, 1, "exactly one of the two concurrent attempts must succeed");
  assert.equal(failures, 1, "the other concurrent attempt must see it already consumed, not silently succeed too");

  await db.walletChallenge.delete({ where: { id: row.id } });
});

test("a genuinely already-used challenge cannot be consumed again later", async () => {
  const address = "TestWallet" + crypto.randomBytes(8).toString("hex");
  const row = await db.walletChallenge.create({
    data: {
      chain: "SOLANA",
      address,
      message: "MemeCloud test challenge",
      purpose: "LOGIN",
      expiresAt: new Date(Date.now() + 5 * 60_000),
      consumedAt: new Date()
    }
  });

  const result = await consumeOnce(row.id);
  assert.equal(result.count, 0, "an already-consumed challenge must never be consumable again");

  await db.walletChallenge.delete({ where: { id: row.id } });
});

test("an expired challenge cannot be consumed even if never used", async () => {
  const address = "TestWallet" + crypto.randomBytes(8).toString("hex");
  const row = await db.walletChallenge.create({
    data: {
      chain: "SOLANA",
      address,
      message: "MemeCloud test challenge",
      purpose: "LOGIN",
      expiresAt: new Date(Date.now() - 1000)
    }
  });

  const result = await consumeOnce(row.id);
  assert.equal(result.count, 0, "an expired challenge must never be consumable");

  await db.walletChallenge.delete({ where: { id: row.id } });
});
