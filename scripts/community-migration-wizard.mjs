#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntimeImage } from "./community-image-builder.mjs";
import {
  communityInstallerInternals as installer,
} from "./community-installer.mjs";
import {
  guidedMigrationInternals as guided,
  runGuidedMigrationCommand,
} from "./community-migration-assistant.mjs";
import {
  postgresMajorMigrationInternals as postgres,
} from "./postgres-major-migration.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const FORMAT_VERSION = 1;
const SOURCE_QUIESCED_ACKNOWLEDGEMENT = postgres.SOURCE_QUIESCED_ACKNOWLEDGEMENT;
const NO_STORAGE_ACKNOWLEDGEMENT = "ALPR_NO_IMAGE_STORAGE";
const ACCEPTANCE_ACKNOWLEDGEMENT = guided.ACCEPTANCE_ACKNOWLEDGEMENT;
const ACTIVATION_ACKNOWLEDGEMENT = "ALPR_ACTIVATE_MIGRATED_TARGET";
const RECOVERY_ACKNOWLEDGEMENT = "ALPR_RECOVER_MIGRATION_TARGET";
const STEPS = Object.freeze(["target", "database", "storage", "application", "restart"]);
const ISOLATION_COMPOSE_FILE = "docker-compose.migration-validation.yml";

function value(environment, name) {
  return String(environment[name] ?? "").trim();
}

function timestamp(clock = () => new Date()) {
  const observed = clock();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(date.getTime())) throw new Error("migration wizard clock returned an invalid date");
  return date.toISOString();
}

function pathIsInside(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function defaultStatePath(environment = process.env) {
  const configured = value(environment, "ALPR_MIGRATION_WIZARD_STATE_PATH");
  if (configured) return resolve(configured);
  const stateHome = value(environment, "XDG_STATE_HOME") || join(homedir(), ".local", "state");
  return join(stateHome, "alpr-community", "migration-wizard.json");
}

function assertPrivatePath(candidate, root, label) {
  if (!isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  const resolved = resolve(candidate);
  if (pathIsInside(root, resolved)) throw new Error(`${label} must be outside the repository`);
  return resolved;
}

function sha256Text(input) {
  return createHash("sha256").update(String(input)).digest("hex");
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

async function writePrivateJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

function validateState(state, root) {
  if (state?.formatVersion !== FORMAT_VERSION) {
    throw new Error("migration wizard state is not a supported format");
  }
  if (resolve(state.root || "") !== resolve(root)) {
    throw new Error("migration wizard state belongs to a different release directory");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(state.release?.tag || "") ||
      !/^\d+\.\d+\.\d+$/.test(state.release?.version || "") ||
      !/^[0-9a-f]{40}$/.test(state.release?.commit || "") ||
      !/^alpr-community:\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(state.release?.image || "")) {
    throw new Error("migration wizard state has an invalid release identity");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(state.configuration?.projectName || "")) {
    throw new Error("migration wizard state has an invalid Compose project name");
  }
  if (!Number.isInteger(state.configuration?.appPort) || !Number.isInteger(state.configuration?.dbPort)) {
    throw new Error("migration wizard state has invalid target ports");
  }
  if (resolve(state.configuration?.storage?.targetPath || "") !== resolve(root, "storage")) {
    throw new Error("migration wizard state has an invalid target storage path");
  }
  for (const path of [state.configuration?.dumpPath, state.configuration?.workflowStatePath]) {
    if (!isAbsolute(path || "") || pathIsInside(root, path)) {
      throw new Error("migration wizard state has an unsafe private artifact path");
    }
  }
  if (!Array.isArray(state.resources?.directories) ||
      state.resources.directories.some((directory) => !installer.RUNTIME_DIRECTORIES.includes(directory)) ||
      new Set(state.resources.directories).size !== state.resources.directories.length) {
    throw new Error("migration wizard state has an invalid runtime directory inventory");
  }
  for (const step of STEPS) {
    if (!state.steps?.[step] || typeof state.steps[step].status !== "string") {
      throw new Error(`migration wizard state is missing the ${step} step`);
    }
  }
  const forbiddenKey = (candidate) => candidate && typeof candidate === "object" && Object.entries(candidate).some(
    ([key, child]) => /password|secret/i.test(key) || forbiddenKey(child)
  );
  if (forbiddenKey(state)) {
    throw new Error("migration wizard state contains a forbidden secret-like field");
  }
  return state;
}

async function readState(statePath, root) {
  try {
    return validateState(JSON.parse(await readFile(statePath, "utf8")), root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("migration wizard state is not valid JSON");
    throw error;
  }
}

async function saveState(statePath, state, clock) {
  state.updatedAt = timestamp(clock);
  await writePrivateJson(statePath, state);
}

function verifyRecordedRelease(state, options = {}) {
  if (options.releaseIdentity) {
    if (options.releaseIdentity.tag !== state.release.tag ||
        options.releaseIdentity.commit !== state.release.commit) {
      throw new Error("the checkout no longer matches the exact release recorded by the migration wizard");
    }
    return;
  }
  const runner = options.runner || installer.defaultRunner;
  const dirty = runner("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: state.root,
    quiet: true,
  });
  const tag = runner("git", ["describe", "--tags", "--exact-match", "--match", "v[0-9]*"], {
    cwd: state.root,
    quiet: true,
  });
  const commit = runner("git", ["rev-parse", "HEAD"], { cwd: state.root, quiet: true }).toLowerCase();
  const origin = runner("git", ["remote", "get-url", "origin"], { cwd: state.root, quiet: true });
  if (dirty || tag !== state.release.tag || commit !== state.release.commit ||
      installer.normalizeRepositoryUrl(origin) !== installer.CANONICAL_REPOSITORY) {
    throw new Error("the checkout no longer matches the exact release recorded by the migration wizard");
  }
}

async function assertTargetIdentity(state, options = {}) {
  verifyRecordedRelease(state, options);
  const envPath = join(state.root, ".env");
  if (!(await exists(envPath)) || !state.resources.environmentDigest ||
      await installer.sha256File(envPath) !== state.resources.environmentDigest) {
    throw new Error("the target .env no longer matches the migration wizard state");
  }
}

function parseDotenv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let parsed = match[2];
    if (parsed.startsWith("'") && parsed.endsWith("'")) {
      parsed = parsed.slice(1, -1).replaceAll("'\\''", "'");
    } else if (parsed.startsWith('"') && parsed.endsWith('"')) {
      parsed = parsed.slice(1, -1);
    }
    result[match[1]] = parsed;
  }
  return result;
}

async function targetDatabasePassword(root) {
  const environment = parseDotenv(await readFile(join(root, ".env"), "utf8"));
  if (!environment.DB_PASSWORD) throw new Error("the private target .env has no DB_PASSWORD");
  return environment.DB_PASSWORD;
}

function sourceEndpoint(environment) {
  const host = value(environment, "ALPR_MIGRATION_SOURCE_HOST");
  const database = value(environment, "ALPR_MIGRATION_SOURCE_DATABASE");
  const user = value(environment, "ALPR_MIGRATION_SOURCE_USER");
  if (!host || !database || !user) {
    throw new Error("source host, database, and user are required");
  }
  const port = installer.validatePort(
    value(environment, "ALPR_MIGRATION_SOURCE_PORT") || "5432",
    "source database port"
  );
  const sslMode = value(environment, "ALPR_MIGRATION_SOURCE_SSLMODE") || "prefer";
  if (!new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]).has(sslMode)) {
    throw new Error("source SSL mode is invalid");
  }
  return { host, port, database, user, sslMode };
}

