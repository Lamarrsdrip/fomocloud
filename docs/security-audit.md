# Production dependency security

`image-size@2.0.2` is present only through the Privy/WalletConnect React Native build-tool chain.
GitHub advisories GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr affect every published version;
there is no installable patched release as of 2026-09-01.

MemeCloud therefore carries `patches/image-size@2.0.2.patch`. The patch rejects zero-length and
out-of-bounds ICNS, JXL and HEIF boxes before loop offsets are advanced. Regression coverage lives
in `apps/web/lib/imageSizeSecurity.test.ts`. The two audit exceptions in `pnpm-workspace.yaml` are
limited to these patched advisories and must be removed when upstream publishes a fixed release.
