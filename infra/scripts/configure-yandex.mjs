import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export async function configureYandex({ envPath, tokenPath, request = fetch }) {
  const tokenFile = await stat(tokenPath);
  if (tokenFile.mode & 0o077) throw new Error("Token file must have permissions 600");
  const token = parseEnv(await readFile(tokenPath, "utf8")).CONTENT_PLATFORM_YANDEX_TOKEN;
  if (!token?.trim()) throw new Error("Token file must contain CONTENT_PLATFORM_YANDEX_TOKEN");
  const source = await readFile(envPath, "utf8");
  const headers = { authorization: `OAuth ${token}`, accept: "application/json" };
  const rootResponse = await request("https://cloud-api.yandex.net/v1/disk/resources?path=app%3A%2F&fields=path,type", { headers, signal: AbortSignal.timeout(15_000) });
  if (!rootResponse.ok) throw new Error(`Application folder request failed (${rootResponse.status})`);
  const metadata = await rootResponse.json();
  const root = metadata.path?.startsWith("disk:/") ? metadata.path.slice(5).replace(/\/+$/, "") : "";
  if (metadata.type !== "dir" || !root || root.split("/").includes("..") || /[\r\n\0]/.test(root)) throw new Error("Invalid Yandex Disk application folder");
  // A read/write token for the entire Disk must never be mistaken for an
  // isolated app-folder token. Only metadata is requested, never personal files.
  const diskResponse = await request("https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2F&fields=type", { headers, signal: AbortSignal.timeout(15_000) });
  if (diskResponse.status !== 403) throw new Error("Expected an app-folder-only token: access to the Disk root must be denied");
  const values = {
    CONTENT_PLATFORM_YANDEX_TOKEN: token,
    CONTENT_PLATFORM_YANDEX_ROOT: root,
    CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY: "true",
  };
  let result = source;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, "m");
    result = pattern.test(result) ? result.replace(pattern, () => line) : `${result.trimEnd()}\n${line}\n`;
  }
  const next = `${envPath}.yandex-next`;
  await writeFile(next, result, { mode: 0o600, flag: "wx" });
  await rename(next, envPath);
  return { root };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const tokenPath = args[args.indexOf("--token-file") + 1];
  const envPath = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : ".env.production";
  if (!args.includes("--token-file") || !tokenPath || tokenPath.startsWith("--") || !envPath || envPath.startsWith("--")) {
    console.error("Usage: node infra/scripts/configure-yandex.mjs --token-file /private/path/token.env [--env-file .env.production]");
    process.exitCode = 1;
  } else {
    try {
      const { root } = await configureYandex({ envPath: resolve(envPath), tokenPath: resolve(tokenPath) });
      console.log(`Yandex Disk application folder configured: ${root}. Existing bot libraries must be migrated before deploying.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
