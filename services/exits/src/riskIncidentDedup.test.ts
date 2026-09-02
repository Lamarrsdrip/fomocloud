// Regression coverage for a real bug found by audit: this exact dedup query (see index.ts's
// catch block) was written specifically to stop a persistent exit error from creating a fresh
// CRITICAL RiskIncident every single 3s tick -- but resolvedAt is never explicitly written at
// RiskIncident creation, so it is genuinely UNSET, not "set to null". A bare `resolvedAt:null`
// filter never matches an unset field on Mongo (only `{isSet:false}` does), so the dedup check
// was always finding nothing and creating a new incident every tick regardless -- the exact
// spam the fix was supposed to prevent, silently not working.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@memecloud/db";

test("a never-resolved RiskIncident is NOT found by {resolvedAt:null} but IS found by {resolvedAt:{isSet:false}}", async () => {
  const positionId = crypto.randomBytes(12).toString("hex");
  const code = `regress-${crypto.randomBytes(6).toString("hex")}`;
  const incident = await db.riskIncident.create({
    data: { severity: "CRITICAL", scope: "EXIT_ENGINE", chain: "SOLANA", positionId, code, detail: { message: "test" } }
  });

  const buggyMatch = await db.riskIncident.findFirst({ where: { positionId, code, resolvedAt: null } });
  assert.equal(buggyMatch, null, "proves the bug: an unset field is never matched by a bare null filter on Mongo");

  const correctMatch = await db.riskIncident.findFirst({ where: { positionId, code, resolvedAt: { isSet: false } } });
  assert.ok(correctMatch, "the exits dedup query (fixed) must find the still-unresolved incident and skip creating a duplicate");

  await db.riskIncident.delete({ where: { id: incident.id } });
});
