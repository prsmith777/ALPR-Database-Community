import { BlueIrisClient } from "./blue-iris.mjs";
import { BlueIrisTimelineExportService } from "./blue-iris-timeline-export.mjs";
import {
  BlueIrisVehicleFrameService,
  OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
} from "./blue-iris-vehicle-frame.mjs";
import { StreetOverviewPairSharingService } from "./street-overview-pair-sharing.mjs";
import { EntryLprRouteFallbackService } from "./entry-lpr-route-fallback.mjs";
import {
  assessEntryOverviewHistoryDaylight,
  entryOverviewHistoryLifecycle,
  entryOverviewHistoryProfileFromClaim,
} from "./entry-overview-history-backfill.mjs";

const BLUE_IRIS_INITIALIZATION_BACKOFF_MS = 30_000;

function normalizedCameraKey(value) {
  return String(value || "").trim().toLowerCase();
}

function addCameraAlias(index, alias, camera) {
  const cameraKey = normalizedCameraKey(alias);
  if (!cameraKey) return;
  const matches = index.get(cameraKey) || [];
  if (!matches.some((item) => item.id === camera.id)) matches.push(camera);
  index.set(cameraKey, matches);
}

function uniqueCamera(index, alias) {
  const matches = index.get(normalizedCameraKey(alias)) || [];
  return matches.length === 1 ? matches[0] : null;
}

function blueIrisConfigured(config) {
  const settings = config?.blueiris || {};
  const host = String(settings.host || "").trim();
  return Boolean(
    host
    && !/your blue iris hostname/i.test(host)
    && String(settings.username || "").trim()
    && String(settings.password || "").trim()
  );
}

