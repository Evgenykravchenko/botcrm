import { randomBytes } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const target = resolve(root, ".env.production");
const template = resolve(root, ".env.production.example");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args.set(key.slice(2), "true");
  else { args.set(key.slice(2), value); index += 1; }
}

const domain = (args.get("domain") || "").trim().toLowerCase();
const email = (args.get("email") || "").trim().toLowerCase();
const storageDomain = (args.get("storage-domain") || (domain ? "media." + domain : "")).trim().toLowerCase();
const timezone = (args.get("timezone") || "Europe/Moscow").trim();
const ownerName = (args.get("owner-name") || "Владелец").trim();
const workspaceName = (args.get("workspace-name") || "Bot Studio").trim();
const force = args.get("force") === "true";

if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  throw new Error("Use --domain crm.example.com");
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Use --email owner@example.com");
const storageEndpointPattern = /^(?=.{4,259}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::(?:443|8443|10000))?$/;
if (!storageEndpointPattern.test(storageDomain) || storageDomain === domain) {
  throw new Error("Storage endpoint must be a separate DNS name or an allowed Funnel port, for example media." + domain + " or " + domain + ":8443");
}
if (!/^[A-Za-z_]+\/[A-Za-z_]+$/.test(timezone)) throw new Error("Invalid IANA timezone");

if (!force) {
  try { await stat(target); throw new Error(".env.production already exists. Use --force only if you intend to rotate every installation secret."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
const ownerPassword = secret(20) + "!Aa1";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const values = {
  BOTCRM_DOMAIN: domain,
  BOTCRM_STORAGE_DOMAIN: storageDomain,
  ACME_EMAIL: email,
  BOOTSTRAP_WORKSPACE_ID: workspaceId,
  BOOTSTRAP_WORKSPACE_NAME: workspaceName,
  BOOTSTRAP_WORKSPACE_TIMEZONE: timezone,
  BOOTSTRAP_OWNER_NAME: ownerName,
  BOOTSTRAP_OWNER_EMAIL: email,
  BOOTSTRAP_OWNER_PASSWORD: ownerPassword,
  POSTGRES_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),
  MINIO_ROOT_PASSWORD: secret(),
  SERVICE_TOKEN: secret(36),
  SERVICE_TOKEN_WORKSPACE_ID: workspaceId,
  MASTER_ENCRYPTION_KEY: secret(36),
  BOT_EVENT_SIGNING_SECRET: secret(36),
  AUTOMATION_WEBHOOK_SECRET: secret(36),
  GRAFANA_ADMIN_PASSWORD: secret(24),
};

let content = await readFile(template, "utf8");
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp("^" + key + "=.*$", "m");
  if (!pattern.test(content)) throw new Error("Template does not contain " + key);
  content = content.replace(pattern, key + "=" + value);
}
await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
await chmod(target, 0o600).catch(() => undefined);

console.log("");
console.log("Production configuration created: " + target);
console.log("Panel:   https://" + domain);
console.log("Storage: https://" + storageDomain);
console.log("Owner:   " + email);
console.log("Password (save it now): " + ownerPassword);
console.log("");
console.log("Next: create DNS records, run npm run prod:check, then npm run prod:up.");
