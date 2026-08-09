"use client";

import { useEffect, useState } from "react";
import { Download, MoreVertical, PlusSquare, Share, Smartphone, X } from "lucide-react";

const DISMISSED_KEY = "fomocloud_install_dismissed_at";
const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function platformDetails() {
  const userAgent = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { isIOS, isAndroid, isStandalone };
}

export function InstallAppPrompt() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [platform, setPlatform] = useState<ReturnType<typeof platformDetails> | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (location.pathname !== "/") return;
    const details = platformDetails();
    setPlatform(details);
    if (details.isStandalone) return;
    const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    const timer = window.setTimeout(() => setVisible(true), details.isIOS || details.isAndroid ? 2200 : 4200);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    };
  }, []);

  if (!platform || !visible || platform.isStandalone) return null;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setVisible(false);
  }

  async function install() {
    if (!deferred) {
      setExpanded(true);
      return;
    }
    await deferred.prompt();
    const result = await deferred.userChoice;
    if (result.outcome === "accepted") setVisible(false);
    setDeferred(null);
  }

  const title = platform.isIOS ? "Install FomoCloud on iPhone" : "Install FomoCloud";
  const subtitle = platform.isIOS ? "Three taps from Safari" : "One tap — opens like a native app";

  return <div className={`install-prompt-wrap ${expanded ? "expanded" : ""}`} data-testid="install-app-banner">
    <section className="install-prompt">
      {!expanded ? <>
        <div className="install-icon"><Smartphone size={21}/></div>
        <div className="install-copy"><b>{title}</b><span>{subtitle}</span></div>
        <button className="install-action" onClick={platform.isIOS ? () => setExpanded(true) : install}>
          {deferred ? <><Download size={14}/> Install</> : <>Show me</>}
        </button>
        <button className="install-close" onClick={dismiss} aria-label="Dismiss install prompt"><X size={17}/></button>
      </> : <div className="install-guide">
        <div className="install-guide-head"><div><b>Install FomoCloud</b><span>Open full screen from your Home Screen</span></div><button onClick={dismiss} aria-label="Close install guide"><X size={17}/></button></div>
        {platform.isIOS ? <ol>
          <li><i>1</i><div><b>Tap Share</b><span>Use the <Share size={14}/> button in Safari.</span></div></li>
          <li><i>2</i><div><b>Add to Home Screen</b><span>Choose <PlusSquare size={14}/> “Add to Home Screen”.</span></div></li>
          <li><i>3</i><div><b>Open FomoCloud</b><span>Launch it from the new Home Screen icon.</span></div></li>
        </ol> : <ol>
          <li><i>1</i><div><b>Open the browser menu</b><span>Use the install icon or <MoreVertical size={14}/> browser menu.</span></div></li>
          <li><i>2</i><div><b>Install FomoCloud</b><span>Choose “Install app” or “Add to Home Screen”.</span></div></li>
          <li><i>3</i><div><b>Open the app</b><span>FomoCloud launches in its own app window.</span></div></li>
        </ol>}
        <button className="install-done" onClick={dismiss}>Got it</button>
      </div>}
    </section>
  </div>;
}