export class BlueIrisVehicleFrameQueue {
  constructor({
    repository,
    fileStorage,
    loadConfig,
    clientFactory = (settings) => new BlueIrisClient(settings),
    serviceFactory = (options) => new BlueIrisVehicleFrameService(options),
    timelineExportFactory = (options) => new BlueIrisTimelineExportService(options),
    pairSharingFactory = (options) => new StreetOverviewPairSharingService(options),
    entryFallbackFactory = (options) => new EntryLprRouteFallbackService(options),
    historyDaylightAssessor = assessEntryOverviewHistoryDaylight,
    logger = console,
  } = {}) {
    if (!repository || !fileStorage || typeof loadConfig !== "function") {
      throw new Error("Blue Iris vehicle-frame queue dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.loadConfig = loadConfig;
    this.clientFactory = clientFactory;
    this.serviceFactory = serviceFactory;
    this.timelineExportFactory = timelineExportFactory;
    this.pairSharingFactory = pairSharingFactory;
    this.entryFallbackFactory = entryFallbackFactory;
    this.historyDaylightAssessor = historyDaylightAssessor;
    this.logger = logger;
    this.cameraCache = null;
    this.cameraCacheAt = 0;
    this.batchRunning = false;
  }

  async getStatus() {
    const [config, queue, overview] = await Promise.all([
      this.loadConfig(),
      this.repository.getQueueStatus(),
      typeof this.repository.getOverviewStatus === "function"
        ? this.repository.getOverviewStatus()
        : Promise.resolve(null),
    ]);
    return { ...queue, overview, configured: blueIrisConfigured(config) };
  }

  async loadCameras(client, { force = false } = {}) {
    const now = Date.now();
    if (!force && this.cameraCache && now - this.cameraCacheAt < 5 * 60_000) {
      return this.cameraCache;
    }
    const connection = await client.testConnection();
    const cameras = new Map();
    for (const camera of connection.cameras || []) {
      const record = { id: camera.id, name: camera.name || camera.id };
      addCameraAlias(cameras, camera.id, record);
      addCameraAlias(cameras, camera.name, record);
    }
    this.cameraCache = cameras;
    this.cameraCacheAt = now;
    return cameras;
  }

  async processBatch({ limit = 1 } = {}) {
    if (this.batchRunning) return { busy: true, processed: 0, succeeded: 0, failed: 0 };
    this.batchRunning = true;
    try {
      const config = await this.loadConfig();
      if (!blueIrisConfigured(config)) {
        return { configured: false, processed: 0, succeeded: 0, failed: 0 };
      }
      const status = await this.repository.getQueueStatus();
      if (typeof this.repository.terminalizeExpiredOverviewReads === "function") {
        await this.repository.terminalizeExpiredOverviewReads();
      }
      if (typeof this.repository.terminalizeExpiredEntryOverviewBackfillJobs === "function") {
        await this.repository.terminalizeExpiredEntryOverviewBackfillJobs();
      }
      if (typeof this.repository.terminalizeExpiredEntryFallbackDecisions === "function") {
        await this.repository.terminalizeExpiredEntryFallbackDecisions();
      }
      const pairSharingService = this.pairSharingFactory({
        repository: this.repository,
        fileStorage: this.fileStorage,
        logger: this.logger,
      });
      const entryFallbackService = this.entryFallbackFactory({
        repository: this.repository,
        fileStorage: this.fileStorage,
        logger: this.logger,
      });
      let blueIrisContext = null;
      const ensureBlueIris = async () => {
        if (blueIrisContext) return blueIrisContext;
        const client = this.clientFactory(config.blueiris);
        const timelineExportService = this.timelineExportFactory({
          client,
          repository: this.repository,
          exportProfile: config.blueiris?.timeline_export_profile,
          minimumWidth: config.blueiris?.timeline_export_min_width,
          minimumHeight: config.blueiris?.timeline_export_min_height,
          logger: this.logger,
        });
        await Promise.all([
          timelineExportService.sweepLocalWorkspaces(),
          timelineExportService.reconcileRemoteExports(),
        ]);
        const cameras = await this.loadCameras(client);
        blueIrisContext = {
          cameras,
          service: this.serviceFactory({
            client,
            repository: this.repository,
            fileStorage: this.fileStorage,
          }),
          overviewService: this.serviceFactory({
            client,
            repository: this.repository,
            fileStorage: this.fileStorage,
            sampleOffsetsMs: OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
            extensionOffsetsMs: [],
            deepExtensionOffsetsMs: [],
            timelineExportService,
          }),
        };
        return blueIrisContext;
      };
      const markBlueIrisInitializationFailure = async ({ read, profile = null }) => {
        const attemptCount = Number(read.vehicle_image_attempt_count || 0);
        const retryable = attemptCount < (read.vehicle_image_queue_kind === "overview" ? 2 : 3);
        const errorCode = "BLUE_IRIS_INITIALIZATION_FAILED";
        const failed = await this.repository.markFailed(read.id, {
          status: "failed",
          errorCode,
          retryable,
          nextAttemptAt: retryable
            ? new Date(Date.now() + BLUE_IRIS_INITIALIZATION_BACKOFF_MS).toISOString()
            : null,
          claimToken: read.vehicle_image_claim_token || null,
          selectionMetadata: profile ? {
            overviewContext: profile.overview_context || "street",
            sourceCameraName: profile.source_camera_name || null,
            sourceCameraId: profile.source_camera_short_name || null,
            sourceCameraShortName: profile.source_camera_short_name || null,
            profileId: Number(profile.id),
            profileRevision: Number(profile.revision || 1),
          } : null,
        });
        if (!failed && read.vehicle_image_claim_token
          && typeof this.repository.releaseOverviewReadClaim === "function") {
          await this.repository.releaseOverviewReadClaim(
            read.id,
            read.vehicle_image_claim_token
          );
        }
        return {
          kind: read.vehicle_image_queue_kind === "overview" ? "overview_read" : "read",
          status: retryable ? "retry_scheduled" : "failed",
          readId: Number(read.id),
          errorCode,
        };
      };
      const markEntryHistoryFailure = async ({
        read,
        errorCode,
        retryable = false,
        unavailable = false,
        errorDetails = null,
      }) => {
        const jobId = Number(read?.entry_history_job_id);
        const claimToken = String(read?.vehicle_image_claim_token || "").trim();
        const failed = await this.repository.markEntryOverviewBackfillFailed(jobId, {
          claimToken,
          errorCode,
          errorDetails,
          retryable,
          nextAttemptAt: retryable
            ? new Date(Date.now() + BLUE_IRIS_INITIALIZATION_BACKOFF_MS).toISOString()
            : null,
          unavailable,
        });
        return {
          kind: "entry_overview_backfill",
          status: failed?.status === "superseded"
            ? "superseded"
            : retryable ? "retry_scheduled" : unavailable ? "unavailable" : "failed",
          readId: Number(read?.id),
          errorCode,
        };
      };
      const processLegacyRead = async (read) => {
        let context;
        try {
          context = await ensureBlueIris();
        } catch (error) {
          this.logger?.error?.("Blue Iris initialization failed for a claimed vehicle-view read", {
            readId: Number(read.id),
            code: String(error?.code || ""),
            message: String(error?.message || error),
          });
          initializationBackoff = true;
          return markBlueIrisInitializationFailure({ read });
        }
        const { cameras, service } = context;
        const camera = uniqueCamera(cameras, read.camera_name);
        if (!camera) {
          await this.repository.markFailed(read.id, {
            status: "unavailable",
            errorCode: "CAMERA_NOT_MAPPED",
            retryable: false,
          });
          return {
            status: "unavailable",
            readId: Number(read.id),
            errorCode: "CAMERA_NOT_MAPPED",
          };
        }
        return service.processRead({
          read,
          camera: camera.id,
          alreadyClaimed: true,
        });
      };
      const boundedLimit = Math.min(5, Math.max(1, Number.parseInt(String(limit), 10) || 1));
      const results = [];
      let initializationBackoff = false;
      for (let index = 0; index < boundedLimit; index += 1) {
        const pairShare = await pairSharingService.processNext();
        if (pairShare) {
          results.push(pairShare);
          continue;
        }
        const entryFallback = await entryFallbackService.processNext();
        if (entryFallback) {
          results.push(entryFallback);
          continue;
        }
        const overviewRead = typeof this.repository.claimNextOverviewRead === "function"
          ? await this.repository.claimNextOverviewRead()
          : null;
        if (overviewRead) {
          const profile = overviewRead.overview_profile_id
            ? {
                id: overviewRead.overview_profile_id,
                source_camera_name: overviewRead.overview_source_camera_name,
                plate_camera_name: overviewRead.camera_name,
                direction_label: overviewRead.bi_trigger_direction_label,
                source_role: "primary",
                overview_context: overviewRead.overview_context || "street",
                source_camera_short_name: overviewRead.overview_source_camera_short_name || null,
                expected_delta_ms: overviewRead.overview_expected_delta_ms,
                tolerance_ms: overviewRead.overview_tolerance_ms,
                priority: overviewRead.overview_profile_priority,
                revision: overviewRead.overview_profile_revision,
                updated_at: overviewRead.overview_profile_updated_at,
                enabled: true,
              }
            : null;
          const profileMatchCount = Number(overviewRead.overview_profile_match_count || 0);
          if (profileMatchCount > 1) {
            await this.repository.markFailed(overviewRead.id, {
              status: "unavailable",
              errorCode: "OVERVIEW_PROFILE_AMBIGUOUS",
              retryable: false,
              claimToken: overviewRead.vehicle_image_claim_token,
              selectionMetadata: profile ? {
                overviewContext: profile.overview_context || "street",
                sourceCameraName: profile.source_camera_name || null,
                sourceCameraId: profile.source_camera_short_name || null,
                sourceCameraShortName: profile.source_camera_short_name || null,
                profileId: Number(profile.id),
                profileRevision: Number(profile.revision || 1),
              } : null,
            });
            results.push({
              kind: "overview_read",
              status: "unavailable",
              readId: Number(overviewRead.id),
              errorCode: "OVERVIEW_PROFILE_AMBIGUOUS",
            });
            continue;
          }
          if (!profile) {
            await this.repository.markFailed(overviewRead.id, {
              status: "unavailable",
              errorCode: "OVERVIEW_PROFILE_NOT_CONFIGURED",
              retryable: false,
              claimToken: overviewRead.vehicle_image_claim_token,
            });
            results.push({
              kind: "overview_read",
              status: "unavailable",
              readId: Number(overviewRead.id),
              errorCode: "OVERVIEW_PROFILE_NOT_CONFIGURED",
            });
            continue;
          }
          if (profile.overview_context === "entry"
            && !String(profile.source_camera_short_name || "").trim()) {
            await this.repository.markFailed(overviewRead.id, {
              status: "unavailable",
              errorCode: "OVERVIEW_CAMERA_BINDING_INVALID",
              retryable: false,
              claimToken: overviewRead.vehicle_image_claim_token,
              selectionMetadata: {
                overviewContext: profile.overview_context || "street",
                sourceCameraName: profile.source_camera_name || null,
                sourceCameraId: profile.source_camera_short_name || null,
                sourceCameraShortName: profile.source_camera_short_name || null,
                profileId: Number(profile.id),
                profileRevision: Number(profile.revision || 1),
              },
            });
            results.push({
              kind: "overview_read",
              status: "unavailable",
              readId: Number(overviewRead.id),
              errorCode: "OVERVIEW_CAMERA_BINDING_INVALID",
            });
            continue;
          }
          let context;
          try {
            context = await ensureBlueIris();
          } catch (error) {
            this.logger?.error?.("Blue Iris initialization failed for a claimed overview read", {
              readId: Number(overviewRead.id),
              code: String(error?.code || ""),
              message: String(error?.message || error),
            });
            results.push(await markBlueIrisInitializationFailure({ read: overviewRead, profile }));
            initializationBackoff = true;
            break;
          }
          const { cameras, overviewService } = context;
          const cameraByName = uniqueCamera(cameras, profile.source_camera_name);
          const cameraByShortName = profile.source_camera_short_name
            ? uniqueCamera(cameras, profile.source_camera_short_name)
            : null;
          const isEntryOverview = profile.overview_context === "entry";
          const bindingMismatch = isEntryOverview
            ? !cameraByName || !cameraByShortName || cameraByName.id !== cameraByShortName.id
            : Boolean(
                profile.source_camera_short_name
                && (!cameraByShortName || (cameraByName && cameraByName.id !== cameraByShortName.id))
              );
          const overviewCamera = bindingMismatch ? null : cameraByShortName || cameraByName;
          if (!overviewCamera) {
            const errorCode = bindingMismatch
              ? "OVERVIEW_CAMERA_BINDING_MISMATCH"
              : "CAMERA_NOT_MAPPED";
            const failed = await this.repository.markFailed(overviewRead.id, {
              status: "unavailable",
              errorCode,
              retryable: false,
              claimToken: overviewRead.vehicle_image_claim_token,
              selectionMetadata: {
                overviewContext: profile.overview_context || "street",
                sourceCameraName: profile.source_camera_name || null,
                sourceCameraId: profile.source_camera_short_name || null,
                sourceCameraShortName: profile.source_camera_short_name || null,
                profileId: Number(profile.id),
                profileRevision: Number(profile.revision || 1),
              },
            });
            if (!failed && typeof this.repository.releaseOverviewReadClaim === "function") {
              await this.repository.releaseOverviewReadClaim(
                overviewRead.id,
                overviewRead.vehicle_image_claim_token
              );
            }
            results.push({
              kind: "overview_read",
              status: "unavailable",
              readId: Number(overviewRead.id),
              errorCode,
            });
          } else {
            results.push(await overviewService.processOverviewRead({
              read: overviewRead,
              profile,
              camera: overviewCamera.id,
              alreadyClaimed: true,
            }));
          }
          continue;
        }

        const liveRead = await this.repository.claimNext({ includeHistorical: false });
        if (liveRead) {
          results.push(await processLegacyRead(liveRead));
          if (initializationBackoff) break;
          continue;
        }

        const entryHistoryRead = typeof this.repository.claimNextEntryOverviewBackfillJob === "function"
          ? await this.repository.claimNextEntryOverviewBackfillJob({ requireNoLiveWork: true })
          : null;
        if (entryHistoryRead) {
          const historyProfile = entryOverviewHistoryProfileFromClaim(entryHistoryRead);
          if (!historyProfile) {
            results.push(await markEntryHistoryFailure({
              read: entryHistoryRead,
              errorCode: "ENTRY_HISTORY_PROFILE_INVALID",
              unavailable: true,
            }));
            continue;
          }
          const daylight = await this.historyDaylightAssessor(
            entryHistoryRead,
            this.fileStorage
          );
          const recorded = await this.repository.recordEntryOverviewBackfillDaylight(
            entryHistoryRead.entry_history_job_id,
            entryHistoryRead.vehicle_image_claim_token,
            { status: daylight.status, evidence: daylight.evidence }
          );
          if (!recorded) {
            results.push({
              kind: "entry_overview_backfill",
              status: "superseded",
              readId: Number(entryHistoryRead.id),
            });
            continue;
          }
          entryHistoryRead.entry_overview_daylight_evidence = daylight.evidence;
          entryHistoryRead.entry_overview_backfill_job_id = entryHistoryRead.entry_history_job_id;
          entryHistoryRead.entry_overview_backfill_run_id = entryHistoryRead.entry_history_run_id;
          if (daylight.status !== "eligible") {
            results.push(await markEntryHistoryFailure({
              read: entryHistoryRead,
              errorCode: daylight.errorCode,
              unavailable: true,
              errorDetails: { daylightEvidence: daylight.evidence },
            }));
            continue;
          }

          let context;
          try {
            context = await ensureBlueIris();
          } catch (error) {
            this.logger?.error?.("Blue Iris initialization failed for Entry Overview history", {
              readId: Number(entryHistoryRead.id),
              jobId: Number(entryHistoryRead.entry_history_job_id),
              code: String(error?.code || ""),
              message: String(error?.message || error),
            });
            const retryable = Number(entryHistoryRead.vehicle_image_attempt_count || 0) < 2;
            results.push(await markEntryHistoryFailure({
              read: entryHistoryRead,
              errorCode: "BLUE_IRIS_INITIALIZATION_FAILED",
              retryable,
              errorDetails: {
                code: String(error?.code || ""),
                message: String(error?.message || error).slice(0, 300),
              },
            }));
            initializationBackoff = true;
            break;
          }
          const cameraByName = uniqueCamera(context.cameras, historyProfile.source_camera_name);
          const cameraByShortName = uniqueCamera(
            context.cameras,
            historyProfile.source_camera_short_name
          );
          if (!cameraByName || !cameraByShortName || cameraByName.id !== cameraByShortName.id) {
            results.push(await markEntryHistoryFailure({
              read: entryHistoryRead,
              errorCode: "OVERVIEW_CAMERA_BINDING_MISMATCH",
              unavailable: true,
              errorDetails: {
                sourceCameraName: historyProfile.source_camera_name,
                sourceCameraShortName: historyProfile.source_camera_short_name,
              },
            }));
            continue;
          }
          results.push(await context.overviewService.processOverviewRead({
            read: entryHistoryRead,
            profile: historyProfile,
            camera: cameraByShortName.id,
            alreadyClaimed: true,
            lifecycle: entryOverviewHistoryLifecycle(this.repository, entryHistoryRead),
          }));
          continue;
        }

        if (status.historicalPaused !== true) {
          const historicalRead = await this.repository.claimNext({ includeHistorical: true });
          if (historicalRead) {
            results.push(await processLegacyRead(historicalRead));
            if (initializationBackoff) break;
            continue;
          }
        }
        break;
      }
      const succeeded = results.filter((result) => ["ready", "associated", "shared"].includes(result.status)).length;
      return {
        configured: true,
        processed: results.length,
        succeeded,
        failed: results.length - succeeded,
        backoff: initializationBackoff,
        backoffMs: initializationBackoff ? BLUE_IRIS_INITIALIZATION_BACKOFF_MS : 0,
        backoffUntil: initializationBackoff
          ? new Date(Date.now() + BLUE_IRIS_INITIALIZATION_BACKOFF_MS).toISOString()
          : null,
        results,
      };
    } catch (error) {
      this.cameraCache = null;
      this.logger?.error?.("Blue Iris vehicle-frame batch failed", {
        code: String(error?.code || ""),
        message: String(error?.message || error),
      });
      throw error;
    } finally {
      this.batchRunning = false;
    }
  }

  async queueHistorical(input = {}) {
    return this.repository.queueHistorical(input);
  }

  async cancelHistorical(input = {}) {
    await this.repository.setHistoricalPaused(true);
    return this.repository.cancelHistorical(input);
  }

  async setHistoricalPaused(paused) {
    return this.repository.setHistoricalPaused(paused === true);
  }
}

export const blueIrisVehicleFrameQueueInternals = Object.freeze({
  BLUE_IRIS_INITIALIZATION_BACKOFF_MS,
  addCameraAlias,
  blueIrisConfigured,
  normalizedCameraKey,
  uniqueCamera,
});
