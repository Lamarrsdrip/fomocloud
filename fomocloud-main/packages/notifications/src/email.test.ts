import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFrom, htmlToPlainFallback, renderEmail } from "./index.js";

// Real gap found by forensic audit (M-51): this package's test script was `echo notification
// tests` -- a green no-op -- despite formatFrom/htmlToPlainFallback/renderEmail being pure,
// deliverability-affecting logic (spam-score signals, accessibility) with zero coverage.

test("formatFrom wraps a bare address (a real spam-score signal) with a display name", () => {
  assert.equal(formatFrom("support@meme.xaucloud.io"), "MemeCloud <support@meme.xaucloud.io>");
});

test("formatFrom never overrides an admin-configured display name", () => {
  assert.equal(formatFrom("Custom Name <custom@meme.xaucloud.io>"), "Custom Name <custom@meme.xaucloud.io>");
});

test("htmlToPlainFallback converts links to '<text> (<url>)', not just stripping the href", () => {
  const text = htmlToPlainFallback('<p>Click <a href="https://example.com/verify">here</a> to verify.</p>');
  assert.match(text, /here \(https:\/\/example\.com\/verify\)/);
});

test("htmlToPlainFallback turns block-level tags into real line breaks, not run-together text", () => {
  const text = htmlToPlainFallback("<div>Line one</div><div>Line two</div>");
  assert.equal(text, "Line one\nLine two");
});

test("htmlToPlainFallback decodes common HTML entities", () => {
  const text = htmlToPlainFallback("<p>Terms &amp; Conditions &lt;v2&gt;</p>");
  assert.equal(text, "Terms & Conditions <v2>");
});

test("htmlToPlainFallback collapses excess blank lines rather than leaving a wall of newlines", () => {
  const text = htmlToPlainFallback("<div>A</div><br><br><br><div>B</div>");
  assert.ok(!/\n{3,}/.test(text), "should not contain 3+ consecutive newlines");
});

test("renderEmail includes a real plaintext multipart alternative (a deliverability signal, not just decoration)", () => {
  const { html, text } = renderEmail({ preheader: "Verify your account", heading: "Confirm your email", bodyHtml: "<p>Tap below to verify.</p>", ctaLabel: "Verify Email", ctaUrl: "https://meme.xaucloud.io/verify?token=abc" });
  assert.match(html, /Confirm your email/);
  assert.match(html, /Verify Email/);
  assert.match(text, /Confirm your email/);
  assert.match(text, /Verify Email \(https:\/\/meme\.xaucloud\.io\/verify\?token=abc\)/);
});

test("renderEmail omits the CTA block entirely when no call-to-action is given", () => {
  const { html } = renderEmail({ preheader: "Notice", heading: "Account update", bodyHtml: "<p>Your settings changed.</p>" });
  assert.doesNotMatch(html, /display:inline-block;background:#6468ff/);
});
