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

export async function getConfig<T=any>(key: string): Promise<T | null> {
  const row = await db.appConfig.findUnique({ where: { key } });
  if (!row) return null;
  if (row.isSecret) return row.encryptedValue ? decryptJson<T>(row.encryptedValue) : null;
  return (row.valueJson ?? null) as T | null;
}

export async function setConfig(key: string, value: unknown, opts: {secret?:boolean; updatedBy?:string}={}) {
  const isSecret = Boolean(opts.secret);
  return db.appConfig.upsert({
    where: { key },
    create: {
      key, isSecret, updatedBy: opts.updatedBy,
      valueJson: isSecret ? { configured: true } : value as any,
      encryptedValue: isSecret ? encryptJson(value) : null
    },
    update: {
      isSecret, updatedBy: opts.updatedBy,
      valueJson: isSecret ? { configured: true } : value as any,
      encryptedValue: isSecret ? encryptJson(value) : null
    }
  });
}

export function redactedConfig(row: {key:string;isSecret:boolean;valueJson:any;encryptedValue?:string|null;updatedAt:Date}) {
  return {
    key: row.key,
    value: row.isSecret ? { configured: Boolean(row.encryptedValue) } : row.valueJson,
    isSecret: row.isSecret,
    updatedAt: row.updatedAt
  };
}
