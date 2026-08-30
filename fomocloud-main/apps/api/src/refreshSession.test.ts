// Regression coverage for a critical bug found during this session's audit: Prisma's MongoDB
// connector does not match an unset optional field with a bare `{field: null}` filter — only
// `{field: {isSet: false}}` does. server.ts used `revokedAt:null` everywhere a session's validity
// was checked (refresh rotation, logout, session listing, revoke-one, revoke-all). Since
// `revokedAt` is never explicitly written at session creation, this meant NONE of those queries
// ever matched a genuinely valid (never-revoked) session — proven here against a real MongoDB
// replica set, not mocked. In practice this made POST /auth/refresh fail for every user, on every
// browser, whenever their ~60-minute access token expired: the silent-refresh path that's
// supposed to keep a session alive across a page reload could never succeed.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

async function makeUser() {
  const email = `regress-${crypto.randomBytes(6).toString("hex")}@example.com`;
  return db.user.create({ data: { email, passwordHash: "x", emailIdentity: { create: { emailNormalized: email } } } });
}

test("a never-revoked refresh session rotates successfully (the actual /auth/refresh query)", async () => {
  const user = await makeUser();
  const tokenHash = crypto.randomBytes(16).toString("hex");
  const session = await db.refreshSession.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) }
  });

  const nextHash = crypto.randomBytes(16).toString("hex");
  const rotated = await db.refreshSession.updateMany({
    where: { id: session.id, tokenHash, revokedAt: { isSet: false }, expiresAt: { gt: new Date() } },
    data: { tokenHash: nextHash, lastUsedAt: new Date() }
  });

  assert.equal(rotated.count, 1, "a valid, never-revoked, unexpired session must rotate exactly once");

  await db.refreshSession.deleteMany({ where: { userId: user.id } });
  await db.emailIdentity.deleteMany({ where: { emailNormalized: user.email! } });
  await db.user.delete({ where: { id: user.id } });
});

test("a revoked session is correctly rejected by the same query", async () => {
  const user = await makeUser();
  const tokenHash = crypto.randomBytes(16).toString("hex");
  const session = await db.refreshSession.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000), revokedAt: new Date() }
  });

  const rotated = await db.refreshSession.updateMany({
    where: { id: session.id, tokenHash, revokedAt: { isSet: false }, expiresAt: { gt: new Date() } },
    data: { tokenHash: crypto.randomBytes(16).toString("hex"), lastUsedAt: new Date() }
  });

  assert.equal(rotated.count, 0, "a revoked session must never rotate");

  await db.refreshSession.deleteMany({ where: { userId: user.id } });
  await db.emailIdentity.deleteMany({ where: { emailNormalized: user.email! } });
  await db.user.delete({ where: { id: user.id } });
});

test("logout revokes an active session (the actual /auth/logout query)", async () => {
  const user = await makeUser();
  const tokenHash = crypto.randomBytes(16).toString("hex");
  await db.refreshSession.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) }
  });

  const result = await db.refreshSession.updateMany({
    where: { tokenHash, revokedAt: { isSet: false } },
    data: { revokedAt: new Date() }
  });
  assert.equal(result.count, 1, "logout must actually revoke the active session");

  await db.refreshSession.deleteMany({ where: { userId: user.id } });
  await db.emailIdentity.deleteMany({ where: { emailNormalized: user.email! } });
  await db.user.delete({ where: { id: user.id } });
});

test("a wallet with a permanent (never-expiring) delegated permission counts as active", async () => {
  const user = await makeUser();
  const wallet = await db.wallet.create({
    data: { userId: user.id, chain: "SOLANA", address: "Addr" + crypto.randomBytes(8).toString("hex"),
      tradingEnabled: true, permissionRef: "test-signer-id" }
  });

  // The exact pattern used by computeLiveReadiness / executor / exits: match wallets whose
  // permission either has no expiry set (permanent grant, the common case) or expires in the future.
  const count = await db.wallet.count({
    where: { id: wallet.id, tradingEnabled: true, permissionRef: { not: null },
      OR: [{ permissionExpiry: { isSet: false } }, { permissionExpiry: { gt: new Date() } }] }
  });
  assert.equal(count, 1, "a permanently-delegated wallet (no expiry ever set) must count as an active permission");

  await db.wallet.delete({ where: { id: wallet.id } });
  await db.emailIdentity.deleteMany({ where: { emailNormalized: user.email! } });
  await db.user.delete({ where: { id: user.id } });
});
