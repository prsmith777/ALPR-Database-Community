#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMMUNITY_UPDATE_CONTROL_FORMAT,
  communityUpdateControlInternals,
  validateCommunityUpdateRequest,
} from "../lib/community-update-control.mjs";
import { runUpdaterCommand } from "./community-updater.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const SERVICE_NAME = "alpr-community-update-agent.service";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const REQUEST_MAX_AGE_MS = 5 * 60 * 1_000;

function timestamp(clock = () => new Date()) {
  const observed = clock();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(date.getTime())) throw new Error("update agent clock returned an invalid date");
  return date.toISOString();
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660 });
  await chmod(temporary, 0o660);
  await rename(temporary, path);
  await chmod(path, 0o660);
}

function safeErrorMessage(error) {
  return String(error?.message || "The operation failed")
    .replace(/([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*)=\S+/gi, "$1=[redacted]")
    .replace(/[\0\r\n]+/g, " ")
    .slice(0, 500);
}

function stateSummary(operation, result, recordedState = null) {
  if (operation === "check") {
    const unfinishedUpdate = Boolean(
      recordedState
      && !["accepted", "rolled-back"].includes(recordedState.status)
    );
    return {
      currentTag: result?.current?.tag || null,
      targetTag: result?.target?.tag || null,
      activeUpdateTag: recordedState?.target?.tag || null,
      updaterStatus: recordedState?.status || (result?.target ? "update-available" : "current"),
      rollbackEligibleUntil: recordedState?.acceptance?.cleanupEligibleAt || null,
      rollbackPresent: Boolean(recordedState?.backup?.directory && !recordedState?.backup?.cleanedAt),
      message: unfinishedUpdate
        ? `${recordedState.target?.tag || "The current update"} is unfinished. Complete or roll back that update before installing another release.`
        : result?.target
          ? `Update ${result.target.tag} is available.`
        : `${result?.current?.tag || "The installed release"} is current.`,
    };
  }
  const state = result || {};
  return {
    currentTag: state.current?.tag || null,
    targetTag: state.target?.tag || null,
    activeUpdateTag: state.target?.tag || null,
    updaterStatus: state.status || null,
    rollbackEligibleUntil: state.acceptance?.cleanupEligibleAt || null,
    rollbackPresent: Boolean(state.backup?.directory && !state.backup?.cleanedAt),
    message: operation === "update"
      ? `${state.target?.tag || "The update"} passed Technical system checks. Complete the listed real-use checks, then accept it.`
      : operation === "validate"
        ? "Technical system checks completed successfully. Complete the listed real-use checks, then accept the update."
        : operation === "accept"
          ? `${state.target?.tag || "The update"} was accepted.`
          : operation === "rollback"
            ? `Rollback to ${state.rollback?.restoredTag || state.current?.tag || "the previous release"} completed.`
            : "The recorded rollback copy was removed.",
  };
}

function hostControlDirectory(options = {}) {
  const configured = String(options.environment?.ALPR_UPDATE_CONTROL_DIR || "").trim();
  return resolve(options.directory || configured || join(options.root || repositoryRoot, "update-control"));
}

async function readRequest(path, clock = () => new Date()) {
  const parsed = await communityUpdateControlInternals.readJsonFile(path);
  if (!parsed) throw new Error("Update request disappeared before validation");
  if (parsed.formatVersion !== COMMUNITY_UPDATE_CONTROL_FORMAT) {
    throw new Error("Update request format is not supported by this agent");
  }
  const request = validateCommunityUpdateRequest(parsed, { requireIdentity: true });
  const age = new Date(clock()).getTime() - Date.parse(request.createdAt);
  if (!Number.isFinite(age) || age < -30_000 || age > REQUEST_MAX_AGE_MS) {
    throw new Error("Update request expired before the host agent could claim it");
  }
  return request;
}

export async function processCommunityUpdateRequest(options = {}) {
  const directory = hostControlDirectory(options);
  const names = communityUpdateControlInternals.FILE_NAMES;
  const queuedPath = join(directory, names.request);
  const activePath = join(directory, names.active);
  const statePath = join(directory, names.state);
  const clock = options.clock || (() => new Date());
  await mkdir(directory, { recursive: true, mode: 0o770 });
  await chmod(directory, 0o2770);

  if (!(await exists(activePath))) {
    try {
      await rename(queuedPath, activePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  let request;
  try {
    request = await readRequest(activePath, clock);
    const startedAt = timestamp(clock);
    await writePrivateJson(statePath, {
      formatVersion: COMMUNITY_UPDATE_CONTROL_FORMAT,
      requestId: request.id,
      operation: request.operation,
      phase: "running",
      message: `Running ${request.operation} on the host.`,
      createdAt: request.createdAt,
      startedAt,
      targetTag: request.target,
    });
    const argumentsList = [request.operation];
    if (request.target) argumentsList.push("--to", request.target);
    const result = await (options.runUpdaterCommand || runUpdaterCommand)(
      argumentsList,
      options.environment || process.env,
      {
        confirmed: true,
        logger: options.logger || console,
        root: options.root || repositoryRoot,
      }
    );
    const recordedState = request.operation === "check"
      ? await (options.runUpdaterCommand || runUpdaterCommand)(
          ["status"],
          options.environment || process.env,
          {
            logger: { log() {}, error() {} },
            root: options.root || repositoryRoot,
          }
        )
      : result;
    const summary = stateSummary(request.operation, result, recordedState);
    const completed = {
      formatVersion: COMMUNITY_UPDATE_CONTROL_FORMAT,
      requestId: request.id,
      operation: request.operation,
      phase: "succeeded",
      createdAt: request.createdAt,
      startedAt,
      completedAt: timestamp(clock),
      ...summary,
    };
    await writePrivateJson(statePath, completed);
    return completed;
  } catch (error) {
    let recordedSummary = {};
    if (request) {
      try {
        const recordedState = await (options.runUpdaterCommand || runUpdaterCommand)(
          ["status"],
          options.environment || process.env,
          {
            logger: { log() {}, error() {} },
            root: options.root || repositoryRoot,
          }
        );
        recordedSummary = stateSummary(request.operation, recordedState);
      } catch {
        // The original operation failure remains authoritative. A missing or
        // unreadable updater state must never mask it.
      }
    }
    const failed = {
      formatVersion: COMMUNITY_UPDATE_CONTROL_FORMAT,
      requestId: request?.id || null,
      operation: request?.operation || null,
      phase: "failed",
      createdAt: request?.createdAt || null,
      completedAt: timestamp(clock),
      targetTag: request?.target || null,
      ...recordedSummary,
      message: safeErrorMessage(error),
    };
    await writePrivateJson(statePath, failed);
    (options.logger || console).error(`Community update operation failed: ${failed.message}`);
    return failed;
  } finally {
    await unlink(activePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function acquireAgentLock(directory) {
  const lockPath = join(directory, "agent.lock");
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
    return async () => unlink(lockPath).catch(() => {});
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingPid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
    if (Number.isInteger(existingPid) && existingPid > 1) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`The Community update agent is already running as process ${existingPid}`);
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
      }
    }
    await unlink(lockPath);
    return acquireAgentLock(directory);
  }
}

export async function runCommunityUpdateAgent(options = {}) {
  const directory = hostControlDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o770 });
  await chmod(directory, 0o2770);
  const releaseLock = await acquireAgentLock(directory);
  const heartbeatPath = join(directory, communityUpdateControlInternals.FILE_NAMES.heartbeat);
  const signal = options.signal;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const writeHeartbeat = () => writePrivateJson(heartbeatPath, {
    formatVersion: COMMUNITY_UPDATE_CONTROL_FORMAT,
    observedAt: timestamp(options.clock),
    pid: process.pid,
  });
  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch((error) => {
      (options.logger || console).error(`Community update heartbeat failed: ${safeErrorMessage(error)}`);
    });
  }, options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  try {
    while (!signal?.aborted) {
      await processCommunityUpdateRequest({ ...options, directory });
      await sleep(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    clearInterval(heartbeatTimer);
    await releaseLock();
  }
}

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `${command} failed`).trim());
  return String(result.stdout || "").trim();
}

