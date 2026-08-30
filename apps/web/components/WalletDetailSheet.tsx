"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { X, Copy, ExternalLink, ShieldOff, KeyRound } from "lucide-react";
import { useExportWallet } from "@privy-io/react-auth/solana";
import { apiFetch, plainError } from "../lib/api";

type Tab = "receive" | "send" | "history" | "access" | "security";

// Real gap found by forensic audit (M-33): this used to deliberately show NO balance because the
// only data available client-side was USD-denominated (TradingCashAllocation), not real on-chain
// SOL/USDC amounts -- showing a number not actually verified against the chain would have been
// exactly the fabricated-looking UI this project rules out. services/balance-worker has synced
// real on-chain WalletAssetBalance rows every cycle since commit 8eae454; GET
// /v1/me/wallets/:id/balances (added alongside this) finally exposes that. dataFreshnessSec is
// surfaced explicitly so a stale sync reads as stale, never silently as live.
function useWalletBalances(walletId: string) {
  const [data, setData] = useState<{ balances: any[]; dataFreshnessSec: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch<any>(`/v1/me/wallets/${walletId}/balances`).then((x) => { if (live) setData(x); }).catch(() => { if (live) setData({ balances: [], dataFreshnessSec: null }); });
    return () => { live = false; };
  }, [walletId]);
  return data;
}
function BalanceHeader({ walletId }: { walletId: string }) {
  const data = useWalletBalances(walletId);
  if (!data) return null;
  const usdc = data.balances.find((b) => b.symbol === "USDC");
  const sol = data.balances.find((b) => b.symbol === "SOL");
  const stale = data.dataFreshnessSec != null && data.dataFreshnessSec > 300;
  return (
    <div className="review-grid" style={{ marginBottom: 12 }}>
      <div><span>USDC</span><b>{usdc ? Number(usdc.amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "Unknown"}</b></div>
      <div><span>SOL</span><b>{sol ? Number(sol.amount).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "Unknown"}</b></div>
      <div><span>Synced</span><b style={{ fontSize: 11, color: stale ? "#f7b95f" : undefined }}>{data.dataFreshnessSec == null ? "Unknown" : stale ? "Delayed" : "Just now"}</b></div>
    </div>
  );
}
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
        <BalanceHeader walletId={wallet.id} />
        <div className="config-tabs" style={{ marginBottom: 14 }}>
          <button className={tab === "receive" ? "active" : ""} onClick={() => setTab("receive")}>Receive</button>
          <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Send</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
          <button className={tab === "access" ? "active" : ""} onClick={() => setTab("access")}>Access</button>
          <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>Security</button>
        </div>
        {tab === "receive" && <ReceiveTab address={wallet.address} />}
        {tab === "send" && <SendTab walletId={wallet.id} onSent={onSent} />}
        {tab === "history" && <HistoryTab walletId={wallet.id} />}
        {tab === "access" && <AccessTab walletId={wallet.id} onRevoked={() => { onSent?.(); onClose(); }} />}
        {tab === "security" && <SecurityTab address={wallet.address} walletId={wallet.id} />}
      </div>
    </div>
  );
}

