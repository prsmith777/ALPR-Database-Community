import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fileInventory, assertRealDirectory } from "./windows-deployment.mjs";
import { safePackagePath } from "./windows-native-package.mjs";
import { postgresMajorMigrationInternals as pg } from "./postgres-major-migration.mjs";

const FORMAT = "alpr-community-migration";
const MANIFEST = "migration-backup.json";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const BLUE_IRIS_ENV = Object.freeze({ BLUEIRIS_HOST: "host", BLUEIRIS_USERNAME: "username", BLUEIRIS_PASSWORD: "password",
  BLUEIRIS_TIMEOUT_SECONDS: "timeout_seconds", BLUEIRIS_TIMELINE_EXPORT_PROFILE: "timeline_export_profile",
  BLUEIRIS_TIMELINE_EXPORT_MIN_WIDTH: "timeline_export_min_width", BLUEIRIS_TIMELINE_EXPORT_MIN_HEIGHT: "timeline_export_min_height" });
function runtimeTimeZone(env) {
  if (!env.TZ) return undefined;
  const value = String(env.TZ).trim();
  new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  return value;
}
function separate(a, b) {
  if (pg.pathIsInside(a, b) || pg.pathIsInside(b, a)) throw new Error("Backup and source directories must be separate and non-nested.");
}
function validateInventory(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Missing backup file inventory.");
  const folded = new Set();
  for (const [name, hash] of Object.entries(files)) {
    safePackagePath(path.resolve("."), name);
    if (!/^[a-f0-9]{64}$/.test(hash) || folded.has(name.toLowerCase())) throw new Error("Invalid backup checksum or case-colliding file name.");
    folded.add(name.toLowerCase());
    if (name !== "postgres.dump" && name !== "postgres.dump.manifest.json" && name !== "auth/auth.json"
        && name !== "config/settings.yaml" && !/^storage\/(images|thumbnails|derived)\//.test(name)) {
      throw new Error("Unexpected file in the ALPR migration backup.");
    }
  }
  for (const required of ["postgres.dump", "postgres.dump.manifest.json"]) {
    if (!files[required]) throw new Error("The backup is missing its database dump or verification manifest.");
  }
}
export async function verifyMigrationBundle(root) {
  root = path.resolve(root);
  await assertRealDirectory(root);
  const info = await lstat(path.join(root, MANIFEST));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid migration backup manifest.");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8"));
  if (manifest.format !== FORMAT || manifest.formatVersion !== 1 || manifest.sourceQuiesced !== true) throw new Error("Choose a completed ALPR migration backup folder.");
  runtimeTimeZone({ TZ: manifest.runtimeTimeZone });
  await assertRealDirectory(path.join(root, "storage"));
  validateInventory(manifest.files);
  const actual = await fileInventory(root);
  delete actual[MANIFEST];
  if (Object.keys(actual).length !== Object.keys(manifest.files).length
      || Object.entries(manifest.files).some(([name, hash]) => actual[name] !== hash)) {
    throw new Error("The migration backup is incomplete or has changed. Keep the original and make a new backup.");
  }
  const { manifest: database } = await pg.readVerifiedManifest(path.join(root, "postgres.dump"));
  // Row counts are evidence, not executable SQL identifiers.
  if (!database.source.tableCounts || Object.entries(database.source.tableCounts).some(([table, count]) =>
    !/^[a-z_][a-z0-9_]*$/.test(table) || !/^\d+$/.test(String(count)))) throw new Error("Invalid backup table-count evidence.");
  return { ...manifest, database };
}

