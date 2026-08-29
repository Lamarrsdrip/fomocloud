"use client";

import { useEffect, useState } from "react";
import { PrivyProvider, usePrivy, useLoginWithEmail, useSigners } from "@privy-io/react-auth";
import { useWallets, useCreateWallet } from "@privy-io/react-auth/solana";
import { apiFetch, plainError } from "../lib/api";
import { Wallet as WalletIcon, Copy } from "lucide-react";

type Step = "idle" | "email" | "code" | "creating" | "delegating" | "registering" | "done";

// This whole module (Privy's SDK plus everything below) is only ever reached via next/dynamic in
// app/app/page.tsx -- it must never be a static import there. Privy's client bundle pulls in a
// full multi-chain SDK (EVM chains, WalletConnect, viem, wagmi) even though only its Solana slice
// is used here, and statically importing it inflated the /app route's first-load JS from ~126KB to
// ~830KB. Lazy-loading confines that cost to the moment someone actually opens the wallet panel.
//
// PrivyProvider is mounted here, not wrapped separately, because EmbeddedWalletPanelInner calls
// Privy's hooks unconditionally -- those throw if rendered without a real, ready PrivyProvider
// ancestor, so the provider must never render its children until pubConfig has actually resolved.
export default function EmbeddedWalletPanel(props: { me: any; reload: () => Promise<void> }) {
  const [pubConfig, setPubConfig] = useState<any>(undefined);
  useEffect(() => {
    let live = true;
    apiFetch<any>("/v1/public/config", {}, false).then((c) => { if (live) setPubConfig(c); }).catch(() => { if (live) setPubConfig({}); });
    return () => { live = false; };
  }, []);

  if (pubConfig === undefined) return null;
  if (!pubConfig.embeddedWalletsConfigured || !pubConfig.privyAppId) {
    return <div className="switch-row"><div><b>MemeCloud wallet</b><small>Not yet available -- the administrator hasn't configured embedded wallets.</small></div></div>;
  }

  return (
    <PrivyProvider
      appId={pubConfig.privyAppId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { solana: { createOnLogin: "off" } },
        appearance: { walletChainType: "solana-only" },
      }}
    >
      <EmbeddedWalletPanelInner {...props} pubConfig={pubConfig} />
    </PrivyProvider>
  );
}

// Creates a real MemeCloud-custodied Solana wallet via Privy's embedded-wallet infrastructure --
// never a plaintext seed/key touching this app or its backend -- and grants MemeCloud's own
// restricted, policy-scoped signer so automated trading can work without the user holding a
// separate Phantom wallet. The backend independently re-verifies every claim this component makes
// (see verifyPrivyDelegation in apps/api/src/server.ts) before ever marking the wallet trading-
// enabled, so nothing here is trusted blindly server-side.
function EmbeddedWalletPanelInner({ me, reload, pubConfig }: { me: any; reload: () => Promise<void>; pubConfig: any }) {
  const { ready, authenticated, user } = usePrivy();
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();
  const { createWallet } = useCreateWallet();
  const { addSigners } = useSigners();

  const [step, setStep] = useState<Step>("idle");
  const [email, setEmail] = useState(me?.email || "");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  const embeddedWallet = (me?.wallets || []).find((w: any) => w.chain === "SOLANA" && w.tradingEnabled && w.permissionRef);

  async function afterAuthenticated() {
    setErr("");
    try {
      // A page reload mid-flow (created a Privy wallet, closed the tab before backend
      // registration) must resume from wherever it actually left off, not restart and hit
      // Privy's "already has an embedded wallet" error.
      const existing = (user?.linkedAccounts || []).find(
        (a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy"
      ) as any | undefined;

      let walletId: string, address: string;
      if (existing) {
        walletId = existing.id; address = existing.address;
      } else {
        setStep("creating");
        const { wallet } = await createWallet({ createAdditional: false });
        walletId = wallet.id!; address = wallet.address;
      }

      if (!existing?.delegated) {
        setStep("delegating");
        await addSigners({ address, signers: [{ signerId: pubConfig.privySignerId, policyIds: [pubConfig.privyPolicyId] }] });
      }

      setStep("registering");
      await apiFetch("/v1/me/wallets/embedded", { method: "POST", body: JSON.stringify({ privyWalletId: walletId, address }) });
      await reload();
      setStep("done");
    } catch (e) {
      setErr(plainError(e));
      setStep("idle");
    }
  }

  // Once Privy auth completes (via the code form below), continue the flow automatically --
  // login() itself isn't awaitable, so this effect is what actually chains "authenticated" into
  // "now create/delegate/register the wallet" rather than requiring a second manual click.
  useEffect(() => {
    if (authenticated && (step === "email" || step === "code")) void afterAuthenticated();
  }, [authenticated]);

  async function start() {
    setErr("");
    if (authenticated) { void afterAuthenticated(); return; }
    setStep("email");
  }
  async function submitEmail(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await sendCode({ email }); setStep("code"); } catch (e) { setErr(plainError(e)); }
  }
  async function submitCode(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { await loginWithCode({ code }); } catch (e) { setErr(plainError(e)); }
  }

  if (embeddedWallet) {
    return <div className="wallet-line">
      <div><b>MemeCloud wallet · {embeddedWallet.address.slice(0, 7)}…{embeddedWallet.address.slice(-5)}</b>
        <small>Created and custodied by MemeCloud (Privy) · Trading permission active{embeddedWallet.permissionExpiry ? ` until ${new Date(embeddedWallet.permissionExpiry).toLocaleDateString()}` : ""}</small></div>
      <button className="soft-action" onClick={() => { navigator.clipboard.writeText(embeddedWallet.address).catch(() => {}); }}><Copy size={12} /> Copy address</button>
    </div>;
  }

  return <div className="switch-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div><b>MemeCloud wallet</b><small>No Phantom needed -- MemeCloud creates and secures a real Solana wallet for you.</small></div>
      {step === "idle" && <button className="soft-action" disabled={!ready} onClick={start}><WalletIcon size={12} /> Create my wallet</button>}
    </div>
    {step === "email" && <form onSubmit={submitEmail} style={{ display: "flex", gap: 8 }}>
      <label className="field" style={{ flex: 1 }}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required /></label>
      <button className="action-primary" disabled={emailState.status === "sending-code"}>{emailState.status === "sending-code" ? "Sending…" : "Send code"}</button>
    </form>}
    {step === "code" && <form onSubmit={submitCode} style={{ display: "flex", gap: 8 }}>
      <label className="field" style={{ flex: 1 }}><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" required /></label>
      <button className="action-primary" disabled={emailState.status === "submitting-code"}>{emailState.status === "submitting-code" ? "Verifying…" : "Verify"}</button>
    </form>}
    {(step === "creating" || step === "delegating" || step === "registering") &&
      <div className="notice">{step === "creating" ? "Creating your wallet…" : step === "delegating" ? "Granting MemeCloud limited trading access…" : "Finishing setup…"}</div>}
    {err && <div className="auth-error">{err}</div>}
  </div>;
}