async function collectSourceEnvironment(environment, options = {}) {
  const interactive = options.interactive ?? Boolean(
    (options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY
  );
  const next = { ...environment };
  const ask = async (name, question, fallback) => {
    if (!value(next, name) && interactive) {
      next[name] = await installer.promptText(question, fallback, options.input, options.output);
    }
  };
  await ask("ALPR_MIGRATION_SOURCE_HOST", "Source PostgreSQL host or IP", "127.0.0.1");
  await ask("ALPR_MIGRATION_SOURCE_PORT", "Source PostgreSQL port", "5432");
  await ask("ALPR_MIGRATION_SOURCE_DATABASE", "Source database name", "postgres");
  await ask("ALPR_MIGRATION_SOURCE_USER", "Source database user", "postgres");
  await ask("ALPR_MIGRATION_SOURCE_SSLMODE", "Source PostgreSQL SSL mode", "prefer");
  if (!value(next, "ALPR_MIGRATION_SOURCE_PASSWORD") && interactive) {
    next.ALPR_MIGRATION_SOURCE_PASSWORD = await installer.promptHidden(
      "Source database password (not saved)",
      options.input,
      options.output
    );
  }
  if (!value(next, "ALPR_MIGRATION_SOURCE_PASSWORD")) {
    throw new Error("set ALPR_MIGRATION_SOURCE_PASSWORD or run the wizard interactively");
  }
  sourceEndpoint(next);
  return next;
}

async function collectStorage(environment, root, options = {}) {
  const interactive = options.interactive ?? Boolean(
    (options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY
  );
  let sourcePath = value(environment, "ALPR_MIGRATION_SOURCE_STORAGE_PATH");
  let sourceSsh = value(environment, "ALPR_MIGRATION_SOURCE_STORAGE_SSH");
  if (sourcePath && sourceSsh) {
    throw new Error("configure local or SSH source image storage, not both");
  }
  if (!sourcePath && !sourceSsh && interactive) {
    const source = await installer.promptText(
      "Old image storage: /local/path or user@host:/remote/path (leave blank only if none)",
      "",
      options.input,
      options.output
    );
    if (source.includes(":")) sourceSsh = source;
    else sourcePath = source;
  }
  if (!sourcePath && !sourceSsh) {
    let acknowledgement = value(environment, "ALPR_MIGRATION_NO_STORAGE");
    if (!acknowledgement && interactive) {
      acknowledgement = await installer.promptText(
        `Type ${NO_STORAGE_ACKNOWLEDGEMENT} to confirm there are no image files`,
        "",
        options.input,
        options.output
      );
    }
    if (acknowledgement !== NO_STORAGE_ACKNOWLEDGEMENT) {
      throw new Error(
        `provide ALPR_MIGRATION_SOURCE_STORAGE_PATH or set ALPR_MIGRATION_NO_STORAGE=${NO_STORAGE_ACKNOWLEDGEMENT}`
      );
    }
    return { mode: "none", targetPath: join(root, "storage") };
  }
  if (sourceSsh) {
    const match = sourceSsh.match(/^([A-Za-z_][A-Za-z0-9_.-]*@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\/[A-Za-z0-9._/+@=-]*)$/);
    if (!match || sourceSsh.includes("..")) {
      throw new Error("SSH image storage must use the restricted form user@host:/absolute/path");
    }
    return { mode: "ssh", source: sourceSsh.replace(/\/+$/, ""), targetPath: join(root, "storage") };
  }
  if (!isAbsolute(sourcePath)) throw new Error("source image storage path must be absolute");
  const source = resolve(sourcePath);
  const target = resolve(root, "storage");
  if (pathIsInside(source, target) || pathIsInside(target, source)) {
    throw new Error("source and target storage paths must be separate and non-nested");
  }
  return { mode: "local", sourcePath: source, targetPath: target };
}

function migrationEnvironment(state, sourcePassword, databasePassword) {
  const source = state.configuration.source;
  const target = state.configuration.target;
  const result = {
    ALPR_MIGRATION_SOURCE_HOST: source.host,
    ALPR_MIGRATION_SOURCE_PORT: String(source.port),
    ALPR_MIGRATION_SOURCE_DATABASE: source.database,
    ALPR_MIGRATION_SOURCE_USER: source.user,
    ALPR_MIGRATION_SOURCE_PASSWORD: sourcePassword,
    ALPR_MIGRATION_SOURCE_SSLMODE: source.sslMode,
    ALPR_MIGRATION_TARGET_HOST: target.host,
    ALPR_MIGRATION_TARGET_PORT: String(target.port),
    ALPR_MIGRATION_TARGET_DATABASE: target.database,
    ALPR_MIGRATION_TARGET_USER: target.user,
    ALPR_MIGRATION_TARGET_PASSWORD: databasePassword,
    ALPR_MIGRATION_TARGET_SSLMODE: target.sslMode,
    ALPR_MIGRATION_DUMP_PATH: state.configuration.dumpPath,
    ALPR_MIGRATION_STATE_PATH: state.configuration.workflowStatePath,
  };
  if (state.configuration.storage.mode === "local") {
    result.ALPR_MIGRATION_SOURCE_STORAGE_PATH = state.configuration.storage.sourcePath;
    result.ALPR_MIGRATION_TARGET_STORAGE_PATH = state.configuration.storage.targetPath;
  }
  return result;
}

function composeIsolated(runner, state, args, options = {}) {
  return installer.compose(
    runner,
    state.root,
    join(state.root, ".env"),
    state.configuration.projectName,
    ["-f", join(state.root, "docker-compose.yml"), "-f", join(state.root, ISOLATION_COMPOSE_FILE), ...args],
    options
  );
}

async function countFiles(path) {
  let files = 0;
  let bytes = 0;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) {
        files += 1;
        bytes += Number((await stat(candidate)).size);
      }
    }
  };
  await visit(path);
  return { files, bytes };
}

