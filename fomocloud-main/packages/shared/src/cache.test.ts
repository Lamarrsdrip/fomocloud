import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedTokenDecimals, type MinimalRedisClient } from "./index.js";

function mockRedis(initial: Record<string, string> = {}): MinimalRedisClient & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    async get(key: string) {
      return key in store ? store[key] : null;
    },
    async set(key: string, value: string) {
      store[key] = value;
      return "OK";
    },
  };
}

test("a cache miss calls fetchFresh exactly once and stores the result", async () => {
  const redis = mockRedis();
  let calls = 0;
  const fetchFresh = async () => { calls++; return 6; };
  const result = await cachedTokenDecimals(redis, "MINT_A", fetchFresh);
  assert.equal(result, 6);
  assert.equal(calls, 1);
  assert.equal(redis.store["token-decimals:MINT_A"], "6");
});

test("a cache hit never calls fetchFresh -- this is the whole point of sharing the cache across processes", async () => {
  const redis = mockRedis({ "token-decimals:MINT_B": "9" });
  let calls = 0;
  const fetchFresh = async () => { calls++; return 999; };
  const result = await cachedTokenDecimals(redis, "MINT_B", fetchFresh);
  assert.equal(result, 9);
  assert.equal(calls, 0);
});

test("different mints are cached independently", async () => {
  const redis = mockRedis();
  await cachedTokenDecimals(redis, "MINT_C", async () => 6);
  await cachedTokenDecimals(redis, "MINT_D", async () => 8);
  assert.equal(await cachedTokenDecimals(redis, "MINT_C", async () => { throw new Error("should not be called"); }), 6);
  assert.equal(await cachedTokenDecimals(redis, "MINT_D", async () => { throw new Error("should not be called"); }), 8);
});

test("a Redis read failure falls back to fetching fresh rather than throwing", async () => {
  const redis: MinimalRedisClient = {
    get: async () => { throw new Error("redis down"); },
    set: async () => "OK",
  };
  const result = await cachedTokenDecimals(redis, "MINT_E", async () => 5);
  assert.equal(result, 5);
});

test("a Redis write failure never prevents returning the freshly-fetched value", async () => {
  const redis: MinimalRedisClient = {
    get: async () => null,
    set: async () => { throw new Error("redis down"); },
  };
  const result = await cachedTokenDecimals(redis, "MINT_F", async () => 7);
  assert.equal(result, 7);
});
