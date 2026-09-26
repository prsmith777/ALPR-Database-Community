#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { buildRuntimeImage } from "./community-image-builder.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const CANONICAL_REPOSITORY = "github.com/prsmith777/ALPR-Database-Community";
const INSTALL_ACKNOWLEDGEMENT = "ALPR_FRESH_INSTALL";
const RECOVERY_ACKNOWLEDGEMENT = "ALPR_RECOVER_FAILED_INSTALL";
const FORMAT_VERSION = 1;
const MINIMUM_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const STATE_FILENAME = ".alpr-community-install-state.json";
const RUNTIME_DIRECTORIES = Object.freeze(["auth", "config", "storage", "update-control"]);
const REQUIRED_FILES = Object.freeze([
  ".env.example",
  "Dockerfile",
  "docker-compose.yml",
  "migrations.sql",
  "package.json",
  "schema.sql",
]);

function value(environment, name) {
  return String(environment[name] ?? "").trim();
}

function timestamp(clock = () => new Date()) {
  const observed = clock();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(date.getTime())) throw new Error("installer clock returned an invalid date");
  return date.toISOString();
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

function parseVersionTag(tag) {
  const match = String(tag ?? "").trim().match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  return { tag: `v${match[1]}.${match[2]}.${match[3]}`, version: `${match[1]}.${match[2]}.${match[3]}` };
}

function normalizeProjectName(name) {
  const normalized = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 63);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error("Compose project name must contain only lowercase letters, digits, hyphens, or underscores");
  }
  return normalized;
}

function validatePort(input, label) {
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return port;
}