async function prepareTarget(state, context, configuration, databasePassword, options = {}) {
  const runner = options.runner || installer.defaultRunner;
  const target = await installer.assertFreshTarget(context, configuration, options);
  for (const directory of installer.RUNTIME_DIRECTORIES) {
    await mkdir(join(context.root, directory), { recursive: false, mode: 0o750 });
    await chmod(join(context.root, directory), 0o750);
    state.resources.directories.push(directory);
  }
  const environmentFile = await installer.writeEnvironment(context, configuration, databasePassword);
  state.resources.environmentDigest = environmentFile.digest;
  if (!target.imageAlreadyPresent) {
    buildRuntimeImage(runner, context.root, context.release, context.image);
    state.resources.createdImage = true;
  }
  installer.verifyRuntimeImage(runner, context.root, context.image);
  for (const directory of installer.RUNTIME_DIRECTORIES) {
    const ownership = directory === "update-control"
      ? `${configuration.runtimeUid}:${configuration.runtimeGid}`
      : "1000:1000";
    runner("docker", [
      "run", "--rm", "--user", "0:0", "--entrypoint", "chown",
      "--volume", `${join(context.root, directory)}:/target`, context.image,
      "-R", ownership, "/target",
    ], { inherit: true });
    if (directory === "update-control") await chmod(join(context.root, directory), 0o2770);
  }
  composeIsolated(runner, state, ["config", "--quiet"], { quiet: true });
  composeIsolated(runner, state, ["up", "-d", "db"], { inherit: true });
  await installer.waitForDatabase(context, configuration, options.databaseReadyAttempts);
  await resetTargetDatabase(state, runner, options);
}

