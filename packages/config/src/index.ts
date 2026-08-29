import crypto from "node:crypto";
import { db } from "@memecloud/db";
import { resolveExecutionState } from "./executionState.js";
export * from "./executionState.js";

function keyBytes() {
  const source = process.env.ENVELOPE_ENCRYPTION_KEY ?? "";
  if (process.env.NODE_ENV === "production" && (!source || source.startsWith("replace-"))) {
    throw new Error("ENVELOPE_ENCRYPTION_KEY must be configured in production");
  }
  // Accept a real 32-byte base64/hex key; derive only for non-production/dev convenience.
  try {
    const b64 = Buffer.from(source, "base64");
    if (b64.length === 32) return b64;
  } catch {}
  if (/^[a-f0-9]{64}$/i.test(source)) return Buffer.from(source, "hex");
  return crypto.createHash("sha256").update(source || "development-only-memecloud-key").digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptJson<T=any>(ciphertext: string): T {
  const [ivRaw, tagRaw, bodyRaw] = ciphertext.split(".");
  if (!ivRaw || !tagRaw || !bodyRaw) throw new Error("INVALID_ENCRYPTED_CONFIG");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

// Non-secret hint for a secret value: never reversible to the original, safe to send to the browser.
export function maskHint(value: unknown): string {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= 4) return "*".repeat(s.length);
  return `****${s.slice(-4)}`;
}

export async function getConfig<T=any>(key: string): Promise<T | null> {
  const row = await db.appConfig.findUnique({ where: { key } });
  if (!row) return null;
  if (row.isSecret) return row.encryptedValue ? decryptJson<T>(row.encryptedValue) : null;
  return (row.valueJson ?? null) as T | null;
}

// The real, owner-controlled live-trading gate. Checked fresh from the database on every
// decision — never cached — so switching it off takes effect on the very next check, and
// switching it on from Admin never requires touching an env file or restarting a service.
export async function isLiveTradingEnabled(): Promise<boolean> {
  const cfg = await getConfig<{ enabled?: boolean }>("liveTrading");
  return Boolean(cfg?.enabled);
}

const EXECUTION_HEARTBEAT_MAX_AGE_MS=45_000;
const EXECUTION_PROVIDER_HEALTH_MAX_AGE_MS=60*60_000;
const EXECUTION_CHAIN_DATA_MAX_AGE_MS=5*60_000;
const EXECUTION_WORKERS=["executor","exits","market-worker","solana-listener","solana-flow-scanner"] as const;
const EXECUTION_PROVIDER_FIELDS={
  marketData:{rpc:["solanaRpc","heliusRpc","fallbackRpc"],helius:["heliusApiKey"]},
  execution:{jupiter:["jupiterBaseUrl","jupiterApiKey"]},
  signer:{privy:["privyAppId","privyAppSecret","privyAuthorizationPrivateKey","privySignerId","privyPolicyId"]}
} as const;

type ReadExecutionStateOptions={
  runtimeEnvironmentMode?:string;
  runtimeSignerConfigured?:boolean;
  selfWorkerName?:string;
};

/** Reads every real gate and feeds the shared truth table used by API, UI and executor. */
export async function readExecutionState(options:ReadExecutionStateOptions={}){
  const [liveCfg,riskCfg,marketRow,executionRow,signerRow,marketCfg,executionCfg,signerCfg,activeDelegatedWallets,heartbeats,latestChainEvent,openLivePositions]=await Promise.all([
    getConfig<{enabled?:boolean}>("liveTrading"),
    getConfig<{emergencyNewEntriesPaused?:boolean}>("risk"),
    db.appConfig.findUnique({where:{key:"marketData"}}),
    db.appConfig.findUnique({where:{key:"execution"}}),
    db.appConfig.findUnique({where:{key:"signer"}}),
    getConfig<any>("marketData"),
    getConfig<any>("execution"),
    getConfig<any>("signer"),
    db.wallet.count({where:{chain:"SOLANA",tradingEnabled:true,permissionRef:{not:null},OR:[{permissionExpiry:{isSet:false}},{permissionExpiry:{gt:new Date()}}]}}),
    db.workerHeartbeat.findMany({where:{name:{in:[...EXECUTION_WORKERS]}}}),
    db.chainFlowObservation.findFirst({orderBy:{observedAt:"desc"},select:{observedAt:true}}),
    db.position.count({where:{mode:"LIVE",status:{in:["OPEN","PARTIALLY_CLOSED"]}}})
  ]);
  const now=Date.now();
  const provider=(row:any,cfg:any,fields:readonly string[],name:string)=>{
    const status=(row?.testResults as any)?.[name];
    const fingerprintMatches=Boolean(status?.verified?.ok)&&status.verified.fingerprint===fingerprintOf(cfg,[...fields]);
    const hardRejected=status?.health?.state==="INVALID_CREDENTIALS";
    const healthFresh=Boolean(status?.health?.checkedAt)&&now-new Date(status.health.checkedAt).getTime()<=EXECUTION_PROVIDER_HEALTH_MAX_AGE_MS;
    return {
      verified:fingerprintMatches&&!hardRejected,
      operational:fingerprintMatches&&!hardRejected&&healthFresh&&status?.health?.ok===true,
      state:String(status?.health?.state??"UNKNOWN"),
      checkedAt:status?.health?.checkedAt??null
    };
  };
  const rpc=provider(marketRow,marketCfg,EXECUTION_PROVIDER_FIELDS.marketData.rpc,"rpc");
  const helius=provider(marketRow,marketCfg,EXECUTION_PROVIDER_FIELDS.marketData.helius,"helius");
  const jupiter=provider(executionRow,executionCfg,EXECUTION_PROVIDER_FIELDS.execution.jupiter,"jupiter");
  const privy=provider(signerRow,signerCfg,EXECUTION_PROVIDER_FIELDS.signer.privy,"privy");
  const executorHeartbeat=heartbeats.find(h=>h.name==="executor");
  const executorDetail=(executorHeartbeat?.detail??{}) as any;
  const environmentMode=options.runtimeEnvironmentMode??executorDetail.environmentMode??process.env.EXECUTION_MODE??"simulation";
  const completeSignerConfig=Boolean(signerCfg?.privyAppId&&signerCfg?.privyAppSecret&&signerCfg?.privyAuthorizationPrivateKey&&signerCfg?.privySignerId&&signerCfg?.privyPolicyId);
  const signerConfigured=options.runtimeSignerConfigured??(typeof executorDetail.signerConfigured==="boolean"?executorDetail.signerConfigured:completeSignerConfig);
  const workers=EXECUTION_WORKERS.map(name=>{
    const h=heartbeats.find(x=>x.name===name);
    const running=name===options.selfWorkerName||Boolean(h)&&now-h!.lastBeatAt.getTime()<EXECUTION_HEARTBEAT_MAX_AGE_MS;
    return {name,running,lastBeatAt:h?.lastBeatAt??null,detail:h?.detail??null};
  });
  const flow=workers.find(w=>w.name==="solana-flow-scanner")?.detail as any;
  const scannerDegraded=Boolean(flow?.enabled===false||flow?.rateLimited===true||(Number.isFinite(Number(flow?.lastSuccessfulRpcAgoSec))&&Number(flow.lastSuccessfulRpcAgoSec)>60));
  const chainDataFresh=Boolean(latestChainEvent)&&now-latestChainEvent!.observedAt.getTime()<EXECUTION_CHAIN_DATA_MAX_AGE_MS;
  const resolved=resolveExecutionState({
    liveTradingRequested:Boolean(liveCfg?.enabled),
    environmentMode,
    emergencyPaused:Boolean(riskCfg?.emergencyNewEntriesPaused),
    rpcCredentialsVerified:rpc.verified||helius.verified,
    rpcOperational:rpc.operational||helius.operational,
    chainDataFresh,
    scannerDegraded,
    jupiterVerified:jupiter.verified,
    jupiterOperational:jupiter.operational,
    signerConfigured,
    signerVerified:privy.verified,
    signerOperational:privy.operational,
    activeDelegatedWallets,
    requiredWorkersHealthy:workers.every(w=>w.running),
    openLivePositions
  });
  return {
    ...resolved,
    chain:"SOLANA" as const,
    // Backward-compatible names now all derive from the same truth table.
    ready:resolved.readyForLive,
    liveTradingEnabled:Boolean(liveCfg?.enabled),
    dependencies:{
      rpc:rpc.operational||helius.operational,
      rpcCredentials:rpc.verified||helius.verified,
      rpcState:rpc.operational?rpc.state:helius.operational?helius.state:`${rpc.state}/${helius.state}`,
      chainDataFresh,
      lastRealChainEvent:latestChainEvent?.observedAt??null,
      scannerDegraded,
      jupiter:jupiter.operational,
      signerCredentialsConnected:privy.operational,
      signerConfigured,
      walletsWithActivePermission:activeDelegatedWallets
    },
    workers,
    runtimeEvidence:{
      executorRelease:executorDetail.release??null,
      executorHeartbeatAt:executorHeartbeat?.lastBeatAt??null,
      environmentModeSource:options.runtimeEnvironmentMode!==undefined?"LOCAL_PROCESS":executorDetail.environmentMode?"EXECUTOR_HEARTBEAT":"API_ENV_FALLBACK"
    },
    resolvedAt:new Date(now).toISOString(),
    source:"authoritative-execution-state-v1" as const,
    note:"This state governs new Solana entries. Existing LIVE positions remain eligible for real protective exits even when new entries are blocked."
  };
}

export async function setConfig(
  key: string,
  value: unknown,
  opts: { secret?: boolean; updatedBy?: string; secretHints?: Record<string, string>; restartPending?: boolean } = {}
) {
  const isSecret = Boolean(opts.secret);
  return db.appConfig.upsert({
    where: { key },
    create: {
      key, isSecret, updatedBy: opts.updatedBy,
      valueJson: isSecret ? { configured: true } : value as any,
      encryptedValue: isSecret ? encryptJson(value) : null,
      secretHints: opts.secretHints ?? undefined,
      restartPending: opts.restartPending ?? false
    },
    update: {
      isSecret, updatedBy: opts.updatedBy,
      valueJson: isSecret ? { configured: true } : value as any,
      encryptedValue: isSecret ? encryptJson(value) : null,
      secretHints: opts.secretHints ?? undefined,
      ...(opts.restartPending !== undefined ? { restartPending: opts.restartPending } : {})
    }
  });
}

// Clears the restart-pending flag once an admin confirms they restarted the consuming service.
export async function ackRestart(key: string) {
  return db.appConfig.update({ where: { key }, data: { restartPending: false } }).catch(() => null);
}

// A one-way, non-reversible fingerprint of the exact field values a provider's connectivity
// depends on (secrets included) — never exposed to the client, only compared server-side to
// decide whether a past verification still applies to what's currently saved.
export function fingerprintOf(cfg: any, fields: string[]): string {
  const parts = fields.map(f => String(cfg?.[f] ?? ""));
  return crypto.createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16);
}

