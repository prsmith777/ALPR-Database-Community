import { mkdir, mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { docker, POSTGRES_CLIENT_IMAGE, DOCKER_POSTGRES_CONTEXT } from "./docker-migration-client.mjs";
import { postgresMajorMigrationInternals as pg, runPostgresMigrationCommand } from "./postgres-major-migration.mjs";
import { createMigrationBundle, verifyMigrationBundle } from "./community-migration-bundle.mjs";
import { fileInventory, assertRealDirectory } from "./windows-deployment.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
function envOf(record) {
  return Object.fromEntries((record.Config?.Env || []).map(value => { const at = value.indexOf("="); return [value.slice(0, at), value.slice(at + 1)]; }));
}
function summary(record) {
  return { id: record.Id, name: record.Name.replace(/^\//, ""), image: record.Config.Image,
    running: Boolean(record.State.Running), project: record.Config.Labels?.["com.docker.compose.project"] || "",
    service: record.Config.Labels?.["com.docker.compose.service"] || "" };
}
export function sourceCandidates(records) {
  return records.filter(record => /^[a-f0-9]{64}$/.test(record.Id) && record.Platform !== "windows").map(record => {
    const mounts = (record.Mounts || []).map(mount => mount.Destination);
    return { ...summary(record), application: mounts.includes("/app/storage") && mounts.includes("/app/config") && mounts.includes("/app/auth"),
      database: (record.Config.Env || []).some(value => value.startsWith("POSTGRES_DB=")) || /(?:^|\/)postgres(?::|@)/.test(record.Config.Image || "") };
  }).filter(record => record.application || record.database);
}
export function validateSourcePair(app, database, config = {}) {
  if (app.Id === database.Id || !database.State.Running) throw new Error("Choose a separate running Docker PostgreSQL database.");
  if (!sourceCandidates([app]).some(record => record.application) || !sourceCandidates([database]).some(record => record.database)) throw new Error("Select an ALPR Docker application and PostgreSQL container.");
  const a = envOf(app), d = envOf(database), settings = config.database || {};
  for (const [variable, field] of [["DB_HOST", "host"], ["DB_NAME", "name"], ["DB_USER", "user"], ["DB_PASSWORD", "password"]]) {
    if (a[variable] && settings[field] && a[variable] !== settings[field]) throw new Error("The source environment and saved database settings differ. Use the advanced migration procedure to identify the effective source; no application was stopped.");
  }
  const host = a.DB_HOST || settings.host || "db:5432";
  const [hostname, portText = "5432"] = host.split(":");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || d.PGPORT && Number(d.PGPORT) !== port) throw new Error("Unsupported Docker source database port.");
  const shared = Object.keys(app.NetworkSettings?.Networks || {}).filter(name => database.NetworkSettings?.Networks?.[name]);
  const names = [database.Name.replace(/^\//, ""), ...shared.flatMap(name => [database.NetworkSettings.Networks[name].IPAddress, ...(database.NetworkSettings.Networks[name].Aliases || [])])];
  if (!shared.length || !names.includes(hostname)) throw new Error("The selected database does not match the application's configured Docker database. No source was stopped.");
  const password = a.DB_PASSWORD || settings.password || d.POSTGRES_PASSWORD;
  const databaseName = a.DB_NAME || settings.name || d.POSTGRES_DB || "postgres";
  const user = a.DB_USER || settings.user || d.POSTGRES_USER || "postgres";
  if (![databaseName, user].every(value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(value))) throw new Error("Use the advanced procedure for nonstandard database names. Docker export does not accept connection strings or endpoint overrides.");
  if (!password) throw new Error("The source database credential is unavailable. Preserve the source and contact support.");
  return { ...process.env, [DOCKER_POSTGRES_CONTEXT]: true, ALPR_PG_BIN_DIR: "",
    ALPR_MIGRATION_DOCKER_SOURCE: database.Id, ALPR_MIGRATION_SOURCE_HOST: "127.0.0.1",
    ALPR_MIGRATION_SOURCE_PORT: String(port), ALPR_MIGRATION_SOURCE_DATABASE: databaseName,
    ALPR_MIGRATION_SOURCE_USER: user,
    ALPR_MIGRATION_SOURCE_PASSWORD: password, ALPR_MIGRATION_SOURCE_SSLMODE: "disable" };
}
async function inspect(id, run) {
  if (!/^[a-f0-9]{64}$/.test(id || "")) throw new Error("Choose the full source container identity from the list.");
  const records = JSON.parse((await run(["inspect", id])).stdout);
  if (records.length !== 1 || records[0].Id !== id) throw new Error("Docker source identity changed.");
  return records[0];
}
async function copyDirectory(run, id, source, target) {
  await mkdir(target);
  await run(["cp", id + ":" + source + "/.", target], { timeout: 30 * 60_000 });
  await fileInventory(target); // Refuse links, junctions and non-regular files.
}
async function configuration(run, app, scratch) {
  const target = path.join(scratch, "config");
  await copyDirectory(run, app.Id, "/app/config", target);
  try { return require("js-yaml").load(await readFile(path.join(target, "settings.yaml"), "utf8")) || {}; }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error("The source settings file cannot be read safely. Keep it private and contact support."); }
}
function plainConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid source settings.");
  return config;
}
async function sourceEvidence(env, application) {
  const endpoint = pg.readEndpoint(env, "ALPR_MIGRATION_SOURCE");
  const major = pg.parseServerMajor(await pg.query(endpoint, "SHOW server_version_num;", env));
  pg.assertSupportedSourceMajor(major);
  const source = await pg.inspectSourceApplication(endpoint, env);
  const counts = await pg.countTables(endpoint, await pg.listPublicTables(endpoint, env), env);
  return { sourceProfile: source.profile.id, sourceLabel: source.profile.label, serverMajor: major,
    schemaFingerprint: source.schemaFingerprint, tableCounts: counts, plateReads: counts.plate_reads || "0", application };
}
function dockerHostPath(value, platform) {
  if (typeof value !== "string" || !value) return null;
  let normalized = value.replaceAll("\\", "/");
  if (platform === "win32") {
    normalized = normalized.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt|mnt)\/([a-z])\//i, "$1:/")
      .replace(/^\/([a-z])\//i, "$1:/");
    return /^[a-z]:\//i.test(normalized) ? path.win32.resolve(normalized) : null;
  }
  return path.posix.isAbsolute(normalized) ? path.posix.resolve(normalized) : null;
}
export function assertDockerBackupSeparation(roots, candidates, platform = process.platform) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const inside = (parent, child) => {
    const relative = impl.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + impl.sep) && !impl.isAbsolute(relative));
  };
  for (const source of roots.map(value => dockerHostPath(value, platform)).filter(Boolean)) {
    for (const candidate of candidates) {
      const target = impl.resolve(candidate);
      if (inside(source, target) || inside(target, source)) throw new Error("Choose a backup folder outside the original Docker storage, settings and authentication folders. No source application was stopped.");
    }
  }
}
async function checkBackupLocation(app, candidates, run) {
  const roots = [];
  for (const mount of app.Mounts || []) {
    if (!["/app/storage", "/app/config", "/app/auth"].includes(mount.Destination)) continue;
    if (mount.Source) roots.push(mount.Source);
    if (mount.Type === "volume" && mount.Name) {
      const records = JSON.parse((await run(["volume", "inspect", mount.Name])).stdout);
      const device = records[0]?.Options?.device;
      if (!device) continue;
      const absolute = dockerHostPath(device, process.platform);
      if (absolute) roots.push(absolute);
      else if (!device.startsWith(":") && !device.startsWith("//")) {
        const working = dockerHostPath(app.Config.Labels?.["com.docker.compose.project.working_dir"], process.platform);
        if (working) roots.push((process.platform === "win32" ? path.win32 : path.posix).resolve(working, device));
      }
    }
  }
  assertDockerBackupSeparation(roots, candidates);
}

