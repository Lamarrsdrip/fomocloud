# v0.5 verification checklist

Before deploying this update:

1. `pnpm install`
2. `pnpm db:generate`
3. make a `mongodump`, restore it to staging, then run `pnpm db:migrate:v05` and `pnpm db:push` against staging first
4. `pnpm typecheck`
5. `pnpm build`
6. `pnpm test`
7. build static frontend with the exact HTTPS API URL
8. test two separate user accounts and verify no cross-user reads/writes
9. test wallet challenge replay rejection
10. test normal user cannot access `/v1/admin/*`
11. test custom trader labels remain user-specific while source wallet monitoring deduplicates
12. test +5000% daily-move context does not alter a +35% source-wallet chase
13. test duplicate source signal → max one CopyDecision per user
14. test simulation orders are visually/accountingly separated from live P&L
15. test VAPID subscription + admin push
16. test SMTP + broadcast queue
17. restart each Windows service and verify heartbeat recovery
18. keep `LIVE_EXECUTION_ENABLED=false` until signer/delegation readiness is complete
