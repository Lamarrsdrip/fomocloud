// Every RPC-calling service (flow-worker, market-worker, balance-worker, social-worker, exits,
// executor, paper-worker) previously rate-limited itself independently against the shared Helius
// account -- so five processes each thinking they had their own private 10 req/s budget could
// collectively blow through the account's real limit even while each one individually looked fine.
// This is the fix: one Redis-backed token bucket per provider, shared by every process, with a
// priority tier per caller so that when the shared budget gets scarce, background/bulk callers
// (market enrichment, social hype scanning) back off first -- never the paths that touch real money
// (live sell execution) or a user's own position accuracy.

export const RPC_PRIORITY = { P0: "P0", P1: "P1", P2: "P2", P3: "P3", P4: "P4", P5: "P5" } as const;
export type RpcPriority = keyof typeof RPC_PRIORITY;

// Fraction of total bucket capacity that must remain AFTER a request is granted for that
// priority tier to be allowed to draw from the bucket at all. P0 can draw the bucket to zero --
// it is reserved for real-money paths (e.g. exits' live sell submission, executor's live buy)
// that must never be preempted by a background scanner's RPC usage. Each higher tier reserves
// progressively more headroom, so P4/P5 (market-worker enrichment, social-worker hype scanning)
// are the first to get throttled when the account is under real pressure.
export const RESERVE_FRACTION: Record<RpcPriority, number> = {
  P0: 0,
  P1: 0.05,
  P2: 0.15,
  P3: 0.3,
  P4: 0.45,
  P5: 0.6,
};

export interface TokenBucketState {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketResult extends TokenBucketState {
  granted: boolean;
}

// The single source of truth for the bucket algorithm -- unit tested directly (no Redis
// involved). The Lua script below is a deliberate line-for-line mirror of this function so the
// same decision is made atomically inside Redis under real concurrent load; if this function
// ever changes, the script must change with it.
export function computeTokenBucket(params: {
  capacity: number;
  ratePerSec: number;
  reserveFraction: number;
  state: TokenBucketState | null;
  now: number;
}): TokenBucketResult {
  const { capacity, ratePerSec, reserveFraction, now } = params;
  const prevTokens = params.state?.tokens ?? capacity;
  const prevUpdatedAt = params.state?.updatedAt ?? now;
  const elapsedSec = Math.max(0, (now - prevUpdatedAt) / 1000);
  const refilled = Math.min(capacity, prevTokens + elapsedSec * ratePerSec);
  const reserve = capacity * reserveFraction;

  if (refilled - 1 >= reserve) {
    return { tokens: refilled - 1, updatedAt: now, granted: true };
  }
  return { tokens: refilled, updatedAt: now, granted: false };
}

// Deliberate line-for-line mirror of computeTokenBucket -- see the comment there.
const TAKE_TOKEN_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local ratePerSec = tonumber(ARGV[2])
local reserveFraction = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "updatedAt")
local prevTokens = tonumber(data[1])
local prevUpdatedAt = tonumber(data[2])
if prevTokens == nil then prevTokens = capacity end
if prevUpdatedAt == nil then prevUpdatedAt = now end

local elapsedSec = math.max(0, (now - prevUpdatedAt) / 1000)
local refilled = math.min(capacity, prevTokens + elapsedSec * ratePerSec)
local reserve = capacity * reserveFraction

local granted = 0
local tokens = refilled
if refilled - 1 >= reserve then
  tokens = refilled - 1
  granted = 1
end

redis.call("HMSET", key, "tokens", tostring(tokens), "updatedAt", tostring(now))
redis.call("EXPIRE", key, 120)

return {granted, tostring(tokens)}
`;

export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RpcBudgetOptions {
  capacity: number;
  ratePerSec: number;
}

export class RpcBudget {
  constructor(
    private redis: RedisEvalClient,
    private key: string,
    private opts: RpcBudgetOptions
  ) {}

  // Fails open: if Redis is unreachable, the shared budget can't be checked, and a scanner that
  // stops making any RPC calls because its coordination layer is down is a worse outcome than one
  // that falls back to its own per-process rate limit (which every caller already has). The
  // account-level rate limit is still real and still enforced by the provider itself either way.
  async tryAcquire(priority: RpcPriority): Promise<{ granted: boolean; tokensRemaining: number }> {
    try {
      const result = (await this.redis.eval(
        TAKE_TOKEN_SCRIPT,
        1,
        this.key,
        this.opts.capacity,
        this.opts.ratePerSec,
        RESERVE_FRACTION[priority],
        Date.now()
      )) as [number, string];
      return { granted: result[0] === 1, tokensRemaining: Number(result[1]) };
    } catch {
      return { granted: true, tokensRemaining: this.opts.capacity };
    }
  }
}
