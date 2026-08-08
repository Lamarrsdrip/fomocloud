import { Connection, VersionedTransaction } from "@solana/web3.js";

export type QuoteRequest = {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
};

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  raw: unknown;
};

export interface SignerProvider {
  /**
   * Production implementation must apply policy checks and sign ONLY authorized
   * trading transactions. Never implement this by storing a user's primary-wallet seed.
   */
  sign(userId: string, serializedBase64: string): Promise<string>;
  isAuthorized(userId: string): Promise<boolean>;
}

export class DisabledSignerProvider implements SignerProvider {
  async sign(): Promise<string> {
    throw Object.assign(new Error("Live signer provider is not configured"), { code: "SIGNER_DISABLED" });
  }
  async isAuthorized(): Promise<boolean> { return false; }
}

export class JupiterExecution {
  constructor(
    private readonly baseUrl = process.env.JUPITER_API_BASE ?? "https://api.jup.ag",
    private readonly apiKey = process.env.JUPITER_API_KEY
  ) {}

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {})
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const url = new URL("/swap/v1/quote", this.baseUrl);
    url.searchParams.set("inputMint", req.inputMint);
    url.searchParams.set("outputMint", req.outputMint);
    url.searchParams.set("amount", req.amountRaw);
    url.searchParams.set("slippageBps", String(req.slippageBps));
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw Object.assign(new Error(`Quote failed ${res.status}`), { code: "QUOTE_FAILED" });
    const q: any = await res.json();
    return {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      otherAmountThreshold: q.otherAmountThreshold,
      priceImpactPct: q.priceImpactPct,
      raw: q
    };
  }

  async buildSwap(quote: Quote, userPublicKey: string): Promise<string> {
    const res = await fetch(new URL("/swap/v1/swap", this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw Object.assign(new Error(`Swap build failed ${res.status}`), { code: "SWAP_BUILD_FAILED" });
    const body: any = await res.json();
    if (!body.swapTransaction) throw Object.assign(new Error("Missing swap transaction"), { code: "INVALID_SWAP_RESPONSE" });
    return body.swapTransaction;
  }

  async submitSigned(rpcUrl: string, signedBase64: string): Promise<string> {
    const connection = new Connection(rpcUrl, "confirmed");
    const bytes = Buffer.from(signedBase64, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    return connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
  }

  async waitConfirmed(rpcUrl: string, signature: string, timeoutMs = 45_000) {
    const connection = new Connection(rpcUrl, "confirmed");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const s = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (s.value?.err) throw Object.assign(new Error("Transaction failed on-chain"), { code: "TRANSACTION_FAILED", detail: s.value.err });
      if (s.value?.confirmationStatus === "confirmed" || s.value?.confirmationStatus === "finalized") return s.value;
      await new Promise(r => setTimeout(r, 700));
    }
    throw Object.assign(new Error("Confirmation timeout"), { code: "CONFIRMATION_TIMEOUT" });
  }
}

export class SimulationExecution {
  async quote(req: QuoteRequest): Promise<Quote> {
    // Simulation is explicit and labeled. It never masquerades as live execution.
    return {
      ...req,
      inAmount: req.amountRaw,
      outAmount: req.amountRaw,
      priceImpactPct: "0",
      raw: { simulation: true, ...req }
    };
  }
}
