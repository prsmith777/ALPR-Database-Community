#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import {
  access,
  chmod,
  chown,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const FORMAT_VERSION = 1;
const CANONICAL_REPOSITORY = "github.com/prsmith777/ALPR-Database-Community";
const INSTALL_ACKNOWLEDGEMENT = "ALPR_UPDATE_APPROVED";
const ACCEPT_ACKNOWLEDGEMENT = "ALPR_UPDATE_ACCEPTED";
const ROLLBACK_ACKNOWLEDGEMENT = "ALPR_UPDATE_ROLLBACK";
const CLEANUP_ACKNOWLEDGEMENT = "ALPR_UPDATE_CLEANUP";
const DEFAULT_RETENTION_DAYS = 14;
const MINIMUM_BACKUP_HEADROOM_BYTES = 512 * 1024 * 1024;
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function value(environment, name) {
  return String(environment[name] ?? "").trim();
}

function timestamp(clock = () => new Date()) {
  const observed = clock();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(date.getTime())) throw new Error("updater clock returned an invalid date");
  return date.toISOString();
}

function parseVersionTag(tag) {
  const match = String(tag ?? "").trim().match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  return {
    tag: `v${match[1]}.${match[2]}.${match[3]}`,
    version: `${match[1]}.${match[2]}.${match[3]}`,
    parts: match.slice(1).map(Number),
  };
}

function compareVersionTags(left, right) {
  const a = parseVersionTag(left);
  const b = parseVersionTag(right);
  if (!a || !b) throw new Error("only stable vMAJOR.MINOR.PATCH tags can be compared");
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  return 0;
}

function normalizeRepositoryUrl(url) {
  const text = String(url ?? "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const ssh = text.match(/^git@([^:]+):(.+)$/i);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2]}`;
  try {
    const parsed = new URL(text);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
  } catch {
    return null;
  }
}

function pathIsInside(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function resolveBackupRoot(environment, root = repositoryRoot) {
  const configured = value(environment, "ALPR_UPDATER_BACKUP_DIR");
  const candidate = configured || resolve(root, "..", "ALPR-Database-Community-backups");
  if (!isAbsolute(candidate)) {
    throw new Error("ALPR_UPDATER_BACKUP_DIR must be an absolute path outside the repository");
  }
  const resolved = canonicalPath(candidate);
  if (dirname(resolved) === resolved) {
    throw new Error("ALPR_UPDATER_BACKUP_DIR cannot be a filesystem root");
  }
  if (pathIsInside(root, resolved)) {
    throw new Error("ALPR_UPDATER_BACKUP_DIR must be outside the repository");
  }
  return resolved;
}

function canonicalPath(candidate) {
  const missing = [];
  let existing = resolve(candidate);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function statePathFor(backupRoot) {
  return join(backupRoot, "updater-state.json");
}

function assertSafeChild(parent, candidate, label) {
  const relation = relative(resolve(parent), resolve(candidate));
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${label} is not a safe child of the updater backup directory`);
  }
  return resolve(candidate);
}

function upsertEnvironment(source, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = String(source).split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) return line;
    const replacement = `${match[1]}=${remaining.get(match[1])}`;
    remaining.delete(match[1]);
    return replacement;
  });
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (remaining.size > 0) {
    lines.push("", "# Managed by the ALPR Community host updater.");
    for (const [name, replacement] of remaining) lines.push(`${name}=${replacement}`);
  }
  return `${lines.join("\n")}\n`;
}

function shellQuoteForDisplay(valueToQuote) {
  const text = String(valueToQuote);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", `'\\''`)}'`;
}

function defaultRunner(command, args = [], options = {}) {
  const display = [command, ...args].map(shellQuoteForDisplay).join(" ");
  if (!options.quiet) console.log(`> ${display}`);
  let inputHandle;
  let outputHandle;
  try {
    if (options.stdinPath) inputHandle = spawnFileHandle(options.stdinPath, "r");
    if (options.stdoutPath) outputHandle = spawnFileHandle(options.stdoutPath, "w", 0o600);
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.environment || process.env,
      encoding: options.stdoutPath ? undefined : "utf8",
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      stdio: [
        inputHandle?.fd ?? "ignore",
        outputHandle?.fd ?? (options.inherit ? "inherit" : "pipe"),
        options.inherit ? "inherit" : "pipe",
      ],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8")
        : String(result.stderr || "");
      throw new Error(`${display} failed (${result.status})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    if (options.stdoutPath || options.inherit) return "";
    return String(result.stdout || "").trim();
  } finally {
    inputHandle?.close();
    outputHandle?.close();
  }
}

function spawnFileHandle(path, flags, mode) {
  const fd = openSync(path, flags, mode);
  return { fd, close: () => closeSync(fd) };
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

async function writePrivateJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readState(backupRoot) {
  const path = statePathFor(backupRoot);
  if (!(await exists(path))) return null;
  const state = JSON.parse(await readFile(path, "utf8"));
  if (state?.formatVersion !== FORMAT_VERSION || typeof state.status !== "string") {
    throw new Error("updater state is invalid or from an unsupported format");
  }
  return state;
}

async function saveState(backupRoot, state, clock) {
  state.updatedAt = timestamp(clock);
  await writePrivateJson(statePathFor(backupRoot), state);
  return state;
}

async function sha256File(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function secureTree(path) {
  if (!(await exists(path))) return;
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error(`refusing a symbolic link in private backup material: ${path}`);
  if (details.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await secureTree(join(path, entry));
  } else {
    await chmod(path, 0o600);
  }
}

async function restoreOwnership(path, ownership) {
  if (!ownership || process.platform === "win32") return;
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error(`refusing a symbolic link while restoring ownership: ${path}`);
  if (details.isDirectory()) {
    await chown(path, ownership.uid, ownership.gid);
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await restoreOwnership(join(path, entry), ownership);
  } else {
    await chown(path, ownership.uid, ownership.gid);
    await chmod(path, 0o600);
  }
}

async function storageInventory(path) {
  if (!(await exists(path))) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(child)).size;
      }
    }
  }
  return { files, bytes };
}

