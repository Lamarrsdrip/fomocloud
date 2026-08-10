import "./globals.css";
import type { Metadata, Viewport } from "next";
import { PwaRegistrar } from "../components/PwaRegistrar";

export const metadata: Metadata = {
  metadataBase: new URL("https://wheat-viper-505237.hostingersite.com"),
  title: "KAIRO — Autonomous Crypto Intelligence",
  description: "KAIRO discovers, scores and manages crypto opportunities with explainable market and wallet intelligence.",
  manifest: "/manifest.webmanifest",
  applicationName: "KAIRO",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    shortcut: "/icon.svg",
    apple: "/apple-touch-icon.png"
  },
  openGraph: {
    title: "KAIRO — Autonomous Crypto Intelligence",
    description: "Discovery, intelligence, scoring, decisions, execution and position management in one system.",
    type: "website",
    siteName: "KAIRO"
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "KAIRO" }
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: "#08080c"
};

export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}<PwaRegistrar /></body></html>;
}
