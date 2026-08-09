import "./globals.css";
import type { Metadata, Viewport } from "next";
import { PwaRegistrar } from "../components/PwaRegistrar";
import { InstallAppPrompt } from "../components/InstallAppPrompt";

export const metadata: Metadata = {
  title: "FomoCloud — Smart meme copy trading",
  description: "Follow smart wallets. FomoCloud watches, checks, buys and protects meme trades.",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }], shortcut: "/icon.svg", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "FomoCloud — Smart meme copy trading" }
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: "#08080c"
};

export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}<PwaRegistrar /><InstallAppPrompt /></body></html>;
}
