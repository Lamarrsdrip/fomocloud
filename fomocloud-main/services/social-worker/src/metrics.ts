export type TweetRow = { created_at: string; author_id: string; text: string };
export type PulseMetrics = {
  symbol: string;
  mint: string;
  mentions5m: number;
  mentions15m: number;
  uniqueAuthors5m: number;
  sentiment: number;
  influencerMentions: number;
  spamRatio: number;
  velocity: number;
};

const positive = /\b(bull|bullish|send|sending|moon|ape|aped|gem|based|cook|cooking|breakout|runner|100x|10x|cto)\b/i;
const negative = /\b(rug|scam|dead|dump|dumping|sell|exit|honeypot|rekt)\b/i;

// Pure feature extraction from a raw X recent-search response (already a 15-minute window) into
// the metrics Brain's social scoring actually consumes. `now` is passed in (not read from
// Date.now() internally) so a fixed instant can be tested deterministically.
export function computePulseMetrics(token: { symbol?: string | null; mint: string }, rows: TweetRow[], now: number): PulseMetrics {
  const t5 = now - 5 * 60_000;
  const r5 = rows.filter(x => new Date(x.created_at).getTime() >= t5);
  const authors = new Set(r5.map(x => x.author_id));
  const p = rows.filter(x => positive.test(x.text)).length;
  const n = rows.filter(x => negative.test(x.text)).length;
  const sent = (p - n) / Math.max(1, p + n);
  // Recent (last 5m) pace vs. the pace of the preceding 10m of the 15m window -- a genuine spike
  // in mention rate, not just raw volume. Math.max(1, ...) both times keeps a quiet or brand-new
  // token's zero-mention window from ever producing NaN/Infinity.
  const velocity = r5.length / Math.max(1, (rows.length - r5.length) / 2);
  const spam = 1 - authors.size / Math.max(1, r5.length);
  return {
    symbol: token.symbol || "",
    mint: token.mint,
    mentions5m: r5.length,
    mentions15m: rows.length,
    uniqueAuthors5m: authors.size,
    sentiment: sent,
    influencerMentions: 0,
    spamRatio: Math.max(0, Math.min(1, spam)),
    velocity,
  };
}
