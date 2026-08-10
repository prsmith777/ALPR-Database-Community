import crypto from "node:crypto";

import {
  createTimelineExportWorkspace,
  probeTimelineExport,
  removeTimelineExportWorkspace,
} from "./blue-iris-timeline-media.mjs";

const DIAGNOSTIC_TTL_MS = 30 * 60 * 1000;
const DIAGNOSTIC_DURATION_MS = 8_000;
const DIAGNOSTIC_DURATION_TOLERANCE_MS = 500;
const DIAGNOSTIC_START_TOLERANCE_MS = 500;
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

function normalizedEpochMs(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? Math.round(timestamp) : null;
}

function isComplete(record) {
  const status = String(record?.status || "").trim().toLowerCase();
  return record?.complete === true
    || Number(record?.progress) >= 100
    || ["complete", "completed", "done", "ready", "success", "finished"].includes(status);
}

function remoteMetadata(record) {
  const uri = String(record?.remoteUri || "").trim();
  const utc = normalizedEpochMs(record?.remoteUtc);
  const durationMs = Number(record?.remoteDurationMs);
  if (!uri) {
    throw new Error("Blue Iris did not reserve one exact downloadable export URI.");
  }
  if (utc === null || Math.abs(utc - record.requestedStartMs) > DIAGNOSTIC_START_TOLERANCE_MS) {
    throw new Error("Blue Iris did not confirm the requested export start time.");
  }
  if (!Number.isFinite(durationMs)
    || Math.abs(durationMs - DIAGNOSTIC_DURATION_MS) > DIAGNOSTIC_DURATION_TOLERANCE_MS) {
    throw new Error("Blue Iris did not confirm the requested eight-second duration.");
  }
  return { uri, utc, durationMs };
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
    downloadAttemptedAt: record.downloadAttemptedAt,
    downloadedAt: record.downloadedAt,
    downloadValidated: record.downloadValidated,
    downloadError: record.downloadError,
    downloadBytes: record.downloadBytes,
    downloadAttemptCount: record.downloadAttemptCount,
    probe: record.probe,
    deleteRequestedAt: record.deleteRequestedAt,
    deletionCheckedAt: record.deletionCheckedAt,
    deletionError: record.deletionError,
    deletedAt: record.deletedAt,
    localRemovedAt: record.localRemovedAt,
  };
}

function pruneRegistry(registry, now = Date.now()) {
  for (const [token, record] of registry.entries()) {
    if (now - record.createdAtMs > DIAGNOSTIC_TTL_MS) registry.delete(token);
  }
}

