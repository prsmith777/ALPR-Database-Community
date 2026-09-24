import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const TARGET_SERVER_MAJOR = 17;
const SUPPORTED_SOURCE_MAJORS = Object.freeze([13, 17]);
const RESTORE_ACKNOWLEDGEMENT = "ALPR_TO_PG17_EMPTY_TARGET";
const SOURCE_QUIESCED_ACKNOWLEDGEMENT = "ALPR_SOURCE_QUIESCED";
const LEGACY_BASELINE_COMMIT = "aeb72baf6f0435c8d42ed07422f1b2f3a703e6ac";
const COMMUNITY_BASELINE_MIGRATION = "2026082301_vehicle_passage_foundation";
const SOURCE_PROFILES = Object.freeze({
  LEGACY_V019: Object.freeze({
    id: "original-alpr-v0.1.9",
    label: "Original ALPR Database v0.1.9-compatible",
    referenceCommit: LEGACY_BASELINE_COMMIT,
  }),
  COMMUNITY: Object.freeze({
    id: "alpr-community-v0.1.20-plus",
    label: "ALPR Database Community v0.1.20 or newer",
  }),
});
const POST_MIGRATION_RECONCILIATION_SQL = `
  INSERT INTO public.plates (plate_number, occurrence_count)
  SELECT reads.plate_number, COUNT(*)::integer
  FROM public.plate_reads reads
  GROUP BY reads.plate_number
  ON CONFLICT (plate_number) DO UPDATE
  SET occurrence_count = EXCLUDED.occurrence_count;

  UPDATE public.plates plates
  SET occurrence_count = 0
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.plate_reads reads
    WHERE reads.plate_number = plates.plate_number
  ) AND plates.occurrence_count <> 0;
`;

const LEGACY_V019_REQUIRED_COLUMNS = Object.freeze({
  devmgmt: Object.freeze(["id", "training_last_record", "update1"]),
  known_plates: Object.freeze(["ignore", "plate_number"]),
  plate_notifications: Object.freeze(["enabled", "id", "plate_number", "priority"]),
  plate_reads: Object.freeze([
    "bi_path",
    "bi_zone",
    "camera_name",
    "confidence",
    "crop_coordinates",
    "id",
    "image_data",
    "image_path",
    "ocr_annotation",
    "plate_annotation",
    "plate_number",
    "thumbnail_path",
    "timestamp",
    "validated",
  ]),
  plate_tags: Object.freeze(["plate_number", "tag_id"]),
  plates: Object.freeze(["flagged", "occurrence_count", "plate_number"]),
  tags: Object.freeze(["id", "name"]),
});

const LEGACY_V019_REQUIRED_PRIMARY_KEYS = Object.freeze({
  devmgmt: Object.freeze(["id"]),
  known_plates: Object.freeze(["plate_number"]),
  plate_notifications: Object.freeze(["id"]),
  plate_reads: Object.freeze(["id"]),
  plate_tags: Object.freeze(["plate_number", "tag_id"]),
  tags: Object.freeze(["id"]),
});

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

function assertSupportedSourceMajor(actual) {
  if (!SUPPORTED_SOURCE_MAJORS.includes(actual)) {
    throw new Error(
      `source must be a supported PostgreSQL major (${SUPPORTED_SOURCE_MAJORS.join(" or ")}); received ${actual}`
    );
  }
  return actual;
}

