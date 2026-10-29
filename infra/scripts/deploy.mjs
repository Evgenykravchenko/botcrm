import { spawnSync } from "node:child_process";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../..");
const runtime = resolve(root, ".runtime");
const edgeDir = resolve(runtime, "edge");
const statePath = resolve(runtime, "release.json");

function run(args, env = {}, capture = false) {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.status}): ${capture ? result.stderr.trim() : "see output above"}`);
  return capture ? result.stdout.trim() : "";
}

export function upstreamConfig(api, web, previousWeb = web) {
  for (const host of [api, web, previousWeb]) if (!/^botcrm-(?:api-1|web-1|(?:blue|green)-(?:api|web)-release-1)$/.test(host)) throw new Error("Invalid BotCRM upstream");
  return `(api-backend) {
  reverse_proxy ${api}:4100 {
    header_up X-Forwarded-For {client_ip}
    header_up -Forwarded
    header_up -X-Real-IP
    header_up X-Forwarded-Proto https
    stream_close_delay 5m
  }
}
(web-backend) {
  @previous-assets path /assets/* /_next/static/* /_next/assets/*
  handle @previous-assets {
    reverse_proxy ${web}:3000 {
      @missing status 404
      handle_response @missing {
        reverse_proxy ${previousWeb}:3000
      }
    }
  }
  handle {
  reverse_proxy ${web}:3000 {
    header_up X-Forwarded-For {client_ip}
    header_up -Forwarded
    header_up -X-Real-IP
    header_up X-Forwarded-Proto https
  }
  }
}
`;
}

export function funnelConfig(original, domain, port) {
  // Preserve storage and any existing listeners. Only replace the app listener.
  const config = structuredClone(original);
  config.TCP ??= {};
  const configDomain = Object.keys(config.AllowFunnel ?? {}).some((key) => key.includes("${TS_CERT_DOMAIN}")) ? "${TS_CERT_DOMAIN}" : domain;
  config.TCP[String(port)] = { HTTPS: true };
  config.Web ??= {};
  delete config.Web[`${configDomain}:${port}`];
  config.Web[`${configDomain}:${port}`] = { Handlers: { "/": { Proxy: "http://botcrm-edge-1:8080" } } };
  config.AllowFunnel ??= {};
  config.AllowFunnel[`${configDomain}:${port}`] = true;
  return config;
}

async function atomic(path, contents) {
  const temp = `${path}.next`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, path);
}

async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function inspect(name) { return JSON.parse(run(["docker", "inspect", name], {}, true))[0]; }
async function healthy(name) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = inspect(name).State;
    if (state.Running && state.Health?.Status === "healthy") return;
    if (state.Status === "exited" || state.Health?.Status === "unhealthy") throw new Error(`${name} is not healthy`);
    await delay(2000);
  }
  throw new Error(`${name} health check timed out`);
}

async function publicCheck(domain, port = 443) {
  const origin = `https://${domain}${port === 443 ? "" : `:${port}`}`;
  for (const path of ["/landing", "/api/v1/health/ready"]) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error(`${origin}${path} returned ${response.status}`);
  }
}

async function main() {
  const release = process.argv[2];
  if (!release || !/^[a-f0-9]{7,40}$/.test(release)) throw new Error("Usage: node infra/scripts/deploy.mjs <git-commit>");
  if (run(["git", "rev-parse", "--short=12", "HEAD"], {}, true) !== release) throw new Error("Release must match the checked-out 12-character Git commit");
  if (run(["git", "status", "--porcelain"], {}, true)) throw new Error("Deploy requires a clean checkout");
  const env = parseEnv(await readFile(resolve(root, ".env.production"), "utf8"));
  const domain = env.BOTCRM_DOMAIN;
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || !env.BOTCRM_STORAGE_DOMAIN || !/^[a-z0-9.:-]+$/.test(env.BOTCRM_STORAGE_DOMAIN)) throw new Error("Invalid production domain");
  await mkdir(edgeDir, { recursive: true, mode: 0o700 });
  const lockPath = resolve(runtime, "deploy.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const previous = await jsonFile(statePath, null);
  const slot = previous?.slot === "blue" ? "green" : "blue";
  const api = `botcrm-${slot}-api-release-1`;
  const web = `botcrm-${slot}-web-release-1`;
  const releaseEnv = { BOTCRM_RELEASE: release, BOTCRM_RELEASE_API: api };
  const oldApi = previous ? `botcrm-${previous.slot}-api-release-1` : "botcrm-api-1";
  const oldWeb = previous ? `botcrm-${previous.slot}-web-release-1` : "botcrm-web-1";
  const oldWorker = previous ? `botcrm-${previous.slot}-worker-release-1` : "botcrm-worker-1";
  const usesProxy = inspect(oldApi).Config.Env.some((entry) => entry.startsWith("HTTP_PROXY="));
  const compose = (...args) => run(["docker", "compose", "--env-file", ".env.production", "-p", `botcrm-${slot}`, "-f", "infra/docker-compose.release.yml", ...(usesProxy ? ["-f", "infra/docker-compose.release.xray.yml"] : []), ...args], releaseEnv);
  // First migration may build from a separate checkout while the live config stays mounted.
  const servePath = process.env.BOTCRM_SERVE_CONFIG_FILE || resolve(root, "infra/tailscale-serve/serve.json");
  const originalServe = await readFile(servePath, "utf8");
  let switched = false;
  let stoppedWorker = false;
  let legacyDetached = false;
  let finished = false;
  try {
    // Build while the active application continues serving requests.
    for (const target of ["api", "web", "worker", "migrate"]) run(["docker", "build", "-f", "infra/Dockerfile", "--target", target, "-t", `botcrm-${target}:${release}`, "."]);
    // Only backwards-compatible (expand/contract) migrations may be released online.
    compose("run", "--rm", "--no-deps", "migrate-release");
    compose("up", "-d", "--no-deps", "api-release", "web-release");
    await Promise.all([healthy(api), healthy(web)]);

    const tail = inspect("botcrm-tailscale-1");
    const tailIp = tail.NetworkSettings.Networks.botcrm_backend?.IPAddress;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(tailIp ?? "")) throw new Error("Funnel backend address is unavailable");
    await atomic(resolve(edgeDir, "proxy-trust.caddy"), `trusted_proxies static ${tailIp}/32\n`);
    await atomic(resolve(edgeDir, "Caddyfile"), (await readFile(resolve(root, "infra/Caddyfile.edge"), "utf8")).replace("STORAGE_DOMAIN", env.BOTCRM_STORAGE_DOMAIN));
    await atomic(resolve(edgeDir, "upstreams.caddy"), upstreamConfig(oldApi, oldWeb));
    run(["docker", "compose", "--env-file", ".env.production", "-f", "infra/docker-compose.edge.yml", "up", "-d", "--no-deps", "edge"]);
    run(["docker", "exec", "botcrm-edge-1", "caddy", "validate", "--config", "/etc/caddy/Caddyfile"]);
    run(["docker", "exec", "botcrm-edge-1", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);

    // Test the new proxy on the spare Funnel port before switching the live port.
    const baseServe = JSON.parse(originalServe);
    if (baseServe.TCP?.["10000"]) throw new Error("Funnel port 10000 is occupied; refusing to replace it");
    await atomic(servePath, JSON.stringify(funnelConfig(baseServe, domain, 10000), null, 2) + "\n");
    await delay(5000); // containerboot watches the mounted configuration directory
    // The legacy API predates /health/ready; test candidate routes before exposing them.

    await atomic(resolve(edgeDir, "upstreams.caddy"), upstreamConfig(api, web, oldWeb));
    run(["docker", "exec", "botcrm-edge-1", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
    switched = true;
    await publicCheck(domain, 10000);
    await atomic(servePath, JSON.stringify(funnelConfig(baseServe, domain, 443), null, 2) + "\n");
    await delay(5000);
    await publicCheck(domain);

    // Drain the existing queue consumer before starting its replacement.
    run(["docker", "stop", "--time", "60", oldWorker]);
    stoppedWorker = true;
    compose("up", "-d", "--no-deps", "worker-release");
    await healthy(`botcrm-${slot}-worker-release-1`);
    if (!previous) {
      // Remove the old service alias only after the stable private gateway is ready.
      // Otherwise bots resolving http://api could continue reaching the unfixed API.
      run(["docker", "network", "disconnect", env.CONTENT_PLATFORM_NETWORK || "bot_platform_backend", oldApi]);
      legacyDetached = true;
      run(["docker", "stop", "--time", "60", oldApi]);
    }
    await atomic(statePath, JSON.stringify({ slot, release, previous: previous ? { slot: previous.slot, release: previous.release } : null, activatedAt: new Date().toISOString() }, null, 2));
    finished = true;
    console.log(`BotCRM ${release} active in ${slot}. Previous web/API retained for draining and rollback.`);
  } finally {
    try { if (!finished) {
      console.error("Deploy failed; restoring previous routing and worker.");
      await atomic(servePath, originalServe);
      if (legacyDetached) {
        run(["docker", "start", oldApi]);
        run(["docker", "network", "connect", "--alias", "api", env.CONTENT_PLATFORM_NETWORK || "bot_platform_backend", oldApi]);
      }
      if (switched) {
        await atomic(resolve(edgeDir, "upstreams.caddy"), upstreamConfig(oldApi, oldWeb));
        run(["docker", "exec", "botcrm-edge-1", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
      }
      compose("stop", "--timeout", "60", "worker-release");
      if (stoppedWorker) run(["docker", "start", oldWorker]);
    } } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
