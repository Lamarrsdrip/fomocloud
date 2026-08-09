# Live-money readiness checklist

Do not enable public live execution until every critical item is complete.

## Wallet / signing
- [ ] Production signer/delegation provider selected.
- [ ] Users can revoke authority.
- [ ] Per-trade and aggregate limits are enforced outside the browser.
- [ ] No primary-wallet secret enters app servers.
- [ ] Lost/expired permission behavior tested.

## Chain / decoding
- [ ] Production RPC + fallback RPC configured.
- [ ] Jupiter/Raydium/other used routes decoded with real fixtures.
- [ ] Transfers are not misclassified as swaps.
- [ ] Partial sells and routed swaps tested.
- [ ] Reconnect/replay test passes.

## Execution
- [ ] Real quote adapter tested.
- [ ] Token decimals/USDC conversion tested.
- [ ] Slippage and price-impact caps enforced.
- [ ] Quote expiry tested.
- [ ] Transaction failure is never shown as success.
- [ ] Duplicate submission test passes.
- [ ] Service restart during pending transaction tested.

## Accounting
- [ ] Entry amount reconciles to actual wallet balance.
- [ ] Exit amount reconciles to actual wallet balance.
- [ ] Fees included where measurable.
- [ ] Partial exits produce correct cost basis.
- [ ] Realized P&L is chain-derived.
- [ ] Reconciliation alarm works.

## Security
- [ ] Independent application security review.
- [ ] Any custom on-chain program audited.
- [ ] Admin SSO + MFA + RBAC.
- [ ] Secrets moved to KMS/secret manager.
- [ ] Rate limits and abuse controls enabled.
- [ ] Incident response + kill switch exercised.

## Controlled launch
- [ ] Owner-only live testing with tiny amounts.
- [ ] 100+ buy/sell cycles or equivalent scenario coverage.
- [ ] High-congestion test.
- [ ] RPC outage test.
- [ ] Liquidity collapse / no-route test.
- [ ] Gradual allowlist rollout before public availability.

## Legal
- [ ] Counsel reviewed copy-trading, automated execution, custody/non-custody, fees, marketing,
      sanctions/AML obligations and the jurisdictions where the product will be offered.
