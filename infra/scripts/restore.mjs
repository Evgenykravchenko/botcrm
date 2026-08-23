import { execFileSync, spawnSync } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const production = process.argv.includes("--production");
const args = process.argv.slice(2).filter((value) => value !== "--production" && value !== "--confirm");
const file = args[0] ? resolve(args[0]) : "";
if (!file || !process.argv.includes("--confirm")) throw new Error("Usage: node infra/scripts/restore.mjs <backup-file> --confirm");
const password = process.env.BOTCRM_BACKUP_PASSWORD ?? "";
if (password.length < 16) throw new Error("Set BOTCRM_BACKUP_PASSWORD to the password used for backup");
const root = resolve(import.meta.dirname, "../.."); const work = mkdtempSync(join(tmpdir(), "botcrm-restore-"));
const compose = production ? ["compose", "--env-file", join(root, ".env.production"), "-f", join(root, "infra", "docker-compose.prod.yml")] : ["compose", "-f", join(root, "infra", "docker-compose.yml")];

try {
  const payload = readFileSync(file);
  if (payload.subarray(0, 7).toString() !== "BOTCRM1") throw new Error("Unsupported or corrupted backup");
  const salt = payload.subarray(7, 23); const iv = payload.subarray(23, 35); const tag = payload.subarray(35, 51);
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32), iv); decipher.setAuthTag(tag);
  const archive = join(work, "bundle.tar"); writeFileSync(archive, Buffer.concat([decipher.update(payload.subarray(51)), decipher.final()]));
  execFileSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
  const restored = spawnSync("docker", [...compose, "exec", "-T", "postgres", "pg_restore", "--clean", "--if-exists", "--no-owner", "-U", "botcrm", "-d", "botcrm"], { cwd: root, input: readFileSync(join(work, "postgres.dump")), stdio: ["pipe", "inherit", "inherit"] });
  if (restored.status !== 0) throw new Error(`pg_restore failed with code ${restored.status}`);
  execFileSync("docker", [...compose, "cp", join(work, "media", "."), "minio:/data/botcrm-media"], { cwd: root, stdio: "inherit" });
  console.log(JSON.stringify({ ok: true, restored: file }));
} finally { rmSync(work, { recursive: true, force: true }); }