// HTTP 429 (RATE_LIMITED) must never be conflated with an actually-invalid credential
// (INVALID_CREDENTIALS) -- see apps/api/src/server.ts's classifyHttp, the single place every
// provider test derives this. readyNow() below and the admin UI both depend on this distinction.
export type ProviderState="CONNECTED"|"RATE_LIMITED"|"INVALID_CREDENTIALS"|"PROVIDER_UNAVAILABLE"|"NETWORK_ERROR"|"TIMEOUT"|"NOT_CONFIGURED"|"UNKNOWN";
export type ProviderRecord = { ok: boolean; state?: ProviderState; httpStatus?: number; latencyMs?: number; message: string; checkedAt: string; fingerprint: string };
// verified: the last time this provider's connection genuinely PASSED, pinned to the config
// fingerprint at that moment — this is what "Connected" means, and it must survive time passing,
// API restarts, and unrelated saves. It only ever advances forward on a fresh pass; a failing
// health check never erases it.
// health: the single most recent attempt, pass or fail — this is what "currently reachable" means.
export type ProviderStatus = { verified: ProviderRecord | null; health: ProviderRecord };

// Records a real test/health-check attempt for one or more providers within a config key. Upserts
// because a test can legitimately run (and fail, e.g. "no key saved yet") before any config for
// this key was ever saved — there may be no row yet.
export async function recordProviderResults(key: string, results: Record<string, ProviderRecord>) {
  const row = await db.appConfig.findUnique({ where: { key } });
  const existing = (row?.testResults as any) ?? {};
  const merged: Record<string, ProviderStatus> = { ...existing };
  for (const [provider, rec] of Object.entries(results)) {
    const prior: ProviderStatus | undefined = merged[provider];
    merged[provider] = {
      health: rec,
      // Never let a failing attempt overwrite a standing verification — only a genuine pass does.
      verified: rec.ok ? rec : (prior?.verified ?? null)
    };
  }
  return db.appConfig.upsert({
    where: { key },
    create: { key, isSecret: false, valueJson: null, testResults: merged },
    update: { testResults: merged }
  });
}

