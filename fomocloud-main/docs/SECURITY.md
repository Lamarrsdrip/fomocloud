# Security model

## Absolute rules

1. Never ask for a user's seed phrase.
2. Never ask for a user's raw primary-wallet private key.
3. Live execution is fail-closed.
4. A browser wallet signature authenticates ownership; it is not unattended trade authorization.
5. Trade authority must be scoped, revocable, expiring where possible, and independently policy-enforced.
6. Admin access must not imply wallet-withdrawal authority.

## Recommended production signing model

Use a dedicated policy-controlled trading authority or smart-wallet/delegation provider that can:

- restrict supported chains
- cap per-trade value
- cap daily value
- cap total exposure
- restrict allowed programs/contracts or transaction shapes
- require explicit initial user authorization
- support immediate revocation
- expose immutable audit records

Do not improvise key custody in application code.

## Infrastructure

- managed KMS/HSM or audited signer provider for service credentials
- secret rotation
- separate production/staging projects
- database encryption at rest
- TLS everywhere
- private networking for DB/Redis
- rate limiting and bot abuse controls
- SSO + hardware MFA for admin
- RBAC / least privilege
- structured audit logs
- dependency and container vulnerability scanning
- CI secret scanning
- incident-response runbook

## Smart-contract / authority review

Any custom on-chain program or novel delegation design must receive an independent security audit
before public funds are enabled.
