import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const RESTORE_ACKNOWLEDGEMENT = "PG13_TO_PG17_EMPTY_TARGET";
const SOURCE_QUIESCED_ACKNOWLEDGEMENT = "PG13_SOURCE_QUIESCED";

function required(environment, name) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function readEndpoint(environment, prefix) {
  return {
    host: required(environment, `${prefix}_HOST`),
    port: parsePort(environment[`${prefix}_PORT`] || "5432", `${prefix}_PORT`),
    database: required(environment, `${prefix}_DATABASE`),
    user: required(environment, `${prefix}_USER`),
    password: required(environment, `${prefix}_PASSWORD`),
    sslMode: String(environment[`${prefix}_SSLMODE`] || "prefer").trim().toLowerCase(),
  };
}

function endpointIdentity(endpoint) {
  return [endpoint.host.toLowerCase(), endpoint.port, endpoint.database.toLowerCase()].join(":");
}

function assertDistinctEndpoints(source, target) {
  if (endpointIdentity(source) === endpointIdentity(target)) {
    throw new Error("source and target resolve to the same PostgreSQL endpoint");
  }
}

function pathIsInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function resolveArtifactPath(environment, root = repositoryRoot) {
  const configured = required(environment, "ALPR_MIGRATION_DUMP_PATH");
  if (!isAbsolute(configured)) {
    throw new Error("ALPR_MIGRATION_DUMP_PATH must be an absolute path outside the repository");
  }
  const dumpPath = resolve(configured);
  if (pathIsInside(root, dumpPath)) {
    throw new Error("ALPR_MIGRATION_DUMP_PATH must be outside the repository");
  }
  return dumpPath;
}

function executable(name, environment) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binDirectory = String(environment.ALPR_PG_BIN_DIR || "").trim();
  return binDirectory ? resolve(binDirectory, `${name}${suffix}`) : `${name}${suffix}`;
}

function connectionArguments(endpoint) {
  return [
    "--host", endpoint.host,
    "--port", String(endpoint.port),
    "--username", endpoint.user,
    "--dbname", endpoint.database,
  ];
}

function clientEnvironment(endpoint, environment) {
  return {
    ...environment,
    PGPASSWORD: endpoint.password,
    PGSSLMODE: endpoint.sslMode,
  };
}

function runProcess(program, args, { environment = process.env, inherit = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      env: environment,
      shell: false,
      stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${program} was not found; install PostgreSQL 17 client tools or set ALPR_PG_BIN_DIR`));
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${program} exited with status ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function query(endpoint, sql, environment = process.env) {
  const result = await runProcess(executable("psql", environment), [
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set", "ON_ERROR_STOP=1",
    ...connectionArguments(endpoint),
    "--command", sql,
  ], { environment: clientEnvironment(endpoint, environment) });
  return result.stdout.trim();
}

function parseServerMajor(versionNumber) {
  const numeric = Number(String(versionNumber).trim());
  if (!Number.isInteger(numeric) || numeric < 90_000) {
    throw new Error(`unexpected PostgreSQL server_version_num: ${versionNumber}`);
  }
  return Math.floor(numeric / 10_000);
}

function parseClientMajor(versionText) {
  const match = String(versionText).match(/PostgreSQL\)?\s+(\d+)/i);
  if (!match) throw new Error(`could not parse PostgreSQL client version: ${versionText}`);
  return Number(match[1]);
}

async function serverMajor(endpoint, environment) {
  return parseServerMajor(await query(endpoint, "SHOW server_version_num;", environment));
}

async function assertServerMajor(endpoint, expected, label, environment) {
  const actual = await serverMajor(endpoint, environment);
  if (actual !== expected) throw new Error(`${label} must be PostgreSQL ${expected}; received ${actual}`);
  return actual;
}

async function toolVersions(environment) {
  const versions = {};
  for (const name of ["pg_dump", "pg_restore", "psql"]) {
    const result = await runProcess(executable(name, environment), ["--version"], { environment });
    const major = parseClientMajor(result.stdout || result.stderr);
    if (major < 17) throw new Error(`${name} must be PostgreSQL 17 or newer; received ${major}`);
    versions[name] = major;
  }
  return versions;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function listPublicTables(endpoint, environment) {
  const raw = await query(endpoint, `
    SELECT COALESCE(json_agg(table_name ORDER BY table_name), '[]'::json)::text
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `, environment);
  const tables = JSON.parse(raw || "[]");
  if (!Array.isArray(tables) || tables.some((name) => typeof name !== "string")) {
    throw new Error("PostgreSQL returned an invalid public-table inventory");
  }
  return tables;
}

async function countUserRelations(endpoint, environment) {
  const value = await query(endpoint, `
    SELECT COUNT(*)::text
    FROM pg_class relations
    JOIN pg_namespace namespaces ON namespaces.oid = relations.relnamespace
    WHERE namespaces.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespaces.nspname NOT LIKE 'pg_toast%'
      AND relations.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
  `, environment);
  if (!/^\d+$/.test(value)) throw new Error("invalid user-relation count returned by PostgreSQL");
  return Number(value);
}

async function countTables(endpoint, tables, environment) {
  const counts = {};
  for (const table of tables) {
    const value = await query(endpoint, `SELECT COUNT(*)::text FROM public.${quoteIdentifier(table)};`, environment);
    if (!/^\d+$/.test(value)) throw new Error(`invalid row count returned for public.${table}`);
    counts[table] = value;
  }
  return counts;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex").toUpperCase();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readVerifiedManifest(dumpPath) {
  const manifestPath = `${dumpPath}.manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.formatVersion !== 1 || manifest.source?.serverMajor !== 13) {
    throw new Error("the dump manifest is not a supported PostgreSQL 13 migration manifest");
  }
  const dumpStats = await stat(dumpPath);
  const digest = await hashFile(dumpPath);
  if (manifest.dump?.sha256 !== digest || manifest.dump?.sizeBytes !== dumpStats.size) {
    throw new Error("the dump does not match its manifest; do not restore it");
  }
  return { manifest, manifestPath };
}

