import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const file = resolve(root, ".env.production");
const live = process.argv.includes("--live");
const env = {};

for (const rawLine of (await readFile(file, "utf8")).split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
}

const errors = [];
const warnings = [];
const required = [
  "BOTCRM_DOMAIN", "BOTCRM_STORAGE_DOMAIN", "ACME_EMAIL", "POSTGRES_PASSWORD", "REDIS_PASSWORD",
  "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "SERVICE_TOKEN", "MASTER_ENCRYPTION_KEY",
  "BOOTSTRAP_WORKSPACE_ID", "SERVICE_TOKEN_WORKSPACE_ID", "BOOTSTRAP_OWNER_EMAIL", "BOOTSTRAP_OWNER_PASSWORD", "BOT_EVENT_SIGNING_SECRET",
];
for (const key of required) {
  if (!env[key]) errors.push(key + " is missing");
  if (/replace[-_]|example\.com/i.test(env[key] || "") && !["BOTCRM_DOMAIN", "BOTCRM_STORAGE_DOMAIN", "ACME_EMAIL", "BOOTSTRAP_OWNER_EMAIL"].includes(key)) {
    errors.push(key + " still contains an example value");
  }
}
for (const key of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ROOT_PASSWORD", "SERVICE_TOKEN", "MASTER_ENCRYPTION_KEY", "BOT_EVENT_SIGNING_SECRET"]) {
  if ((env[key] || "").length < 32) errors.push(key + " must contain at least 32 characters");
}
if ((env.BOOTSTRAP_OWNER_PASSWORD || "").length < 16) errors.push("BOOTSTRAP_OWNER_PASSWORD must contain at least 16 characters");
if (env.AUTH_REQUIRED !== "true") errors.push("AUTH_REQUIRED must be true in production");
if (env.ALLOW_INSECURE_AUTH_BYPASS !== "false") errors.push("ALLOW_INSECURE_AUTH_BYPASS must be false in production");
if (env.TRUST_PROXY !== "true") errors.push("TRUST_PROXY must be true behind Caddy");
if (env.BOT_EVENT_ALLOW_HTTP !== "false") errors.push("BOT_EVENT_ALLOW_HTTP must be false in production");
if (env.DELIVERY_MODE !== "live") errors.push("DELIVERY_MODE must be live in production");
if (env.SERVICE_TOKEN_WORKSPACE_ID !== env.BOOTSTRAP_WORKSPACE_ID) errors.push("SERVICE_TOKEN_WORKSPACE_ID must match BOOTSTRAP_WORKSPACE_ID");
if (env.BOTCRM_DOMAIN === env.BOTCRM_STORAGE_DOMAIN) errors.push("Panel and storage domains must differ");
if (!env.AUTOMATION_WEBHOOK_ALLOWLIST) warnings.push("AUTOMATION_WEBHOOK_ALLOWLIST is empty; external automation webhooks will be blocked");

const compose = spawnSync("docker", ["compose", "--env-file", file, "-f", resolve(root, "infra", "docker-compose.prod.yml"), "config", "--quiet"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, ...env },
});
if (compose.status !== 0) errors.push("Docker Compose configuration is invalid: " + (compose.stderr || compose.stdout || "unknown error").trim());

if (live && !errors.length) {
  const checks = [
    ["panel", "https://" + env.BOTCRM_DOMAIN + "/landing"],
    ["api", "https://" + env.BOTCRM_DOMAIN + "/api/v1/health"],
    ["storage", "https://" + env.BOTCRM_STORAGE_DOMAIN + "/minio/health/live"],
  ];
  for (const [name, url] of checks) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      if (response.status < 200 || response.status >= 400) errors.push(name + " returned HTTP " + response.status);
      else console.log("OK live " + name + ": " + response.status);
    } catch (error) {
      errors.push(name + " is unavailable: " + error.message);
    }
  }
}

for (const warning of warnings) console.warn("WARN " + warning);
for (const error of errors) console.error("ERROR " + error);
if (errors.length) process.exit(1);
console.log("Production configuration is valid.");
