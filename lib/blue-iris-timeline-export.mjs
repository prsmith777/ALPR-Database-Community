import crypto from "node:crypto";

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
const TIMELINE_EXPORT_ALGORITHM_REVISION = "overview-timeline-export-v2";

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
  // Once the start request has been dispatched, even a Blue Iris command-level
  // rejection is acceptance-uncertain. The installed server has returned a
  // rejection while still creating the MP4 several seconds later. Inputs are
  // validated before dispatch, so every exception here must reconcile against
  // the persisted pre-dispatch snapshot and must never trigger a blind resubmit.
  return Boolean(error);
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

function potentiallyMatchingExport(record, {
  camera,
  requestedStartMs,
  requestedDurationMs,
}) {
  if (!record?.remotePath) return false;
  const recordCamera = normalizedCamera(record.camera);
  if (recordCamera && recordCamera !== normalizedCamera(camera)) return false;
  const remoteStartMs = normalizedEpochMs(record.utc);
  if (remoteStartMs !== null && Math.abs(remoteStartMs - requestedStartMs) > 1_000) return false;
  const remoteDurationMs = Number(record.durationMs);
  if (Number.isFinite(remoteDurationMs)
    && Math.abs(remoteDurationMs - requestedDurationMs) > 250) return false;
  return true;
}

function remoteHasVerifiedMetadata(remote) {
  return Boolean(String(remote?.uri || remote?.remotePath || "").trim())
    && normalizedEpochMs(remote?.utc) !== null
    && Number.isFinite(Number(remote?.durationMs));
}

function canonicalDownloadRemote(remote) {
  if (!remoteHasVerifiedMetadata(remote)) return remote;
  return {
    ...remote,
    uri: String(remote.uri || remote.remotePath).trim(),
  };
}

function sameRemotePath(record, remote) {
  const ownedPath = String(remote?.remotePath || remote?.uri || "").trim();
  if (!ownedPath) return false;
  return [record?.remotePath, record?.uri]
    .some((value) => String(value || "").trim() === ownedPath);
}