async function resetTargetDatabase(state, runner, options = {}) {
  const psql = [
    "exec", "-T", "db", "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--username", "postgres", "--dbname", "template1", "--command",
  ];
  composeIsolated(runner, state, [...psql,
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();"
  ], { quiet: true });
  composeIsolated(runner, state, [...psql, "DROP DATABASE postgres;"], { quiet: true });
  composeIsolated(runner, state, [...psql, "CREATE DATABASE postgres TEMPLATE template0;"], { quiet: true });
  await installer.waitForDatabase(
    { root: state.root, runner },
    state.configuration,
    options.databaseReadyAttempts
  );
}

async function copyStorage(state, options = {}) {
  const storage = state.configuration.storage;
  if (storage.mode === "none") return { mode: "none", files: 0, bytes: 0, checksumVerified: true };
  const runner = options.runner || installer.defaultRunner;
  if (storage.mode === "local" && !(await exists(storage.sourcePath))) {
    throw new Error("source image storage path does not exist");
  }
  const chownStorage = (ownership) => runner("docker", [
    "run", "--rm", "--user", "0:0", "--entrypoint", "chown",
    "--volume", `${storage.targetPath}:/target`, state.release.image,
    "-R", ownership, "/target",
  ], { inherit: true });
  chownStorage(`${state.configuration.runtimeUid}:${state.configuration.runtimeGid}`);
  const source = storage.mode === "ssh" ? `${storage.source}/` : `${storage.sourcePath}/`;
  runner("rsync", [
    "--archive", "--checksum", "--no-owner", "--no-group", "--omit-dir-times",
    source, `${storage.targetPath}/`,
  ], {
    inherit: true,
  });
  const differences = runner("rsync", [
    "--archive", "--checksum", "--no-owner", "--no-group", "--delete", "--dry-run",
    "--itemize-changes", "--omit-dir-times",
    source, `${storage.targetPath}/`,
  ], { quiet: true });
  if (differences) throw new Error("storage checksum verification found differences after copy");
  const inventory = await countFiles(storage.targetPath);
  chownStorage("1000:1000");
  return { mode: storage.mode, ...inventory, checksumVerified: true };
}

function targetDataSignature(state, runner, { isolated = true } = {}) {
  const sql = `SELECT concat_ws('|',
    (SELECT count(*) FROM public.plates),
    (SELECT count(*) FROM public.plate_reads),
    (SELECT count(*) FROM public.known_plates),
    (SELECT count(*) FROM public.tags),
    (SELECT count(*) FROM public.plate_tags),
    (SELECT count(*) FROM public.plate_notifications)
  );`;
  const args = [
    "exec", "-T", "db", "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--tuples-only", "--no-align", "--username", "postgres", "--dbname", "postgres",
    "--command", sql,
  ];
  return isolated
    ? composeIsolated(runner, state, args, { quiet: true })
    : installer.compose(
      runner,
      state.root,
      join(state.root, ".env"),
      state.configuration.projectName,
      args,
      { quiet: true }
    );
}

async function validateApplication(state, options = {}) {
  const runner = options.runner || installer.defaultRunner;
  composeIsolated(runner, state, ["up", "-d", "--no-deps", "app"], { inherit: true });
  const health = await (options.healthCheck || installer.defaultHealthCheck)(
    `http://127.0.0.1:${state.configuration.appPort}/api/health-check`,
    options.healthAttempts
  );
  const appContainer = composeIsolated(runner, state, ["ps", "-q", "app"], { quiet: true });
  if (!appContainer) throw new Error("target application container is not running");
  const runningImage = runner("docker", ["inspect", "--format", "{{.Config.Image}}", appContainer], { quiet: true });
  if (runningImage !== state.release.image) throw new Error("target application is running the wrong image");
  return {
    health: health?.status || "unknown",
    image: runningImage,
    dataSignature: targetDataSignature(state, runner),
    outboundNetwork: "isolated",
  };
}

async function validateRestart(state, options = {}) {
  const runner = options.runner || installer.defaultRunner;
  composeIsolated(runner, state, ["restart", "db", "app"], { inherit: true });
  await installer.waitForDatabase(
    { root: state.root, runner },
    state.configuration,
    options.databaseReadyAttempts
  );
  const health = await (options.healthCheck || installer.defaultHealthCheck)(
    `http://127.0.0.1:${state.configuration.appPort}/api/health-check`,
    options.healthAttempts
  );
  const dataSignature = targetDataSignature(state, runner);
  const expectedSignature = state.steps.application.result?.dataSignature;
  if (!expectedSignature || dataSignature !== expectedSignature) {
    throw new Error("target database signature changed across the restart check");
  }
  return { health: health?.status || "unknown", dataSignature, persistence: "passed" };
}

