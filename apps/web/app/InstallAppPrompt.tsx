"use client";
import { useEffect, useState } from "react";
import { Download, Share, PlusSquare, X, Smartphone, ChevronRight } from "lucide-react";

const DISMISSED_KEY = "fomocloud_install_dismissed_at";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type BIPEvent = Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> };

function detectPlatform() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi/i.test(ua);
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return { isIOS, isAndroid, isMobile, isStandalone };
}

/**
 * First-visit "Add to Home Screen" prompt.
 * Android/Chrome → uses beforeinstallprompt for one-tap install.
 * iOS/Safari → shows the manual Share → Add to Home Screen steps (no programmatic API).
 * Dismissals are remembered for 7 days; hidden entirely once installed (standalone).
 */
export default function InstallAppPrompt() {
  const [show, setShow] = useState(false);
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [platform, setPlatform] = useState<ReturnType<typeof detectPlatform> | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const p = detectPlatform();
    setPlatform(p);
    if (p.isStandalone) return;
    const dismissedAt = parseInt(localStorage.getItem(DISMISSED_KEY) || "0", 10);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;

    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BIPEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBIP);

    let t: ReturnType<typeof setTimeout> | undefined;
    if (p.isMobile) t = setTimeout(() => setShow(true), 1500);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener("beforeinstallprompt", onBIP);
    };
  }, []);

  if (!platform || !show || platform.isStandalone) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, Date.now().toString());
    setShow(false);
  };
  const installNow = async () => {
    if (!deferred) { setExpanded(true); return; }
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setShow(false);
    setDeferred(null);
  };

  const wrap: React.CSSProperties = {
    position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 80,
    padding: "12px", paddingBottom: "calc(env(safe-area-inset-bottom) + 84px)",
    pointerEvents: "none"
  };
  const card: React.CSSProperties = {
    maxWidth: 460, margin: "0 auto", pointerEvents: "auto",
    background: "linear-gradient(160deg,#151428,#0b0b14)",
    border: "1px solid rgba(124,92,255,0.34)", borderRadius: 20,
    boxShadow: "0 24px 70px -18px rgba(91,140,255,0.45)", overflow: "hidden",
    color: "#fff", fontFamily: "inherit"
  };
  const badge: React.CSSProperties = {
    width: 44, height: 44, borderRadius: 13, flex: "none", color: "#0a0a12",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "linear-gradient(135deg,#7c5cff,#22d3ee)"
  };
  const cta: React.CSSProperties = {
    border: "none", cursor: "pointer", flex: "none", fontWeight: 700, fontSize: 13,
    padding: "9px 15px", borderRadius: 999, color: "#0a0a12",
    background: "linear-gradient(135deg,#7c5cff,#5b8cff)",
    display: "inline-flex", alignItems: "center", gap: 6
  };
  const xbtn: React.CSSProperties = {
    background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.45)",
    padding: 6, display: "flex", flex: "none"
  };
  const num: React.CSSProperties = {
    width: 24, height: 24, borderRadius: 999, flex: "none", fontSize: 12, fontWeight: 700,
    color: "#0a0a12", background: "linear-gradient(135deg,#7c5cff,#22d3ee)",
    display: "flex", alignItems: "center", justifyContent: "center"
  };

  return (
    <div style={wrap} data-testid="install-app-banner">
      <div style={card}>
        {!expanded && (
          <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={badge}><Smartphone size={20} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Install FomoCloud</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                {platform.isIOS ? "Tap Share → Add to Home Screen" : "One tap — opens like a native app"}
              </div>
            </div>
            <button style={cta} onClick={platform.isIOS ? () => setExpanded(true) : installNow} data-testid="install-app-btn">
              {platform.isIOS ? <>Show me <ChevronRight size={13} /></> : <>Install <Download size={13} /></>}
            </button>
            <button style={xbtn} onClick={dismiss} aria-label="Dismiss"><X size={16} /></button>
          </div>
        )}
        {expanded && (
          <div style={{ padding: 20 }} data-testid="install-app-expanded">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Add to Home Screen</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>3 quick steps — feels like a native app</div>
              </div>
              <button style={xbtn} onClick={dismiss} aria-label="Close"><X size={16} /></button>
            </div>
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
              <li style={{ display: "flex", gap: 12 }}>
                <span style={num}>1</span>
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>Tap the <Share size={15} /> Share button</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>At the bottom of Safari</div>
                </div>
              </li>
              <li style={{ display: "flex", gap: 12 }}>
                <span style={num}>2</span>
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>Tap <PlusSquare size={15} /> &quot;Add to Home Screen&quot;</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Scroll down if you don&apos;t see it</div>
                </div>
              </li>
              <li style={{ display: "flex", gap: 12 }}>
                <span style={num}>3</span>
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>Tap &quot;Add&quot;</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>FomoCloud opens full-screen like a real app</div>
                </div>
              </li>
            </ol>
            <button style={{ ...cta, width: "100%", justifyContent: "center", marginTop: 16, padding: "11px 0" }} onClick={dismiss} data-testid="install-got-it-btn">
              Got it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
