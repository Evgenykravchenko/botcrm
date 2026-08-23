import { createDecipheriv, createHash } from "node:crypto";

export function decryptCredentials(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") return {};
  const envelope = value as Record<string, any>;
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") return envelope;
  const master = process.env.MASTER_ENCRYPTION_KEY;
  if (!master || master.length < 32) throw new Error("MASTER_ENCRYPTION_KEY must contain at least 32 characters");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(master).digest(), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
}
