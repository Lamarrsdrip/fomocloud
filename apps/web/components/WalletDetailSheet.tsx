"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { X, Copy, ExternalLink } from "lucide-react";
import { apiFetch, plainError } from "../lib/api";

type Tab = "receive" | "send" | "history";

// Deliberately no client-side balance display here: the only real balance sources available
// client-side are USD-denominated (TradingCashAllocation), not native SOL/USDC on-chain amounts,
// and showing a number that isn't actually verified against the chain would be exactly the kind
// of fabricated-looking UI this project has repeatedly ruled out. The Send form instead shows the
// real INSUFFICIENT_BALANCE error from the backend (which does check on-chain balance) if it
// happens, rather than guessing a number up front.
export function WalletDetailSheet({ wallet, onClose, onSent }: { wallet: { id: string; address: string }; onClose: () => void; onSent?: () => void }) {
  const [tab, setTab] = useState<Tab>("receive");

  return (
    <div className="wallet-chooser-wrap" onClick={onClose}>
      <div className="wallet-chooser-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-chooser-handle" />
        <div className="wallet-chooser-head">
          <b>{wallet.address.slice(0, 6)}…{wallet.address.slice(-5)}</b>
          <button type="button" className="wallet-chooser-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="config-tabs" style={{ marginBottom: 14 }}>
          <button className={tab === "receive" ? "active" : ""} onClick={() => setTab("receive")}>Receive</button>
          <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Send</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
        </div>
        {tab === "receive" && <ReceiveTab address={wallet.address} />}
        {tab === "send" && <SendTab walletId={wallet.id} onSent={onSent} />}
        {tab === "history" && <HistoryTab walletId={wallet.id} />}
      </div>
    </div>
  );
}

function ReceiveTab({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "4px 0 6px" }}>
      <div style={{ background: "#fff", padding: 14, borderRadius: 16 }}>
        <QRCodeSVG value={address} size={180} level="M" />
      </div>
      <p style={{ fontSize: 11, color: "#8a8fa0", textAlign: "center", margin: 0 }}>
        Send only Solana (SOL or SPL tokens like USDC) to this address. Sending anything else, or from another network, will be lost.
      </p>
      <div className="contract-line" style={{ width: "100%", textAlign: "center", wordBreak: "break-all" }}>{address}</div>
      <button className="action-primary" style={{ width: "100%" }} onClick={() => { navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}>
        <Copy size={14} /> {copied ? "Copied" : "Copy address"}
      </button>
    </div>
  );
}

function SendTab({ walletId, onSent }: { walletId: string; onSent?: () => void }) {
  const [asset, setAsset] = useState<"SOL" | "USDC">("USDC");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<"form" | "confirm" | "sending" | "done">("form");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  function reviewSend(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const amt = Number(amount);
    if (!toAddress.trim() || toAddress.trim().length < 32) { setErr("Enter a valid Solana address."); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setErr("Enter a valid amount."); return; }
    setStep("confirm");
  }

  async function confirmSend() {
    setErr(""); setStep("sending");
    const clientRequestId = (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const r = await apiFetch<any>(`/v1/me/wallets/${walletId}/send`, { method: "POST", body: JSON.stringify({ asset, toAddress: toAddress.trim(), amount: Number(amount), clientRequestId }) });
      setTxHash(r.txHash); setStep("done");
      onSent?.();
    } catch (e) {
      setErr(plainError(e)); setStep("confirm");
    }
  }

  if (step === "done") {
    return <div style={{ textAlign: "center", padding: "10px 0" }}>
      <p style={{ fontSize: 13, color: "#e7e8ee", marginBottom: 10 }}>Sent {amount} {asset}.</p>
      <a className="soft-action" style={{ display: "inline-flex" }} href={`https://solscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">View on Solscan <ExternalLink size={12} /></a>
    </div>;
  }

  if (step === "confirm" || step === "sending") {
    return <div>
      <p style={{ fontSize: 12, color: "#9a9fb0", lineHeight: 1.6 }}>
        Send <b style={{ color: "#e7e8ee" }}>{amount} {asset}</b> to<br />
        <span className="contract-line" style={{ wordBreak: "break-all" }}>{toAddress.trim()}</span>
      </p>
      <p style={{ fontSize: 11, color: "#e8b96d" }}>This is irreversible. Double-check the address -- Solana transfers cannot be undone.</p>
      {err && <div className="auth-error" style={{ marginBottom: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="soft-action" style={{ flex: 1 }} disabled={step === "sending"} onClick={() => setStep("form")}>Back</button>
        <button className="action-primary" style={{ flex: 1 }} disabled={step === "sending"} onClick={confirmSend}>{step === "sending" ? "Sending…" : "Confirm send"}</button>
      </div>
    </div>;
  }

  return <form onSubmit={reviewSend}>
    <div className="pct-row" style={{ marginBottom: 10 }}>
      <button type="button" className={asset === "USDC" ? "active" : ""} onClick={() => setAsset("USDC")}>USDC</button>
      <button type="button" className={asset === "SOL" ? "active" : ""} onClick={() => setAsset("SOL")}>SOL</button>
    </div>
    <label className="field"><span>Destination address</span><input value={toAddress} onChange={(e) => setToAddress(e.target.value)} placeholder="Solana address" required /></label>
    <label className="field"><span>Amount ({asset})</span><input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required /></label>
    {err && <div className="auth-error" style={{ margin: "6px 0" }}>{err}</div>}
    <button className="action-primary" style={{ width: "100%", marginTop: 6 }}>Review send</button>
  </form>;
}

function HistoryTab({ walletId }: { walletId: string }) {
  const [data, setData] = useState<any>(undefined);
  useEffect(() => {
    let live = true;
    apiFetch<any>(`/v1/me/wallets/${walletId}/history`).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData({ transactions: [], rpcConfigured: false }); });
    return () => { live = false; };
  }, [walletId]);

  if (data === undefined) return <div className="loading" style={{ minHeight: 100 }}>Loading…</div>;
  if (!data.rpcConfigured) return <div className="pnl-empty">No Solana RPC is configured yet, so history can't be read.</div>;
  if (!data.transactions?.length) return <div className="pnl-empty">No transactions found yet for this wallet.</div>;

  return <div className="list">
    {data.transactions.map((t: any) => {
      const usd = Number(t.usdcDelta || 0), sol = Number(t.solDeltaSol || 0);
      const label = t.status === "FAILED" ? "Failed" : t.status === "UNKNOWN" ? "Unresolved" : usd !== 0 ? `${usd > 0 ? "+" : ""}${usd.toFixed(2)} USDC` : sol !== 0 ? `${sol > 0 ? "+" : ""}${sol.toFixed(4)} SOL` : "Activity";
      return <a className="list-row" key={t.signature} href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer">
        <div><b className={usd > 0 || sol > 0 ? "positive" : usd < 0 || sol < 0 ? "negative" : ""}>{label}</b><small>{t.blockTime ? new Date(t.blockTime * 1000).toLocaleString() : "Pending"}</small></div>
        <span>{t.signature.slice(0, 6)}…{t.signature.slice(-4)}</span>
      </a>;
    })}
  </div>;
}