export class BlueIrisExportDiagnosticService {
  constructor({
    client,
    registry = diagnosticRegistry(),
    now = () => Date.now(),
    createWorkspace = createTimelineExportWorkspace,
    removeWorkspace = removeTimelineExportWorkspace,
    probe = probeTimelineExport,
    minimumWidth = 1_920,
    minimumHeight = 1_080,
  } = {}) {
    if (!client) throw new Error("A Blue Iris client is required.");
    this.client = client;
    this.registry = registry;
    this.now = now;
    this.createWorkspace = createWorkspace;
    this.removeWorkspace = removeWorkspace;
    this.probe = probe;
    this.minimumWidth = Math.max(1, Number(minimumWidth) || 1_920);
    this.minimumHeight = Math.max(1, Number(minimumHeight) || 1_080);
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
      (record) => record.actorKey === owner && !record.localRemovedAt
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
      requestedStartMs: startMs,
      requestedDurationMs: DIAGNOSTIC_DURATION_MS,
      remotePath: remote.remotePath,
      remoteUri: remote.uri || remote.remotePath,
      remoteUtc: remote.utc,
      remoteDurationMs: remote.durationMs,
      status: remote.status || "queued",
      progress: remote.progress,
      listed: true,
      complete: isComplete(remote),
      fileSize: remote.fileSize,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      checkedAt: null,
      downloadAttemptedAt: null,
      downloadedAt: null,
      downloadValidated: false,
      downloadError: null,
      downloadBytes: null,
      downloadAttemptCount: 0,
      probe: null,
      workspace: null,
      deleteRequestedAt: null,
      deletionCheckedAt: null,
      deletionError: null,
      deletedAt: null,
      localRemovedAt: null,
    };
    this.registry.set(token, record);
    return publicRecord(record);
  }

  async check({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (record.deletedAt) return publicRecord(record);

    // Blue Iris 6 may reject cmd:export status lookups for a reserved @record
    // even after the direct-copy file is complete. The exact download URI is
    // therefore the readiness authority: a bounded range request proves the
    // owned export is available without downloading the full MP4.
    const availability = await this.client.checkTimelineExportDownloadAvailability(
      record.remoteUri || record.remotePath
    );
    record.listed = null;
    record.checkedAt = new Date(this.now()).toISOString();
    record.status = availability.available ? "download_ready" : "queued";
    record.progress = availability.available ? 100 : null;
    record.complete = availability.available;
    return publicRecord(record);
  }

  async download({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (!record.checkedAt) throw new Error("Check whether the export is available before downloading it.");
    if (record.deletedAt) throw new Error("The Blue Iris diagnostic export was already deleted.");
    if (record.downloadValidated) return publicRecord(record);
    const eligible = record.complete === true;
    if (!eligible) throw new Error("Blue Iris has not completed or released the diagnostic export.");

    record.downloadAttemptedAt = new Date(this.now()).toISOString();
    record.downloadAttemptCount += 1;
    record.downloadError = null;
    let workspace;
    try {
      const verified = remoteMetadata(record);
      workspace = await this.createWorkspace();
      record.workspace = workspace;
      const downloaded = await this.client.downloadTimelineExport({
        uri: verified.uri,
        destinationPath: workspace.clipPath,
      });
      const probe = await this.probe(workspace.clipPath);
      record.downloadBytes = Number(downloaded?.bytes) || probe.fileSize || null;
      record.probe = probe;
      if (Math.abs(probe.durationMs - DIAGNOSTIC_DURATION_MS) > DIAGNOSTIC_DURATION_TOLERANCE_MS) {
        throw new Error(`Downloaded MP4 duration was ${probe.durationMs}ms instead of eight seconds.`);
      }
      if (probe.width < this.minimumWidth || probe.height < this.minimumHeight) {
        throw new Error(
          `Downloaded MP4 was ${probe.width}x${probe.height}; at least ${this.minimumWidth}x${this.minimumHeight} is required.`
        );
      }
      record.downloadedAt = new Date(this.now()).toISOString();
      record.downloadValidated = true;
      record.downloadError = null;
      record.status = "download_validated";
    } catch (error) {
      record.downloadValidated = false;
      record.downloadError = String(error?.message || "Unable to download and validate the diagnostic export.")
        .slice(0, 500);
      record.status = "download_failed";
      if (workspace) {
        await this.removeWorkspace(workspace).catch(() => {});
        record.workspace = null;
      }
    }
    return publicRecord(record);
  }

  async remove({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (!record.deletedAt && record.downloadValidated !== true) {
      throw new Error("Download and validate the exact export before deleting it from Blue Iris.");
    }
    if (!record.deletedAt) {
      await this.client.requestTimelineExportDeletion(record.remotePath);
      record.deleteRequestedAt = new Date(this.now()).toISOString();
      record.deletionCheckedAt = null;
      record.deletionError = null;
      record.status = "delete_requested";
    }
    return publicRecord(record);
  }

  async verifyRemoval({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (!record.deleteRequestedAt) {
      throw new Error("Request deletion of the exact Blue Iris export before verifying it.");
    }
    if (record.deletedAt) return publicRecord(record);

    const verification = await this.client.verifyTimelineExportDeletion({
      remotePath: record.remotePath,
      uri: record.remoteUri || record.remotePath,
    });
    record.deletionCheckedAt = new Date(this.now()).toISOString();
    record.listed = verification.recordAvailable;
    if (verification.deleted) {
      record.deletedAt = record.deletionCheckedAt;
      record.deletionError = null;
      record.status = "remote_deleted";
      record.complete = false;
    } else {
      record.deletionError = verification.downloadAvailable
        ? "Blue Iris still serves the exported file from its Clipboard storage."
        : "Blue Iris still reports the export record."
      record.status = "delete_pending";
    }
    return publicRecord(record);
  }

  async cleanup({ actor, token }) {
    const record = this.ownedRecord({ actor, token });
    if (!record.deletedAt) {
      throw new Error("Delete the exact Blue Iris export before removing the staging copy.");
    }
    if (!record.localRemovedAt && record.workspace) {
      await this.removeWorkspace(record.workspace);
      record.workspace = null;
    }
    record.localRemovedAt = record.localRemovedAt || new Date(this.now()).toISOString();
    record.status = "finished";
    const result = publicRecord(record);
    this.registry.delete(record.token);
    return result;
  }
}

export const blueIrisExportDiagnosticInternals = Object.freeze({
  DIAGNOSTIC_DURATION_MS,
  actorKey,
  isComplete,
  normalizedEpochMs,
  normalizedStart,
  publicRecord,
  pruneRegistry,
  remoteMetadata,
});
