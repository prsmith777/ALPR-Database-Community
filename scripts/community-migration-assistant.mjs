import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  postgresMajorMigrationInternals,
  runPostgresMigrationCommand,
} from "./postgres-major-migration.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const WORKFLOW_FORMAT_VERSION = 1;
const WORKFLOW_STEPS = Object.freeze([
  "preflight",
  "dump",
  "restore",
  "validate",
]);
const STORAGE_VERIFIED_ACKNOWLEDGEMENT = "ALPR_STORAGE_VERIFIED";
const APPLICATION_VERIFIED_ACKNOWLEDGEMENT = "ALPR_APPLICATION_VERIFIED";
const ACCEPTANCE_ACKNOWLEDGEMENT = "ALPR_MIGRATION_ACCEPTED";
const REQUIRED_ENVIRONMENT_VARIABLES = Object.freeze([
  "ALPR_MIGRATION_SOURCE_HOST",
  "ALPR_MIGRATION_SOURCE_DATABASE",
  "ALPR_MIGRATION_SOURCE_USER",
  "ALPR_MIGRATION_SOURCE_PASSWORD",
  "ALPR_MIGRATION_TARGET_HOST",
  "ALPR_MIGRATION_TARGET_DATABASE",
  "ALPR_MIGRATION_TARGET_USER",
  "ALPR_MIGRATION_TARGET_PASSWORD",
  "ALPR_MIGRATION_DUMP_PATH",
]);

const {
  RESTORE_ACKNOWLEDGEMENT,
  SOURCE_QUIESCED_ACKNOWLEDGEMENT,
  pathIsInside,
  readEndpoint,
  resolveArtifactPath,
} = postgresMajorMigrationInternals;

function value(environment, name) {
  return String(environment[name] || "").trim();
}

function missingRequiredEnvironment(environment) {
  return REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !value(environment, name));
}

