import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaRpcCandidates, FREE_PUBLIC_SOLANA_RPC_FALLBACKS } from "./index.js";

test("candidate list is never empty, even with zero config -- the free public fallbacks always apply", () => {
  const candidates = solanaRpcCandidates(null);
  assert.ok(candidates.length > 0);
  for (const url of FREE_PUBLIC_SOLANA_RPC_FALLBACKS) assert.ok(candidates.includes(url));
});

test("admin-configured RPCs are prioritized ahead of the free public fallbacks", () => {
  const candidates = solanaRpcCandidates({ heliusRpc: "https://my-helius.example.com", solanaRpc: "https://my-backup.example.com" });
  assert.equal(candidates[0], "https://my-helius.example.com");
  assert.equal(candidates[1], "https://my-backup.example.com");
  // the previously-orphaned fallbackRpc field and free public fallbacks still appear, just later
  assert.ok(candidates.includes(FREE_PUBLIC_SOLANA_RPC_FALLBACKS[0]));
});

test("the admin's fallbackRpc field (previously never read by any worker) is included", () => {
  const candidates = solanaRpcCandidates({ fallbackRpc: "https://my-fallback.example.com" });
  assert.ok(candidates.includes("https://my-fallback.example.com"));
});

test("duplicate hosts across candidates are deduped, keeping the higher-priority occurrence", () => {
  const candidates = solanaRpcCandidates({ heliusRpc: "https://same.example.com/a", solanaRpc: "https://same.example.com/b" });
  const hosts = candidates.map(u => new URL(u).host);
  assert.equal(new Set(hosts).size, hosts.length, "no duplicate hosts");
  assert.equal(candidates[0], "https://same.example.com/a", "the higher-priority URL for that host is kept");
});