async function supportedSourceMajor(endpoint, environment) {
  return assertSupportedSourceMajor(await serverMajor(endpoint, environment));
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

async function listPublicColumns(endpoint, environment) {
  const raw = await query(endpoint, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'table', table_name,
          'column', column_name,
          'ordinal', ordinal_position,
          'dataType', data_type,
          'udtName', udt_name,
          'nullable', is_nullable
        )
        ORDER BY table_name, ordinal_position
      ),
      '[]'::json
    )::text
    FROM information_schema.columns
    WHERE table_schema = 'public';
  `, environment);
  const columns = JSON.parse(raw || "[]");
  if (
    !Array.isArray(columns) ||
    columns.some(
      (entry) =>
        typeof entry?.table !== "string" ||
        typeof entry?.column !== "string" ||
        !Number.isInteger(entry?.ordinal)
    )
  ) {
    throw new Error("PostgreSQL returned an invalid public-column inventory");
  }
  return columns;
}

async function listPublicPrimaryKeys(endpoint, environment) {
  const raw = await query(endpoint, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'table', constraints.table_name,
          'column', columns.column_name,
          'ordinal', columns.ordinal_position
        )
        ORDER BY constraints.table_name, columns.ordinal_position
      ),
      '[]'::json
    )::text
    FROM information_schema.table_constraints constraints
    JOIN information_schema.key_column_usage columns
      ON columns.constraint_schema = constraints.constraint_schema
     AND columns.constraint_name = constraints.constraint_name
     AND columns.table_schema = constraints.table_schema
     AND columns.table_name = constraints.table_name
    WHERE constraints.table_schema = 'public'
      AND constraints.constraint_type = 'PRIMARY KEY';
  `, environment);
  const primaryKeys = JSON.parse(raw || "[]");
  if (
    !Array.isArray(primaryKeys) ||
    primaryKeys.some(
      (entry) =>
        typeof entry?.table !== "string" ||
        typeof entry?.column !== "string" ||
        !Number.isInteger(entry?.ordinal)
    )
  ) {
    throw new Error("PostgreSQL returned an invalid primary-key inventory");
  }
  return primaryKeys;
}

async function listSchemaMigrationVersions(endpoint, tables, environment) {
  if (!tables.includes("schema_migrations")) return [];
  const raw = await query(endpoint, `
    SELECT COALESCE(json_agg(version ORDER BY version), '[]'::json)::text
    FROM public.schema_migrations;
  `, environment);
  const versions = JSON.parse(raw || "[]");
  if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
    throw new Error("PostgreSQL returned an invalid schema-migration inventory");
  }
  return versions;
}

function columnsByTable(columns) {
  const inventory = {};
  for (const entry of columns) {
    if (!inventory[entry.table]) inventory[entry.table] = [];
    inventory[entry.table].push(entry.column);
  }
  for (const names of Object.values(inventory)) names.sort();
  return inventory;
}

function primaryKeysByTable(primaryKeys) {
  const inventory = {};
  for (const entry of primaryKeys) {
    if (!inventory[entry.table]) inventory[entry.table] = [];
    inventory[entry.table].push(entry.column);
  }
  return inventory;
}

function missingLegacyV019Requirements(signature) {
  const missing = [];
  const availableColumns = columnsByTable(signature.columns);
  const availablePrimaryKeys = primaryKeysByTable(signature.primaryKeys);
  for (const [table, requiredColumns] of Object.entries(LEGACY_V019_REQUIRED_COLUMNS)) {
    const tableColumns = new Set(availableColumns[table] || []);
    for (const column of requiredColumns) {
      if (!tableColumns.has(column)) missing.push(`column public.${table}.${column}`);
    }
  }
  for (const [table, requiredColumns] of Object.entries(LEGACY_V019_REQUIRED_PRIMARY_KEYS)) {
    const actualColumns = availablePrimaryKeys[table] || [];
    if (JSON.stringify(actualColumns) !== JSON.stringify(requiredColumns)) {
      missing.push(`primary key public.${table}(${requiredColumns.join(",")})`);
    }
  }
  return missing;
}

function classifySourceApplication(signature) {
  const missing = missingLegacyV019Requirements(signature);
  if (missing.length > 0) {
    throw new Error(
      `source is missing the supported ALPR database foundation: ${missing.join(", ")}`
    );
  }

  const hasMigrationTable = signature.tables.includes("schema_migrations");
  if (hasMigrationTable) {
    if (!signature.migrationVersions.includes(COMMUNITY_BASELINE_MIGRATION)) {
      throw new Error(
        `source has schema_migrations but lacks the supported Community baseline ${COMMUNITY_BASELINE_MIGRATION}`
      );
    }
    return SOURCE_PROFILES.COMMUNITY;
  }
  return SOURCE_PROFILES.LEGACY_V019;
}

