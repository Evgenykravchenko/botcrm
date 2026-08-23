import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Client } from "pg";

const root = resolve(import.meta.dirname, "../..");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({
  connectionString: databaseUrl,
  application_name: "botcrm-migrations",
  connectionTimeoutMillis: 10_000,
});

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function applied(name) {
  const result = await client.query("select checksum from schema_migrations where name=$1", [name]);
  return result.rows[0]?.checksum;
}

async function record(name, value) {
  await client.query("insert into schema_migrations(name,checksum) values($1,$2) on conflict(name) do nothing", [name, value]);
}

async function run(name, sql, allowExistingBaseline = false) {
  const hash = checksum(sql);
  const previous = await applied(name);
  if (previous) {
    if (previous !== hash) throw new Error("Applied migration was modified: " + name);
    console.log("Migration already applied: " + name);
    return;
  }

  if (allowExistingBaseline) {
    const exists = await client.query("select to_regclass('public.workspaces') is not null as exists");
    if (exists.rows[0]?.exists) {
      await record(name, hash);
      console.log("Existing schema registered as baseline: " + name);
      return;
    }
  }

  await client.query("begin");
  try {
    await client.query(sql);
    await record(name, hash);
    await client.query("commit");
    console.log("Migration applied: " + name);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

try {
  await client.connect();
  await client.query("select pg_advisory_lock(hashtext('botcrm-schema-migrations'))");
  await client.query("create table if not exists schema_migrations(name text primary key, checksum char(64) not null, applied_at timestamptz not null default now())");

  const baseline = await readFile(join(root, "infra", "postgres.sql"), "utf8");
  await run("001_postgres.sql", baseline, true);

  const migrationDir = join(root, "infra", "migrations");
  const files = (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    await run(file, await readFile(join(migrationDir, file), "utf8"));
  }

  console.log("BotCRM database schema is up to date.");
} finally {
  await client.query("select pg_advisory_unlock(hashtext('botcrm-schema-migrations'))").catch(() => undefined);
  await client.end().catch(() => undefined);
}