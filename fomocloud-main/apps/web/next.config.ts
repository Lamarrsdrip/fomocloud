import type { NextConfig } from "next";

// Static PWA on Hostinger. All account/trading data comes from the HTTPS VPS API.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
