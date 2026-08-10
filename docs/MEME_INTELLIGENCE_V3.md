# KAIRO Meme Intelligence v3

## Design goal

Memecoins can move hundreds or thousands of percent before a slow bot finishes "confirming"
traditional indicators. KAIRO therefore uses **fast evidence + adaptive confidence**, not a
large stack of rigid gates.

### Principle 1 — Only catastrophic facts hard-block

Examples:
- no executable sell route
- liquidity has effectively disappeared
- intended order has unusable price impact
- a dangerous token control/extension creates an unacceptable exit risk
- creator is dumping most of their exposure into a collapsing pool

Ordinary concerns such as "top holders are a little concentrated" are warnings that affect
confidence/size. They are not automatic blocks.

### Principle 2 — Dynamic chase, not 10%

For fresh memes:
- normal chase window: about 35–40%
- strong acceleration: about 42–47%
- exceptional hyper momentum: up to about 55%

For older coins the window naturally tightens.

If a good coin is beyond the current chase window, KAIRO normally changes state to
`WAIT_PULLBACK` and keeps watching. It does not permanently throw the opportunity away.

### Principle 3 — Measure velocity, not only levels

A meme at $1m market cap with shrinking volume may be worse than a meme already at $5m with
volume, holders and buyer flow accelerating.

The engine measures:
- 1m/5m/15m volume acceleration
- buy-dollar vs sell-dollar flow
- unique buyer growth
- holder growth
- smart-wallet net flow
- creator/insider distribution
- liquidity changes
- executable price impact
- social mention velocity + unique authors + spam
- source-trader behavior
- launch/migration state

### Principle 4 — Fast path must stay fast

No LLM/API committee blocks the hot path.

Watched-wallet event -> decode -> real quote/liquidity snapshot -> deterministic intelligence ->
authorized transaction.

Social/ML enrichment runs continuously in parallel. If X is slow, the bot does not miss a
3-second meme move. It uses the latest fresh evidence and refreshes executable price immediately
before submission.

### Principle 5 — Profit harvest, then keep a moonbag

Established:
- +50%: normal partial ~30%
- +100%: normal partial ~25%
- ~45% runner

Fresh/new:
- +100%: normal partial ~30%
- +150%: normal partial ~20%
- +200%: normal partial ~15%
- ~35% runner

If trend is HYPER, the bot sells *less* at each target so more remains exposed to the exceptional
winner. If trend is cooling, it harvests more.

There is no final +500%/+1000%/+5000% sell rule. The runner exits because evidence deteriorates,
not because profit became "too large".

### Principle 6 — Adaptive runner

Approximate default breathing room:
- HYPER: 32–38%
- ACCELERATING: 26–30%
- HEALTHY: 20%
- PULLBACK with recovery evidence: 24%
- COOLING: 12%
- BROKEN: exit

A sharp pullback inside a still-strong hyper trend can trigger a partial reduction instead of
killing the entire runner.

### Principle 7 — Stops understand memes

Static stops are only the last line of defense.

Fresh token catastrophic protection starts much wider (around -55% default), while established
tokens start around -45%. Earlier exits can still happen when the *reason* for the drop is bad:
liquidity collapse, creator dump, inability to sell, flow breakdown, or clear distribution.

This avoids treating every normal 20–30% meme wick as a dead trade.

## Smart money memory

Persist per-source-wallet statistics by:
- launch age
- entry market-cap band
- liquidity band
- time since launch
- first buy vs add-on buy
- average delay between source and follower fill
- return after 30s/1m/5m/15m/1h
- maximum favorable excursion
- maximum adverse excursion
- exit quality
- token creator/deployer clusters
- social regime

Source-quality score must decay when recent behavior changes. Do not trust a wallet forever
because it had one spectacular historical winner.

## Manipulation defense

Raw volume is not enough.

Where data permits, distinguish:
- unique wallets vs repeated wallet churn
- organic buyers vs linked/funded clusters
- LP/burn/system addresses vs real holder concentration
- source trader buying vs transfers
- creator/deployer cluster distribution
- bundles/sniper clusters around launch
- wash-like repeated buy/sell behavior

## Replay / learning loop

Every accepted AND rejected signal should be forward-tracked.

For each decision record what happened after:
30s, 1m, 5m, 15m, 1h, 6h, 24h.

This lets KAIRO answer:
- Did the 40% chase window improve outcomes?
- Which skipped trades became winners?
- Which allowed warnings predict rugs?
- When should HYPER targets harvest less?
- Which source traders remain copyable after real execution lag?

Any automatic parameter update must be bounded, versioned, backtested and promoted through
staging. The bot must not silently rewrite its own money rules in production.
