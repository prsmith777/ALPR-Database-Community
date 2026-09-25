import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  COMMUNITY_UPDATE_OPERATIONS,
  confirmationForCommunityUpdate,
} from "./community-update-shape.mjs";

export { COMMUNITY_UPDATE_OPERATIONS, confirmationForCommunityUpdate } from "./community-update-shape.mjs";

export const COMMUNITY_UPDATE_CONTROL_FORMAT = 1;

const OPERATION_SET = new Set(COMMUNITY_UPDATE_OPERATIONS);
const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEARTBEAT_MAX_AGE_MS = 20_000;
const FILE_NAMES = Object.freeze({
  active: "request-active.json",
  heartbeat: "heartbeat.json",
  request: "request.json",
  state: "state.json",
});

function nowIso(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("update control clock returned an invalid date");
  return date.toISOString();
}

export function resolveCommunityUpdateControlDirectory(environment = process.env) {
  const configured = String(environment.ALPR_UPDATE_CONTROL_DIR || "").trim();
  return resolve(configured || "/app/update-control");
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

async function readJsonFile(path, { maximumBytes = 64 * 1024 } = {}) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("update control files must be regular files");
  }
  if (details.size > maximumBytes) throw new Error("update control file is too large");
  return JSON.parse(await readFile(path, "utf8"));
}

function safeText(value, maximumLength = 240) {
  const text = String(value ?? "").replace(/[\0\r\n]+/g, " ").trim();
  return text.slice(0, maximumLength);
}

function safeActor(actor = {}) {
  return {
    id: safeText(actor.id || "unknown", 120),
    username: safeText(actor.username || "administrator", 120),
  };
}

export function validateCommunityUpdateRequest(input = {}, { requireIdentity = false } = {}) {
  const operation = safeText(input.operation, 30);
  if (!OPERATION_SET.has(operation)) throw new Error("Unsupported software update operation");
  const target = input.target == null || input.target === "" ? null : safeText(input.target, 40);
  if (target && !VERSION_TAG.test(target)) throw new Error("Target must be an exact vMAJOR.MINOR.PATCH release tag");
  if (operation === "update" && !target) throw new Error("An exact target release is required");
  if (target && operation !== "update" && operation !== "check") {
    throw new Error("This operation does not accept a target release");
  }
  const expectedConfirmation = confirmationForCommunityUpdate(operation, target);
  if (expectedConfirmation && input.confirmation !== expectedConfirmation) {
    throw new Error(`Type ${expectedConfirmation} to confirm this operation`);
  }
  const id = safeText(input.id, 80);
  const createdAt = safeText(input.createdAt, 40);
  if (requireIdentity && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Update request identifier is invalid");
  }
  if (requireIdentity && Number.isNaN(Date.parse(createdAt))) throw new Error("Update request timestamp is invalid");
  return {
    formatVersion: COMMUNITY_UPDATE_CONTROL_FORMAT,
    id: id || randomUUID(),
    operation,
    target,
    confirmation: expectedConfirmation || null,
    createdAt: createdAt || nowIso(),
    actor: safeActor(input.actor),
  };
}

function publicState(value) {
  if (!value || typeof value !== "object") return null;
  return {
    formatVersion: Number(value.formatVersion) || null,
    requestId: safeText(value.requestId, 80) || null,
    operation: OPERATION_SET.has(value.operation) ? value.operation : null,
    phase: safeText(value.phase, 40) || "unknown",
    message: safeText(value.message, 500) || null,
    createdAt: safeText(value.createdAt, 40) || null,
    startedAt: safeText(value.startedAt, 40) || null,
    completedAt: safeText(value.completedAt, 40) || null,
    currentTag: VERSION_TAG.test(value.currentTag || "") ? value.currentTag : null,
    targetTag: VERSION_TAG.test(value.targetTag || "") ? value.targetTag : null,
    updaterStatus: safeText(value.updaterStatus, 80) || null,
    rollbackEligibleUntil: safeText(value.rollbackEligibleUntil, 40) || null,
    rollbackPresent: value.rollbackPresent === true,
  };
}

export async function readCommunityUpdateControlSnapshot(options = {}) {
  const directory = resolve(options.directory || resolveCommunityUpdateControlDirectory(options.environment));
  const clock = options.clock || (() => new Date());
  const [heartbeat, state, queued, active] = await Promise.all([
    readJsonFile(join(directory, FILE_NAMES.heartbeat)).catch(() => null),
    readJsonFile(join(directory, FILE_NAMES.state)).catch(() => null),
    exists(join(directory, FILE_NAMES.request)),
    exists(join(directory, FILE_NAMES.active)),
  ]);
  const heartbeatAt = safeText(heartbeat?.observedAt, 40) || null;
  const heartbeatAge = heartbeatAt ? new Date(clock()).getTime() - Date.parse(heartbeatAt) : Number.POSITIVE_INFINITY;
  return {
    agent: {
      online: Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= HEARTBEAT_MAX_AGE_MS,
      lastSeenAt: heartbeatAt,
    },
    busy: queued || active || state?.phase === "running",
    queued,
    active,
    state: publicState(state),
  };
}

export async function submitCommunityUpdateRequest(input, options = {}) {
  const directory = resolve(options.directory || resolveCommunityUpdateControlDirectory(options.environment));
  await mkdir(directory, { recursive: true, mode: 0o770 });
  if (options.requireAgentOnline !== false) {
    const snapshot = await readCommunityUpdateControlSnapshot({ directory, clock: options.clock });
    if (!snapshot.agent.online) throw new Error("The host update agent is offline");
  }
  if (await exists(join(directory, FILE_NAMES.active))) {
    throw new Error("A software update operation is already running");
  }
  const request = validateCommunityUpdateRequest({
    ...input,
    id: randomUUID(),
    createdAt: nowIso(options.clock),
    actor: options.actor,
  });
  const requestPath = join(directory, FILE_NAMES.request);
  let handle;
  try {
    handle = await open(requestPath, "wx", 0o660);
    await handle.writeFile(`${JSON.stringify(request, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("A software update request is already queued");
    throw error;
  } finally {
    await handle?.close();
  }
  return { accepted: true, requestId: request.id, operation: request.operation, target: request.target };
}

export const communityUpdateControlInternals = Object.freeze({
  FILE_NAMES,
  HEARTBEAT_MAX_AGE_MS,
  VERSION_TAG,
  exists,
  nowIso,
  publicState,
  readJsonFile,
  safeText,
});
