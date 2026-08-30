"use client";

export type DetectedWallet = { id: "phantom" | "solflare" | "backpack"; name: string; provider: any };

// iOS/Android mobile browsers have no extension mechanism, so on mobile Safari/Chrome
// window.solana is NEVER injected — whether or not Phantom is actually installed. The only
// correct mobile-web path is Phantom's own documented universal link that reopens the current
// page inside Phantom's in-app browser (where it injects window.solana like a normal extension).
export function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

export function detectInjectedWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as any;
  const found: DetectedWallet[] = [];
  if (w.solana?.isPhantom) found.push({ id: "phantom", name: "Phantom", provider: w.solana });
  if (w.solflare?.isSolflare) found.push({ id: "solflare", name: "Solflare", provider: w.solflare });
  if (w.backpack?.isBackpack) found.push({ id: "backpack", name: "Backpack", provider: w.backpack });
  return found;
}

// Phantom's documented "Browse" universal link: https://docs.phantom.app/phantom-deeplinks/other-methods/browse
// Reopens `url` inside Phantom's in-app browser, where window.solana becomes available exactly
// like a desktop extension. This does not require implementing Phantom's encrypted deep-link
// connect protocol (a much larger, separate integration) — it just moves the user into an
// environment where the existing injected-provider flow already works unmodified.
export function phantomBrowseUrl(targetUrl: string) {
  const url = encodeURIComponent(targetUrl);
  const ref = encodeURIComponent(typeof window !== "undefined" ? window.location.origin : "https://meme.xaucloud.io");
  return `https://phantom.app/ul/browse/${url}?ref=${ref}`;
}

export const WALLET_INSTALL_LINKS: Record<DetectedWallet["id"], string> = {
  phantom: "https://phantom.app/download",
  solflare: "https://solflare.com/download",
  backpack: "https://backpack.app/download"
};

function toBase64(bytes: Uint8Array) {
  let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s);
}

export async function connectWallet(provider: any): Promise<string> {
  const connected = await provider.connect();
  return connected.publicKey.toString();
}

export async function signWithWallet(provider: any, message: string): Promise<string> {
  const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  return `base64:${toBase64(signed.signature)}`;
}
