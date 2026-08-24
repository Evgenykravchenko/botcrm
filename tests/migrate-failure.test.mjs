import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("migration runner preserves the original connection failure", async () => {
  const child = spawn(process.execPath, ["infra/scripts/migrate.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://botcrm:botcrm@127.0.0.1:1/botcrm",
      MIGRATION_CONNECTION_TIMEOUT_MS: "150",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /ECONNREFUSED|connect/i);
  assert.doesNotMatch(stderr, /unsettled top-level await/i);
});