// Real gap found by a full-platform audit: the backend has had a working
// POST /v1/me/wallets/:id/disable-automation endpoint since earlier this session, but nothing in
// the app ever called it -- once a user created this wallet, they had no self-service way to
// revoke MemeCloud's delegated signing authority over it. For a platform about to hold live money,
// that's a real trust gap, not a cosmetic one.
function AccessTab({ walletId, onRevoked }: { walletId: string; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function revoke() {
    setBusy(true); setErr("");
    try {
      await apiFetch(`/v1/me/wallets/${walletId}/disable-automation`, { method: "POST" });
      onRevoked();
    } catch (e) {
      setErr(plainError(e)); setBusy(false);
    }
  }

  return <div>
    <p style={{ fontSize: 12, color: "#9a9fb0", lineHeight: 1.6, marginBottom: 14 }}>
      MemeCloud currently has a restricted, policy-scoped signer on this wallet, used only to execute your trades and sends. Revoking it stops all automated and app-initiated activity immediately -- the wallet and its funds are unaffected, and you can grant access again later.
    </p>
    {!confirming
      ? <button className="soft-action" style={{ width: "100%", color: "#ee6673" }} onClick={() => setConfirming(true)}><ShieldOff size={14} /> Revoke MemeCloud's trading access</button>
      : <div>
          <p style={{ fontSize: 11, color: "#e8b96d", marginBottom: 10 }}>This will stop Auto Copy and any in-app trading for this wallet until access is granted again. Continue?</p>
          {err && <div className="auth-error" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="soft-action" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="action-primary" style={{ flex: 1, background: "linear-gradient(135deg,#ee6673,#c73f4e)" }} disabled={busy} onClick={revoke}>{busy ? "Revoking…" : "Yes, revoke access"}</button>
          </div>
        </div>}
  </div>;
}

// Real capability, verified directly against the installed SDK (@privy-io/react-auth@3.38.0,
// node_modules/@privy-io/react-auth/dist/dts/solana.d.ts): useExportWallet()'s own doc comment --
// "The private key is loaded on an iframe running on a separate domain from your app, meaning your
// app cannot access it" -- is Privy's own security guarantee, not something MemeCloud implements or
// could weaken even if it wanted to. This code only ever triggers Privy's modal and awaits its
// close; the private key itself never enters MemeCloud's JS context, API, logs, or database at any
// point. This is the real ownership model: the user's key is exportable to any standard wallet
// (Phantom, Backpack, etc.) at any time -- MemeCloud holds only a revocable, policy-scoped trading
// permission on top of a wallet the user genuinely owns and can walk away with.
function SecurityTab({ address, walletId }: { address: string; walletId: string }) {
  const { exportWallet } = useExportWallet();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function doExport() {
    setBusy(true); setErr("");
    try {
      await exportWallet({ address });
      // Real gap found by forensic audit: nothing anywhere recorded that a private-key export ever
      // happened -- no audit trail, no security notification. This call cannot see or transmit the
      // key itself (Privy's modal never exposes it to this app); it only logs that the user
      // completed the flow, so there's a real record and an alert if it wasn't actually them.
      // Best-effort: a logging failure must never be presented as if the export itself failed.
      apiFetch(`/v1/me/wallets/${walletId}/exported`, { method: "POST" }).catch(() => {});
    } catch (e: any) {
      setErr(plainError(e));
    } finally {
      setBusy(false); setConfirming(false);
    }
  }

  return <div>
    <p style={{ fontSize: 12, color: "#9a9fb0", lineHeight: 1.6, marginBottom: 14 }}>
      This wallet is genuinely yours. MemeCloud never holds your private key -- it only has a revocable, policy-scoped permission to trade on your behalf (see the Access tab). You can export your private key to a standard wallet like Phantom or Backpack at any time, and MemeCloud's own systems never see it: the key is shown inside Privy's own secure interface, on a domain MemeCloud's app has no access to.
    </p>
    {!confirming
      ? <button className="soft-action" style={{ width: "100%" }} onClick={() => setConfirming(true)}><KeyRound size={14} /> Export private key</button>
      : <div>
          <p style={{ fontSize: 11, color: "#e8b96d", marginBottom: 10 }}>Anyone who sees your private key can move every asset in this wallet, permanently and irreversibly. Only continue somewhere private, and never share it with anyone -- including someone claiming to be MemeCloud support.</p>
          {err && <div className="auth-error" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="soft-action" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="action-primary" style={{ flex: 1 }} disabled={busy} onClick={doExport}>{busy ? "Opening…" : "Continue"}</button>
          </div>
        </div>}
  </div>;
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

// Reserved so a "Max" SOL send never leaves the wallet with nothing to pay its own network fee --
// SPL token transfers (USDC) are paid for in SOL, not the token being sent, so this reserve only
// applies to sending SOL itself. A real, small, fixed buffer, not a guess at the exact fee.
const SOL_FEE_RESERVE = 0.002;
function SendTab({ walletId, onSent }: { walletId: string; onSent?: () => void }) {
  const [asset, setAsset] = useState<"SOL" | "USDC">("USDC");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  // Real gap found by forensic audit (M-33): with no real balance ever shown (see BalanceHeader's
  // own history above), a "Max" button was impossible to build honestly -- there was nothing real
  // to max out to. Now that GET /v1/me/wallets/:id/balances exists, this closes that gap.
  const balanceData = useWalletBalances(walletId);
  const assetBalance = balanceData?.balances.find((b) => b.symbol === asset);
  function fillMax() {
    if (!assetBalance) return;
    const raw = Number(assetBalance.amount);
    const max = asset === "SOL" ? Math.max(0, raw - SOL_FEE_RESERVE) : raw;
    setAmount(String(max));
  }
  const [step, setStep] = useState<"form" | "confirm" | "sending" | "done">("form");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");
  // Real bug found by a full-platform audit: this codebase already identified and fixed this exact
  // class of bug in AuthCard.tsx ("a rapid double-tap/duplicate touch event... can fire this
  // handler twice before React re-renders the disabled button. disabled={busy} alone does not"
  // prevent it) but that fix was never applied here, for a real money-movement action. A
  // synchronous ref closes the gap a React state flag can't. clientRequestId is also generated
  // once per reviewed send and reused across a retry of THIS SAME attempt (matching TokenDetail's
  // buy flow), not minted fresh on every confirmSend() call -- otherwise even the backend's
  // idempotency-by-clientRequestId protection couldn't catch a genuine double-fire, since two
  // rapid taps would carry two different keys.
  const sendingRef = useRef(false);
  const [clientRequestId, setClientRequestId] = useState("");

  function reviewSend(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const amt = Number(amount);
    // Real validation is server-side (new PublicKey() there is the actual source of truth) -- this
    // is just a real base58-charset + length check to catch obviously-malformed input before
    // showing the "this is irreversible" confirm screen, not a length-only check that let any
    // 32+ character string through (a pasted URL, an Ethereum address, a typo) to that screen.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(toAddress.trim())) { setErr("Enter a valid Solana address."); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setErr("Enter a valid amount."); return; }
    setClientRequestId((crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setStep("confirm");
  }

  async function confirmSend() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setErr(""); setStep("sending");
    try {
      const r = await apiFetch<any>(`/v1/me/wallets/${walletId}/send`, { method: "POST", body: JSON.stringify({ asset, toAddress: toAddress.trim(), amount: Number(amount), clientRequestId }) });
      setTxHash(r.txHash); setStep("done");
      onSent?.();
    } catch (e) {
      setErr(plainError(e)); setStep("confirm");
    } finally {
      sendingRef.current = false;
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
    <label className="field">
      <span>Amount ({asset}){assetBalance && <> · <button type="button" onClick={fillMax} style={{ background: "none", border: "none", color: "#9a97ff", cursor: "pointer", padding: 0, font: "inherit" }}>Max: {Number(assetBalance.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}</button></>}</span>
      <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
    </label>
    {err && <div className="auth-error" style={{ margin: "6px 0" }}>{err}</div>}
    <button className="action-primary" style={{ width: "100%", marginTop: 6 }}>Review send</button>
  </form>;
}

function HistoryTab({ walletId }: { walletId: string }) {
  const [data, setData] = useState<any>(undefined);
  useEffect(() => {
    let live = true;
    apiFetch<any>(`/v1/me/wallets/${walletId}/history`)
      .then((d) => { if (live) setData(d); })
      // A request failure here (network, auth, an unexpected backend error) is not the same fact
      // as "the RPC is not configured" -- conflating them showed a misleading, specifically-wrong
      // message when the real cause could be almost anything. Keep the real error and say so.
      .catch((e) => { if (live) setData({ transactions: [], fetchError: plainError(e) }); });
    return () => { live = false; };
  }, [walletId]);

  if (data === undefined) return <div className="loading" style={{ minHeight: 100 }}>Loading…</div>;
  if (data.fetchError) return <div className="pnl-empty">Couldn't load history: {data.fetchError}</div>;
  if (data.rpcConfigured === false) return <div className="pnl-empty">No Solana RPC is configured yet, so history can't be read.</div>;
  if (data.rpcError) return <div className="pnl-empty">History is temporarily unavailable (the Solana RPC provider is rate-limited or unreachable right now). Try again shortly.</div>;
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
