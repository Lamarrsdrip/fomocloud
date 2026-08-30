"use client";

import { useEffect, useState } from "react";
import { Download, PlusSquare, Share, X } from "lucide-react";
import {BrandGlyph} from "./BrandGlyph";

const DISMISSED_KEY = "memecloud_install_dismissed_at";
const INSTALLED_KEY = "memecloud_install_completed_at";
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
    if (details.isStandalone) return; // never show once running as an installed PWA
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

  useEffect(() => {
    if (!visible || !platform?.isIOS) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [visible, platform?.isIOS]);

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

  if (platform.isIOS) return <div className="install-ios-wrap" onClick={dismiss}>
    <section className="install-ios-sheet" role="dialog" aria-modal="true" aria-labelledby="install-ios-title" onClick={e=>e.stopPropagation()}>
      <div className="install-ios-handle" />
      <button className="install-ios-close" onClick={dismiss} aria-label="Close"><X size={18}/></button>
      <div className="install-ios-head">
        <div className="install-brand-icon" aria-hidden="true"><BrandGlyph size={26}/></div>
        <b id="install-ios-title">Install MemeCloud</b>
        <p>Use MemeCloud like an app on your iPhone.</p>
      </div>
      {!platform.isSafari && <p className="install-ios-browser-note">Open this page in Safari to install it.</p>}
      <div className="install-ios-steps">
        <div className="install-step"><i>1</i><span>Tap <Share size={14}/> Share</span></div>
        <div className="install-step"><i>2</i><span>Tap <PlusSquare size={14}/> "Add to Home Screen"</span></div>
        <div className="install-step"><i>3</i><span>Tap "Add"</span></div>
      </div>
      <button className="install-done" onClick={dismiss}>Got it</button>
    </section>
  </div>;

  if (!deferred) return null;

  return <div className="install-prompt-wrap" data-testid="install-app-banner" data-platform={platform.isAndroid ? "android" : "desktop"}>
    <section className="install-prompt">
        <div className="install-brand-icon" aria-hidden="true"><BrandGlyph size={22}/></div>
        <div className="install-copy"><b>Install MemeCloud</b><span>Open MemeCloud like a native app.</span></div>
        <button className="install-action" onClick={install} data-testid="install-app-btn"><Download size={14}/> Install</button>
        <button className="install-close" onClick={dismiss} aria-label="Dismiss install prompt"><X size={17}/></button>
    </section>
  </div>;
}