// secretFieldNames: only these fields (within an isSecret config) are stripped from the response —
// the rest of that same config object (e.g. execution.jupiterBaseUrl, marketData.solanaRpc) is
// genuinely non-secret and must round-trip to the admin UI in the clear, or every plain field in a
// "secret" section would wrongly appear to reset on every reload.
// fingerprintFields, when given, lets the response tell the client whether each provider's
// standing verification still matches what's currently saved — WITHOUT ever sending the
// fingerprint itself or any secret value, only a derived boolean.
export function redactedConfig(row: {
  key: string; isSecret: boolean; valueJson: any; encryptedValue?: string | null; updatedAt: Date;
  secretHints?: any; testResults?: any; restartPending?: boolean;
}, secretFieldNames: string[] = [], fingerprintFields?: Record<string, string[]>) {
  let fullValue: any;
  if (row.isSecret) {
    fullValue = row.encryptedValue ? decryptJson<any>(row.encryptedValue) : {};
  } else {
    fullValue = row.valueJson ?? {};
  }
  const value = { ...fullValue };
  for (const f of secretFieldNames) delete value[f];

  let testResults: any = row.testResults ?? null;
  if (testResults && fingerprintFields) {
    const out: Record<string, any> = {};
    for (const [provider, status] of Object.entries(testResults as Record<string, any>)) {
      if (status && typeof status === "object" && "verified" in status) {
        const currentFp = fingerprintOf(fullValue, fingerprintFields[provider] ?? []);
        const v = (status as ProviderStatus).verified;
        out[provider] = {
          health: status.health ? { ok: status.health.ok, state: status.health.state, httpStatus: status.health.httpStatus, latencyMs: status.health.latencyMs, message: status.health.message, checkedAt: status.health.checkedAt, stale: status.health.fingerprint !== currentFp } : null,
          verified: v ? { ok: v.ok, state: v.state, httpStatus: v.httpStatus, latencyMs: v.latencyMs, message: v.message, checkedAt: v.checkedAt, stale: v.fingerprint !== currentFp } : null
        };
      } else {
        out[provider] = status; // legacy flat shape from before this change — self-heals on next test
      }
    }
    testResults = out;
  }

  return {
    key: row.key,
    value,
    isSecret: row.isSecret,
    updatedAt: row.updatedAt,
    secretHints: row.secretHints ?? null,
    testResults,
    restartPending: Boolean(row.restartPending)
  };
}