async function executeStep(statePath, state, step, action, options = {}) {
  state.status = `running-${step}`;
  state.waitingFor = null;
  state.steps[step] = { status: "running", startedAt: timestamp(options.clock) };
  await saveState(statePath, state, options.clock);
  try {
    const result = await action();
    state.steps[step] = {
      status: "completed",
      completedAt: timestamp(options.clock),
      ...(result ? { result } : {}),
    };
    state.status = `completed-${step}`;
    delete state.lastFailure;
    await saveState(statePath, state, options.clock);
  } catch (error) {
    state.status = "failed";
    state.steps[step] = { ...state.steps[step], status: "failed", failedAt: timestamp(options.clock) };
    state.lastFailure = { step, code: "step-failed", failedAt: timestamp(options.clock) };
    await saveState(statePath, state, options.clock).catch(() => {});
    throw error;
  }
}

async function initialize(environment, options = {}) {
  const root = resolve(options.root || repositoryRoot);
  const statePath = assertPrivatePath(defaultStatePath(environment), root, "wizard state path");
  const existing = await readState(statePath, root);
  if (existing) {
    if (existing.steps.target.status === "completed") {
      await assertTargetIdentity(existing, options);
    } else {
      verifyRecordedRelease(existing, options);
    }
    return { statePath, state: existing, context: null, configuration: null, runtimeEnvironment: environment };
  }

  const runtimeEnvironment = await collectSourceEnvironment(environment, options);
  const context = await installer.preflight(runtimeEnvironment, { ...options, root });
  const configuration = await installer.collectConfiguration(runtimeEnvironment, root, {
    ...options,
    defaultDbPort: "5433",
  });
  const storage = await collectStorage(runtimeEnvironment, root, options);
  const dataHome = value(runtimeEnvironment, "XDG_DATA_HOME") || join(homedir(), ".local", "share");
  const generatedRunName = `${context.release.tag}-${timestamp(options.clock).replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const artifactDirectory = assertPrivatePath(
    resolve(value(runtimeEnvironment, "ALPR_MIGRATION_ARTIFACT_DIR") || join(dataHome, "alpr-community", "migrations", generatedRunName)),
    root,
    "migration artifact directory"
  );
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const source = sourceEndpoint(runtimeEnvironment);
  const dumpPath = join(artifactDirectory, "source.dump");
  const state = {
    formatVersion: FORMAT_VERSION,
    root,
    createdAt: timestamp(options.clock),
    updatedAt: timestamp(options.clock),
    status: "initialized",
    release: { ...context.release, image: context.image },
    configuration: {
      source,
      target: {
        host: "127.0.0.1",
        port: configuration.dbPort,
        database: "postgres",
        user: "postgres",
        sslMode: "disable",
      },
      appPort: configuration.appPort,
      dbPort: configuration.dbPort,
      projectName: configuration.projectName,
      timeZone: configuration.timeZone,
      runtimeUid: configuration.runtimeUid,
      runtimeGid: configuration.runtimeGid,
      storage,
      dumpPath,
      workflowStatePath: `${dumpPath}.workflow.json`,
      identity: sha256Text(JSON.stringify({ source, storage, dumpPath, release: context.release })),
    },
    resources: { directories: [], createdImage: false },
    steps: Object.fromEntries(STEPS.map((step) => [step, { status: "pending" }])),
    acceptance: { status: "pending" },
    activation: { status: "pending" },
  };
  await saveState(statePath, state, options.clock);
  return { statePath, state, context, configuration, runtimeEnvironment };
}

async function ensureSourcePassword(environment, options = {}) {
  if (value(environment, "ALPR_MIGRATION_SOURCE_PASSWORD")) return environment.ALPR_MIGRATION_SOURCE_PASSWORD;
  const interactive = options.interactive ?? Boolean(
    (options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY
  );
  if (interactive) {
    const password = await installer.promptHidden("Source database password (not saved)", options.input, options.output);
    if (password) return password;
  }
  throw new Error("source database password is required to continue; it is never saved by the wizard");
}

async function sourceQuiesced(environment, options = {}) {
  if (value(environment, "ALPR_MIGRATION_SOURCE_QUIESCED") === SOURCE_QUIESCED_ACKNOWLEDGEMENT) return true;
  const interactive = options.interactive ?? Boolean(
    (options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY
  );
  if (!interactive) return false;
  const answer = await installer.promptText(
    `Stop the old ALPR app and every database writer, then type ${SOURCE_QUIESCED_ACKNOWLEDGEMENT}`,
    "",
    options.input,
    options.output
  );
  return answer === SOURCE_QUIESCED_ACKNOWLEDGEMENT;
}

async function advance(environment = process.env, options = {}) {
  const logger = options.logger || console;
  const initialized = await initialize(environment, options);
  const { statePath, state } = initialized;
  const runner = options.runner || installer.defaultRunner;
  let context = initialized.context;
  let configuration = initialized.configuration;
  let runtimeEnvironment = initialized.runtimeEnvironment;

  if (state.acceptance.status === "completed") {
    logger.log("Migration has already been accepted. Run activate only when this isolated target is ready for service.");
    return state;
  }
  if (state.steps.target.status === "failed") {
    throw new Error("target preparation previously failed; run migrate wizard recover before starting again");
  }
  if (state.steps.target.status !== "completed") {
    if (!context || !configuration) throw new Error("target preparation cannot resume from an incomplete target; run recover");
    const databasePassword = randomBytes(32).toString("base64url");
    await executeStep(statePath, state, "target", async () => {
      await (options.prepareTarget || prepareTarget)(state, context, configuration, databasePassword, { ...options, runner });
      return { emptyPostgres17: true, outboundNetwork: "isolated" };
    }, options);
  }

  if (state.steps.database.status !== "completed") {
    const sourcePassword = await ensureSourcePassword(runtimeEnvironment, options);
    const databasePassword = await targetDatabasePassword(state.root);
    const migration = migrationEnvironment(state, sourcePassword, databasePassword);
    if (state.steps.database.status === "failed") {
      state.status = "resetting-disposable-target";
      await saveState(statePath, state, options.clock);
      await resetTargetDatabase(state, runner, options);
      await guided.rewindTargetWorkflow(migration, {
        root: state.root,
        logger,
        clock: options.clock,
      });
    }
    let workflow = await runGuidedMigrationCommand("start", migration, {
      root: state.root,
      logger,
      runner: options.migrationRunner,
      clock: options.clock,
    });
    if (workflow.status === "waiting-for-dump") {
      if (!(await sourceQuiesced(runtimeEnvironment, options))) {
        state.status = "waiting-for-source-stop";
        state.waitingFor = {
          code: "source-stop",
          requiredValue: SOURCE_QUIESCED_ACKNOWLEDGEMENT,
          reason: "Stop the source application, ingestion, jobs, and every database writer.",
        };
        await saveState(statePath, state, options.clock);
        logger.log(`Source stop is still required. Then rerun with ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT}.`);
        return state;
      }
      runtimeEnvironment = {
        ...runtimeEnvironment,
        ALPR_MIGRATION_SOURCE_QUIESCED: SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      };
    }
    const acknowledged = {
      ...migration,
      ALPR_MIGRATION_SOURCE_QUIESCED: SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      ALPR_MIGRATION_ACKNOWLEDGE: postgres.RESTORE_ACKNOWLEDGEMENT,
    };
    await executeStep(statePath, state, "database", async () => {
      workflow = await runGuidedMigrationCommand("resume", acknowledged, {
        root: state.root,
        logger,
        runner: options.migrationRunner,
        clock: options.clock,
      });
      if (workflow.status !== "ready-for-acceptance") {
        throw new Error(`database migration stopped at unexpected state ${workflow.status}`);
      }
      return { validated: true, workflowId: workflow.workflowId };
    }, options);
  }

  if (state.steps.storage.status !== "completed") {
    await executeStep(statePath, state, "storage", () => (options.copyStorage || copyStorage)(state, { ...options, runner }), options);
  }
  if (state.steps.application.status !== "completed") {
    await executeStep(statePath, state, "application", () => (options.validateApplication || validateApplication)(state, { ...options, runner }), options);
  }
  if (state.steps.restart.status !== "completed") {
    await executeStep(statePath, state, "restart", () => (options.validateRestart || validateRestart)(state, { ...options, runner }), options);
  }

  state.status = "ready-for-review";
  state.waitingFor = {
    code: "browser-review",
    reason: "Sign in, inspect totals/search/tags/history, and open representative images before acceptance.",
  };
  await saveState(statePath, state, options.clock);
  logger.log(`Automated migration checks passed. Open http://SERVER_ADDRESS:${state.configuration.appPort}`);
  logger.log("The validation target has no outbound network access, so integrations cannot send while you review it.");
  logger.log(`After browser review: ALPR_MIGRATION_ACCEPTANCE=${ACCEPTANCE_ACKNOWLEDGEMENT} ./alpr-community migrate wizard accept`);
  return state;
}