async function preflight(environment) {
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const target = readEndpoint(environment, "ALPR_MIGRATION_TARGET");
  assertDistinctEndpoints(source, target);
  const versions = await toolVersions(environment);
  await assertServerMajor(source, 13, "source", environment);
  await assertServerMajor(target, 17, "target", environment);
  const targetRelations = await countUserRelations(target, environment);
  if (targetRelations > 0) {
    throw new Error(`target must be an empty PostgreSQL 17 database; found ${targetRelations} user relation(s)`);
  }
  console.log(JSON.stringify({ ok: true, sourceMajor: 13, targetMajor: 17, targetRelations: 0, clients: versions }, null, 2));
}

async function createDump(environment) {
  if (environment.ALPR_MIGRATION_SOURCE_QUIESCED !== SOURCE_QUIESCED_ACKNOWLEDGEMENT) {
    throw new Error(`set ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT} after stopping all source writers`);
  }
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const dumpPath = resolveArtifactPath(environment);
  await toolVersions(environment);
  await assertServerMajor(source, 13, "source", environment);
  const overwrite = environment.ALPR_MIGRATION_OVERWRITE_DUMP === "true";
  if (!overwrite && (await exists(dumpPath) || await exists(`${dumpPath}.manifest.json`))) {
    throw new Error("dump or manifest already exists; choose a new path or explicitly set ALPR_MIGRATION_OVERWRITE_DUMP=true");
  }
  await mkdir(dirname(dumpPath), { recursive: true, mode: 0o700 });
  const sourceTables = await listPublicTables(source, environment);
  const sourceCounts = await countTables(source, sourceTables, environment);
  await runProcess(executable("pg_dump", environment), [
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    ...connectionArguments(source),
    "--file", dumpPath,
  ], { environment: clientEnvironment(source, environment), inherit: true });
  await chmod(dumpPath, 0o600);
  const dumpStats = await stat(dumpPath);
  if (dumpStats.size < 1) throw new Error("pg_dump created an empty file");
  const digest = await hashFile(dumpPath);
  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    source: {
      serverMajor: 13,
      database: source.database,
      tableCounts: sourceCounts,
    },
    dump: {
      sizeBytes: dumpStats.size,
      sha256: digest,
    },
  };
  await writeFile(`${dumpPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Verified PostgreSQL 13 dump: ${dumpPath}`);
  console.log(`SHA-256: ${digest}`);
}

async function restoreDump(environment) {
  if (environment.ALPR_MIGRATION_ACKNOWLEDGE !== RESTORE_ACKNOWLEDGEMENT) {
    throw new Error(`set ALPR_MIGRATION_ACKNOWLEDGE=${RESTORE_ACKNOWLEDGEMENT} to confirm the target is disposable and empty`);
  }
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const target = readEndpoint(environment, "ALPR_MIGRATION_TARGET");
  assertDistinctEndpoints(source, target);
  const dumpPath = resolveArtifactPath(environment);
  await toolVersions(environment);
  await assertServerMajor(source, 13, "source", environment);
  await assertServerMajor(target, 17, "target", environment);
  const targetRelations = await countUserRelations(target, environment);
  if (targetRelations > 0) {
    throw new Error(`restore refuses a non-empty target; found ${targetRelations} user relation(s)`);
  }
  await readVerifiedManifest(dumpPath);
  await runProcess(executable("pg_restore", environment), [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    ...connectionArguments(target),
    dumpPath,
  ], { environment: clientEnvironment(target, environment), inherit: true });
  await runProcess(executable("psql", environment), [
    "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1",
    "--single-transaction",
    ...connectionArguments(target),
    "--file", resolve(repositoryRoot, "migrations.sql"),
  ], { environment: clientEnvironment(target, environment), inherit: true });
  console.log("Restore and current migrations completed. Run validate before using the target.");
}