async function prepare({ appId, databaseId, scratch, destination }, run) {
  const app = await inspect(appId, run), database = await inspect(databaseId, run);
  await checkBackupLocation(app, [scratch, ...(destination ? [destination] : [])], run);
  const config = plainConfig(await configuration(run, app, scratch));
  const env = { ...validateSourcePair(app, database, config), ALPR_MIGRATION_DOCKER_SCRATCH: scratch };
  await run(["image", "inspect", POSTGRES_CLIENT_IMAGE]).catch(() => run(["pull", POSTGRES_CLIENT_IMAGE], { timeout: 10 * 60_000 }));
  return { app, database, env, evidence: await sourceEvidence(env, summary(app)) };
}
export async function listDockerSources(options = {}) {
  const run = options.docker || docker;
  const info = JSON.parse((await run(["info", "--format", "{{json .}}"])).stdout);
  if (info.OSType !== "linux") throw new Error("Switch Docker Desktop to Linux containers. No source was changed.");
  const ids = (await run(["ps", "--all", "--quiet", "--no-trunc"])).stdout.trim().split(/\s+/).filter(Boolean);
  const records = [];
  for (const id of ids) records.push(await inspect(id, run));
  return { engine: info.Name, containers: sourceCandidates(records) };
}
export async function previewDockerExport({ appId, databaseId, workParent }, options = {}) {
  await assertRealDirectory(workParent);
  const scratch = await mkdtemp(path.join(workParent, "alpr-docker-preview-"));
  try {
    const result = await prepare({ appId, databaseId, scratch }, options.docker || docker);
    return { ...result.evidence, database: summary(result.database), confirmation: appId + ":" + databaseId };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function exportDockerMigration({ appId, databaseId, destination, confirmation, expected, writersPaused }, options = {}) {
  if (writersPaused !== true || confirmation !== appId + ":" + databaseId || !expected?.sourceProfile || !expected?.tableCounts) throw new Error("Review the source counts and confirm other database writers are paused before exporting.");
  destination = path.resolve(destination);
  const parent = path.dirname(destination);
  await assertRealDirectory(parent);
  if (await lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Choose a new backup folder; existing backups are never overwritten.");
  const lockPath = destination + ".export-lock";
  await mkdir(lockPath);
  const scratch = await mkdtemp(path.join(parent, "alpr-docker-export-"));
  const run = options.docker || docker;
  let selected, restart = false;
  try {
    const result = await prepare({ appId, databaseId, scratch, destination }, run);
    selected = result.app;
    if (result.evidence.sourceProfile !== expected.sourceProfile || result.evidence.schemaFingerprint !== expected.schemaFingerprint) throw new Error("The source schema changed after review. Review it again.");
    // Full IDs prevent a renamed/replaced container from being stopped by name.
    if (selected.State.Running) {
      restart = true;
      await run(["stop", "--time", "60", selected.Id]);
    }
    const stopped = await inspect(appId, run);
    if (stopped.State.Running) throw new Error("The selected source application did not stop.");
    const env = { ...result.env, ALPR_MIGRATION_SOURCE_QUIESCED: pg.SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      ALPR_MIGRATION_DUMP_PATH: path.join(scratch, "postgres.dump") };
    await runPostgresMigrationCommand("dump", env);
    const before = await sourceEvidence(env, summary(stopped));
    if (BigInt(before.plateReads) < BigInt(expected.plateReads)) throw new Error("The source has fewer plate records than the reviewed source. Preserve it and review again.");
    const storage = path.join(scratch, "storage"), auth = path.join(scratch, "auth");
    await copyDirectory(run, appId, "/app/storage", storage);
    await copyDirectory(run, appId, "/app/auth", auth);
    const configCopy = path.join(scratch, "config-stopped");
    await copyDirectory(run, appId, "/app/config", configCopy);
    const optional = async file => readFile(file).then(() => file, error => { if (error.code === "ENOENT") return undefined; throw error; });
    const sameInventory = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const manifest = await createMigrationBundle({ dumpPath: env.ALPR_MIGRATION_DUMP_PATH, storagePath: storage,
      configPath: await optional(path.join(configCopy, "settings.yaml")), authPath: await optional(path.join(auth, "auth.json")),
      destination, sourceQuiesced: true, configEnvironment: envOf(stopped), beforeSeal: async () => {
        for (const [name, first] of [["storage", storage], ["config", configCopy], ["auth", auth]]) {
          const second = path.join(scratch, name + "-check");
          await copyDirectory(run, appId, "/app/" + name, second);
          if (!sameInventory(await fileInventory(first), await fileInventory(second))) throw new Error("Source files changed during export. Stop every writer and retry.");
        }
        const current = await inspect(appId, run);
        const after = await sourceEvidence(env, summary(current));
        if (current.State.Running || !sameInventory(before.tableCounts, after.tableCounts) || before.schemaFingerprint !== after.schemaFingerprint) throw new Error("The source changed during export. Stop every writer and retry.");
        const verified = await pg.readVerifiedManifest(env.ALPR_MIGRATION_DUMP_PATH);
        if (!sameInventory(verified.manifest.source.tableCounts, after.tableCounts)) throw new Error("The dump does not match the stopped source.");
      } });
    await verifyMigrationBundle(destination);
    return { destination, sourceProfile: manifest.source, plateReads: before.plateReads, filesVerified: Object.keys(manifest.files).length,
      application: summary(stopped), database: summary(result.database) };
  } finally {
    try {
      if (restart) {
        try {
          await run(["start", selected.Id]);
          if (!(await inspect(selected.Id, run)).State.Running) throw new Error("not running");
        } catch {
          throw new Error("The backup operation ended, but the original Docker application " + summary(selected).name + " did not restart. Start that selected container in Docker; its data is preserved.");
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}
async function main() {
  const [command, requestFile, resultFile] = process.argv.slice(2);
  const request = command === "list" ? {} : JSON.parse(await readFile(requestFile, "utf8"));
  const result = command === "list" ? await listDockerSources()
    : command === "preview" ? await previewDockerExport(request)
    : command === "export" ? await exportDockerMigration(request) : null;
  if (!result) throw new Error("Use list, preview or export with private request and result files.");
  await writeFile(resultFile || requestFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error("Docker migration export: " + error.message); process.exitCode = 1; });
}
