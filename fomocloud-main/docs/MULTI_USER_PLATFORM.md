# Multi-user product architecture

## Source signal fan-out

One verified public trader wallet is monitored once regardless of follower count.

```text
source wallet transaction
        ↓
normalized Signal (unique idempotency key)
        ↓
Redis `signals` queue
        ↓
resolve every FOLLOW/WATCH/AUTO_COPY user
        ↓
independent CopyDecision per user
        ↓
user-specific order / activity / notification
```

`CopyDecision` has a unique `(signalId, userId)` constraint. `Order.idempotencyKey` adds another business-level duplicate barrier.

## Follow states

- `FOLLOW_ONLY` — save/social favorite, no trade decision needed for execution
- `WATCH_ONLY` — receive source-signal activity, never buy
- `AUTO_COPY` — evaluate with user settings
- `PAUSED` — disabled per trader

Global Auto Copy is another independent user switch.

## User-owned data

The following remain scoped to `userId`: wallets, trading cash allocations, follows/settings, copy decisions, orders, positions, activity, notifications, P&L snapshots, push subscriptions and social links.

Custom source wallets can be deduplicated globally so 10,000 people following the same public address do not create 10,000 chain subscriptions. The display label/X label is stored on each `UserFollow`, not leaked across users.

## Authentication vs trading permission

Account auth proves the person can use their private workspace. Wallet proof proves ownership of a public address. Neither equals unattended trading authority.

Live execution must require an active chain-specific `Wallet.tradingEnabled + permissionRef` and an actual reviewed SignerProvider. The current executor still refuses live submission because that final signer is intentionally not implemented as a fake fallback.