function compose(runner, root, args, options = {}) {
  return runner("docker", ["compose", ...args], { cwd: root, ...options });
}

function git(runner, root, args, options = {}) {
  return runner("git", args, { cwd: root, ...options });
}

function quoteIdentifier(identifier) {
  if (!SAFE_TABLE_NAME.test(identifier)) {
    throw new Error(`database contains an unexpected public table name: ${identifier}`);
  }
  return `"${identifier}"`;
}

function psql(runner, root, sql) {
  return compose(runner, root, [
    "exec", "-T", "db", "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--tuples-only", "--no-align", "--username", "postgres", "--dbname", "postgres",
    "--command", sql,
  ], { quiet: true });
}

function databaseTableCounts(runner, root) {
  const tableOutput = psql(
    runner,
    root,
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
  );
  const tables = tableOutput.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  return Object.fromEntries(tables.map((table) => {
    const count = psql(runner, root, `SELECT count(*) FROM public.${quoteIdentifier(table)};`);
    if (!/^\d+$/.test(count)) throw new Error(`invalid row count returned for ${table}`);
    return [table, Number(count)];
  }));
}

function databaseSize(runner, root) {
  const result = psql(runner, root, "SELECT pg_database_size(current_database());");
  if (!/^\d+$/.test(result)) throw new Error("could not determine PostgreSQL database size");
  return Number(result);
}

function exactCurrentRelease(runner, root) {
  const dirty = git(runner, root, ["status", "--porcelain", "--untracked-files=no"], { quiet: true });
  if (dirty) throw new Error("the installation has tracked local changes; update from a clean release checkout");
  const tag = git(runner, root, ["describe", "--tags", "--exact-match", "--match", "v[0-9]*"], { quiet: true });
  const parsed = parseVersionTag(tag);
  if (!parsed) throw new Error("the installation is not checked out at an exact stable vMAJOR.MINOR.PATCH tag");
  const commit = git(runner, root, ["rev-parse", "HEAD"], { quiet: true }).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not resolve the installed release commit");
  const installedPackage = JSON.parse(git(runner, root, ["show", "HEAD:package.json"], { quiet: true }));
  if (installedPackage.version !== parsed.version) {
    throw new Error(`${tag} contains package version ${installedPackage.version}; expected ${parsed.version}`);
  }
  return { ...parsed, commit };
}

function verifyCanonicalOrigin(runner, root) {
  const origin = git(runner, root, ["remote", "get-url", "origin"], { quiet: true });
  if (normalizeRepositoryUrl(origin) !== CANONICAL_REPOSITORY) {
    throw new Error(`origin must identify ${CANONICAL_REPOSITORY}; found ${origin || "nothing"}`);
  }
  return origin;
}

function fetchReleases(runner, root) {
  verifyCanonicalOrigin(runner, root);
  git(runner, root, ["fetch", "--prune", "--prune-tags", "--tags", "origin"], { inherit: true });
  const output = git(runner, root, ["tag", "--list", "v*", "--merged", "origin/main"], { quiet: true });
  return output.split(/\r?\n/).map((tag) => tag.trim()).filter((tag) => parseVersionTag(tag));
}

function selectTargetRelease(currentTag, tags, requestedTag) {
  const candidates = [...new Set(tags)].filter((tag) => compareVersionTags(tag, currentTag) > 0);
  candidates.sort(compareVersionTags);
  if (requestedTag) {
    if (!parseVersionTag(requestedTag)) throw new Error("target must be an exact stable vMAJOR.MINOR.PATCH tag");
    if (!tags.includes(requestedTag)) throw new Error(`target release ${requestedTag} was not fetched from origin/main`);
    if (compareVersionTags(requestedTag, currentTag) <= 0) {
      throw new Error(`target release ${requestedTag} is not newer than ${currentTag}`);
    }
    return requestedTag;
  }
  return candidates.at(-1) || null;
}

