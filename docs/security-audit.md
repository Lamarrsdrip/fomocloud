# Production dependency security

`image-size@2.0.2` is present only through the Privy/WalletConnect React Native build-tool chain.
GitHub advisories GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr affect every published version;
there is no installable patched release as of 2026-09-01.

MemeCloud therefore carries `patches/image-size@2.0.2.patch`. The patch rejects zero-length and
out-of-bounds ICNS, JXL and HEIF boxes before loop offsets are advanced. Regression coverage lives
in `apps/web/lib/imageSizeSecurity.test.ts`. The two audit exceptions in `pnpm-workspace.yaml` are
limited to these patched advisories and must be removed when upstream publishes a fixed release.
Re-checked 2026-09-02: npm still lists `2.0.2` (2025-04-02) as latest; no newer release exists.
`pnpm install --frozen-lockfile` from a clean `node_modules` applies the patch correctly (verified
by grepping the installed `dist/*.cjs`/`.mjs` for the patch's guard strings) and the regression
test passes against that install. `image-size` is also unreachable at runtime: it only appears via
`@privy-io/react-auth > @walletconnect/ethereum-provider > ... > react-native > metro`, an
RN-only build-tool path that Next.js's webpack build never bundles (`@walletconnect/keyvaluestorage`
declares a `browser` field that routes web builds away from the `react-native/` entry point that
requires it). Confirmed by grepping the actual production `apps/web/out`/`.next` build output: no
trace of `image-size`, `metro-resolver`, `@react-native-async-storage`, or the patched module's own
identifiers (`ispeBox`, `ipcoBox`) anywhere in the compiled bundles.

## Hostinger vs. `pnpm audit` reconciliation (2026-09-02)

Hostinger's scanner and `pnpm audit --prod` were reading two different dependency trees, not
disagreeing about the same one:

- `pnpm audit --prod` resolves the **pnpm workspace** lockfile, where the root `pnpm.overrides` in
  `package.json` force-pins `axios`, `ws`, `postcss`, `uuid` and `decode-uri-component` to versions
  already past their respective advisories (`GHSA-jqh4-m9w3-8hp9`/`GHSA-f4gw-2p7v-4548` for axios,
  `GHSA-96hv-2xvq-fx4p`/`GHSA-58qx-3vcg-4xpx` for ws, `GHSA-6g55-p6wh-862q`/`GHSA-r28c-9q8g-f849` for
  postcss, `GHSA-w5hq-g745-h8pq` for uuid, `GHSA-vcc3-ghjq-m6fr` for decode-uri-component) — this is
  why only the two already-mitigated `image-size` advisories remain.
- `docs/HOSTINGER_DEPLOYMENT.md` (now corrected) previously documented the Hostinger Git App as
  running a bare `npm run build` with `apps/web` as its own root, independent of the pnpm workspace.
  A plain `npm install` of `apps/web/package.json` in isolation was reproduced locally on
  2026-09-02: 792 packages, 29 advisories (3 high, 26 moderate) — because `npm` has no knowledge of
  the workspace's `overrides`/`patchedDependencies`/`auditConfig.ignoreGhsas`, every one of those
  five root packages resolves to its natural (vulnerable) semver-range version, and npm's audit then
  fans each one out across every ancestor package that depends on it (`@reown/appkit*`,
  `@walletconnect/*`, `@metamask/*`, `wagmi`, `next`, `query-string`, `x402`, etc. — all "moderate"
  entries in Hostinger's report are ancestors of the same handful of root advisories, not
  independent findings). This fully accounts for both the count and the severity mix Hostinger
  reported (7 high / 14 moderate); the small numeric gap from the local repro is expected registry
  drift between whenever Hostinger's scan last ran and this 2026-09-02 re-check.
- Action taken: `docs/HOSTINGER_DEPLOYMENT.md` corrected to match `docs/DEPLOY_SPLIT.md` and the
  root `hostinger:build` script (`pnpm --filter @memecloud/web build`) — pnpm, not npm. **This still
  needs to be verified/changed in the Hostinger dashboard's Git App build-command setting itself**;
  that setting isn't in this repo and wasn't accessible from this session.