function fingerprintSourceSchema(signature) {
  const normalized = {
    tables: [...signature.tables].sort(),
    columns: [...signature.columns].sort((left, right) =>
      `${left.table}\u0000${String(left.ordinal).padStart(6, "0")}\u0000${left.column}`.localeCompare(
        `${right.table}\u0000${String(right.ordinal).padStart(6, "0")}\u0000${right.column}`
      )
    ),
    primaryKeys: [...signature.primaryKeys].sort((left, right) =>
      `${left.table}\u0000${String(left.ordinal).padStart(6, "0")}\u0000${left.column}`.localeCompare(
        `${right.table}\u0000${String(right.ordinal).padStart(6, "0")}\u0000${right.column}`
      )
    ),
    migrationVersions: [...signature.migrationVersions].sort(),
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .toUpperCase();
}

async function inspectSourceApplication(endpoint, environment) {
  const tables = await listPublicTables(endpoint, environment);
  const signature = {
    tables,
    columns: await listPublicColumns(endpoint, environment),
    primaryKeys: await listPublicPrimaryKeys(endpoint, environment),
    migrationVersions: await listSchemaMigrationVersions(endpoint, tables, environment),
  };
  return {
    profile: classifySourceApplication(signature),
    schemaFingerprint: fingerprintSourceSchema(signature),
  };
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

async function countOccurrenceCountMismatches(endpoint, environment) {
  const value = await query(endpoint, `
    WITH read_counts AS (
      SELECT plate_number, COUNT(*)::bigint AS read_count
      FROM public.plate_reads
      GROUP BY plate_number
    )
    SELECT COUNT(*)::text
    FROM public.plates plates
    FULL JOIN read_counts reads USING (plate_number)
    WHERE plates.plate_number IS NULL
       OR plates.occurrence_count IS DISTINCT FROM COALESCE(reads.read_count, 0);
  `, environment);
  if (!/^\d+$/.test(value)) {
    throw new Error("invalid plate occurrence-count reconciliation result");
  }
  return Number(value);
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
  const supportedManifest =
    manifest.formatVersion === 3 &&
    SUPPORTED_SOURCE_MAJORS.includes(manifest.source?.serverMajor) &&
    Object.values(SOURCE_PROFILES).some(
      (profile) => profile.id === manifest.source?.applicationProfile
    ) &&
    /^[A-F0-9]{64}$/.test(manifest.source?.schemaFingerprint || "");
  if (!supportedManifest) {
    throw new Error(
      "the dump manifest lacks the current source-readiness evidence; rerun preflight and create a new dump"
    );
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
  const sourceMajor = await supportedSourceMajor(source, environment);
  const sourceApplication = await inspectSourceApplication(source, environment);
  await assertServerMajor(target, TARGET_SERVER_MAJOR, "target", environment);
  const targetRelations = await countUserRelations(target, environment);
  if (targetRelations > 0) {
    throw new Error(
      `target must be an empty PostgreSQL ${TARGET_SERVER_MAJOR} database; found ${targetRelations} user relation(s)`
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        sourceMajor,
        sourceApplicationProfile: sourceApplication.profile.id,
        sourceApplicationLabel: sourceApplication.profile.label,
        sourceSchemaFingerprint: sourceApplication.schemaFingerprint,
        targetMajor: TARGET_SERVER_MAJOR,
        targetRelations: 0,
        clients: versions,
      },
      null,
      2
    )
  );
}

async function createDump(environment) {
  if (environment.ALPR_MIGRATION_SOURCE_QUIESCED !== SOURCE_QUIESCED_ACKNOWLEDGEMENT) {
    throw new Error(`set ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT} after stopping all source writers`);
  }
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const dumpPath = resolveArtifactPath(environment);
  await toolVersions(environment);
  const sourceMajor = await supportedSourceMajor(source, environment);
  const sourceApplication = await inspectSourceApplication(source, environment);
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
  const currentSourceTables = await listPublicTables(source, environment);
  if (JSON.stringify(sourceTables) !== JSON.stringify(currentSourceTables)) {
    throw new Error("the source public-table inventory changed during the dump");
  }
  const currentSourceCounts = await countTables(
    source,
    currentSourceTables,
    environment
  );
  const sourceMismatches = compareCounts(sourceCounts, currentSourceCounts);
  if (sourceMismatches.length > 0) {
    throw new Error(
      `source changed during the dump: ${JSON.stringify(sourceMismatches)}`
    );
  }
  const currentSourceApplication = await inspectSourceApplication(source, environment);
  if (
    currentSourceApplication.profile.id !== sourceApplication.profile.id ||
    currentSourceApplication.schemaFingerprint !== sourceApplication.schemaFingerprint
  ) {
    throw new Error("the source application schema changed during the dump");
  }
  await chmod(dumpPath, 0o600);
  const dumpStats = await stat(dumpPath);
  if (dumpStats.size < 1) throw new Error("pg_dump created an empty file");
  const digest = await hashFile(dumpPath);
  const manifest = {
    formatVersion: 3,
    createdAt: new Date().toISOString(),
    source: {
      serverMajor: sourceMajor,
      database: source.database,
      applicationProfile: sourceApplication.profile.id,
      schemaFingerprint: sourceApplication.schemaFingerprint,
      tableCounts: sourceCounts,
    },
    dump: {
      sizeBytes: dumpStats.size,
      sha256: digest,
    },
  };
  await writeFile(`${dumpPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Verified PostgreSQL ${sourceMajor} dump: ${dumpPath}`);
  console.log(`Source application profile: ${sourceApplication.profile.label}`);
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
  const sourceMajor = await supportedSourceMajor(source, environment);
  await assertServerMajor(target, TARGET_SERVER_MAJOR, "target", environment);
  const targetRelations = await countUserRelations(target, environment);
  if (targetRelations > 0) {
    throw new Error(`restore refuses a non-empty target; found ${targetRelations} user relation(s)`);
  }
  const { manifest } = await readVerifiedManifest(dumpPath);
  await assertLiveSourceMatchesManifest(
    manifest,
    source,
    sourceMajor,
    environment
  );
  await runProcess(executable("pg_restore", environment), [
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-privileges",
    ...connectionArguments(target),
    dumpPath,
  ], { environment: clientEnvironment(target, environment), inherit: true });
  const restoredTables = await listPublicTables(target, environment);
  const restoredCounts = await countTables(target, restoredTables, environment);
  const restoreMismatches = compareCounts(
    manifest.source.tableCounts,
    restoredCounts
  );
  if (restoreMismatches.length > 0) {
    throw new Error(
      `restored row counts differ before migrations: ${JSON.stringify(restoreMismatches)}`
    );
  }
  await runProcess(executable("psql", environment), [
    "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1",
    "--single-transaction",
    ...connectionArguments(target),
    "--file", resolve(repositoryRoot, "migrations.sql"),
    "--command", POST_MIGRATION_RECONCILIATION_SQL,
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

function compareMinimumCounts(sourceCounts, targetCounts) {
  const losses = [];
  for (const [table, sourceCount] of Object.entries(sourceCounts)) {
    const targetCount = targetCounts[table];
    if (targetCount === undefined) {
      losses.push({ table, source: sourceCount, target: "missing" });
    } else if (BigInt(targetCount) < BigInt(sourceCount)) {
      losses.push({ table, source: sourceCount, target: targetCount });
    }
  }
  return losses;
}

function listMigrationAdditions(sourceCounts, targetCounts) {
  const additions = [];
  for (const [table, sourceCount] of Object.entries(sourceCounts)) {
    const targetCount = targetCounts[table];
    if (
      targetCount !== undefined &&
      BigInt(targetCount) > BigInt(sourceCount)
    ) {
      additions.push({
        table,
        source: sourceCount,
        target: targetCount,
        added: String(BigInt(targetCount) - BigInt(sourceCount)),
      });
    }
  }
  return additions;
}

function assertManifestSourceIdentity(manifest, source, sourceMajor) {
  if (manifest.source.serverMajor !== sourceMajor) {
    throw new Error(
      `dump source PostgreSQL ${manifest.source.serverMajor} does not match live source PostgreSQL ${sourceMajor}`
    );
  }
  if (manifest.source.database !== source.database) {
    throw new Error(
      `dump database ${manifest.source.database} does not match live source database ${source.database}`
    );
  }
}

async function assertLiveSourceMatchesManifest(
  manifest,
  source,
  sourceMajor,
  environment
) {
  assertManifestSourceIdentity(manifest, source, sourceMajor);
  const sourceApplication = await inspectSourceApplication(source, environment);
  if (manifest.source.applicationProfile !== sourceApplication.profile.id) {
    throw new Error(
      `dump application profile ${manifest.source.applicationProfile} does not match live source ${sourceApplication.profile.id}`
    );
  }
  if (manifest.source.schemaFingerprint !== sourceApplication.schemaFingerprint) {
    throw new Error("the source application schema changed after the dump");
  }
  const sourceTables = await listPublicTables(source, environment);
  const dumpedTables = Object.keys(manifest.source.tableCounts).sort();
  const currentSourceTables = [...sourceTables].sort();
  if (JSON.stringify(dumpedTables) !== JSON.stringify(currentSourceTables)) {
    throw new Error("the source public-table inventory changed after the dump");
  }
  const sourceCounts = await countTables(source, sourceTables, environment);
  const manifestMismatches = compareCounts(
    manifest.source.tableCounts,
    sourceCounts
  );
  if (manifestMismatches.length > 0) {
    throw new Error(
      `source changed after the dump: ${JSON.stringify(manifestMismatches)}`
    );
  }
  return { sourceApplication, sourceTables, sourceCounts };
}

async function validateMigration(environment) {
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const target = readEndpoint(environment, "ALPR_MIGRATION_TARGET");
  assertDistinctEndpoints(source, target);
  await toolVersions(environment);
  const sourceMajor = await supportedSourceMajor(source, environment);
  await assertServerMajor(target, TARGET_SERVER_MAJOR, "target", environment);
  const dumpPath = resolveArtifactPath(environment);
  const { manifest } = await readVerifiedManifest(dumpPath);
  const { sourceApplication, sourceTables, sourceCounts } = await assertLiveSourceMatchesManifest(
    manifest,
    source,
    sourceMajor,
    environment
  );
  const targetTables = await listPublicTables(target, environment);
  const targetCounts = await countTables(target, targetTables, environment);
  const targetApplication = await inspectSourceApplication(target, environment);
  if (targetApplication.profile.id !== SOURCE_PROFILES.COMMUNITY.id) {
    throw new Error(
      `migrated target is not a supported Community schema: ${targetApplication.profile.id}`
    );
  }
  const targetLosses = compareMinimumCounts(sourceCounts, targetCounts);
  if (targetLosses.length > 0) {
    throw new Error(
      `migrated target lost source rows: ${JSON.stringify(targetLosses)}`
    );
  }
  const occurrenceCountMismatches = await countOccurrenceCountMismatches(
    target,
    environment
  );
  if (occurrenceCountMismatches > 0) {
    throw new Error(
      `migrated target has ${occurrenceCountMismatches} plate occurrence-count mismatch(es)`
    );
  }
  const migrationAddedRows = listMigrationAdditions(sourceCounts, targetCounts);
  console.log(JSON.stringify({
    ok: true,
    sourceMajor,
    sourceApplicationProfile: sourceApplication.profile.id,
    targetMajor: TARGET_SERVER_MAJOR,
    targetApplicationProfile: targetApplication.profile.id,
    plateOccurrenceCounts: "reconciled",
    comparedTables: sourceTables.length,
    targetOnlyTables: targetTables.filter((table) => !sourceTables.includes(table)),
    migrationAddedRows,
  }, null, 2));
}

async function rollbackCheck(environment) {
  const source = readEndpoint(environment, "ALPR_MIGRATION_SOURCE");
  const dumpPath = resolveArtifactPath(environment);
  await toolVersions(environment);
  const sourceMajor = await supportedSourceMajor(source, environment);
  const { manifest } = await readVerifiedManifest(dumpPath);
  await assertLiveSourceMatchesManifest(
    manifest,
    source,
    sourceMajor,
    environment
  );
  console.log(
    `Rollback prerequisites verified: the PostgreSQL ${sourceMajor} source is reachable and the logical dump is intact.`
  );
  console.log(
    `Stop the PostgreSQL ${TARGET_SERVER_MAJOR} target, then restart the retained PostgreSQL ${sourceMajor} source with its matching application release.`
  );
  console.log("This tool intentionally does not switch volumes or delete either database.");
}

function printHelp() {
  console.log(`Usage: node scripts/postgres-major-migration.mjs <command>

Commands:
  preflight       Verify PostgreSQL 17 clients, a supported source, and an empty PostgreSQL 17 target.
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
Supported source PostgreSQL majors: ${SUPPORTED_SOURCE_MAJORS.join(", ")}.
Supported legacy application baseline: Original ALPR Database v0.1.9 (${LEGACY_BASELINE_COMMIT}).
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
  SOURCE_PROFILES,
  SUPPORTED_SOURCE_MAJORS,
  TARGET_SERVER_MAJOR,
  LEGACY_BASELINE_COMMIT,
  COMMUNITY_BASELINE_MIGRATION,
  POST_MIGRATION_RECONCILIATION_SQL,
  assertSupportedSourceMajor,
  assertDistinctEndpoints,
  assertManifestSourceIdentity,
  classifySourceApplication,
  compareCounts,
  compareMinimumCounts,
  connectionArguments,
  endpointIdentity,
  fingerprintSourceSchema,
  missingLegacyV019Requirements,
  parseClientMajor,
  parseServerMajor,
  pathIsInside,
  listMigrationAdditions,
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