function inspectRelease(runner, root, tag) {
  const parsed = parseVersionTag(tag);
  if (!parsed) throw new Error(`invalid release tag: ${tag}`);
  const commit = git(runner, root, ["rev-list", "-n", "1", `${tag}^{commit}`], { quiet: true }).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`could not resolve ${tag} to a commit`);
  git(runner, root, ["merge-base", "--is-ancestor", commit, "origin/main"], { quiet: true });
  const packageSource = git(runner, root, ["show", `${commit}:package.json`], { quiet: true });
  const packageVersion = JSON.parse(packageSource).version;
  if (packageVersion !== parsed.version) {
    throw new Error(`${tag} contains package version ${packageVersion}; expected ${parsed.version}`);
  }
  return {
    ...parsed,
    commit,
    image: `alpr-community:${parsed.version}-${commit.slice(0, 12)}`,
  };
}

function installedImageFromEnvironment(source) {
  const match = String(source).match(/^ALPR_APP_IMAGE=(.+)$/m);
  return match?.[1]?.trim() || "alpr-dashboard:local";
}

function installedShaFromEnvironment(source) {
  const match = String(source).match(/^ALPR_RELEASE_SHA=([0-9a-fA-F]{40})$/m);
  return match?.[1]?.toLowerCase() || null;
}

async function preflight(environment, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  if ((options.platform || process.platform) !== "linux") {
    throw new Error("this updater release supports standard Linux Docker Compose hosts and Linux virtual machines only");
  }
  for (const required of ["docker-compose.yml", "Dockerfile", "migrations.sql", ".env"]) {
    if (!(await exists(join(root, required)))) throw new Error(`required installation file is missing: ${required}`);
  }
  if (await exists(join(root, "docker-compose.override.yml"))) {
    throw new Error("docker-compose.override.yml is not supported by the guarded updater");
  }
  const current = exactCurrentRelease(runner, root);
  verifyCanonicalOrigin(runner, root);
  runner("docker", ["version"], { quiet: true });
  runner("docker", ["compose", "version"], { quiet: true });
  compose(runner, root, ["config", "--quiet"], { quiet: true });
  const services = compose(runner, root, ["config", "--services"], { quiet: true })
    .split(/\r?\n/).filter(Boolean);
  for (const service of ["app", "db", "migrate"]) {
    if (!services.includes(service)) throw new Error(`bundled Compose service is missing: ${service}`);
  }
  const dbContainer = compose(runner, root, ["ps", "-q", "db"], { quiet: true });
  const appContainer = compose(runner, root, ["ps", "-q", "app"], { quiet: true });
  if (!dbContainer || !appContainer) throw new Error("both bundled app and database containers must be running");
  compose(runner, root, ["exec", "-T", "db", "pg_isready", "-U", "postgres", "-d", "postgres"], { quiet: true });
  const envSource = await readFile(join(root, ".env"), "utf8");
  const configuredImage = installedImageFromEnvironment(envSource);
  const configuredSha = installedShaFromEnvironment(envSource);
  if (configuredSha && configuredSha !== current.commit) {
    throw new Error(`.env ALPR_RELEASE_SHA ${configuredSha} does not match checked-out commit ${current.commit}`);
  }
  const runningImage = runner("docker", ["inspect", "--format", "{{.Config.Image}}", appContainer], { quiet: true });
  if (runningImage !== configuredImage) {
    throw new Error(`running app image ${runningImage} does not match .env ALPR_APP_IMAGE ${configuredImage}`);
  }
  const imageRevision = runner("docker", [
    "image", "inspect", "--format",
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
    configuredImage,
  ], { quiet: true }).toLowerCase();
  if (imageRevision && imageRevision !== "<no value>" && imageRevision !== current.commit) {
    throw new Error(`running image revision ${imageRevision} does not match checked-out commit ${current.commit}`);
  }
  if (configuredImage.startsWith("alpr-community:") && (!imageRevision || imageRevision === "<no value>")) {
    throw new Error("commit-qualified ALPR images must contain the recorded source revision label");
  }
  const port = applicationPort(envSource);
  const health = await (options.healthCheck || defaultHealthCheck)(
    `http://127.0.0.1:${port}/api/health-check`,
    options.healthAttempts
  );
  return { root, current: { ...current, image: configuredImage }, dbContainer, appContainer, health };
}

async function checkForUpdates(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  const current = exactCurrentRelease(runner, root);
  const tags = fetchReleases(runner, root);
  const targetTag = selectTargetRelease(current.tag, tags, options.requestedTag);
  const target = targetTag ? inspectRelease(runner, root, targetTag) : null;
  const result = { current, target };
  (options.logger || console).log(
    target
      ? `Update available: ${current.tag} -> ${target.tag} (${target.commit})`
      : `No newer stable release is available; ${current.tag} is current.`
  );
  return result;
}

