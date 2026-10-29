import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { configureYandex } from "../infra/scripts/configure-yandex.mjs";

test("app-folder configuration preserves other credentials and rejects a whole-Disk token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botcrm-yandex-"));
  try {
    const envPath = join(dir, "production.env");
    const tokenPath = join(dir, "token.env");
    const original = "DATABASE_URL=unchanged\nCONTENT_PLATFORM_YANDEX_ROOT=/old\n";
    await writeFile(envPath, original, { mode: 0o600 });
    await writeFile(tokenPath, "CONTENT_PLATFORM_YANDEX_TOKEN=test-app-folder-token\n", { mode: 0o600 });
    let diskStatus = 200;
    const calls = [];
    const request = async (input, options) => {
      assert.equal(options.headers.authorization, "OAuth test-app-folder-token");
      const path = new URL(input).searchParams.get("path");
      calls.push(path);
      return path === "app:/" ? Response.json({ path: "disk:/Приложения/My CRM", type: "dir" }) : new Response(null, { status: diskStatus });
    };
    await assert.rejects(configureYandex({ envPath, tokenPath, request }), /access to the Disk root must be denied/);
    assert.equal(await readFile(envPath, "utf8"), original);
    diskStatus = 403;
    assert.deepEqual(await configureYandex({ envPath, tokenPath, request }), { root: "/Приложения/My CRM" });
    const values = parseEnv(await readFile(envPath, "utf8"));
    assert.equal(values.DATABASE_URL, "unchanged");
    assert.equal(values.CONTENT_PLATFORM_YANDEX_ROOT, "/Приложения/My CRM");
    assert.equal(values.CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY, "true");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.deepEqual(calls, ["app:/", "disk:/", "app:/", "disk:/"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