async function accept(environment = process.env, options = {}) {
  const root = resolve(options.root || repositoryRoot);
  const statePath = assertPrivatePath(defaultStatePath(environment), root, "wizard state path");
  const state = await readState(statePath, root);
  if (!state) throw new Error("no migration wizard state exists");
  await assertTargetIdentity(state, options);
  if (state.status !== "ready-for-review") throw new Error("automated migration checks must pass before acceptance");
  let acknowledgement = value(environment, "ALPR_MIGRATION_ACCEPTANCE");
  const interactive = options.interactive ?? Boolean(
    (options.input || process.stdin).isTTY && (options.output || process.stdout).isTTY
  );
  if (!acknowledgement && interactive) {
    acknowledgement = await installer.promptText(
      `After completing the browser review, type ${ACCEPTANCE_ACKNOWLEDGEMENT}`,
      "",
      options.input,
      options.output
    );
  }
  if (acknowledgement !== ACCEPTANCE_ACKNOWLEDGEMENT) {
    throw new Error(`acceptance requires ALPR_MIGRATION_ACCEPTANCE=${ACCEPTANCE_ACKNOWLEDGEMENT}`);
  }
  const databasePassword = await targetDatabasePassword(root);
  const sourcePassword = await ensureSourcePassword(environment, options);
  const migration = {
    ...migrationEnvironment(state, sourcePassword, databasePassword),
    ALPR_MIGRATION_STORAGE_VERIFIED: guided.STORAGE_VERIFIED_ACKNOWLEDGEMENT,
    ALPR_MIGRATION_APPLICATION_VERIFIED: guided.APPLICATION_VERIFIED_ACKNOWLEDGEMENT,
    ALPR_MIGRATION_ACCEPTANCE: ACCEPTANCE_ACKNOWLEDGEMENT,
  };
  await runGuidedMigrationCommand("accept", migration, { root, logger: options.logger, clock: options.clock });
  await runGuidedMigrationCommand("rollback-check", migration, {
    root,
    logger: options.logger,
    runner: options.migrationRunner,
    clock: options.clock,
  });
  state.status = "accepted-isolated";
  state.waitingFor = {
    code: "activation",
    reason: "Configure integrations, plan service cutover, then explicitly activate outbound networking.",
  };
  state.acceptance = { status: "completed", acceptedAt: timestamp(options.clock) };
  await saveState(statePath, state, options.clock);
  (options.logger || console).log("Migration accepted. The retained source and dump remain available for rollback; the target is still isolated.");
  return state;
}