function assertOutsideRepository(path, root, label) {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path outside the repository`);
  }
  const resolvedPath = resolve(path);
  if (pathIsInside(root, resolvedPath)) {
    throw new Error(`${label} must be outside the repository`);
  }
  return resolvedPath;
}

function resolveWorkflowStatePath(environment, root = repositoryRoot, dumpPath) {
  const configured = value(environment, "ALPR_MIGRATION_STATE_PATH");
  const candidate = configured || `${dumpPath || value(environment, "ALPR_MIGRATION_DUMP_PATH")}.workflow.json`;
  if (!candidate || candidate === ".workflow.json") {
    throw new Error(
      "set ALPR_MIGRATION_STATE_PATH or ALPR_MIGRATION_DUMP_PATH to locate the workflow state"
    );
  }
  return assertOutsideRepository(candidate, root, "ALPR_MIGRATION_STATE_PATH");
}

function optionalStoragePaths(environment) {
  const source = value(environment, "ALPR_MIGRATION_SOURCE_STORAGE_PATH");
  const target = value(environment, "ALPR_MIGRATION_TARGET_STORAGE_PATH");
  if (Boolean(source) !== Boolean(target)) {
    throw new Error(
      "set both ALPR_MIGRATION_SOURCE_STORAGE_PATH and ALPR_MIGRATION_TARGET_STORAGE_PATH, or neither"
    );
  }
  if (!source) return null;
  if (!isAbsolute(source) || !isAbsolute(target)) {
    throw new Error("migration storage paths must both be absolute");
  }
  const resolvedSource = resolve(source);
  const resolvedTarget = resolve(target);
  const relation = relative(resolvedSource, resolvedTarget);
  const reverseRelation = relative(resolvedTarget, resolvedSource);
  const targetInsideSource = relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  const sourceInsideTarget = reverseRelation === "" || (!reverseRelation.startsWith("..") && !isAbsolute(reverseRelation));
  if (targetInsideSource || sourceInsideTarget) {
    throw new Error("source and target storage paths must be separate and non-nested");
  }
  return { sourcePath: resolvedSource, targetPath: resolvedTarget };
}

function redactedEndpoint(endpoint) {
  return {
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    sslMode: endpoint.sslMode,
  };
}

function workflowConfiguration(environment, root = repositoryRoot) {
  const missing = missingRequiredEnvironment(environment);
  if (missing.length > 0) {
    throw new Error(`missing required migration variables: ${missing.join(", ")}`);
  }
  const dumpPath = resolveArtifactPath(environment, root);
  const statePath = resolveWorkflowStatePath(environment, root, dumpPath);
  if (statePath === dumpPath || statePath === `${dumpPath}.manifest.json`) {
    throw new Error("workflow state must not overwrite the dump or its manifest");
  }
  return {
    source: redactedEndpoint(readEndpoint(environment, "ALPR_MIGRATION_SOURCE")),
    target: redactedEndpoint(readEndpoint(environment, "ALPR_MIGRATION_TARGET")),
    dumpPath,
    statePath,
    storage: optionalStoragePaths(environment),
  };
}

function workflowIdentity(configuration) {
  return createHash("sha256")
    .update(JSON.stringify(configuration))
    .digest("hex")
    .toUpperCase();
}

function timestamp(clock = () => new Date()) {
  const observed = clock();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(date.getTime())) throw new Error("workflow clock returned an invalid date");
  return date.toISOString();
}

function initialWorkflowState(configuration, clock) {
  const createdAt = timestamp(clock);
  return {
    formatVersion: WORKFLOW_FORMAT_VERSION,
    workflowId: workflowIdentity(configuration),
    createdAt,
    updatedAt: createdAt,
    status: "initialized",
    configuration: {
      source: configuration.source,
      target: configuration.target,
      dumpPath: configuration.dumpPath,
      storage: configuration.storage,
    },
    steps: Object.fromEntries(
      WORKFLOW_STEPS.map((step) => [step, { status: "pending" }])
    ),
    acceptance: { status: "pending" },
    rollbackCheck: { status: "not-run" },
  };
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

async function writeWorkflowState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function validateWorkflowState(state) {
  if (state?.formatVersion !== WORKFLOW_FORMAT_VERSION) {
    throw new Error("workflow state is not a supported Community migration state file");
  }
  if (!/^[A-F0-9]{64}$/.test(state.workflowId || "")) {
    throw new Error("workflow state has an invalid identity");
  }
  for (const step of WORKFLOW_STEPS) {
    if (!state.steps?.[step] || typeof state.steps[step].status !== "string") {
      throw new Error(`workflow state is missing the ${step} step`);
    }
  }
  return state;
}

async function readWorkflowState(statePath) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  return validateWorkflowState(state);
}

function assertWorkflowMatches(state, configuration) {
  if (state.workflowId !== workflowIdentity(configuration)) {
    throw new Error(
      "migration endpoints, artifact paths, or storage paths changed; start a new state file instead of resuming this workflow"
    );
  }
}

function markUpdated(state, clock) {
  state.updatedAt = timestamp(clock);
  return state.updatedAt;
}

function requiredAcknowledgement(step) {
  if (step === "dump") {
    return {
      variable: "ALPR_MIGRATION_SOURCE_QUIESCED",
      value: SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      reason: "Stop the source application, plate ingestion, and every database writer before continuing.",
    };
  }
  if (step === "restore") {
    return {
      variable: "ALPR_MIGRATION_ACKNOWLEDGE",
      value: RESTORE_ACKNOWLEDGEMENT,
      reason: "Confirm the PostgreSQL 17 target is separate, disposable, and empty before continuing.",
    };
  }
  return null;
}

async function initializeWorkflow(
  environment,
  { root = repositoryRoot, clock, logger = console } = {}
) {
  const configuration = workflowConfiguration(environment, root);
  if (await exists(configuration.statePath)) {
    const state = await readWorkflowState(configuration.statePath);
    assertWorkflowMatches(state, configuration);
    logger.log(`Migration workflow already initialized: ${configuration.statePath}`);
    return { state, statePath: configuration.statePath, configuration };
  }
  const state = initialWorkflowState(configuration, clock);
  await writeWorkflowState(configuration.statePath, state);
  logger.log(`Initialized private migration workflow state: ${configuration.statePath}`);
  logger.log("Passwords are required at runtime but are never written to this state file.");
  return { state, statePath: configuration.statePath, configuration };
}

async function executeStep({
  state,
  statePath,
  step,
  environment,
  runner,
  clock,
  logger,
}) {
  state.status = `running-${step}`;
  state.waitingFor = null;
  state.steps[step] = {
    status: "running",
    startedAt: markUpdated(state, clock),
  };
  await writeWorkflowState(statePath, state);
  logger.log(`Starting migration step: ${step}`);
  try {
    await runner(step, environment);
  } catch (error) {
    const failedAt = markUpdated(state, clock);
    state.status = "failed";
    state.lastFailure = { step, failedAt, code: "step-failed" };
    state.steps[step] = {
      ...state.steps[step],
      status: "failed",
      failedAt,
    };
    await writeWorkflowState(statePath, state);
    throw error;
  }
  const completedAt = markUpdated(state, clock);
  state.steps[step] = {
    ...state.steps[step],
    status: "completed",
    completedAt,
  };
  delete state.lastFailure;
  await writeWorkflowState(statePath, state);
  logger.log(`Completed migration step: ${step}`);
}

async function resumeWorkflow(
  environment,
  {
    root = repositoryRoot,
    clock,
    logger = console,
    runner = runPostgresMigrationCommand,
  } = {}
) {
  const configuration = workflowConfiguration(environment, root);
  const state = await readWorkflowState(configuration.statePath);
  assertWorkflowMatches(state, configuration);

  if (state.acceptance.status === "completed") {
    logger.log("Migration workflow is already accepted and complete.");
    return state;
  }

  for (const step of WORKFLOW_STEPS) {
    if (state.steps[step].status === "completed") continue;
    const acknowledgement = requiredAcknowledgement(step);
    if (
      acknowledgement &&
      value(environment, acknowledgement.variable) !== acknowledgement.value
    ) {
      state.status = `waiting-for-${step}`;
      state.waitingFor = {
        step,
        variable: acknowledgement.variable,
        requiredValue: acknowledgement.value,
        reason: acknowledgement.reason,
      };
      markUpdated(state, clock);
      await writeWorkflowState(configuration.statePath, state);
      logger.log(acknowledgement.reason);
      logger.log(
        `When that checkpoint is satisfied, set ${acknowledgement.variable}=${acknowledgement.value} and run resume again.`
      );
      return state;
    }
    await executeStep({
      state,
      statePath: configuration.statePath,
      step,
      environment,
      runner,
      clock,
      logger,
    });
  }

  state.status = "ready-for-acceptance";
  state.waitingFor = {
    step: "acceptance",
    reason:
      "Copy and verify image storage, start the target application, and validate health, sign-in, search, ingestion, images, and restart persistence.",
  };
  markUpdated(state, clock);
  await writeWorkflowState(configuration.statePath, state);
  logger.log(state.waitingFor.reason);
  logger.log("Run status for the exact acceptance acknowledgements; this assistant never performs cutover automatically.");
  return state;
}

async function acceptWorkflow(
  environment,
  { root = repositoryRoot, clock, logger = console } = {}
) {
  const statePath = resolveWorkflowStatePath(environment, root);
  const state = await readWorkflowState(statePath);
  if (state.steps.validate.status !== "completed") {
    throw new Error("database validation must complete before migration acceptance");
  }
  const required = [
    ["ALPR_MIGRATION_STORAGE_VERIFIED", STORAGE_VERIFIED_ACKNOWLEDGEMENT],
    ["ALPR_MIGRATION_APPLICATION_VERIFIED", APPLICATION_VERIFIED_ACKNOWLEDGEMENT],
    ["ALPR_MIGRATION_ACCEPTANCE", ACCEPTANCE_ACKNOWLEDGEMENT],
  ];
  const missing = required.filter(([name, expected]) => value(environment, name) !== expected);
  if (missing.length > 0) {
    throw new Error(
      `acceptance requires ${missing.map(([name, expected]) => `${name}=${expected}`).join(", ")}`
    );
  }
  const acceptedAt = markUpdated(state, clock);
  state.status = "accepted";
  state.waitingFor = null;
  state.acceptance = {
    status: "completed",
    acceptedAt,
    storageVerified: true,
    applicationVerified: true,
  };
  await writeWorkflowState(statePath, state);
  logger.log("Migration acceptance recorded. This assistant did not switch traffic or delete the source.");
  return state;
}

async function runRollbackCheck(
  environment,
  {
    root = repositoryRoot,
    clock,
    logger = console,
    runner = runPostgresMigrationCommand,
  } = {}
) {
  const configuration = workflowConfiguration(environment, root);
  const state = await readWorkflowState(configuration.statePath);
  assertWorkflowMatches(state, configuration);
  await runner("rollback-check", environment);
  state.rollbackCheck = {
    status: "completed",
    completedAt: markUpdated(state, clock),
  };
  await writeWorkflowState(configuration.statePath, state);
  logger.log("Rollback prerequisites recorded; no database or volume was switched.");
  return state;
}

async function rewindTargetWorkflow(
  environment,
  { root = repositoryRoot, clock, logger = console } = {}
) {
  const configuration = workflowConfiguration(environment, root);
  const state = await readWorkflowState(configuration.statePath);
  assertWorkflowMatches(state, configuration);
  if (state.acceptance.status === "completed") {
    throw new Error("an accepted migration workflow cannot be rewound");
  }
  state.steps.restore = { status: "pending" };
  state.steps.validate = { status: "pending" };
  state.status = state.steps.dump.status === "completed"
    ? "waiting-for-restore"
    : state.status;
  state.waitingFor = null;
  delete state.lastFailure;
  markUpdated(state, clock);
  await writeWorkflowState(configuration.statePath, state);
  logger.log("Reset only the disposable target restore and validation checkpoints; the verified source dump was retained.");
  return state;
}

async function showStatus(environment, { root = repositoryRoot, logger = console } = {}) {
  const statePath = resolveWorkflowStatePath(environment, root);
  const state = await readWorkflowState(statePath);
  logger.log(JSON.stringify({ statePath, ...state }, null, 2));
  return state;
}

function printHelp(logger = console) {
  logger.log(`Usage: node scripts/community-migration-assistant.mjs <command>

Commands:
  start           Initialize state, run preflight, and stop at the first safety checkpoint.
  init            Create the private resumable state file without running database commands.
  resume          Continue completed checkpoints without repeating successful steps.
  status          Display the redacted workflow state and exact next checkpoint.
  accept          Record operator acceptance after database, storage, app, and restart checks.
  rollback-check  Recheck the unchanged source and verified dump needed for rollback.

Set the ALPR_MIGRATION_SOURCE_*, ALPR_MIGRATION_TARGET_*, and
ALPR_MIGRATION_DUMP_PATH variables documented in docs/DEPLOYMENT.md.
ALPR_MIGRATION_STATE_PATH is optional and defaults beside the dump.
Passwords are used only by child PostgreSQL clients and are never stored.

The assistant stops before dump until:
  ALPR_MIGRATION_SOURCE_QUIESCED=${SOURCE_QUIESCED_ACKNOWLEDGEMENT}

It stops before restore until:
  ALPR_MIGRATION_ACKNOWLEDGE=${RESTORE_ACKNOWLEDGEMENT}

It never switches traffic or deletes the source. Final acceptance requires:
  ALPR_MIGRATION_STORAGE_VERIFIED=${STORAGE_VERIFIED_ACKNOWLEDGEMENT}
  ALPR_MIGRATION_APPLICATION_VERIFIED=${APPLICATION_VERIFIED_ACKNOWLEDGEMENT}
  ALPR_MIGRATION_ACCEPTANCE=${ACCEPTANCE_ACKNOWLEDGEMENT}`);
}

export async function runGuidedMigrationCommand(
  command = process.argv[2],
  environment = process.env,
  options = {}
) {
  switch (command) {
    case "start":
      await initializeWorkflow(environment, options);
      return resumeWorkflow(environment, options);
    case "init":
      return initializeWorkflow(environment, options);
    case "resume":
      return resumeWorkflow(environment, options);
    case "status":
      return showStatus(environment, options);
    case "accept":
      return acceptWorkflow(environment, options);
    case "rollback-check":
      return runRollbackCheck(environment, options);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp(options.logger);
      return;
    default:
      throw new Error(`unknown guided migration command: ${command}`);
  }
}

export const guidedMigrationInternals = {
  ACCEPTANCE_ACKNOWLEDGEMENT,
  APPLICATION_VERIFIED_ACKNOWLEDGEMENT,
  REQUIRED_ENVIRONMENT_VARIABLES,
  STORAGE_VERIFIED_ACKNOWLEDGEMENT,
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_STEPS,
  acceptWorkflow,
  assertWorkflowMatches,
  initialWorkflowState,
  missingRequiredEnvironment,
  optionalStoragePaths,
  requiredAcknowledgement,
  resolveWorkflowStatePath,
  rewindTargetWorkflow,
  resumeWorkflow,
  workflowConfiguration,
  workflowIdentity,
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runGuidedMigrationCommand().catch((error) => {
    console.error(`Guided migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