function compareCounts(sourceCounts, targetCounts) {
  const mismatches = [];
  for (const [table, sourceCount] of Object.entries(sourceCounts)) {
    const targetCount = targetCounts[table];
    if (targetCount === undefined) mismatches.push({ table, source: sourceCount, target: "missing" });
    else if (sourceCount !== targetCount) mismatches.push({ table, source: sourceCount, target: targetCount });
  }
  return mismatches;
}

async function validateMigration(environment) {
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const target = readEndpoint(environment, "ALPR_MIGRATION_TARGET");
  assertDistinctEndpoints(source, target);
  await toolVersions(environment);
  await assertServerMajor(source, 13, "source", environment);
  await assertServerMajor(target, 17, "target", environment);
  const dumpPath = resolveArtifactPath(environment);
  const { manifest } = await readVerifiedManifest(dumpPath);
  const sourceTables = await listPublicTables(source, environment);
  const targetTables = await listPublicTables(target, environment);
  const sourceCounts = await countTables(source, sourceTables, environment);
  const targetCounts = await countTables(target, targetTables, environment);
  const dumpedTables = Object.keys(manifest.source.tableCounts).sort();
  const currentSourceTables = [...sourceTables].sort();
  if (JSON.stringify(dumpedTables) !== JSON.stringify(currentSourceTables)) {
    throw new Error("the PostgreSQL 13 public-table inventory changed after the dump");
  }
  const manifestMismatches = compareCounts(manifest.source.tableCounts, sourceCounts);
  if (manifestMismatches.length > 0) {
    throw new Error(`source changed after the dump: ${JSON.stringify(manifestMismatches)}`);
  }
  const targetMismatches = compareCounts(sourceCounts, targetCounts);
  if (targetMismatches.length > 0) {
    throw new Error(`restored row counts differ: ${JSON.stringify(targetMismatches)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    sourceMajor: 13,
    targetMajor: 17,
    comparedTables: sourceTables.length,
    targetOnlyTables: targetTables.filter((table) => !sourceTables.includes(table)),
  }, null, 2));
}

async function rollbackCheck(environment) {
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const dumpPath = resolveArtifactPath(environment);
  await toolVersions(environment);
  await assertServerMajor(source, 13, "source", environment);
  await readVerifiedManifest(dumpPath);
  console.log("Rollback prerequisites verified: the PostgreSQL 13 source is reachable and the logical dump is intact.");
  console.log("Stop the PostgreSQL 17 target, then restart the retained PostgreSQL 13 volume with its matching application release.");
  console.log("This tool intentionally does not switch volumes or delete either database.");
}

function printHelp() {
  console.log(`Usage: node scripts/postgres-major-migration.mjs <command>

Commands:
  preflight       Verify PostgreSQL 17 clients, a PostgreSQL 13 source, and an empty PostgreSQL 17 target.
  dump            Create a custom-format dump and SHA-256/count manifest outside the repository.
  restore         Restore only into an empty PostgreSQL 17 target, then apply migrations.sql.
  validate        Compare every source public-table row count with the restored target and dump manifest.
  rollback-check  Verify the retained source and dump needed for rollback; performs no mutation.

Required endpoint variables use ALPR_MIGRATION_SOURCE_* and ALPR_MIGRATION_TARGET_*:
  HOST, PORT (default 5432), DATABASE, USER, PASSWORD, SSLMODE (default prefer)

Dump, restore, validate, and rollback-check require an absolute
ALPR_MIGRATION_DUMP_PATH outside this repository. Restore also requires:
  ALPR_MIGRATION_ACKNOWLEDGE=${RESTORE_ACKNOWLEDGEMENT}

Dump requires all source writers to be stopped and this acknowledgement:
  ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT}

Set ALPR_PG_BIN_DIR when PostgreSQL 17 pg_dump, pg_restore, and psql are not on PATH.
Never commit the dump, manifest, passwords, or a populated .env file.`);
}

async function main(command = process.argv[2], environment = process.env) {
  switch (command) {
    case "preflight": return preflight(environment);
    case "dump": return createDump(environment);
    case "restore": return restoreDump(environment);
    case "validate": return validateMigration(environment);
    case "rollback-check": return rollbackCheck(environment);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`unknown migration command: ${command}`);
  }
}

export const postgresMajorMigrationInternals = {
  RESTORE_ACKNOWLEDGEMENT,
  SOURCE_QUIESCED_ACKNOWLEDGEMENT,
  assertDistinctEndpoints,
  compareCounts,
  connectionArguments,
  endpointIdentity,
  parseClientMajor,
  parseServerMajor,
  pathIsInside,
  quoteIdentifier,
  readEndpoint,
  resolveArtifactPath,
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`PostgreSQL migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
