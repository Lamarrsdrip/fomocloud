"use client";

import { useEffect, useState } from "react";
import { Download, PlusSquare, Share, X } from "lucide-react";

const DISMISSED_KEY = "fomocloud_install_dismissed_at";
const INSTALLED_KEY = "fomocloud_install_completed_at";
const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const INSTALLED_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function platformDetails() {
  const userAgent = navigator.userAgent || "";
  const isIPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || isIPadOS;
  const isAndroid = /Android/i.test(userAgent);
  const isSafari = /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { isIOS, isAndroid, isSafari, isStandalone };
}

function recentStorageValue(key: string, cooldown: number) {
  try {
    const value = Number(localStorage.getItem(key) || 0);
    return value > 0 && Date.now() - value < cooldown;
  } catch {
    return false;
  }
}

function remember(key: string) {
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {}
}

export function InstallAppPrompt() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<ReturnType<typeof platformDetails> | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (location.pathname !== "/") return;
    const details = platformDetails();
    setPlatform(details);
    if (details.isStandalone) return;
    if (recentStorageValue(DISMISSED_KEY, DISMISS_COOLDOWN_MS) ||
      recentStorageValue(INSTALLED_KEY, INSTALLED_COOLDOWN_MS)) return;

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onAppInstalled = () => {
      remember(INSTALLED_KEY);
      setDeferred(null);
      setVisible(false);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    const timer = details.isIOS ? window.setTimeout(() => setVisible(true), 1800) : undefined;
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (!platform || !visible || platform.isStandalone) return null;

  function dismiss() {
    remember(DISMISSED_KEY);
    setVisible(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const result = await deferred.userChoice;
    if (result.outcome === "accepted") remember(INSTALLED_KEY);
    else remember(DISMISSED_KEY);
    setVisible(false);
    setDeferred(null);
  }

  if (platform.isIOS) return <div className="install-ios-wrap" data-testid="install-ios-guide">
    <section className="install-ios-sheet" role="dialog" aria-modal="false" aria-labelledby="install-ios-title">
      <div className="install-ios-handle" />
      <div className="install-ios-head">
        <div className="install-brand-icon" aria-hidden="true">∞</div>
        <div><span>INSTALL FOMOCLOUD</span><b id="install-ios-title">Use FomoCloud like an app.</b></div>
        <button onClick={dismiss} aria-label="Dismiss install guide"><X size={18}/></button>
      </div>
      {!platform.isSafari && <p className="install-ios-browser-note">For the standard Home Screen experience, open this page in Safari first.</p>}
      <ol className="install-ios-steps">
        <li><i>1</i><div><b>Tap the Share button</b><span><Share size={15}/> Find Share in the Safari toolbar.</span></div></li>
        <li><i>2</i><div><b>Choose “Add to Home Screen”</b><span><PlusSquare size={15}/> Scroll down if it is not immediately visible.</span></div></li>
        <li><i>3</i><div><b>Tap Add</b><span>FomoCloud will open full-screen from your Home Screen.</span></div></li>
      </ol>
      <button className="install-done" onClick={dismiss}>Got it</button>
    </section>
  </div>;

  if (!deferred) return null;

  return <div className="install-prompt-wrap" data-testid="install-app-banner" data-platform={platform.isAndroid ? "android" : "desktop"}>
    <section className="install-prompt">
        <div className="install-brand-icon" aria-hidden="true">∞</div>
        <div className="install-copy"><b>Install FomoCloud</b><span>Open FomoCloud like an app.</span></div>
        <button className="install-action" onClick={install} data-testid="install-app-btn"><Download size={14}/> Install</button>
        <button className="install-close" onClick={dismiss} aria-label="Dismiss install prompt"><X size={17}/></button>
    </section>
  </div>;
}
