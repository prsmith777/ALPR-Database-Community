import {
  createTimelineExportWorkspace,
  extractTimelineAnalysisFrames,
  extractTimelineFinalFrame,
  probeTimelineExport,
  removeTimelineExportWorkspace,
  sweepTimelineExportWorkspaces,
  TIMELINE_ANALYSIS_DURATION_MS,
  TIMELINE_EXPORT_DURATION_MS,
  TIMELINE_EXPORT_PADDING_MS,
} from "./blue-iris-timeline-media.mjs";
import { BlueIrisError } from "./blue-iris.mjs";

const DEFAULT_EXPORT_DEADLINE_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MINIMUM_WIDTH = 1_920;
const DEFAULT_MINIMUM_HEIGHT = 1_080;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizedEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric);
}

function boundedErrorDetails(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  return {
    message: String(error?.message || "Timeline export failed.").slice(0, 1_000),
    ...(details ? { details } : {}),
  };
}

function normalizedCamera(value) {
  return String(value || "").trim().toLowerCase();
}

function uncertainStartError(error) {
  return ["TIMEOUT", "CONNECTION_FAILED", "HTTP_ERROR", "INVALID_RESPONSE"]
    .includes(String(error?.code || ""));
}

function matchingUnknownStartExport(record, {
  camera,
  requestedStartMs,
  requestedDurationMs,
  existingPaths,
}) {
  const remoteStartMs = normalizedEpochMs(record?.utc);
  return record?.remotePath
    && !existingPaths.has(record.remotePath)
    && (!normalizedCamera(record.camera)
      || normalizedCamera(record.camera) === normalizedCamera(camera))
    && remoteStartMs !== null
    && Math.abs(remoteStartMs - requestedStartMs) <= 1_000
    && Number.isFinite(Number(record.durationMs))
    && Math.abs(Number(record.durationMs) - requestedDurationMs) <= 250;
}

