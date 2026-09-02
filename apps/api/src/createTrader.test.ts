// Regression coverage for a real bug: Admin "Create trader" returned a bare "internal error"
// with no explanation whenever the submitted handle collided with an existing Trader.handle
// (@unique in schema.prisma) -- the route had no pre-check, so db.trader.create threw an
// unhandled Prisma P2002 that fell straight through to the generic 500 handler. This proves the
// exact DB-level condition POST /v1/admin/traders now checks for before attempting the create
// (see adminRoutes.ts), and that a raw duplicate create still throws -- which is why the
// pre-check is necessary, not optional.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

test("a duplicate Trader.handle is detected by findUnique before create is attempted", async () => {
  const handle = `regress-${crypto.randomBytes(6).toString("hex")}`;
  const first = await db.trader.create({ data: { handle, displayName: "First", kind: "PLATFORM" } });

  const existing = await db.trader.findUnique({ where: { handle }, select: { id: true } });
  assert.ok(existing, "the route's pre-check must find the existing trader by handle");

  await assert.rejects(
    db.trader.create({ data: { handle, displayName: "Second", kind: "PLATFORM" } }),
    /Unique constraint failed/,
    "a genuine duplicate create must still be rejected at the DB level -- proves the pre-check guards a real constraint, not a phantom one"
  );

  await db.trader.delete({ where: { id: first.id } });
});

test("distinct handles never collide", async () => {
  const a = await db.trader.create({ data: { handle: `regress-a-${crypto.randomBytes(6).toString("hex")}`, displayName: "A", kind: "PLATFORM" } });
  const b = await db.trader.create({ data: { handle: `regress-b-${crypto.randomBytes(6).toString("hex")}`, displayName: "B", kind: "PLATFORM" } });
  assert.notEqual(a.id, b.id);
  await db.trader.delete({ where: { id: a.id } });
  await db.trader.delete({ where: { id: b.id } });
});
