import type { NextConfig } from "next";

// FomoCloud frontend is a static PWA hosted on Hostinger. All data comes from the
// VPS backend API over HTTPS (NEXT_PUBLIC_API_URL) — there is no server on Hostinger.
// Security headers are applied at the host (Hostinger/.htaccess or the backend), since
// `headers()` does not run in a static export.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