function stableTimelineExportKey({
  readId,
  camera,
  requestedStartMs,
  requestedDurationMs,
  exportProfile,
  pairProfileId,
  profileRevision,
  profileKind = null,
  profileIdentity = null,
  algorithmRevision = TIMELINE_EXPORT_ALGORITHM_REVISION,
}) {
  const identityParts = {
    readId: Number(readId),
    camera: normalizedCamera(camera),
    requestedStartMs: Math.round(Number(requestedStartMs)),
    requestedDurationMs: Number(requestedDurationMs),
    exportProfile: Number(exportProfile),
    stream: "main",
    reencode: false,
    pairProfileId: Number(pairProfileId),
    profileRevision: Number(profileRevision),
    algorithmRevision: String(algorithmRevision),
  };
  if (profileKind) identityParts.profileKind = String(profileKind);
  if (profileIdentity) identityParts.profileIdentity = String(profileIdentity);
  const identity = JSON.stringify(identityParts);
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function remoteFromLedger(ledger) {
  if (!ledger?.remote_uri && !ledger?.remote_path) return null;
  return {
    remotePath: ledger.remote_path || null,
    uri: ledger.remote_uri || null,
    status: ledger.remote_status || ledger.status || "exporting",
    progress: ledger.progress ?? null,
    fileSize: ledger.file_size_bytes ?? null,
    utc: ledger.remote_utc_ms ?? null,
    durationMs: ledger.remote_duration_ms ?? ledger.requested_duration_ms ?? null,
    complete: ledger.status === "ready" || ledger.status === "downloaded",
    failed: false,
  };
}

function ledgerFailure(ledger) {
  const code = String(ledger?.error_code || "EXPORT_START_UNCERTAIN");
  const message = String(
    ledger?.error_details?.message
      || "Blue Iris may have accepted this export, so ALPR will not request it again automatically."
  );
  return new BlueIrisError(code, message, {
    details: {
      exportToken: ledger?.export_token || null,
      automaticStartCount: Number(ledger?.automatic_start_count || 0),
    },
  });
}

function reconciledRemoteMatch(matches, {
  allowEquivalentLegacyDuplicates = false,
  requestedCamera = null,
} = {}) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const downloadable = matches.filter((record) => remoteHasVerifiedMetadata(record));
  if (matches.length === 1) return downloadable[0] || null;
  if (!allowEquivalentLegacyDuplicates) return null;
  const identities = new Set(matches.map((record) => JSON.stringify({
    camera: normalizedCamera(record.camera) || normalizedCamera(requestedCamera),
    utc: normalizedEpochMs(record.utc),
    durationMs: Number.isFinite(Number(record.durationMs))
      ? Math.round(Number(record.durationMs))
      : null,
  })));
  if (identities.size !== 1) return null;
  return downloadable
    .sort((left, right) => String(left.remotePath || left.uri)
      .localeCompare(String(right.remotePath || right.uri)))[0] || null;
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

  logTransition(level, event, details = {}) {
    const writer = this.logger?.[level];
    if (typeof writer !== "function") return;
    writer.call(this.logger, "Blue Iris overview export", {
      event,
      ...details,
    });
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
    pairProfileId,
    profileRevision,
    profileKind = null,
    profileIdentity = null,
    algorithmRevision = TIMELINE_EXPORT_ALGORITHM_REVISION,
    assertActive = null,
  }) {
    const intendedStartMs = new Date(intendedStartAt).getTime();
    if (!read?.id || !claimToken || !camera || !Number.isFinite(intendedStartMs)) {
      throw new Error("A claimed read, camera, and intended timeline start are required.");
    }
    const requestedStartMs = intendedStartMs - TIMELINE_EXPORT_PADDING_MS;
    const exportKey = stableTimelineExportKey({
      readId: read.id,
      camera,
      requestedStartMs,
      requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
      exportProfile: this.exportProfile,
      pairProfileId,
      profileRevision,
      profileKind,
      profileIdentity,
      algorithmRevision,
    });
    const workspace = await this.media.createWorkspace();
    const ensureActive = async () => {
      if (typeof assertActive === "function") await assertActive();
    };
    let resolvedEquivalentMatches = 0;
    const resolveRemoteMetadata = async ({
      initialRemote = null,
      existingPaths = new Set(),
      allowEquivalentLegacyDuplicates = false,
    } = {}) => {
      let candidate = initialRemote;
      let lastMatchingJobs = 0;
      const maximumChecks = Math.max(1, Math.ceil(this.deadlineMs / this.pollIntervalMs));
      for (let check = 0; check < maximumChecks; check += 1) {
        if (remoteHasVerifiedMetadata(candidate)) return canonicalDownloadRemote(candidate);
        await this.sleepImpl(this.pollIntervalMs);
        await ensureActive();
        const records = await this.client.listTimelineExports();
        if (candidate?.remotePath || candidate?.uri) {
          const refreshed = records.find((record) => sameRemotePath(record, candidate));
          if (refreshed) candidate = { ...candidate, ...refreshed };
          lastMatchingJobs = refreshed ? 1 : 0;
          continue;
        }
        const matches = records.filter((record) => matchingUnknownStartExport(record, {
          camera,
          requestedStartMs,
          requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
          existingPaths,
        }));
        lastMatchingJobs = matches.length;
        const reconciled = reconciledRemoteMatch(matches, {
          allowEquivalentLegacyDuplicates,
          requestedCamera: camera,
        });
        if (reconciled) {
          candidate = reconciled;
          resolvedEquivalentMatches = matches.length;
        }
        if (matches.length > 1 && !reconciled) break;
      }
      throw new BlueIrisError(
        candidate ? "EXPORT_TIMELINE_UNVERIFIED" : "EXPORT_START_UNCERTAIN",
        candidate
          ? "Blue Iris reserved the owned export, but its URI and exact timeline metadata did not become verifiable before the deadline."
          : "Blue Iris may have accepted the export, but ALPR could not identify exactly one owned downloadable job. It will not be submitted again automatically.",
        { details: { matchingJobs: lastMatchingJobs } }
      );
    };
    let ledger;
    try {
      await ensureActive();
      ledger = await this.repository.beginTimelineExport({
        exportKey,
        readId: read.id,
        claimToken,
        sourceCameraName,
        requestedStartAt: new Date(requestedStartMs).toISOString(),
        requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
        hardDeadlineAt: read.vehicle_image_hard_deadline_at || null,
        pairProfileId,
        profileRevision,
        profileKind,
        profileIdentity,
        algorithmRevision,
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
    this.logTransition("info", "ledger_acquired", {
      readId: Number(read.id),
      exportToken,
      exportKey,
      automaticStartCount: Number(ledger?.automatic_start_count || 0),
      status: ledger?.status || null,
    });
    let remote = remoteFromLedger(ledger);
    try {
      if (!remote) {
        const alreadyRequested = Number(ledger?.automatic_start_count || 0) >= 1;
        if (alreadyRequested) {
          await ensureActive();
          const preexistingPaths = new Set(Array.isArray(ledger?.preexisting_remote_paths)
            ? ledger.preexisting_remote_paths.map((value) => String(value || "").trim()).filter(Boolean)
            : []);
          remote = await resolveRemoteMetadata({
            existingPaths: preexistingPaths,
            allowEquivalentLegacyDuplicates: ledger?.legacy_imported === true,
          });
          if (ledger?.legacy_imported === true) {
            this.logTransition("info", "legacy_duplicate_export_adopted", {
              readId: Number(read.id),
              exportToken,
              equivalentMatches: resolvedEquivalentMatches,
              selectedRemotePath: remote.remotePath || null,
            });
          }
          this.logTransition("info", "uncertain_start_adopted", {
            readId: Number(read.id),
            exportToken,
          });
        } else {
          const before = await this.client.listTimelineExports();
          const existingPaths = new Set(before
            .filter((record) => potentiallyMatchingExport(record, {
              camera,
              requestedStartMs,
              requestedDurationMs: TIMELINE_EXPORT_DURATION_MS,
            }))
            .map((record) => record.remotePath)
            .filter(Boolean));
          const startClaim = await this.repository.claimTimelineExportStart(
            exportToken,
            claimToken,
            [...existingPaths]
          );
          if (!startClaim) {
            ledger = await this.repository.getTimelineExport(exportToken);
            remote = remoteFromLedger(ledger);
            if (!remote) throw ledgerFailure(ledger);
          } else {
            ledger = startClaim;
            this.logTransition("info", "start_dispatched", {
              readId: Number(read.id),
              exportToken,
              sourceCameraName,
            });
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
              remote = await resolveRemoteMetadata({ existingPaths });
            }
          }
        }
      }
      remote = await resolveRemoteMetadata({
        initialRemote: remote,
        existingPaths: new Set(Array.isArray(ledger?.preexisting_remote_paths)
          ? ledger.preexisting_remote_paths
          : []),
        allowEquivalentLegacyDuplicates: ledger?.legacy_imported === true,
      });
      if (remote && ledger?.status !== "downloaded") {
        const transitioned = await this.repository.recordTimelineExportRemote(
          exportToken,
          remote,
          { claimToken }
        );
        if (!transitioned) {
          throw new BlueIrisError("EXPORT_CLAIM_LOST", "This export is now owned by a newer worker.");
        }
        ledger = transitioned;
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
      if (ledger?.status !== "downloaded") {
        const transitioned = await this.repository.recordTimelineExportRemote(
          exportToken,
          remote,
          { claimToken }
        );
        if (!transitioned) {
          throw new BlueIrisError("EXPORT_CLAIM_LOST", "This export is now owned by a newer worker.");
        }
        ledger = transitioned;
      }
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
      const downloaded = await this.repository.markTimelineExportDownloaded(exportToken, {
        uri: remote.uri,
        fileSize: probe.fileSize ?? remote.fileSize,
        width: probe.width,
        height: probe.height,
        durationMs: probe.durationMs,
      }, { claimToken });
      if (!downloaded) {
        throw new BlueIrisError("EXPORT_CLAIM_LOST", "This export is now owned by a newer worker.");
      }
      ledger = downloaded;
      this.logTransition("info", "download_validated", {
        readId: Number(read.id),
        exportToken,
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
      this.logTransition("warn", "failed", {
        readId: Number(read.id),
        exportToken,
        errorCode: error?.code || "TIMELINE_EXPORT_FAILED",
      });
      await this.repository.markTimelineExportFailed(exportToken, {
        errorCode: error?.code || "TIMELINE_EXPORT_FAILED",
        errorDetails: boundedErrorDetails(error),
      }, { claimToken }).catch(() => {});
      await this.media.removeWorkspace(workspace).catch(() => {});
      throw error;
    }
  }
}

export const blueIrisTimelineExportInternals = Object.freeze({
  boundedErrorDetails,
  ledgerFailure,
  matchingUnknownStartExport,
  normalizedEpochMs,
  reconciledRemoteMatch,
  remoteFromLedger,
  stableTimelineExportKey,
  TIMELINE_EXPORT_ALGORITHM_REVISION,
  uncertainStartError,
});