async function activate(environment = process.env, options = {}) {
  const root = resolve(options.root || repositoryRoot);
  const statePath = assertPrivatePath(defaultStatePath(environment), root, "wizard state path");
  const state = await readState(statePath, root);
  if (!state || state.acceptance.status !== "completed") throw new Error("accept the isolated migration before activation");
  await assertTargetIdentity(state, options);
  if (state.activation.status === "completed") return state;
  if (value(environment, "ALPR_MIGRATION_ACTIVATION") !== ACTIVATION_ACKNOWLEDGEMENT) {
    throw new Error(`activation requires ALPR_MIGRATION_ACTIVATION=${ACTIVATION_ACKNOWLEDGEMENT}`);
  }
  const sourcePassword = await ensureSourcePassword(environment, options);
  const databasePassword = await targetDatabasePassword(root);
  await runGuidedMigrationCommand(
    "rollback-check",
    migrationEnvironment(state, sourcePassword, databasePassword),
    {
      root,
      logger: options.logger,
      runner: options.migrationRunner,
      clock: options.clock,
    }
  );
  const runner = options.runner || installer.defaultRunner;
  state.status = "activating";
  state.activation = { status: "running", startedAt: timestamp(options.clock) };
  await saveState(statePath, state, options.clock);
  try {
    composeIsolated(runner, state, ["down", "--remove-orphans"], { inherit: true });
    installer.compose(runner, root, join(root, ".env"), state.configuration.projectName, ["up", "-d", "db"], { inherit: true });
    await installer.waitForDatabase({ root, runner }, state.configuration, options.databaseReadyAttempts);
    installer.compose(runner, root, join(root, ".env"), state.configuration.projectName, [
      "run", "--rm", "--no-deps", "migrate",
    ], { inherit: true });
    const dataSignature = targetDataSignature(state, runner, { isolated: false });
    const expectedSignature = state.steps.restart.result?.dataSignature;
    if (!expectedSignature || dataSignature !== expectedSignature) {
      throw new Error("target database signature changed while activating networking");
    }
    installer.compose(runner, root, join(root, ".env"), state.configuration.projectName, [
      "up", "-d", "--no-deps", "app",
    ], { inherit: true });
    await (options.healthCheck || installer.defaultHealthCheck)(
      `http://127.0.0.1:${state.configuration.appPort}/api/health-check`,
      options.healthAttempts
    );
    state.status = "activated";
    state.waitingFor = null;
    state.activation = {
      status: "completed",
      activatedAt: timestamp(options.clock),
      dataSignature,
    };
    await saveState(statePath, state, options.clock);
  } catch (error) {
    let isolationRecovery = "failed";
    try {
      installer.compose(
        runner,
        root,
        join(root, ".env"),
        state.configuration.projectName,
        ["down", "--remove-orphans"],
        { inherit: true }
      );
      composeIsolated(runner, state, ["up", "-d", "db"], { inherit: true });
      await installer.waitForDatabase({ root, runner }, state.configuration, options.databaseReadyAttempts);
      composeIsolated(runner, state, ["up", "-d", "--no-deps", "app"], { inherit: true });
      isolationRecovery = "completed";
    } catch {
      // Preserve the activation failure while recording that manual isolation is required.
    }
    state.status = "activation-failed";
    state.activation = {
      ...state.activation,
      status: "failed",
      failedAt: timestamp(options.clock),
      code: "activation-failed",
      isolationRecovery,
    };
    await saveState(statePath, state, options.clock).catch(() => {});
    throw error;
  }
  (options.logger || console).log("Target networking activated. This command did not change DNS, reverse proxy, router, or source services.");
  return state;
}

