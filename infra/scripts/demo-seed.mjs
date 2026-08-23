import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, "..", "docker-compose.yml");
const seedFile = join(here, "..", "seed.sql");
const sql = await readFile(seedFile);

const child = spawn(
  "docker",
  ["compose", "-f", composeFile, "exec", "-T", "postgres", "psql", "-U", "botcrm", "-d", "botcrm", "-v", "ON_ERROR_STOP=1"],
  { stdio: ["pipe", "inherit", "inherit"] },
);

child.stdin.end(sql);
child.on("error", (error) => {
  console.error("Не удалось запустить Docker:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  if (code === 0) console.log("Демонстрационные данные добавлены.");
  process.exitCode = code ?? 1;
});
