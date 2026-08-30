"use client";
import { useEffect, useState } from "react";
import { X, Wallet, ExternalLink } from "lucide-react";
import { detectInjectedWallets, isMobileDevice, phantomBrowseUrl, WALLET_INSTALL_LINKS, type DetectedWallet } from "../lib/wallet";

export default function WalletChooser({open, busy, onClose, onPick}:{
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onPick: (wallet: DetectedWallet) => void;
}){
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWallets(detectInjectedWallets());
    setMobile(isMobileDevice());
  }, [open]);

  if (!open) return null;
  const hasPhantom = wallets.some(w => w.id === "phantom");

  return <div className="wallet-chooser-wrap" onClick={onClose}>
    <div className="wallet-chooser-sheet" onClick={e => e.stopPropagation()}>
      <div className="wallet-chooser-handle" />
      <div className="wallet-chooser-head">
        <b>Choose a Solana wallet</b>
        <button type="button" className="wallet-chooser-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <p>Connect an installed wallet, or open MemeCloud inside your wallet's app.</p>

      {wallets.length > 0 && <div className="wallet-chooser-list">
        {wallets.map(w => (
          <button key={w.id} type="button" className="wallet-chooser-row" disabled={busy} onClick={() => onPick(w)}>
            <span className="wallet-chooser-icon"><Wallet size={17} /></span>
            <span>{w.name}</span>
            <span className="wallet-chooser-tag">Detected</span>
          </button>
        ))}
      </div>}

      {mobile && !hasPhantom && <>
        {/* Mobile Safari/Chrome never inject a wallet provider — the only correct path is
            Phantom's own documented universal link, which reopens this exact page inside
            Phantom's in-app browser (where window.solana becomes available normally). */}
        <a className="wallet-chooser-row wallet-chooser-link" href={phantomBrowseUrl(typeof window !== "undefined" ? window.location.href : "https://meme.xaucloud.io")}>
          <span className="wallet-chooser-icon"><Wallet size={17} /></span>
          <span>Open in Phantom<small>Continue in the Phantom app</small></span>
          <ExternalLink size={14} />
        </a>
      </>}

      {wallets.length === 0 && !mobile && <>
        <a className="wallet-chooser-row wallet-chooser-link" href={WALLET_INSTALL_LINKS.phantom} target="_blank" rel="noreferrer">
          <span className="wallet-chooser-icon"><Wallet size={17} /></span>
          <span>Install Phantom<small>Browser extension</small></span>
          <ExternalLink size={14} />
        </a>
        <a className="wallet-chooser-row wallet-chooser-link" href={WALLET_INSTALL_LINKS.solflare} target="_blank" rel="noreferrer">
          <span className="wallet-chooser-icon"><Wallet size={17} /></span>
          <span>Install Solflare<small>Browser extension</small></span>
          <ExternalLink size={14} />
        </a>
      </>}

      {wallets.length === 0 && mobile && hasPhantom === false && (
        <div className="wallet-chooser-note">Don't have Phantom? <a href={WALLET_INSTALL_LINKS.phantom} target="_blank" rel="noreferrer">Get it here</a>, then come back and tap Continue with Solana wallet again.</div>
      )}
    </div>
  </div>;
}
