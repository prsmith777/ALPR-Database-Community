import crypto from "node:crypto";

const DIAGNOSTIC_TTL_MS = 30 * 60 * 1000;
const DIAGNOSTIC_DURATION_MS = 8_000;
const REGISTRY_KEY = Symbol.for("alpr.blue-iris-export-diagnostic-registry");

function diagnosticRegistry() {
  if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

function actorKey(actor) {
  const value = String(actor?.id ?? actor?.username ?? "").trim();
  if (!value) throw new Error("An authenticated administrator is required.");
  return value;
}

function normalizedStart(value, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Choose a valid recorded timeline time.");
  if (timestamp > now - 5_000) {
    throw new Error("Choose a timeline time at least five seconds in the past.");
  }
  if (timestamp < now - 24 * 60 * 60 * 1000) {
    throw new Error("The manual diagnostic is limited to recordings from the last 24 hours.");
  }
  return timestamp;
}

function isComplete(record) {
  const status = String(record?.status || "").trim().toLowerCase();
  return record?.complete === true
    || Number(record?.progress) >= 100
    || ["complete", "completed", "done", "ready", "success", "finished"].includes(status);
}

function publicRecord(record) {
  return {
    token: record.token,
    camera: record.camera,
    requestedStartAt: record.requestedStartAt,
    requestedDurationMs: record.requestedDurationMs,
    remotePath: record.remotePath,
    status: record.status,
    progress: record.progress,
    listed: record.listed,
    complete: record.complete,
    fileSize: record.fileSize,
    createdAt: record.createdAt,
    checkedAt: record.checkedAt,
    deletedAt: record.deletedAt,
  };
}

function pruneRegistry(registry, now = Date.now()) {
  for (const [token, record] of registry.entries()) {
    if (now - record.createdAtMs > DIAGNOSTIC_TTL_MS) registry.delete(token);
  }
}

export class BlueIrisExportDiagnosticService {
  constructor({ client, registry = diagnosticRegistry(), now = () => Date.now() } = {}) {
    if (!client) throw new Error("A Blue Iris client is required.");
    this.client = client;
    this.registry = registry;
    this.now = now;
  }

  ownedRecord({ actor, token }) {
    pruneRegistry(this.registry, this.now());
    const record = this.registry.get(String(token || ""));
    if (!record || record.actorKey !== actorKey(actor)) {
      throw new Error("This diagnostic export is unavailable or has expired.");
    }
    return record;
  }

  async create({ actor, camera, start }) {
    const owner = actorKey(actor);
    const now = this.now();
    pruneRegistry(this.registry, now);
    const active = [...this.registry.values()].find(
      (record) => record.actorKey === owner && !record.deletedAt
    );
    if (active) return publicRecord(active);

    const cameraId = String(camera || "").trim();
    if (!cameraId) throw new Error("Select a Blue Iris camera.");
    const startMs = normalizedStart(start, now);
    const connection = await this.client.testConnection();
    if (!connection.cameras?.some((item) => item.id === cameraId && item.enabled !== false)) {
      throw new Error("The selected Blue Iris camera is not available.");
    }

    const remote = await this.client.startTimelineExport({
      camera: cameraId,
      start: new Date(startMs),
      durationMs: DIAGNOSTIC_DURATION_MS,
      profile: 0,
      reencode: false,
      substream: false,
    });
    const token = crypto.randomUUID();
    const record = {
      token,
      actorKey: owner,
      camera: cameraId,
      requestedStartAt: new Date(startMs).toISOString(),
      requestedDurationMs: DIAGNOSTIC_DURATION_MS,
      remotePath: remote.remotePath,
      status: remote.status || "queued",
      progress: remote.progress,
      listed: true,
      complete: isComplete(remote),
      fileSize: remote.fileSize,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      checkedAt: null,
      deletedAt: null,
    };
    this.registry.set(token, record);
    return publicRecord(record);
  }

  async check({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (record.deletedAt) return publicRecord(record);

    // Deliberately one queue request per explicit administrator click.
    const exports = await this.client.listTimelineExports();
    const remote = exports.find((item) => item.remotePath === record.remotePath);
    record.listed = Boolean(remote);
    record.checkedAt = new Date(this.now()).toISOString();
    if (remote) {
      record.status = remote.status || record.status;
      record.progress = remote.progress;
      record.complete = isComplete(remote);
      record.fileSize = remote.fileSize;
    } else {
      record.status = "not_listed";
      record.progress = null;
      record.complete = false;
      record.fileSize = null;
    }
    return publicRecord(record);
  }

  async remove({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (!record.deletedAt && record.complete !== true) {
      throw new Error("Check the export status and confirm completion before deleting it.");
    }
    if (!record.deletedAt) {
      await this.client.deleteTimelineExport(record.remotePath);
      record.deletedAt = new Date(this.now()).toISOString();
      record.status = "deleted";
      record.listed = false;
      record.complete = false;
    }
    return publicRecord(record);
  }
}

export const blueIrisExportDiagnosticInternals = Object.freeze({
  DIAGNOSTIC_DURATION_MS,
  actorKey,
  isComplete,
  normalizedStart,
  publicRecord,
  pruneRegistry,
});
