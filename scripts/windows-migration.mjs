import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { atomicJson, fileInventory, loadWindowsDeployment } from "./windows-deployment.mjs";
import { createMigrationBundle, verifyMigrationBundle } from "./community-migration-bundle.mjs";
import { postgresMajorMigrationInternals as pg, runPostgresMigrationCommand } from "./postgres-major-migration.mjs";
import { captureNativeUpgradeSnapshot, compareSavedNativeUpgradeCounts, nativeIdentityInstalled } from "./native-reid-upgrade-policy.mjs";
import { safePackagePath } from "./windows-native-package.mjs";

export function normalizeMigratedStorageReference(value) {
  const normalized = String(value).replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) throw new Error("Migrated image references cannot contain traversal segments.");
  const relative = normalized.replace(/^(?:.*\/)?storage\//, "").replace(/^\/+/, "");
  if (!/^(images|thumbnails|derived)\//.test(relative)) throw new Error("A migrated image reference is not a portable ALPR storage path.");
  safePackagePath(path.resolve("."), relative);
  return relative;
}
function requireFor(deployment) { return createRequire(path.join(deployment.currentPath, "app", "package.json")); }
function sourceEnvironment(deployment) {
  const installation = deployment.installation;
  const port = installation.environment.DB_HOST.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Migration requires the installer-owned local database.");
  return { ...process.env, ALPR_PG_BIN_DIR: installation.pgBin,
    ALPR_MIGRATION_SOURCE_HOST: "127.0.0.1", ALPR_MIGRATION_SOURCE_PORT: port,
    ALPR_MIGRATION_SOURCE_DATABASE: "postgres", ALPR_MIGRATION_SOURCE_USER: "postgres",
    ALPR_MIGRATION_SOURCE_PASSWORD: installation.environment.DB_PASSWORD,
    ALPR_MIGRATION_SOURCE_SSLMODE: "disable", ALPR_MIGRATION_SOURCE_QUIESCED: pg.SOURCE_QUIESCED_ACKNOWLEDGEMENT };
}
export async function exportWindowsMigration({ installationFile, destination }, options = {}) {
  const deployment = options.deployment || await loadWindowsDeployment(installationFile, { allowPreview: true });
  const scratch = path.join(deployment.data, "management", "migration-export-" + randomUUID());
  const lockPath = path.join(deployment.backupRoot, "maintenance.lock");
  const { open } = await import("node:fs/promises");
  await mkdir(deployment.backupRoot, { recursive: true });
  const lock = await open(lockPath, "wx");
  let stopped = false;
  try {
    // The installation's protected management directory owns every scratch file.
    await mkdir(scratch);
    const updateState = await readFile(path.join(deployment.backupRoot, "updater-state.json"), "utf8")
      .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (updateState && !["accepted", "rolled-back"].includes(updateState.status)) throw new Error("Complete or recover the pending ALPR update before exporting a migration backup.");
    const running = await deployment.attest();
    if (!running.listenerOwned || running.commit !== deployment.current.commit || running.status !== "Running") throw new Error("The source ALPR service is not the expected running installation.");
    stopped = true;
    deployment.service("stop");
    const before = await deployment.counts();
    const env = { ...sourceEnvironment(deployment), ALPR_MIGRATION_DUMP_PATH: path.join(scratch, "postgres.dump") };
    await runPostgresMigrationCommand("dump", env);
    const config = path.join(deployment.data, "config", "settings.yaml");
    const auth = path.join(deployment.data, "auth", "auth.json");
    const exists = async (file) => readFile(file).then(() => true).catch((error) => { if (error.code === "ENOENT") return false; throw error; });
    const result = await createMigrationBundle({ dumpPath: env.ALPR_MIGRATION_DUMP_PATH,
      storagePath: path.join(deployment.data, "storage"), destination, sourceQuiesced: true,
      configEnvironment: deployment.installation.environment,
      configPath: await exists(config) ? config : undefined, authPath: await exists(auth) ? auth : undefined });
    if (JSON.stringify(before) !== JSON.stringify(await deployment.counts())) {
      await rm(path.join(destination, "migration-backup.json"));
      throw new Error("The source database changed while exporting. Keep ALPR ingestion paused and create a new backup.");
    }
    return result;
  } finally {
    try { if (stopped) deployment.service("start"); }
    finally {
      await lock.close(); await rm(lockPath, { force: true });
      // scratch was generated inside this installation's management directory.
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export async function restoreWindowsMigration({ bundleRoot, installationFile }, options = {}) {
  if (!options.confirmed && process.env.ALPR_WINDOWS_MIGRATION !== "ALPR_EMPTY_WINDOWS_TARGET") throw new Error("Migration requires an explicitly selected empty Windows target.");
  const bundle = await verifyMigrationBundle(bundleRoot);
  const deployment = options.deployment || await loadWindowsDeployment(installationFile, { allowPreview: true });
  const sql = (statement) => deployment.sql(statement);
  if (sql(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','f','S');`) !== "0") throw new Error("Migration refuses an existing database. Use a fresh installation or keep the current data.");
  for (const folder of ["storage", "auth", "config"]) {
    if (Object.keys(await fileInventory(path.join(deployment.data, folder))).length) throw new Error("Migration refuses existing image, authentication, or settings files.");
  }
  const stateFile = path.join(deployment.data, "management", "migration-state.json");
  const state = { formatVersion: 1, status: "restoring", phase: "database-restore", sourceProfile: bundle.source,
    startedAt: new Date().toISOString(), release: deployment.current.commit };
  await atomicJson(stateFile, state);
  try {
    deployment.run(path.join(deployment.installation.pgBin, "pg_restore.exe"), ["--list", path.join(bundleRoot, "postgres.dump")]);
    deployment.pg("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", path.join(bundleRoot, "postgres.dump")]);
    state.phase = "source-validation";
    const restored = await deployment.counts();
    if (Object.keys(restored).length !== Object.keys(bundle.database.source.tableCounts).length
        || pg.compareCounts(bundle.database.source.tableCounts, restored).length) throw new Error("Restored database row counts do not match the backup.");
    const env = sourceEnvironment(deployment);
    const endpoint = pg.readEndpoint(env, "ALPR_MIGRATION_SOURCE");
    const source = await pg.inspectSourceApplication(endpoint, env);
    if (source.schemaFingerprint !== bundle.database.source.schemaFingerprint
        || source.profile.id !== bundle.database.source.applicationProfile) throw new Error("Restored database schema does not match the verified source.");
    const retirement = await captureNativeUpgradeSnapshot(sql, restored);
    state.phase = "schema-migration";
    deployment.migrate(deployment.currentPath);
    deployment.pg("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--single-transaction", "--command", pg.POST_MIGRATION_RECONCILIATION_SQL]);
    const after = await deployment.counts();
    const policy = compareSavedNativeUpgradeCounts(restored, after, retirement, await nativeIdentityInstalled(sql, after));
    if (policy.losses.length) throw new Error("Migration validation found database row loss. The source and backup are preserved.");
    // Keep the session audit rows while invalidating tokens from the old host.
    sql("UPDATE public.user_sessions SET revoked_at=CURRENT_TIMESTAMP, revoke_reason='computer migration' WHERE revoked_at IS NULL;");
    state.phase = "image-verification";
    const expected = Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name.startsWith("storage/")).map(([name, hash]) => [name.slice(8), hash]));
    for (const name of Object.keys(expected)) {
      const target = path.join(deployment.data, "storage", ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(bundleRoot, "storage", ...name.split("/")), target, { errorOnExist: true, force: false });
    }
    const stored = await fileInventory(path.join(deployment.data, "storage"));
    if (JSON.stringify(Object.entries(stored).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error("Copied image files failed checksum verification.");
    // Current files are relative; normalize legacy slash formats only for read
    // display paths. All destinations must exist in the verified storage copy.
    let lastId = 0;
    while (true) {
      const rows = JSON.parse(sql(`SELECT COALESCE(json_agg(r),'[]') FROM (SELECT id, image_path, thumbnail_path, vehicle_image_path
        FROM public.plate_reads WHERE id > ${lastId} ORDER BY id LIMIT 1000) r;`));
      if (!rows.length) break;
      for (const row of rows) {
        lastId = Number(row.id);
        if (!Number.isSafeInteger(lastId)) throw new Error("Invalid migrated plate read identity.");
        for (const column of ["image_path", "thumbnail_path", "vehicle_image_path"]) {
          if (!row[column]) continue;
          const relative = normalizeMigratedStorageReference(row[column]);
          if (!Object.hasOwn(stored, relative)) throw new Error("A referenced plate image is missing from the migration backup. The source and backup have been preserved.");
          if (relative !== row[column]) sql(`UPDATE public.plate_reads SET ${column} = '${relative.replaceAll("'", "''")}' WHERE id = ${lastId};`);
        }
      }
    }
    const require = requireFor(deployment);
    state.phase = "settings-restore";
    if (bundle.files["config/settings.yaml"]) {
      const yaml = require("js-yaml");
      const config = yaml.load(await readFile(path.join(bundleRoot, "config", "settings.yaml"), "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid migrated settings file.");
      delete config.database; // The target owns new database credentials.
      await writeFile(path.join(deployment.data, "config", "settings.yaml"), yaml.dump(config), { flag: "wx" });
    }
    if (bundle.files["auth/auth.json"]) {
      const auth = JSON.parse(await readFile(path.join(bundleRoot, "auth", "auth.json"), "utf8"));
      if (!auth || typeof auth !== "object" || !/^[a-f0-9]{64}$/i.test(auth.apiKey || "")) throw new Error("Invalid migrated authentication file.");
      // Retain the integration key, invalidate old browser sessions, and apply
      // the setup password the user explicitly chose for this new computer.
      auth.password = await require("bcrypt").hash(deployment.installation.environment.ADMIN_PASSWORD, 10);
      auth.sessions = {};
      await writeFile(path.join(deployment.data, "auth", "auth.json"), JSON.stringify(auth, null, 2) + "\n", { flag: "wx" });
    }
    if (bundle.runtimeTimeZone) {
      deployment.installation.environment.TZ = bundle.runtimeTimeZone;
      if (installationFile) await atomicJson(installationFile, deployment.installation);
    }
    state.status = "validated";
    state.phase = "complete";
    state.completedAt = new Date().toISOString();
    state.tableCounts = after;
    state.imagesVerified = Object.keys(stored).length;
    state.retiredDerivedRows = policy.retiredDerivedRows;
    await atomicJson(stateFile, state);
    return state;
  } catch (error) {
    state.status = "failed-preserved";
    await atomicJson(stateFile, state);
    throw new Error("Migration stopped during " + state.phase + " before ALPR was started. The source, backup, and target data are preserved. Contact the maintainer with the Setup log.", { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, folder, ...extra] = process.argv.slice(2);
  const task = !extra.length && folder && command === "restore"
    ? restoreWindowsMigration({ bundleRoot: path.resolve(folder), installationFile: process.env.ALPR_WINDOWS_INSTALLATION })
    : !extra.length && folder && command === "export"
      ? exportWindowsMigration({ destination: path.resolve(folder), installationFile: process.env.ALPR_WINDOWS_INSTALLATION })
      : Promise.reject(new Error("Choose a migration operation and backup folder."));
  task.then(() => console.log("ALPR_SETUP_PROGRESS:Database and image migration checks passed."))
    .catch((error) => { console.error("ALPR_SETUP_ERROR:" + error.message); process.exitCode = 1; });
}