export class BlueIrisTimelineExportService {
  constructor({
    client,
    repository,
    exportProfile = 0,
    minimumWidth = DEFAULT_MINIMUM_WIDTH,
    minimumHeight = DEFAULT_MINIMUM_HEIGHT,
    deadlineMs = DEFAULT_EXPORT_DEADLINE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleepImpl = sleep,
    media = {},
    logger = console,
  } = {}) {
    if (!client || !repository) {
      throw new Error("Blue Iris timeline export dependencies are required.");
    }
    this.client = client;
    this.repository = repository;
    this.exportProfile = Math.min(3, Math.max(0, Number.parseInt(String(exportProfile), 10) || 0));
    this.minimumWidth = Math.max(320, Number.parseInt(String(minimumWidth), 10) || DEFAULT_MINIMUM_WIDTH);
    this.minimumHeight = Math.max(180, Number.parseInt(String(minimumHeight), 10) || DEFAULT_MINIMUM_HEIGHT);
    this.deadlineMs = Math.min(180_000, Math.max(15_000, Number(deadlineMs) || DEFAULT_EXPORT_DEADLINE_MS));
    this.pollIntervalMs = Math.min(
      30_000,
      Math.max(5_000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
    );
    this.sleepImpl = sleepImpl;
    this.media = {
      createWorkspace: media.createWorkspace || createTimelineExportWorkspace,
      removeWorkspace: media.removeWorkspace || removeTimelineExportWorkspace,
      sweepWorkspaces: media.sweepWorkspaces || sweepTimelineExportWorkspaces,
      probe: media.probe || probeTimelineExport,
      extractAnalysisFrames: media.extractAnalysisFrames || extractTimelineAnalysisFrames,
      extractFinalFrame: media.extractFinalFrame || extractTimelineFinalFrame,
    };
    this.logger = logger;
  }

  async reconcileRemoteExports({ limit = 20 } = {}) {
    // Blue Iris owns Clipboard retention. The ALPR account intentionally lacks
    // Administrator permission, so workers must never request remote deletion.
    void limit;
    return { examined: 0, deleted: 0, failed: 0, retentionManagedBy: "blue_iris" };
  }

  async sweepLocalWorkspaces() {
    return this.media.sweepWorkspaces();
  }

  async acquire({
    read,
    claimToken,
    camera,
    sourceCameraName,
    intendedStartAt,
    assertActive = null,
  }) {
    const intendedStartMs = new Date(intendedStartAt).getTime();
    if (!read?.id || !claimToken || !camera || !Number.isFinite(intendedStartMs)) {
      throw new Error("A claimed read, camera, and intended timeline start are required.");
    }
    const requestedStartMs = intendedStartMs - TIMELINE_EXPORT_PADDING_MS;
    const workspace = await this.media.createWorkspace();
    const ensureActive = async () => {
      if (typeof assertActive === "function") await assertActive();
    };
    let ledger;
    try {
      await ensureActive();
      ledger = await this.repository.beginTimelineExport({
        readId: read.id,
        claimToken,
        sourceCameraName,
        requestedStartAt: new Date(requestedStartMs).toISOString(),
        requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
        hardDeadlineAt: read.vehicle_image_hard_deadline_at || null,
      });
    } catch (error) {
      await this.media.removeWorkspace(workspace).catch(() => {});
      throw error;
    }
    const exportToken = ledger?.export_token;
    if (!exportToken) {
      await this.media.removeWorkspace(workspace).catch(() => {});
      throw new BlueIrisError("EXPORT_LEDGER_FAILED", "Unable to create the Blue Iris export ledger.");
    }
    let remote = null;
    try {
      const before = await this.client.listTimelineExports();
      const existingPaths = new Set(before.map((record) => record.remotePath));
      await ensureActive();
      try {
        remote = await this.client.startTimelineExport({
          camera,
          start: new Date(requestedStartMs),
          durationMs: TIMELINE_EXPORT_DURATION_MS,
          profile: this.exportProfile,
          reencode: false,
          substream: false,
        });
      } catch (error) {
        if (!uncertainStartError(error)) throw error;
        let matches = [];
        for (let attempt = 0; attempt < 5 && matches.length === 0; attempt += 1) {
          await this.sleepImpl(this.pollIntervalMs);
          await ensureActive();
          const after = await this.client.listTimelineExports();
          matches = after.filter((record) => matchingUnknownStartExport(record, {
            camera,
            requestedStartMs,
            requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
            existingPaths,
          }));
        }
        if (matches.length !== 1) {
          throw new BlueIrisError(
            "EXPORT_START_UNCERTAIN",
            "Blue Iris may have accepted the export, but ALPR could not identify exactly one owned job.",
            { details: { matchingJobs: matches.length, originalCode: error?.code || null } }
          );
        }
        remote = matches[0];
      }
      await this.repository.recordTimelineExportRemote(exportToken, remote);
      if (!remote.uri) {
        throw new BlueIrisError("EXPORT_URI_MISSING", "Blue Iris did not reserve a download URI for the export.");
      }
      const verifiedRemoteStartMs = normalizedEpochMs(remote.utc);
      if (verifiedRemoteStartMs === null || !Number.isFinite(Number(remote.durationMs))) {
        throw new BlueIrisError(
          "EXPORT_TIMELINE_UNVERIFIED",
          "Blue Iris did not return the export UTC start and duration required for exact frame alignment."
        );
      }
      if (Math.abs(Number(remote.durationMs) - TIMELINE_EXPORT_DURATION_MS) > 250) {
        throw new BlueIrisError(
          "EXPORT_TIMELINE_MISMATCH",
          "Blue Iris returned an export duration that does not match the requested eight seconds.",
          { details: { durationMs: remote.durationMs } }
        );
      }
      const deadline = Date.now() + this.deadlineMs;
      let availability = null;
      while (!availability?.available) {
        if (remote.failed) {
          throw new BlueIrisError(
            "EXPORT_FAILED",
            remote.error || "Blue Iris failed to create the timeline export."
          );
        }
        if (Date.now() >= deadline) {
          throw new BlueIrisError("EXPORT_TIMEOUT", "Blue Iris did not finish the export before the deadline.");
        }
        await ensureActive();
        await this.sleepImpl(this.pollIntervalMs);
        await ensureActive();
        availability = await this.client.checkTimelineExportDownloadAvailability(remote.uri);
      }
      remote = { ...remote, status: "download_ready", progress: 100, complete: true };
      await this.repository.recordTimelineExportRemote(exportToken, remote);
      await ensureActive();
      await this.client.downloadTimelineExport({
        uri: remote.uri,
        destinationPath: workspace.clipPath,
      });
      await ensureActive();
      const probe = await this.media.probe(workspace.clipPath);
      if (probe.width < this.minimumWidth || probe.height < this.minimumHeight) {
        throw new BlueIrisError(
          "EXPORT_RESOLUTION_TOO_LOW",
          `Blue Iris exported ${probe.width}x${probe.height}; at least ${this.minimumWidth}x${this.minimumHeight} is required.`,
          { details: { width: probe.width, height: probe.height } }
        );
      }
      if (probe.durationMs < TIMELINE_EXPORT_DURATION_MS - 500) {
        throw new BlueIrisError(
          "EXPORT_DURATION_TOO_SHORT",
          `Blue Iris exported ${probe.durationMs}ms; the padded timeline export is incomplete.`
        );
      }
      const remoteStartMs = verifiedRemoteStartMs;
      const trimStartMs = intendedStartMs - remoteStartMs;
      if (trimStartMs < 0
        || trimStartMs + TIMELINE_ANALYSIS_DURATION_MS > probe.durationMs + 100) {
        throw new BlueIrisError(
          "EXPORT_TIMELINE_MISMATCH",
          "The Blue Iris export does not cover the intended six-second analysis window.",
          { details: { requestedStartMs, remoteStartMs, trimStartMs, durationMs: probe.durationMs } }
        );
      }
      await this.repository.markTimelineExportDownloaded(exportToken, {
        uri: remote.uri,
        fileSize: probe.fileSize ?? remote.fileSize,
        width: probe.width,
        height: probe.height,
        durationMs: probe.durationMs,
      });
      await ensureActive();
      const frames = await this.media.extractAnalysisFrames({
        inputPath: workspace.clipPath,
        outputDirectory: workspace.framesDirectory,
        trimStartMs,
      });
      await ensureActive();
      return {
        exportToken,
        remotePath: remote.remotePath,
        remoteRetentionManaged: true,
        workspace,
        probe,
        requestedStartMs,
        remoteStartMs,
        trimStartMs,
        utcVerified: true,
        frames,
        extractFinalFrame: ({ selectedOffsetMs }) => this.media.extractFinalFrame({
          inputPath: workspace.clipPath,
          outputPath: workspace.finalFramePath,
          trimStartMs,
          selectedFrameIndex: Math.round(Number(selectedOffsetMs || 0) / 100),
        }),
        cleanup: () => this.media.removeWorkspace(workspace),
      };
    } catch (error) {
      await this.repository.markTimelineExportFailed(exportToken, {
        errorCode: error?.code || "TIMELINE_EXPORT_FAILED",
        errorDetails: boundedErrorDetails(error),
      }).catch(() => {});
      await this.media.removeWorkspace(workspace).catch(() => {});
      throw error;
    }
  }
}

export const blueIrisTimelineExportInternals = Object.freeze({
  boundedErrorDetails,
  matchingUnknownStartExport,
  normalizedEpochMs,
  uncertainStartError,
});
