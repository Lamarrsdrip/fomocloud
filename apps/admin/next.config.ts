import type { NextConfig } from "next";
import { join } from "node:path";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the monorepo root so Next's file tracing ignores stray parent lockfiles.
  outputFileTracingRoot: join(import.meta.dirname, "../../"),
  headers: async () => [{
    source: "/(.*)",
    headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }
    ]
  }]
};
export default nextConfig;
