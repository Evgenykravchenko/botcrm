import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Client } from "pg";

const root = resolve(import.meta.dirname, "../..");
const migrationsRoot = resolve(root, "infra/migrations");
const requested = process.argv[2];
if (!requested) throw new Error("Migration path is required");
const migrationPath = resolve(root, requested);
if (relative(migrationsRoot, migrationPath).startsWith("..")) throw new Error("Only infra/migrations files can be applied");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");

const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: "botcrm-migration" });
try {
  await client.connect();
  await client.query(await readFile(migrationPath, "utf8"));
  process.stdout.write(`Applied ${relative(root, migrationPath)}\n`);
} finally {
  await client.end().catch(() => undefined);
}
