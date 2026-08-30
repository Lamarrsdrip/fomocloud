import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPulse } from "./index.js";

// Real gap found by forensic audit (M-51): this package's test script was `echo social tests`
// despite classifyPulse feeding directly into Brain's narrativeScore/socialVelocity/
// socialSpamRatio scoring inputs -- including the one signal specifically meant to catch a fake,
// bot-driven pump narrative (MANIPULATED). Untested classification logic here means a bug could
// silently let a manipulated narrative score as genuine "RISING" momentum.

const base = { symbol: "MEME", mint: "MINT", mentions5m: 20, mentions15m: 40, uniqueAuthors5m: 15, sentiment: 0.1, influencerMentions: 0, spamRatio: 0.1, velocity: 1.0 };

test("classifyPulse flags high spam ratio as MANIPULATED regardless of other metrics", () => {
  assert.equal(classifyPulse({ ...base, spamRatio: 0.7, sentiment: 0.5, velocity: 2 }), "MANIPULATED");
});

test("classifyPulse flags high mention volume from very few unique authors as MANIPULATED (bot-driven)", () => {
  assert.equal(classifyPulse({ ...base, mentions5m: 150, uniqueAuthors5m: 5, spamRatio: 0.1 }), "MANIPULATED");
});

test("classifyPulse requires genuine breadth (uniqueAuthors5m) before calling something RISING, not just velocity+sentiment", () => {
  // Fast, positive, but too few distinct people talking about it -- not enough evidence of real spread.
  assert.equal(classifyPulse({ ...base, velocity: 1.5, sentiment: 0.2, uniqueAuthors5m: 5 }), "STEADY");
  assert.equal(classifyPulse({ ...base, velocity: 1.5, sentiment: 0.2, uniqueAuthors5m: 12 }), "RISING");
});

test("classifyPulse flags negative sentiment as FADING even with normal velocity", () => {
  assert.equal(classifyPulse({ ...base, velocity: 1.0, sentiment: -0.3 }), "FADING");
});

test("classifyPulse flags low velocity as FADING even with positive sentiment", () => {
  assert.equal(classifyPulse({ ...base, velocity: 0.5, sentiment: 0.3 }), "FADING");
});

test("classifyPulse defaults to STEADY for genuinely unremarkable activity", () => {
  assert.equal(classifyPulse(base), "STEADY");
});

test("classifyPulse checks MANIPULATED before FADING/RISING -- a spammy AND fast-moving token is still MANIPULATED", () => {
  assert.equal(classifyPulse({ ...base, spamRatio: 0.8, velocity: 2.0, sentiment: 0.5, uniqueAuthors5m: 20 }), "MANIPULATED");
});