function validateTimeZone(input) {
  const timeZone = String(input || "UTC").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

function validateAdministratorPassword(input) {
  const password = String(input ?? "");
  if (password.length < 12 || password.length > 128) {
    throw new Error("administrator password must contain 12 through 128 characters");
  }
  if (password !== password.trim()) {
    throw new Error("administrator password cannot begin or end with whitespace");
  }
  if (/['\\\r\n\0]/.test(password)) {
    throw new Error("administrator password cannot contain quotes, backslashes, line breaks, or NUL characters");
  }
  return password;
}

function quoteDotenv(input) {
  const text = String(input);
  if (/['\\\r\n\0]/.test(text)) throw new Error("value cannot be represented safely in the private environment file");
  return `'${text}'`;
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
    lines.push("", "# Managed by the ALPR Community fresh installer.");
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
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.environment || process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`${display} failed (${result.status})${stderr ? `: ${stderr}` : ""}`);
  }
  return options.inherit ? "" : String(result.stdout || "").trim();
}

function git(runner, root, args, options = {}) {
  return runner("git", args, { cwd: root, ...options });
}

function compose(runner, root, envPath, projectName, args, options = {}) {
  return runner("docker", ["compose", "--env-file", envPath, "-p", projectName, ...args], {
    cwd: root,
    ...options,
  });
}

function verifyRuntimeImage(runner, root, image) {
  return runner(process.execPath, [join(root, "scripts", "verify-runtime-image.mjs"), image], {
    cwd: root,
    inherit: true,
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
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

function statePath(root) {
  return join(root, STATE_FILENAME);
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function writePrivateJson(path, data) {
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

async function readState(root) {
  try {
    return JSON.parse(await readFile(statePath(root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("installer state is not valid JSON");
    throw error;
  }
}

async function saveState(root, state, clock) {
  state.updatedAt = timestamp(clock);
  await writePrivateJson(statePath(root), state);
}

function exactRelease(runner, root, override) {
  if (override) {
    const parsed = parseVersionTag(override.tag);
    if (!parsed || parsed.version !== override.version || !/^[0-9a-f]{40}$/.test(override.commit)) {
      throw new Error("test release override is invalid");
    }
    return { ...parsed, commit: override.commit.toLowerCase() };
  }
  const dirty = git(runner, root, ["status", "--porcelain", "--untracked-files=normal"], { quiet: true });
  if (dirty) throw new Error("installation requires a clean release checkout without local changes or untracked files");
  const tag = git(runner, root, ["describe", "--tags", "--exact-match", "--match", "v[0-9]*"], { quiet: true });
  const parsed = parseVersionTag(tag);
  if (!parsed) throw new Error("installation requires an exact stable vMAJOR.MINOR.PATCH tag");
  const commit = git(runner, root, ["rev-parse", "HEAD"], { quiet: true }).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not resolve the release commit");
  const packageSource = git(runner, root, ["show", "HEAD:package.json"], { quiet: true });
  if (JSON.parse(packageSource).version !== parsed.version) {
    throw new Error(`${tag} does not contain matching package version ${parsed.version}`);
  }
  const origin = git(runner, root, ["remote", "get-url", "origin"], { quiet: true });
  if (normalizeRepositoryUrl(origin) !== CANONICAL_REPOSITORY) {
    throw new Error(`origin must identify ${CANONICAL_REPOSITORY}; found ${origin || "nothing"}`);
  }
  git(runner, root, [
    "fetch", "--no-tags", "origin",
    "refs/heads/main:refs/remotes/origin/main",
    `refs/tags/${parsed.tag}:refs/tags/${parsed.tag}`,
  ], { inherit: true });
  const remoteTagCommit = git(runner, root, ["rev-list", "-n", "1", `${parsed.tag}^{commit}`], { quiet: true }).toLowerCase();
  if (remoteTagCommit !== commit) throw new Error(`${parsed.tag} does not resolve to the checked-out commit after origin verification`);
  git(runner, root, ["merge-base", "--is-ancestor", commit, "origin/main"], { quiet: true });
  return { ...parsed, commit };
}

function imageForRelease(release) {
  return `alpr-community:${release.version}-${release.commit.slice(0, 12)}`;
}

async function defaultFreeBytes(path) {
  const result = await statfs(path, { bigint: true });
  return Number(result.bavail * result.bsize);
}

async function defaultPortAvailable(port, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (["EADDRINUSE", "EACCES"].includes(error.code)) resolvePromise(false);
      else rejectPromise(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise(true));
    });
  });
}

async function promptText(question, defaultValue, input = process.stdin, output = process.stdout) {
  const terminal = createInterface({ input, output, terminal: true });
  try {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = (await terminal.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    terminal.close();
  }
}

async function promptHidden(question, input = process.stdin, output = process.stdout) {
  output.write(`${question}: `);
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminal = createInterface({ input, output: mutedOutput, terminal: true });
  try {
    const answer = await terminal.question("");
    output.write("\n");
    return answer;
  } finally {
    terminal.close();
  }
}

async function collectConfiguration(environment, root, options = {}) {
  const runtimeUid = Number(options.runtimeUid ?? process.getuid?.() ?? 1000);
  const runtimeGid = Number(options.runtimeGid ?? process.getgid?.() ?? 1000);
  if (!Number.isInteger(runtimeUid) || runtimeUid < 1 || !Number.isInteger(runtimeGid) || runtimeGid < 1) {
    throw new Error("the host runtime user and group identifiers must be positive integers");
  }
  if (options.configuration) {
    const configuration = options.configuration;
    return {
      administratorPassword: validateAdministratorPassword(configuration.administratorPassword),
      timeZone: validateTimeZone(configuration.timeZone),
      appPort: validatePort(configuration.appPort, "application port"),
      dbPort: validatePort(configuration.dbPort, "database port"),
      projectName: normalizeProjectName(configuration.projectName),
      runtimeUid,
      runtimeGid,
    };
  }

  const interactive = options.interactive ?? Boolean((options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY);
  let administratorPassword = environment.ALPR_INSTALL_ADMIN_PASSWORD;
  if (!administratorPassword && interactive) {
    administratorPassword = await promptHidden(
      "Choose an administrator password (12-128 characters)",
      options.input,
      options.output
    );
    const confirmation = await promptHidden("Confirm administrator password", options.input, options.output);
    if (administratorPassword !== confirmation) throw new Error("administrator password confirmation did not match");
  }
  if (!administratorPassword) {
    throw new Error("set ALPR_INSTALL_ADMIN_PASSWORD for a non-interactive installation");
  }

  const defaultProject = normalizeProjectName(basename(root));
  const defaultAppPort = String(options.defaultAppPort || "3000");
  const defaultDbPort = String(options.defaultDbPort || "5432");
  const timeZone = value(environment, "ALPR_INSTALL_TIMEZONE") || (interactive
    ? await promptText("IANA time zone", "UTC", options.input, options.output)
    : "UTC");
  const appPort = value(environment, "ALPR_INSTALL_APP_PORT") || (interactive
    ? await promptText("Application port", defaultAppPort, options.input, options.output)
    : defaultAppPort);
  const dbPort = value(environment, "ALPR_INSTALL_DB_PORT") || (interactive
    ? await promptText("Local PostgreSQL port", defaultDbPort, options.input, options.output)
    : defaultDbPort);
  return {
    administratorPassword: validateAdministratorPassword(administratorPassword),
    timeZone: validateTimeZone(timeZone),
    appPort: validatePort(appPort, "application port"),
    dbPort: validatePort(dbPort, "database port"),
    projectName: normalizeProjectName(value(environment, "ALPR_INSTALL_PROJECT_NAME") || defaultProject),
    runtimeUid,
    runtimeGid,
  };
}

async function confirmInstallation(environment, release, configuration, options = {}) {
  if (options.confirmed) return;
  const interactive = options.interactive ?? Boolean((options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY);
  if (!interactive) {
    if (value(environment, "ALPR_INSTALL_ACKNOWLEDGE") !== INSTALL_ACKNOWLEDGEMENT) {
      throw new Error(`non-interactive installation requires ALPR_INSTALL_ACKNOWLEDGE=${INSTALL_ACKNOWLEDGEMENT}`);
    }
    return;
  }
  const answer = await promptText(
    `Install empty ALPR Community ${release.tag} on port ${configuration.appPort}? Type yes to continue`,
    "no",
    options.input,
    options.output
  );
  if (answer.toLowerCase() !== "yes") throw new Error("installation cancelled");
}

async function preflight(environment = process.env, options = {}) {
  const root = canonicalPath(options.root || repositoryRoot);
  const runner = options.runner || defaultRunner;
  if ((options.platform || process.platform) !== "linux") {
    throw new Error("fresh installation currently supports Linux hosts and Linux virtual machines only");
  }
  if ((options.arch || process.arch) !== "x64") {
    throw new Error("fresh installation currently supports Linux x86-64 hosts only");
  }
  const nodeVersion = options.nodeVersion || process.versions.node;
  if (Number(nodeVersion.split(".")[0]) !== 24) throw new Error("Node.js 24 is required");
  for (const required of REQUIRED_FILES) {
    if (!(await exists(join(root, required)))) throw new Error(`required release file is missing: ${required}`);
  }
  if (await exists(join(root, "docker-compose.override.yml"))) {
    throw new Error("docker-compose.override.yml is not supported by the fresh installer");
  }
  if (await exists(statePath(root))) {
    const existingState = await readState(root);
    if (existingState?.status === "installed") throw new Error("this release directory is already installed");
    throw new Error("an interrupted installation exists; run ./alpr-community install --recover");
  }
  if (await exists(join(root, ".env"))) throw new Error(".env already exists; this is not a fresh installation directory");
  const release = exactRelease(runner, root, options.releaseIdentity);
  const image = imageForRelease(release);
  runner("git", ["--version"], { quiet: true });
  runner("docker", ["version"], { quiet: true });
  runner("docker", ["info"], { quiet: true });
  runner("docker", ["compose", "version"], { quiet: true });
  runner("docker", ["buildx", "version"], { quiet: true });

  const freeBytes = await (options.freeBytes || defaultFreeBytes)(root);
  if (!Number.isFinite(freeBytes) || freeBytes < MINIMUM_FREE_BYTES) {
    throw new Error(`at least ${Math.ceil(MINIMUM_FREE_BYTES / 1024 ** 3)} GiB of free disk space is required`);
  }
  return { root, runner, release, image, freeBytes };
}

async function assertFreshTarget(context, configuration, options = {}) {
  const { root, runner, image } = context;
  if (configuration.appPort === configuration.dbPort) {
    throw new Error("application and PostgreSQL ports must be different");
  }
  const portAvailable = options.portAvailable || defaultPortAvailable;
  if (!(await portAvailable(configuration.appPort, "0.0.0.0"))) {
    throw new Error(`application port ${configuration.appPort} is already in use or unavailable`);
  }
  if (!(await portAvailable(configuration.dbPort, "127.0.0.1"))) {
    throw new Error(`PostgreSQL port ${configuration.dbPort} is already in use or unavailable`);
  }
  for (const directory of RUNTIME_DIRECTORIES) {
    const path = join(root, directory);
    if (await exists(path)) throw new Error(`${directory}/ already exists; the fresh installer must create every runtime directory`);
  }
  const projectFilter = `label=com.docker.compose.project=${configuration.projectName}`;
  const containers = runner("docker", ["ps", "-a", "--filter", projectFilter, "--format", "{{.ID}}"], { quiet: true });
  if (containers) throw new Error(`Compose project ${configuration.projectName} already has containers`);
  const expectedResources = new Set([
    `${configuration.projectName}_db-data`,
    `${configuration.projectName}_app-auth`,
    `${configuration.projectName}_app-config`,
    `${configuration.projectName}_app-logs`,
    `${configuration.projectName}_app-plate_images`,
    `${configuration.projectName}_default`,
  ]);
  const volumes = runner("docker", ["volume", "ls", "--format", "{{.Name}}"], { quiet: true })
    .split(/\r?\n/).filter(Boolean);
  const networks = runner("docker", ["network", "ls", "--format", "{{.Name}}"], { quiet: true })
    .split(/\r?\n/).filter(Boolean);
  const collision = [...volumes, ...networks].find((name) => expectedResources.has(name));
  if (collision) throw new Error(`Docker resource ${collision} already exists; refusing to reuse it`);

  const imageId = runner("docker", ["image", "ls", "--quiet", image], { quiet: true });
  if (imageId) {
    const revision = runner("docker", [
      "image", "inspect", "--format", '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image,
    ], { quiet: true }).toLowerCase();
    if (revision !== context.release.commit) throw new Error(`existing image ${image} has the wrong source revision`);
  }
  return { imageAlreadyPresent: Boolean(imageId) };
}

async function writeEnvironment(context, configuration, databasePassword) {
  const template = await readFile(join(context.root, ".env.example"), "utf8");
  const source = upsertEnvironment(template, {
    ADMIN_PASSWORD: quoteDotenv(configuration.administratorPassword),
    DB_PASSWORD: quoteDotenv(databasePassword),
    TZ: configuration.timeZone,
    APP_PORT: configuration.appPort,
    DB_PORT: configuration.dbPort,
    COMPOSE_PROJECT_NAME: configuration.projectName,
    ALPR_APP_IMAGE: context.image,
    ALPR_RELEASE_SHA: context.release.commit,
    ALPR_RELEASE_CHANNEL: "stable",
    ALPR_UPDATE_HOST_GID: configuration.runtimeGid,
  });
  const path = join(context.root, ".env");
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return { path, digest: await sha256File(path) };
}

async function waitForDatabase(context, configuration, attempts = 60) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      compose(context.runner, context.root, join(context.root, ".env"), configuration.projectName, [
        "exec", "-T", "db", "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres",
      ], { quiet: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError?.message || "unknown error"}`);
}

async function defaultHealthCheck(url, attempts = 90) {
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

function freshDatabaseSignature(context, configuration) {
  const sql = `SELECT concat_ws('|',
    (SELECT count(*) FROM public.plates),
    (SELECT count(*) FROM public.plate_reads),
    (SELECT count(*) FROM public.known_plates),
    (SELECT count(*) FROM public.tags),
    (SELECT count(*) FROM public.plate_tags),
    (SELECT count(*) FROM public.plate_notifications),
    (SELECT count(*) FROM (VALUES
      (to_regclass('public.codex_staging_fixture_sets')),
      (to_regclass('public.codex_staging_fixture_manifest'))
    ) AS fixture_tables(table_name) WHERE table_name IS NOT NULL),
    (SELECT update1 FROM public.devmgmt WHERE id = 1)
  );`;
  return compose(context.runner, context.root, join(context.root, ".env"), configuration.projectName, [
    "exec", "-T", "db", "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--tuples-only", "--no-align", "--username", "postgres", "--dbname", "postgres", "--command", sql,
  ], { quiet: true });
}

async function removeFailedInstallation(environment, options = {}) {
  const root = canonicalPath(options.root || repositoryRoot);
  const runner = options.runner || defaultRunner;
  const logger = options.logger || console;
  const state = options.state || await readState(root);
  if (!state) throw new Error("no interrupted installation state exists");
  if (state.formatVersion !== FORMAT_VERSION || canonicalPath(state.root) !== root) {
    throw new Error("installer state does not identify this release directory");
  }
  if (state.status === "installed") throw new Error("recovery cleanup refuses a completed installation");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(state.projectName || "")) {
    throw new Error("installer state contains an invalid Compose project name");
  }
  if (!/^alpr-community:\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(state.image || "")) {
    throw new Error("installer state contains an invalid image name");
  }
  if (!options.automatic && !options.confirmed && value(environment, "ALPR_INSTALL_RECOVERY") !== RECOVERY_ACKNOWLEDGEMENT) {
    throw new Error(`recovery cleanup requires ALPR_INSTALL_RECOVERY=${RECOVERY_ACKNOWLEDGEMENT}`);
  }
  const envPath = join(root, ".env");
  const environmentExists = await exists(envPath);
  if (!environmentExists && state.environmentDigest) {
    throw new Error(".env is missing after installation began; recovery refuses to discard the remaining state");
  }
  if (environmentExists) {
    if (!state.environmentDigest || await sha256File(envPath) !== state.environmentDigest) {
      throw new Error(".env changed after installation began; recovery refuses to remove modified configuration");
    }
    compose(runner, root, envPath, state.projectName, ["down", "--volumes", "--remove-orphans"], { inherit: true });
  }
  if (state.createdImage) {
    const imageId = runner("docker", ["image", "ls", "--quiet", state.image], { quiet: true });
    if (imageId) runner("docker", ["image", "rm", state.image], { inherit: true });
  }
  for (const directory of state.createdDirectories || []) {
    if (!RUNTIME_DIRECTORIES.includes(directory)) throw new Error("installer state contains an unsafe runtime directory");
    const candidate = resolve(root, directory);
    if (relative(root, candidate) !== directory) throw new Error("installer state contains an unsafe runtime path");
    await rm(candidate, { recursive: true, force: true });
  }
  await unlink(envPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(statePath(root)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  logger.log("Removed only resources recorded for the interrupted fresh installation.");
}

async function installCommunity(environment = process.env, options = {}) {
  const logger = options.logger || console;
  const context = await preflight(environment, options);
  const configuration = await collectConfiguration(environment, context.root, options);
  await confirmInstallation(environment, context.release, configuration, options);
  const target = await assertFreshTarget(context, configuration, options);
  const databasePassword = randomBytes(32).toString("base64url");
  const state = {
    formatVersion: FORMAT_VERSION,
    status: "preparing",
    root: context.root,
    release: context.release,
    image: context.image,
    projectName: configuration.projectName,
    appPort: configuration.appPort,
    dbPort: configuration.dbPort,
    timeZone: configuration.timeZone,
    runtimeUid: configuration.runtimeUid,
    runtimeGid: configuration.runtimeGid,
    createdAt: timestamp(options.clock),
    createdDirectories: [],
    createdImage: false,
  };
  await saveState(context.root, state, options.clock);
  try {
    for (const directory of RUNTIME_DIRECTORIES) {
      const path = join(context.root, directory);
      const alreadyExisted = await exists(path);
      await mkdir(path, { recursive: false, mode: 0o750 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      await chmod(path, 0o750);
      if (!alreadyExisted) state.createdDirectories.push(directory);
    }
    const environmentFile = await writeEnvironment(context, configuration, databasePassword);
    state.environmentDigest = environmentFile.digest;
    state.status = "building";
    await saveState(context.root, state, options.clock);

    if (!target.imageAlreadyPresent) {
      buildRuntimeImage(context.runner, context.root, context.release, context.image);
      state.createdImage = true;
      await saveState(context.root, state, options.clock);
    }
    verifyRuntimeImage(context.runner, context.root, context.image);

    for (const directory of RUNTIME_DIRECTORIES) {
      const ownership = directory === "update-control"
        ? `${configuration.runtimeUid}:${configuration.runtimeGid}`
        : "1000:1000";
      context.runner("docker", [
        "run", "--rm", "--user", "0:0", "--entrypoint", "chown",
        "--volume", `${join(context.root, directory)}:/target`, context.image,
        "-R", ownership, "/target",
      ], { inherit: true });
      if (directory === "update-control") await chmod(join(context.root, directory), 0o2770);
    }

    const envPath = join(context.root, ".env");
    compose(context.runner, context.root, envPath, configuration.projectName, ["config", "--quiet"], { quiet: true });
    state.status = "starting";
    await saveState(context.root, state, options.clock);
    compose(context.runner, context.root, envPath, configuration.projectName, ["up", "-d", "db"], { inherit: true });
    await waitForDatabase(context, configuration, options.databaseReadyAttempts);
    compose(context.runner, context.root, envPath, configuration.projectName, [
      "run", "--rm", "--no-deps", "migrate",
    ], { inherit: true });
    compose(context.runner, context.root, envPath, configuration.projectName, [
      "up", "-d", "--no-deps", "app",
    ], { inherit: true });

    state.status = "validating";
    await saveState(context.root, state, options.clock);
    const health = await (options.healthCheck || defaultHealthCheck)(
      `http://127.0.0.1:${configuration.appPort}/api/health-check`,
      options.healthAttempts
    );
    const appContainer = compose(context.runner, context.root, envPath, configuration.projectName, [
      "ps", "-q", "app",
    ], { quiet: true });
    if (!appContainer) throw new Error("application container is not running");
    const runningImage = context.runner("docker", [
      "inspect", "--format", "{{.Config.Image}}", appContainer,
    ], { quiet: true });
    if (runningImage !== context.image) throw new Error(`running image ${runningImage} does not match ${context.image}`);
    const revision = context.runner("docker", [
      "image", "inspect", "--format", '{{ index .Config.Labels "org.opencontainers.image.revision" }}', context.image,
    ], { quiet: true }).toLowerCase();
    if (revision !== context.release.commit) throw new Error("running image source revision does not match the release");
    const signature = freshDatabaseSignature(context, configuration);
    if (signature !== "0|0|0|0|0|0|0|t") {
      throw new Error(`fresh database verification failed with signature ${signature || "empty"}`);
    }
    state.status = "installed";
    state.installedAt = timestamp(options.clock);
    state.validation = { health: health?.status || "unknown", freshDatabase: true };
    await saveState(context.root, state, options.clock);
    logger.log(`ALPR Community ${context.release.tag} installed successfully.`);
    logger.log(`Open http://SERVER_ADDRESS:${configuration.appPort}`);
    logger.log("Leave the username blank and use the administrator password you chose.");
    logger.log("The generated database password is stored only in the private .env file; you do not need to enter it.");
    logger.log("To enable Settings > Software Updates, run ./alpr-community agent install as this same host account.");
    return state;
  } catch (error) {
    state.status = "failed";
    state.failure = { phase: "installation", code: "installation-failed", at: timestamp(options.clock) };
    await saveState(context.root, state, options.clock).catch(() => {});
    try {
      await removeFailedInstallation(environment, {
        ...options,
        root: context.root,
        runner: context.runner,
        logger,
        state,
        automatic: true,
      });
    } catch (cleanupError) {
      logger.error?.(`Automatic cleanup stopped safely: ${cleanupError.message}`);
      logger.error?.("Run ./alpr-community install --recover after correcting the reported cleanup issue.");
    }
    throw error;
  }
}

function parseArguments(argumentsList) {
  const args = [...argumentsList];
  if (args.length === 0) return { command: "install" };
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return { command: "help" };
  if (args.length === 1 && args[0] === "--recover") return { command: "recover" };
  if (args.length === 1 && args[0] === "--status") return { command: "status" };
  throw new Error(`unknown fresh-install option: ${args.join(" ")}`);
}

function printHelp(logger = console) {
  logger.log(`Usage: ./alpr-community install [--status | --recover | --help]

Creates a new, empty ALPR Community installation from an exact stable release
tag on a Linux x86-64 Docker Compose host or Linux virtual machine. It never
imports test data or overwrites an existing .env, runtime directory, Compose
project, database volume, or port binding.

Interactive installation asks for an administrator password, time zone, and
ports. The database password is generated automatically and stored only in the
private .env file. Leave the username blank at first sign-in.

Non-interactive configuration:
  ALPR_INSTALL_ADMIN_PASSWORD=<12-128 character password>
  ALPR_INSTALL_TIMEZONE=UTC
  ALPR_INSTALL_APP_PORT=3000
  ALPR_INSTALL_DB_PORT=5432
  ALPR_INSTALL_PROJECT_NAME=<optional Compose project name>
  ALPR_INSTALL_ACKNOWLEDGE=${INSTALL_ACKNOWLEDGEMENT}

Interrupted-install recovery:
  ./alpr-community install --status
  ALPR_INSTALL_RECOVERY=${RECOVERY_ACKNOWLEDGEMENT} ./alpr-community install --recover

Recovery removes only resources recorded by the unfinished installer and
refuses a completed installation or a subsequently modified .env file.`);
}

async function showStatus(options = {}) {
  const root = canonicalPath(options.root || repositoryRoot);
  const state = await readState(root);
  (options.logger || console).log(JSON.stringify(state || { status: "not-installed" }, null, 2));
  return state;
}

export async function runInstallerCommand(argumentsList = process.argv.slice(2), environment = process.env, options = {}) {
  const { command } = parseArguments(argumentsList);
  if (command === "install") return installCommunity(environment, options);
  if (command === "recover") return removeFailedInstallation(environment, options);
  if (command === "status") return showStatus(options);
  return printHelp(options.logger);
}

export const communityInstallerInternals = Object.freeze({
  CANONICAL_REPOSITORY,
  FORMAT_VERSION,
  INSTALL_ACKNOWLEDGEMENT,
  MINIMUM_FREE_BYTES,
  RECOVERY_ACKNOWLEDGEMENT,
  RUNTIME_DIRECTORIES,
  assertFreshTarget,
  collectConfiguration,
  compose,
  defaultHealthCheck,
  defaultRunner,
  exactRelease,
  exists,
  imageForRelease,
  preflight,
  promptHidden,
  promptText,
  sha256File,
  verifyRuntimeImage,
  normalizeProjectName,
  normalizeRepositoryUrl,
  parseArguments,
  parseVersionTag,
  quoteDotenv,
  readState,
  statePath,
  upsertEnvironment,
  validateAdministratorPassword,
  validatePort,
  validateTimeZone,
  waitForDatabase,
  writeEnvironment,
});

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runInstallerCommand().catch((error) => {
    console.error(`Community installation stopped safely: ${error.message}`);
    process.exitCode = 1;
  });
}