async function recover(environment = process.env, options = {}) {
  const root = resolve(options.root || repositoryRoot);
  const statePath = assertPrivatePath(defaultStatePath(environment), root, "wizard state path");
  const state = await readState(statePath, root);
  if (!state) throw new Error("no migration wizard state exists");
  if (state.acceptance.status === "completed") throw new Error("recovery refuses an accepted migration target");
  if (value(environment, "ALPR_MIGRATION_RECOVERY") !== RECOVERY_ACKNOWLEDGEMENT) {
    throw new Error(`recovery requires ALPR_MIGRATION_RECOVERY=${RECOVERY_ACKNOWLEDGEMENT}`);
  }
  const runner = options.runner || installer.defaultRunner;
  const envPath = join(root, ".env");
  if (await exists(envPath)) {
    if (!state.resources.environmentDigest || await installer.sha256File(envPath) !== state.resources.environmentDigest) {
      throw new Error(".env is missing from state or changed; recovery refuses to remove modified configuration");
    }
    composeIsolated(runner, state, ["down", "--volumes", "--remove-orphans"], { inherit: true });
  }
  if (state.resources.createdImage) {
    const imageId = runner("docker", ["image", "ls", "--quiet", state.release.image], { quiet: true });
    if (imageId) runner("docker", ["image", "rm", state.release.image], { inherit: true });
  }
  for (const directory of state.resources.directories) {
    if (!installer.RUNTIME_DIRECTORIES.includes(directory)) throw new Error("wizard state contains an unsafe runtime directory");
    await rm(join(root, directory), { recursive: true, force: true });
  }
  await unlink(envPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(state.configuration.workflowStatePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(statePath);
  (options.logger || console).log("Removed only the unaccepted target resources recorded by the migration wizard. Source data and dump artifacts were retained.");
}

async function status(environment = process.env, options = {}) {
  const root = resolve(options.root || repositoryRoot);
  const statePath = assertPrivatePath(defaultStatePath(environment), root, "wizard state path");
  const state = await readState(statePath, root);
  const output = state ? { statePath, ...state } : { statePath, status: "not-started" };
  (options.logger || console).log(JSON.stringify(output, null, 2));
  return state;
}

function printHelp(logger = console) {
  logger.log(`Usage: ./alpr-community migrate wizard [start | resume | status | accept | activate | recover | help]

The wizard prepares a separate PostgreSQL 17 Community target, creates and
verifies the logical dump, copies locally mounted image storage with checksum
verification, starts an outbound-isolated target, and validates health plus
restart persistence. Successful checkpoints are resumable.

It never stops or deletes the source, never stores either database password in
state, and never changes DNS, reverse proxy, router, or VM configuration.

Source connection (prompted interactively or set privately):
  ALPR_MIGRATION_SOURCE_HOST, _PORT, _DATABASE, _USER, _PASSWORD, _SSLMODE

Image storage:
  ALPR_MIGRATION_SOURCE_STORAGE_PATH=/absolute/mounted/source/storage
  or ALPR_MIGRATION_SOURCE_STORAGE_SSH=user@source-host:/absolute/storage
  or ALPR_MIGRATION_NO_STORAGE=${NO_STORAGE_ACKNOWLEDGEMENT}

Safety acknowledgements:
  ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT}
  ALPR_MIGRATION_ACCEPTANCE=${ACCEPTANCE_ACKNOWLEDGEMENT}
  ALPR_MIGRATION_ACTIVATION=${ACTIVATION_ACKNOWLEDGEMENT}
  ALPR_MIGRATION_RECOVERY=${RECOVERY_ACKNOWLEDGEMENT}`);
}

export async function runMigrationWizardCommand(
  argumentsList = process.argv.slice(2),
  environment = process.env,
  options = {}
) {
  const command = argumentsList[0] || "start";
  if (["start", "resume"].includes(command)) return advance(environment, options);
  if (command === "status") return status(environment, options);
  if (command === "accept") return accept(environment, options);
  if (command === "activate") return activate(environment, options);
  if (command === "recover") return recover(environment, options);
  if (["help", "--help", "-h"].includes(command)) return printHelp(options.logger);
  throw new Error(`unknown migration wizard command: ${argumentsList.join(" ")}`);
}

export const migrationWizardInternals = Object.freeze({
  ACCEPTANCE_ACKNOWLEDGEMENT,
  ACTIVATION_ACKNOWLEDGEMENT,
  FORMAT_VERSION,
  NO_STORAGE_ACKNOWLEDGEMENT,
  RECOVERY_ACKNOWLEDGEMENT,
  SOURCE_QUIESCED_ACKNOWLEDGEMENT,
  STEPS,
  assertPrivatePath,
  collectStorage,
  defaultStatePath,
  migrationEnvironment,
  parseDotenv,
  pathIsInside,
  sourceEndpoint,
  validateState,
});

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runMigrationWizardCommand().catch((error) => {
    console.error(`Community migration wizard stopped safely: ${error.message}`);
    process.exitCode = 1;
  });
}
