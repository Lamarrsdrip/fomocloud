// Regression coverage for a real bug found by audit, the same class as RefreshSession's:
// AdminAlert.resolvedAt is never explicitly written at creation (see brain-worker's
// checkWatchlist), so it is genuinely UNSET on every row, not "set to null". Prisma's MongoDB
// connector does not match a bare `{resolvedAt:null}` filter against an unset field -- only
// `{resolvedAt:{isSet:false}}` does. GET /v1/admin/alerts?unresolved=true used the former, which
// silently returned zero alerts always, no matter how many genuinely unresolved ones existed.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

test("a never-resolved AdminAlert is NOT found by the old {resolvedAt:null} filter but IS found by {resolvedAt:{isSet:false}}", async () => {
  const alert = await db.adminAlert.create({
    data: { type: `regress-${crypto.randomBytes(6).toString("hex")}`, chain: "SOLANA", message: "test" }
  });

  const buggyMatch = await db.adminAlert.findFirst({ where: { id: alert.id, resolvedAt: null } });
  assert.equal(buggyMatch, null, "proves the bug: an unset field is never matched by a bare null filter on Mongo");

  const correctMatch = await db.adminAlert.findFirst({ where: { id: alert.id, resolvedAt: { isSet: false } } });
  assert.ok(correctMatch, "the route's actual (fixed) query must find a genuinely unresolved alert");

  await db.adminAlert.delete({ where: { id: alert.id } });
});

test("a resolved AdminAlert is excluded by {resolvedAt:{isSet:false}}", async () => {
  const alert = await db.adminAlert.create({
    data: { type: `regress-${crypto.randomBytes(6).toString("hex")}`, chain: "SOLANA", message: "test", resolvedAt: new Date() }
  });

  const match = await db.adminAlert.findFirst({ where: { id: alert.id, resolvedAt: { isSet: false } } });
  assert.equal(match, null, "a resolved alert must not appear in the unresolved-only filter");

  await db.adminAlert.delete({ where: { id: alert.id } });
});