function systemdQuote(value) {
  const text = String(value);
  if (!text || /[\0\r\n]/.test(text)) throw new Error("systemd service paths must be nonempty single-line values");
  return `"${text.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdDirectivePath(value) {
  const text = String(value);
  if (!text || /[\0\r\n]/.test(text)) throw new Error("systemd service paths must be nonempty single-line values");
  return text
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll('"', "\\x22")
    .replaceAll("'", "\\x27")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

function serviceFile(root, nodePath = process.execPath) {
  const agentPath = posix.join(root, "scripts", "community-update-agent.mjs");
  return `[Unit]\nDescription=ALPR Community restricted software update agent\nAfter=docker.service network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdDirectivePath(root)}\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(agentPath)} run\nRestart=on-failure\nRestartSec=5\nUMask=0007\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}

export async function installCommunityUpdateAgent(options = {}) {
  if ((options.platform || process.platform) !== "linux") {
    throw new Error("Automatic agent service installation is available only on Linux systemd hosts");
  }
  const root = resolve(options.root || repositoryRoot);
  const controlDirectory = hostControlDirectory({ ...options, root });
  const probePath = join(controlDirectory, `.agent-install-probe-${randomUUID()}`);
  try {
    await mkdir(controlDirectory, { recursive: true, mode: 0o770 });
    await chmod(controlDirectory, 0o2770);
    const probe = await open(probePath, "wx", 0o600);
    await probe.close();
    await unlink(probePath);
  } catch (error) {
    await unlink(probePath).catch(() => {});
    if (["EACCES", "EPERM"].includes(error?.code)) {
      throw new Error(`The installation owner cannot write ${controlDirectory}; correct that directory's ownership before installing the agent`);
    }
    throw error;
  }
  const serviceDirectory = resolve(options.serviceDirectory || join(homedir(), ".config", "systemd", "user"));
  const servicePath = join(serviceDirectory, SERVICE_NAME);
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(servicePath, serviceFile(root, options.nodePath), { mode: 0o600 });
  await chmod(servicePath, 0o600);
  const runner = options.runner || defaultRunner;
  runner("systemctl", ["--user", "daemon-reload"]);
  runner("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  return { servicePath, serviceName: SERVICE_NAME, controlDirectory };
}

export async function uninstallCommunityUpdateAgent(options = {}) {
  const serviceDirectory = resolve(options.serviceDirectory || join(homedir(), ".config", "systemd", "user"));
  const servicePath = join(serviceDirectory, SERVICE_NAME);
  const runner = options.runner || defaultRunner;
  try { runner("systemctl", ["--user", "disable", "--now", SERVICE_NAME]); } catch {}
  await rm(servicePath, { force: true });
  try { runner("systemctl", ["--user", "daemon-reload"]); } catch {}
  return { removed: true, servicePath };
}

function printHelp(logger = console) {
  logger.log(`Usage: ./alpr-community agent <command>\n\nCommands:\n  run       Run the restricted update agent in the foreground.\n  install   Install and start a per-user systemd service.\n  status    Show the per-user systemd service status.\n  uninstall Stop and remove the per-user systemd service.\n\nFor unattended startup, enable lingering once for this Linux account:\n  sudo loginctl enable-linger "$USER"`);
}

export async function runCommunityUpdateAgentCommand(argumentsList = process.argv.slice(2), environment = process.env, options = {}) {
  const command = argumentsList[0] || "help";
  if (argumentsList.length > 1) throw new Error("The update agent command does not accept extra arguments");
  if (command === "run") return runCommunityUpdateAgent({ ...options, environment });
  if (command === "install") return installCommunityUpdateAgent(options);
  if (command === "uninstall") return uninstallCommunityUpdateAgent(options);
  if (command === "status") return (options.runner || defaultRunner)("systemctl", ["--user", "status", "--no-pager", SERVICE_NAME], { stdio: "inherit" });
  if (["help", "--help", "-h"].includes(command)) return printHelp(options.logger);
  throw new Error(`Unknown update agent command: ${command}`);
}

export const communityUpdateAgentInternals = Object.freeze({
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  REQUEST_MAX_AGE_MS,
  SERVICE_NAME,
  hostControlDirectory,
  safeErrorMessage,
  serviceFile,
  systemdDirectivePath,
  stateSummary,
  systemdQuote,
  timestamp,
  writePrivateJson,
});

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runCommunityUpdateAgentCommand().catch((error) => {
    console.error(`Community update agent stopped safely: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
