import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
function run(args, capture = false) {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.status})`);
  return capture ? result.stdout.trim() : "";
}

// On an existing installation, never recreate the active API/web for an update.
const legacy = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", "botcrm-api-1"], { cwd: root, encoding: "utf8" });
const edge = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", "botcrm-edge-1"], { cwd: root, encoding: "utf8" });
if (legacy.stdout?.trim() !== "true" && edge.stdout?.trim() !== "true") {
  const args = ["docker", "compose", "--env-file", ".env.production", "-f", "infra/docker-compose.prod.yml", "-f", "infra/docker-compose.tailscale.yml"];
  if (process.argv.includes("--xray")) args.push("-f", "infra/docker-compose.xray.yml");
  run([...args, "up", "-d", "--build", "postgres", "redis", "minio", "create-bucket", "migrate", "api", "web", "worker", "tailscale"]);
}
const release = run(["git", "rev-parse", "--short=12", "HEAD"], true);
run([process.execPath, "infra/scripts/deploy.mjs", release]);
