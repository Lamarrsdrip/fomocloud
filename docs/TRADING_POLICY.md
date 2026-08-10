# NOTE: Superseded/extended by MEME_INTELLIGENCE_V3.md

# KAIRO trading policy

## Plain-English goal

KAIRO should behave like a disciplined meme-coin trader, not a blind copy button.

It watches verified source wallets. When they buy, KAIRO asks:

1. Is this really a buy?
2. Can we actually sell this token again?
3. Is there enough liquidity for this user's size?
4. Has the price already run too far since the source trade?
5. Are buyers still entering, or are early wallets dumping?
6. Is the token contract/mint showing dangerous permissions or concentration?
7. Is social attention real and broad, or mostly spam/bot repetition?
8. Does this user still have room under their own risk limits?

Only then can it enter.

## Profit rules

### Established tokens

Default:
- +50%: sell 35% of the position.
- +100%: sell another 25%.
- Remaining 40% becomes a runner.

The runner has no fixed maximum profit target.

If the token keeps strong volume, healthy buy flow, real social attention and sufficient
liquidity, KAIRO can hold the runner through +200%, +500%, +1000%, +5000% and beyond.

### New tokens

A "new token" is initially defined as <=24 hours old and should be configurable.

Default:
- +100%: sell 30%.
- +150%: sell another 20%.
- +200%: sell another 15%.
- Remaining 35% becomes a runner.

The runner is protected by an adaptive trail, not a fixed final TP.

## Adaptive trailing

The bot tracks the best profit reached since entry.

When trend is:
- ACCELERATING: allow roughly 28% pullback from peak before closing the runner.
- HEALTHY: allow roughly 18%.
- COOLING: tighten to roughly 10%.
- BROKEN: exit rather than wait for a large giveback.

This is designed to let exceptional meme winners breathe while still protecting gains after
hype/volume weakens.

These percentages are defaults, not guarantees, and must be tested against real historical ticks/
swaps before public launch.

## Stop-loss logic

A meme token can wick violently, so KAIRO should not use an unnecessarily tight static stop.

Default initial protection:
- Established: around -22%.
- New token: around -28%.

Hard emergency limits:
- Established: around -35%.
- New token: around -42%.

More important than the static number is **why** price is falling.

KAIRO tightens/forces exit when several things deteriorate together:
- sell flow overwhelms buys
- volume collapses
- liquidity is removed
- social attention turns sharply negative/fades
- source trader exits
- sell route disappears or price impact becomes extreme
- holder/authority risk suddenly worsens

The engine should avoid treating every normal meme pullback as a dead token.

## "Dip ending" logic

KAIRO must never claim it knows the exact bottom.

Instead, a dip-recovery state can require evidence such as:
- selling intensity falls for multiple windows
- unique buyers begin rising again
- 1m/5m volume stops contracting
- price reclaims a short-term VWAP/structure level
- liquidity remains intact
- social velocity is stable or increasing
- large tracked wallets are not aggressively distributing

Only then can the engine classify:
`DIP_RECOVERY_POSSIBLE`

It is a probability state, not certainty.

## Scam/rug protection

A token can be BLOCKED before entry or emergency-exited if evidence is severe.

Examples:
- no executable sell route
- liquidity disappears
- freeze/mint permissions create unacceptable risk
- extreme holder concentration
- huge price impact at the user's intended size
- suspicious wallet concentration
- abnormal sell restrictions
- social activity looks highly manipulated
- tracked insiders distribute aggressively

The UI should say:
`Blocked — no safe sell route`
or
`High risk — holder concentration`
instead of pretending the bot "knows it is a scam."

## Social/X monitoring

Social data is a confirmation layer, not a reason to buy by itself.

Track:
- mention velocity
- unique authors
- influencer/trader mentions
- sentiment
- spam ratio
- repeated identical posts
- engagement quality
- project/mint address mentions
- how quickly attention is growing/fading

Social signal states:
- RISING
- STEADY
- FADING
- MANIPULATED

A token with 5,000 bot posts from ten accounts is not treated like a token discussed by hundreds
of independent real accounts.

## Fees

KAIRO is designed for transaction/execution fees instead of subscription fees.

The production fee model must be:
- disclosed before authorization
- visible on every trade receipt
- included in realized P&L
- never silently deducted
- legally reviewed for each launch jurisdiction

A reasonable implementation is a small percentage of executed volume or realized trade value,
subject to legal review and unit-economics testing.

## What KAIRO cannot truthfully promise

It cannot guarantee:
- profit
- that a token is not a scam
- the exact top
- the exact bottom
- that hype will continue
- that a source trader will remain profitable

The product advantage should come from fast detection, disciplined filters, transparent execution,
adaptive exits and strong risk controls — not impossible certainty claims.
