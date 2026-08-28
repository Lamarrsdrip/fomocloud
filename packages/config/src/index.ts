import crypto from "node:crypto";
import { db } from "@memecloud/db";

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

export type TestResult = { ok: boolean; httpStatus?: number; latencyMs?: number; message: string; checkedAt: string };

// Records real provider-test outcomes without touching the saved config value itself. Upserts
// because a test can legitimately run (and fail, e.g. "no key saved yet") before any config for
// this key was ever saved — there may be no row yet.
export async function recordTestResults(key: string, results: Record<string, TestResult>) {
  const row = await db.appConfig.findUnique({ where: { key } });
  const merged = { ...(row?.testResults as any ?? {}), ...results };
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
export function redactedConfig(row: {
  key: string; isSecret: boolean; valueJson: any; encryptedValue?: string | null; updatedAt: Date;
  secretHints?: any; testResults?: any; restartPending?: boolean;
}, secretFieldNames: string[] = []) {
  let value: any;
  if (row.isSecret) {
    if (row.encryptedValue) {
      value = { ...decryptJson<any>(row.encryptedValue) };
      for (const f of secretFieldNames) delete value[f];
    } else {
      value = {};
    }
  } else {
    value = row.valueJson;
  }
  return {
    key: row.key,
    value,
    isSecret: row.isSecret,
    updatedAt: row.updatedAt,
    secretHints: row.secretHints ?? null,
    testResults: row.testResults ?? null,
    restartPending: Boolean(row.restartPending)
  };
}