export async function createMigrationBundle({ dumpPath, storagePath, configPath, authPath, destination, sourceQuiesced, configEnvironment = {} }) {
  if (sourceQuiesced !== true) throw new Error("Stop source ALPR and database writers before creating a migration backup.");
  destination = path.resolve(destination);
  separate(path.resolve(dumpPath), destination);
  for (const source of [storagePath, configPath, authPath].filter(Boolean)) separate(path.resolve(source), destination);
  const { manifest: database } = await pg.readVerifiedManifest(dumpPath);
  const timeZone = runtimeTimeZone(configEnvironment);
  if (!storagePath) throw new Error("Include the source storage folder so plate images are preserved.");
  await assertRealDirectory(storagePath);
  const original = await fileInventory(storagePath);
  validateInventory({ "postgres.dump": "0".repeat(64), "postgres.dump.manifest.json": "0".repeat(64),
    ...Object.fromEntries(Object.entries(original).map(([name, hash]) => ["storage/" + name, hash])) });
  // mkdir without recursive refuses an existing destination, even an empty one.
  await mkdir(destination, { mode: 0o700 });
  await cp(dumpPath, path.join(destination, "postgres.dump"), { errorOnExist: true, force: false });
  await cp(dumpPath + ".manifest.json", path.join(destination, "postgres.dump.manifest.json"), { errorOnExist: true, force: false });
  await cp(storagePath, path.join(destination, "storage"), { recursive: true, errorOnExist: true, force: false });
  for (const [source, name] of [[configPath, "config/settings.yaml"], [authPath, "auth/auth.json"]]) {
    if (!source) continue;
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Settings and authentication must be regular files.");
    await mkdir(path.dirname(path.join(destination, name)), { mode: 0o700 });
    await cp(source, path.join(destination, name), { errorOnExist: true, force: false });
  }
  // Blue Iris may be configured by environment, with its password deliberately
  // omitted from settings.yaml. Export the effective values into this private
  // bundle; do not transfer the Linux .env or its old database credentials.
  const blueIrisOverrides = Object.entries(BLUE_IRIS_ENV).filter(([key]) => configEnvironment[key]);
  if (configPath || blueIrisOverrides.length) {
    const yaml = require("js-yaml");
    const file = path.join(destination, "config", "settings.yaml");
    const config = configPath ? yaml.load(await readFile(file, "utf8")) : {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid source settings file.");
    if (blueIrisOverrides.length) config.blueiris = { ...config.blueiris };
    for (const [key, field] of blueIrisOverrides) {
      const value = configEnvironment[key];
      config.blueiris[field] = field.endsWith("seconds") || field.startsWith("timeline_") ? Number(value) : String(value);
      if (typeof config.blueiris[field] === "number" && !Number.isInteger(config.blueiris[field])) throw new Error("Invalid source Blue Iris runtime setting.");
    }
    delete config.database;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, yaml.dump(config), { mode: 0o600 });
  }
  const sourceAfter = await fileInventory(storagePath);
  const copied = await fileInventory(path.join(destination, "storage"));
  if (JSON.stringify(Object.entries(original).sort()) !== JSON.stringify(Object.entries(sourceAfter).sort())
      || JSON.stringify(Object.entries(original).sort()) !== JSON.stringify(Object.entries(copied).sort())) {
    throw new Error("Source image storage changed during backup or the copied images failed verification.");
  }
  const files = await fileInventory(destination);
  validateInventory(files);
  const manifest = { format: FORMAT, formatVersion: 1, createdAt: new Date().toISOString(),
    sourceQuiesced: true, source: database.source.applicationProfile, ...(timeZone ? { runtimeTimeZone: timeZone } : {}), files };
  await writeFile(path.join(destination, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await verifyMigrationBundle(destination);
  return manifest;
}

export async function stageMigrationBundle(source, destination) {
  separate(path.resolve(source), path.resolve(destination));
  const verified = await verifyMigrationBundle(source);
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  const copied = await verifyMigrationBundle(destination);
  if (JSON.stringify(copied.files) !== JSON.stringify(verified.files)) throw new Error("Staged migration backup does not match its source.");
  return copied;
}

export async function runMigrationBundleCommand(args = process.argv.slice(2), env = process.env) {
  const [command, ...flags] = args;
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    if (!["--dump", "--storage", "--config", "--auth", "--output", "--source"].includes(key) || !flags[index + 1] || options[key]) throw new Error("Invalid migration backup option.");
    options[key] = path.resolve(flags[index + 1]);
  }
  if (command === "verify" && options["--source"]) return verifyMigrationBundle(options["--source"]);
  if (command === "stage" && options["--source"] && options["--output"]) return stageMigrationBundle(options["--source"], options["--output"]);
  if (command !== "create" || !options["--dump"] || !options["--output"]) throw new Error("Use create --dump FILE --storage FOLDER --output NEW_FOLDER, or verify --source FOLDER.");
  return createMigrationBundle({ dumpPath: options["--dump"], storagePath: options["--storage"], configPath: options["--config"],
    authPath: options["--auth"], destination: options["--output"], configEnvironment: env,
    sourceQuiesced: env.ALPR_MIGRATION_SOURCE_QUIESCED === pg.SOURCE_QUIESCED_ACKNOWLEDGEMENT });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrationBundleCommand().then(() => console.log("ALPR_SETUP_PROGRESS:Migration backup verified."))
    .catch(() => { console.error("ALPR_SETUP_ERROR:Migration backup verification failed. Keep the original backup and inspect its files."); process.exitCode = 1; });
}