async function makeBackup(environment, context, target, options = {}) {
  const { root, current } = context;
  const runner = options.runner || defaultRunner;
  const clock = options.clock;
  const backupRoot = resolveBackupRoot(environment, root);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);

  const previousState = await readState(backupRoot);
  if (previousState && !["accepted", "rolled-back"].includes(previousState.status)) {
    throw new Error(`an update is already ${previousState.status}; use status, validate, accept, or rollback`);
  }

  const databaseBytes = databaseSize(runner, root);
  const fileSystem = await statfs(backupRoot, { bigint: true });
  const availableBytes = Number(fileSystem.bavail * fileSystem.bsize);
  const requiredBytes = databaseBytes + MINIMUM_BACKUP_HEADROOM_BYTES;
  if (availableBytes < requiredBytes) {
    throw new Error(`backup location has ${availableBytes} bytes free; at least ${requiredBytes} are required`);
  }

  const backupId = `${current.version}-to-${target.version}-${timestamp(clock).replaceAll(/[:.]/g, "-")}`;
  const directory = assertSafeChild(backupRoot, join(backupRoot, backupId), "backup directory");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const dumpPath = join(directory, "postgres.dump");
  const envPath = join(directory, "installation.env");
  const authPath = join(directory, "auth");
  const configPath = join(directory, "config");

  const state = {
    formatVersion: FORMAT_VERSION,
    status: "backing-up",
    createdAt: timestamp(clock),
    installationRoot: root,
    current,
    target,
    preUpdateHealth: { status: context.health?.status || "unknown" },
    backup: { directory, dumpPath, envPath, authPath, configPath },
    supersededRollback: previousState?.backup?.directory && !previousState.backup.cleanedAt
      ? previousState
      : null,
  };
  await saveState(backupRoot, state, clock);

  compose(runner, root, ["stop", "app"], { inherit: true });
  try {
    const counts = databaseTableCounts(runner, root);
    const storage = await storageInventory(join(root, "storage"));
    const ownership = {};
    await copyFile(join(root, ".env"), envPath);
    for (const [sourceName, destination] of [["auth", authPath], ["config", configPath]]) {
      const source = join(root, sourceName);
      if (await exists(source)) {
        const details = await lstat(source);
        if (details.isSymbolicLink() || !details.isDirectory()) {
          throw new Error(`${sourceName} must be a real runtime directory`);
        }
        ownership[sourceName] = { uid: details.uid, gid: details.gid };
        await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
      } else {
        ownership[sourceName] = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
        await mkdir(destination, { mode: 0o700 });
      }
    }
    await secureTree(directory);
    compose(runner, root, [
      "exec", "-T", "db", "pg_dump", "--format=custom", "--compress=9",
      "--no-owner", "--no-privileges", "--username", "postgres", "--dbname", "postgres",
    ], { stdoutPath: dumpPath });
    await chmod(dumpPath, 0o600);
    const dumpSha256 = await sha256File(dumpPath);
    state.backup = { ...state.backup, databaseBytes, counts, storage, ownership, dumpSha256 };
    state.status = "backed-up";
    await saveState(backupRoot, state, clock);
    return { state, backupRoot };
  } catch (error) {
    state.status = "backup-failed";
    state.lastFailure = { phase: "backup", code: "backup-failed", at: timestamp(clock) };
    await saveState(backupRoot, state, clock);
    compose(runner, root, ["up", "-d", "--no-deps", "app"], { inherit: true });
    throw error;
  }
}

async function recoverIncompleteBackup(environment, root, runner, logger = console) {
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  if (!state) return;
  if (!["backing-up", "backup-failed"].includes(state.status)) return;
  if (state.backup?.dumpSha256) {
    throw new Error("incomplete backup state unexpectedly contains a verified dump; inspect status before continuing");
  }
  if (state.backup?.directory) {
    const directory = assertSafeChild(backupRoot, state.backup.directory, "incomplete backup directory");
    await rm(directory, { recursive: true, force: true });
  }
  await unlink(statePathFor(backupRoot));
  compose(runner, root, ["up", "-d", "--no-deps", "app"], { inherit: true });
  logger.log("Removed an unverified incomplete backup and restored the existing application before retrying.");
}

