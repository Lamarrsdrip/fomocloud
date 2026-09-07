import test from "node:test";
import assert from "node:assert/strict";
import { unresolvedRiskIncidentWhere } from "./riskIncidentDedup.js";

test("unresolved risk incidents use Mongo isSet:false rather than null", () => {
  const since = new Date("2026-09-07T00:00:00.000Z");

  const where = unresolvedRiskIncidentWhere(
    "position-test",
    "EXIT_TEST",
    since
  );

  assert.equal(where.positionId, "position-test");
  assert.equal(where.code, "EXIT_TEST");
  assert.deepEqual(where.resolvedAt, { isSet: false });
  assert.notEqual(where.resolvedAt, null);
  assert.equal(where.createdAt.gte, since);
});
