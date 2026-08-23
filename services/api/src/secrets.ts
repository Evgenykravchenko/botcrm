import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DomainError } from "./core.js";

export interface EncryptedSecret { v: 1; alg: "aes-256-gcm"; iv: string; tag: string; ciphertext: string }

function key() {
  const master = process.env.MASTER_ENCRYPTION_KEY;
  if (!master || master.length < 32) throw new DomainError(503, "MASTER_ENCRYPTION_KEY must contain at least 32 characters", "encryption_key_missing");
  return createHash("sha256").update(master).digest();
}

export function encryptSecret(value: Record<string, unknown>): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function decryptSecret(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") return {};
  const envelope = value as Partial<EncryptedSecret>;
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.ciphertext) return value as Record<string, any>;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const cleartext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    return JSON.parse(cleartext) as Record<string, any>;
  } catch {
    throw new DomainError(500, "Stored connector credentials cannot be decrypted", "credential_decryption_failed");
  }
}