async function waitForDatabase(runner, root, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      compose(runner, root, ["exec", "-T", "db", "pg_isready", "-U", "postgres", "-d", "postgres"], { quiet: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError?.message || "unknown error"}`);
}

async function applyRelease(environment, backupRoot, state, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  const clock = options.clock;
  state.status = "applying";
  delete state.lastFailure;
  await saveState(backupRoot, state, clock);
  try {
    git(runner, root, ["checkout", "--detach", state.target.tag], { inherit: true });
    const checkedOut = git(runner, root, ["rev-parse", "HEAD"], { quiet: true }).toLowerCase();
    if (checkedOut !== state.target.commit) throw new Error("target tag changed after release inspection");
    runner("docker", [
      "build", "--pull", "--tag", state.target.image,
      "--label", `org.opencontainers.image.version=${state.target.version}`,
      "--label", `org.opencontainers.image.revision=${state.target.commit}`,
      "--label", "org.opencontainers.image.source=https://github.com/prsmith777/ALPR-Database-Community",
      ".",
    ], { cwd: root, inherit: true });

    const envPath = join(root, ".env");
    const envSource = await readFile(envPath, "utf8");
    await writeFile(envPath, upsertEnvironment(envSource, {
      ALPR_APP_IMAGE: state.target.image,
      ALPR_RELEASE_SHA: state.target.commit,
      ALPR_RELEASE_CHANNEL: "stable",
    }), { mode: 0o600 });
    await chmod(envPath, 0o600);

    compose(runner, root, ["up", "-d", "db"], { inherit: true });
    await waitForDatabase(runner, root, options.databaseReadyAttempts);
    compose(runner, root, ["run", "--rm", "--no-deps", "migrate"], { inherit: true });
    compose(runner, root, ["up", "-d", "--no-deps", "app"], { inherit: true });
    state.status = "validating";
    await saveState(backupRoot, state, clock);
    return state;
  } catch (error) {
    state.status = "apply-failed";
    state.lastFailure = { phase: "apply", code: "apply-failed", at: timestamp(clock) };
    await saveState(backupRoot, state, clock);
    throw error;
  }
}

async function defaultHealthCheck(url, attempts = 60) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === "ok") return body;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`application health check failed: ${lastError?.message || "unknown error"}`);
}

function applicationPort(envSource) {
  const match = String(envSource).match(/^APP_PORT=(\d+)$/m);
  const port = Number(match?.[1] || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("APP_PORT is invalid");
  return port;
}

async function validateUpdate(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  const clock = options.clock;
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  if (!state) throw new Error("no updater state exists for this installation");
  if (!["validating", "validation-failed", "ready-for-acceptance"].includes(state.status)) {
    throw new Error(`cannot validate an update in state ${state.status}`);
  }
  try {
    await waitForDatabase(runner, root, options.databaseReadyAttempts);
    const appContainer = compose(runner, root, ["ps", "-q", "app"], { quiet: true });
    if (!appContainer) throw new Error("application container is not running");
    const runningImage = runner("docker", ["inspect", "--format", "{{.Config.Image}}", appContainer], { quiet: true });
    if (runningImage !== state.target.image) {
      throw new Error(`running image ${runningImage} is not expected target ${state.target.image}`);
    }
    const envSource = await readFile(join(root, ".env"), "utf8");
    const port = applicationPort(envSource);
    const health = await (options.healthCheck || defaultHealthCheck)(
      `http://127.0.0.1:${port}/api/health-check`,
      options.healthAttempts
    );
    const counts = databaseTableCounts(runner, root);
    const losses = Object.entries(state.backup.counts).filter(([table, before]) =>
      !(table in counts) || counts[table] < before
    );
    if (losses.length > 0) {
      throw new Error(`post-update row counts decreased: ${losses.map(([table]) => table).join(", ")}`);
    }
    const storage = await storageInventory(join(root, "storage"));
    if (storage.files < state.backup.storage.files || storage.bytes < state.backup.storage.bytes) {
      throw new Error("application storage inventory decreased during the update");
    }
    state.validation = {
      completedAt: timestamp(clock),
      health: { status: health?.status || "unknown" },
      counts,
      storage,
    };
    state.status = "ready-for-acceptance";
    delete state.lastFailure;
    await saveState(backupRoot, state, clock);
    (options.logger || console).log(
      `Update ${state.target.tag} passed automated validation. Verify sign-in, search, ingestion, and images, then run accept.`
    );
    return state;
  } catch (error) {
    state.status = "validation-failed";
    state.lastFailure = { phase: "validation", code: "validation-failed", at: timestamp(clock) };
    await saveState(backupRoot, state, clock);
    throw error;
  }
}

async function acceptUpdate(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  if (!state) throw new Error("no updater state exists for this installation");
  if (state.status !== "ready-for-acceptance") {
    throw new Error("automated validation must pass before update acceptance");
  }
  if (!options.confirmed && value(environment, "ALPR_UPDATE_ACCEPTANCE") !== ACCEPT_ACKNOWLEDGEMENT) {
    throw new Error(`acceptance requires ALPR_UPDATE_ACCEPTANCE=${ACCEPT_ACKNOWLEDGEMENT}`);
  }
  const acceptedAt = timestamp(options.clock);
  const retentionDays = Number(value(environment, "ALPR_UPDATER_RETENTION_DAYS") || DEFAULT_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
    throw new Error("ALPR_UPDATER_RETENTION_DAYS must be an integer from 1 through 90");
  }
  state.status = "accepted";
  state.acceptance = {
    acceptedAt,
    cleanupEligibleAt: new Date(Date.parse(acceptedAt) + retentionDays * 86400000).toISOString(),
    manualChecksConfirmed: true,
  };
  await saveState(backupRoot, state, options.clock);
  if (state.supersededRollback) {
    try {
      await removeOwnedArtifacts(
        state.supersededRollback,
        backupRoot,
        options.runner || defaultRunner,
        root,
        { clock: options.clock, superseded: true }
      );
      state.supersededRollback = null;
      delete state.retentionWarning;
    } catch {
      state.retentionWarning = {
        code: "superseded-cleanup-pending",
        at: timestamp(options.clock),
      };
    }
  }
  await saveState(backupRoot, state, options.clock);
  (options.logger || console).log(
    `Accepted ${state.target.tag}. One rollback generation is retained until ${state.acceptance.cleanupEligibleAt}.`
  );
  return state;
}

