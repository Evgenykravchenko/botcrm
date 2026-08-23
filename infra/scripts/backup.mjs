import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const password = process.env.BOTCRM_BACKUP_PASSWORD ?? "";
if (password.length < 16) throw new Error("Set BOTCRM_BACKUP_PASSWORD to at least 16 characters");
const root = resolve(import.meta.dirname, "../..");
const production = process.argv.includes("--production");
const args = process.argv.slice(2).filter((value) => value !== "--production");
const destination = resolve(args[0] ?? join(root, "backups", `botcrm-${new Date().toISOString().replaceAll(":", "-")}.botcrm-backup`));
const work = mkdtempSync(join(tmpdir(), "botcrm-backup-"));
const compose = production ? ["compose", "--env-file", join(root, ".env.production"), "-f", join(root, "infra", "docker-compose.prod.yml")] : ["compose", "-f", join(root, "infra", "docker-compose.yml")];

try {
  mkdirSync(resolve(destination, ".."), { recursive: true });
  const database = execFileSync("docker", [...compose, "exec", "-T", "postgres", "pg_dump", "-Fc", "-U", "botcrm", "-d", "botcrm"], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  writeFileSync(join(work, "postgres.dump"), database);
  mkdirSync(join(work, "media"));
  execFileSync("docker", [...compose, "cp", "minio:/data/botcrm-media/.", join(work, "media")], { cwd: root, stdio: "inherit" });
  const archive = join(work, "bundle.tar");
  execFileSync("tar", ["-cf", archive, "-C", work, "postgres.dump", "media"], { cwd: root, stdio: "inherit" });
  const salt = randomBytes(16); const iv = randomBytes(12); const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv); const encrypted = Buffer.concat([cipher.update(readFileSync(archive)), cipher.final()]);
  writeFileSync(destination, Buffer.concat([Buffer.from("BOTCRM1"), salt, iv, cipher.getAuthTag(), encrypted]));
  console.log(JSON.stringify({ ok: true, file: destination, name: basename(destination), encrypted: true }));
} finally { rmSync(work, { recursive: true, force: true }); }