async function restorePrivateDirectory(source, destination, ownership) {
  const parent = dirname(destination);
  const temporary = await mkdtemp(join(parent, `.${basename(destination)}-restore-`));
  try {
    await rm(temporary, { recursive: true, force: true });
    await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
    const displaced = `${destination}.pre-rollback-${randomUUID()}`;
    if (await exists(destination)) await rename(destination, displaced);
    try {
      await rename(temporary, destination);
      await restoreOwnership(destination, ownership);
      await rm(displaced, { recursive: true, force: true });
    } catch (error) {
      if (await exists(displaced)) {
        await rm(destination, { recursive: true, force: true });
        await rename(displaced, destination);
      }
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function rollbackUpdate(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  const clock = options.clock;
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  if (!state) throw new Error("no updater state exists for this installation");
  if (![
    "applying",
    "apply-failed",
    "validation-failed",
    "validating",
    "ready-for-acceptance",
    "accepted",
    "rolling-back",
    "rollback-failed",
  ].includes(state.status)) {
    throw new Error(`cannot roll back an update in state ${state.status}`);
  }
  if (!options.confirmed && value(environment, "ALPR_UPDATE_ROLLBACK") !== ROLLBACK_ACKNOWLEDGEMENT) {
    throw new Error(`rollback requires ALPR_UPDATE_ROLLBACK=${ROLLBACK_ACKNOWLEDGEMENT}`);
  }
  if (await sha256File(state.backup.dumpPath) !== state.backup.dumpSha256) {
    throw new Error("rollback database dump checksum no longer matches its recorded digest");
  }
  state.status = "rolling-back";
  await saveState(backupRoot, state, clock);
  try {
    compose(runner, root, ["stop", "app"], { inherit: true });
    git(runner, root, ["checkout", "--detach", state.current.tag], { inherit: true });
    const currentCommit = git(runner, root, ["rev-parse", "HEAD"], { quiet: true }).toLowerCase();
    if (currentCommit !== state.current.commit) throw new Error("previous release tag no longer matches the recorded commit");
    await copyFile(state.backup.envPath, join(root, ".env"));
    await chmod(join(root, ".env"), 0o600);
    await restorePrivateDirectory(
      state.backup.authPath,
      join(root, "auth"),
      state.backup.ownership?.auth
    );
    await restorePrivateDirectory(
      state.backup.configPath,
      join(root, "config"),
      state.backup.ownership?.config
    );
    compose(runner, root, ["up", "-d", "db"], { inherit: true });
    await waitForDatabase(runner, root, options.databaseReadyAttempts);
    compose(runner, root, [
      "exec", "-T", "db", "pg_restore", "--clean", "--if-exists", "--single-transaction",
      "--exit-on-error", "--no-owner", "--no-privileges", "--username", "postgres",
      "--dbname", "postgres",
    ], { stdinPath: state.backup.dumpPath, inherit: true });
    compose(runner, root, ["run", "--rm", "--no-deps", "migrate"], { inherit: true });
    const counts = databaseTableCounts(runner, root);
    const mismatch = Object.entries(state.backup.counts).filter(([table, before]) => counts[table] !== before);
    if (mismatch.length > 0) throw new Error(`rollback row counts do not match: ${mismatch.map(([table]) => table).join(", ")}`);
    compose(runner, root, ["up", "-d", "--no-deps", "app"], { inherit: true });
    await waitForDatabase(runner, root, options.databaseReadyAttempts);
    const port = applicationPort(await readFile(join(root, ".env"), "utf8"));
    await (options.healthCheck || defaultHealthCheck)(
      `http://127.0.0.1:${port}/api/health-check`,
      options.healthAttempts
    );
    state.status = "rolled-back";
    state.rollback = { completedAt: timestamp(clock), restoredTag: state.current.tag };
    delete state.lastFailure;
    await saveState(backupRoot, state, clock);
    (options.logger || console).log(`Rollback to ${state.current.tag} completed and passed validation.`);
    return state;
  } catch (error) {
    state.status = "rollback-failed";
    state.lastFailure = { phase: "rollback", code: "rollback-failed", at: timestamp(clock) };
    await saveState(backupRoot, state, clock);
    throw error;
  }
}

async function removeOwnedArtifacts(state, backupRoot, runner, root, options = {}) {
  if (!state.backup?.directory) return state;
  const directory = assertSafeChild(backupRoot, state.backup.directory, "recorded backup directory");
  const image = state.status === "rolled-back" ? state.target?.image : state.current?.image;
  if ((image && image !== state.target?.image) || (state.status === "rolled-back" && image)) {
    try {
      runner("docker", ["image", "rm", image], { cwd: root, quiet: true });
    } catch {
      state.backup.imageRetained = image;
    }
  }
  await rm(directory, { recursive: true, force: false });
  state.backup.cleanedAt = timestamp(options.clock);
  state.backup.cleanupReason = options.superseded ? "superseded-by-next-update" : "operator-cleanup";
  return state;
}

async function cleanupUpdate(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  if (!state) throw new Error("no updater state exists for this installation");
  if (!["accepted", "rolled-back"].includes(state.status)) {
    throw new Error(`cleanup is unavailable while update state is ${state.status}`);
  }
  if (state.backup?.cleanedAt) {
    (options.logger || console).log("The recorded rollback generation is already cleaned up.");
    return state;
  }
  if (!options.confirmed && value(environment, "ALPR_UPDATE_CLEANUP") !== CLEANUP_ACKNOWLEDGEMENT) {
    throw new Error(`cleanup requires ALPR_UPDATE_CLEANUP=${CLEANUP_ACKNOWLEDGEMENT}`);
  }
  if (state.supersededRollback) {
    await removeOwnedArtifacts(
      state.supersededRollback,
      backupRoot,
      runner,
      root,
      { clock: options.clock, superseded: true }
    );
    state.supersededRollback = null;
    delete state.retentionWarning;
    await saveState(backupRoot, state, options.clock);
  }
  if (
    state.status === "accepted" &&
    !options.force &&
    Date.now() < Date.parse(state.acceptance?.cleanupEligibleAt || "")
  ) {
    throw new Error(`rollback retention remains active until ${state.acceptance.cleanupEligibleAt}`);
  }
  await removeOwnedArtifacts(state, backupRoot, runner, root, { clock: options.clock });
  await saveState(backupRoot, state, options.clock);
  (options.logger || console).log("Removed only the recorded database/configuration backup and superseded ALPR image.");
  return state;
}

async function installUpdate(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const runner = options.runner || defaultRunner;
  if (!options.confirmed && value(environment, "ALPR_UPDATE_ACKNOWLEDGE") !== INSTALL_ACKNOWLEDGEMENT) {
    throw new Error(`installation requires ALPR_UPDATE_ACKNOWLEDGE=${INSTALL_ACKNOWLEDGEMENT}`);
  }
  await recoverIncompleteBackup(environment, root, runner, options.logger || console);
  const existingState = await readState(resolveBackupRoot(environment, root));
  if (existingState && !["accepted", "rolled-back"].includes(existingState.status)) {
    throw new Error(`an update is already ${existingState.status}; use status, validate, accept, or rollback`);
  }
  const context = await preflight(environment, { ...options, root, runner });
  const tags = fetchReleases(runner, root);
  const targetTag = selectTargetRelease(context.current.tag, tags, options.requestedTag);
  if (!targetTag) throw new Error(`${context.current.tag} is already the newest stable release`);
  const target = inspectRelease(runner, root, targetTag);
  const { state, backupRoot } = await makeBackup(environment, context, target, { ...options, runner });
  await applyRelease(environment, backupRoot, state, { ...options, root, runner });
  return validateUpdate(environment, { ...options, root, runner });
}

async function showStatus(environment = process.env, options = {}) {
  const root = options.root || repositoryRoot;
  const backupRoot = resolveBackupRoot(environment, root);
  const state = await readState(backupRoot);
  const display = state
    ? { statePath: statePathFor(backupRoot), ...state }
    : { statePath: statePathFor(backupRoot), status: "no-update-recorded" };
  (options.logger || console).log(JSON.stringify(display, null, 2));
  return state;
}

function parseArguments(argumentsList) {
  const args = [...argumentsList];
  const command = args.shift() || "menu";
  let requestedTag;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--to") requestedTag = args[++index];
    else if (arg === "--force") force = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (requestedTag !== undefined && !requestedTag) throw new Error("--to requires an exact release tag");
  if (requestedTag && !["check", "update"].includes(command)) {
    throw new Error("--to is available only with check or update");
  }
  if (force && command !== "cleanup") throw new Error("--force is available only with cleanup");
  return { command, requestedTag, force };
}

async function runMenu(environment, options = {}) {
  const terminal = createInterface({ input: options.input || process.stdin, output: options.output || process.stdout });
  try {
    while (true) {
      console.log(`\nALPR Community Maintenance\n\n1. Check for updates\n2. Install available update\n3. Validate installation\n4. Accept update\n5. Roll back previous update\n6. Remove expired rollback files\n7. Show updater status\n8. Exit`);
      const selection = (await terminal.question("\nChoose an option: ")).trim();
      if (selection === "8") return;
      try {
        if (selection === "1") await checkForUpdates(environment, options);
        else if (selection === "2") {
          const result = await checkForUpdates(environment, options);
          if (!result.target) continue;
          const confirmed = (await terminal.question(
            `Install ${result.target.tag}? This stops ALPR, creates one rollback backup, builds the exact release, migrates, restarts, and validates. [y/N] `
          )).trim().toLowerCase();
          if (!["y", "yes"].includes(confirmed)) continue;
          await installUpdate(environment, { ...options, requestedTag: result.target.tag, confirmed: true });
        } else if (selection === "3") await validateUpdate(environment, options);
        else if (selection === "4") {
          const confirmed = (await terminal.question("Confirm manual sign-in, search, ingestion, image, and restart checks passed. Accept update? [y/N] ")).trim().toLowerCase();
          if (["y", "yes"].includes(confirmed)) await acceptUpdate(environment, { ...options, confirmed: true });
        } else if (selection === "5") {
          const confirmed = (await terminal.question("Rollback restores the pre-update database and discards post-update writes. Continue? [y/N] ")).trim().toLowerCase();
          if (["y", "yes"].includes(confirmed)) await rollbackUpdate(environment, { ...options, confirmed: true });
        } else if (selection === "6") {
          const confirmed = (await terminal.question("Remove the recorded rollback backup and superseded ALPR image? [y/N] ")).trim().toLowerCase();
          if (["y", "yes"].includes(confirmed)) await cleanupUpdate(environment, { ...options, confirmed: true });
        } else if (selection === "7") await showStatus(environment, options);
        else console.log("Choose a number from 1 through 8.");
      } catch (error) {
        console.error(`Operation stopped safely: ${error.message}`);
      }
    }
  } finally {
    terminal.close();
  }
}

function printHelp(logger = console) {
  logger.log(`Usage: ./alpr-community [command] [options]\n\nCommands:\n  menu                 Open the guided maintenance menu (default).\n  check [--to TAG]     Fetch and inspect stable release tags without changing services.\n  update [--to TAG]    Back up, install, migrate, restart, and validate an exact release.\n  validate             Repeat automated post-update validation.\n  accept               Accept after the documented manual checks.\n  rollback             Restore the pre-update database, configuration, release, and image.\n  cleanup [--force]    Remove only state-owned rollback artifacts after retention.\n  status               Show redacted updater state and artifact paths.\n\nStandard Linux Docker Compose installations, including Linux virtual machines\nand Unraid, are supported in this release. The update path refuses dirty or\nuntagged checkouts, unknown remotes, external databases, Compose overrides,\nmoving image tags, and missing backups.\n\nNon-interactive safety acknowledgements:\n  ALPR_UPDATE_ACKNOWLEDGE=${INSTALL_ACKNOWLEDGEMENT}\n  ALPR_UPDATE_ACCEPTANCE=${ACCEPT_ACKNOWLEDGEMENT}\n  ALPR_UPDATE_ROLLBACK=${ROLLBACK_ACKNOWLEDGEMENT}\n  ALPR_UPDATE_CLEANUP=${CLEANUP_ACKNOWLEDGEMENT}\n\nOptional configuration:\n  ALPR_UPDATER_BACKUP_DIR=/absolute/path/outside/the/repository\n  ALPR_UPDATER_RETENTION_DAYS=${DEFAULT_RETENTION_DAYS}`);
}

export async function runUpdaterCommand(argumentsList = process.argv.slice(2), environment = process.env, options = {}) {
  const { command, requestedTag, force } = parseArguments(argumentsList);
  const commandOptions = { ...options, requestedTag, force };
  switch (command) {
    case "menu": return runMenu(environment, commandOptions);
    case "check": return checkForUpdates(environment, commandOptions);
    case "update": return installUpdate(environment, commandOptions);
    case "validate": return validateUpdate(environment, commandOptions);
    case "accept": return acceptUpdate(environment, commandOptions);
    case "rollback": return rollbackUpdate(environment, commandOptions);
    case "cleanup": return cleanupUpdate(environment, commandOptions);
    case "status": return showStatus(environment, commandOptions);
    case "help":
    case "--help":
    case "-h": return printHelp(options.logger);
    default: throw new Error(`unknown updater command: ${command}`);
  }
}

export const communityUpdaterInternals = Object.freeze({
  ACCEPT_ACKNOWLEDGEMENT,
  CANONICAL_REPOSITORY,
  CLEANUP_ACKNOWLEDGEMENT,
  DEFAULT_RETENTION_DAYS,
  FORMAT_VERSION,
  INSTALL_ACKNOWLEDGEMENT,
  ROLLBACK_ACKNOWLEDGEMENT,
  applicationPort,
  assertSafeChild,
  compareVersionTags,
  exactCurrentRelease,
  installedImageFromEnvironment,
  installedShaFromEnvironment,
  normalizeRepositoryUrl,
  parseArguments,
  parseVersionTag,
  pathIsInside,
  readState,
  resolveBackupRoot,
  selectTargetRelease,
  statePathFor,
  storageInventory,
  upsertEnvironment,
  writePrivateJson,
});

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runUpdaterCommand().catch((error) => {
    console.error(`Community update stopped safely: ${error.message}`);
    process.exitCode = 1;
  });
}
