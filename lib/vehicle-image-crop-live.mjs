const LIVE_RETRY_LIMIT = 5;

const TERMINAL_INVALID_CODES = new Set([
  "VEHICLE_IMAGE_CROP_CONFLICT",
  "VEHICLE_IMAGE_CROP_INVALID_BOX",
  "VEHICLE_IMAGE_CROP_INVALID_HASH",
  "VEHICLE_IMAGE_CROP_INVALID_SOURCE",
]);

const TERMINAL_CHANGED_CODES = new Set([
  "VEHICLE_IMAGE_CROP_PREVIEW_CHANGED",
  "VEHICLE_IMAGE_CROP_SOURCE_CHANGED",
]);

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_IMAGE_CROP_LIVE_FAILED").trim().slice(0, 80),
    message: String(error?.message || "Automatic canonical Overview vehicle crop failed")
      .trim().slice(0, 500),
  };
}

export function vehicleCropLiveFailureDisposition(error, job) {
  const details = safeError(error);
  if (TERMINAL_INVALID_CODES.has(details.code)) {
    return { ...details, status: "invalid", retryable: false };
  }
  if (TERMINAL_CHANGED_CODES.has(details.code)) {
    return { ...details, status: "source_changed", retryable: false };
  }
  const exhausted = Number(job?.attempt_count || 0) >= LIVE_RETRY_LIMIT;
  if (details.code === "VEHICLE_IMAGE_CROP_SOURCE_MISSING" && exhausted) {
    return { ...details, status: "unavailable", retryable: false };
  }
  return { ...details, status: "failed", retryable: !exhausted };
}

function exactJobSnapshot(job) {
  return {
    ...job,
    evidence_source_updated_at: job.evidence_source_updated_at_exact
      ?? job.evidence_source_updated_at
      ?? null,
  };
}

export class VehicleImageCropLiveService {
  constructor({ repository, cropService, logger = console } = {}) {
    if (!repository || !cropService) {
      throw new Error("Automatic vehicle crop dependencies are required");
    }
    this.repository = repository;
    this.cropService = cropService;
    this.logger = logger;
    this.processing = false;
  }

  getOverview() { return this.repository.getOverview(); }
  setEnabled(input) { return this.repository.setEnabled(input); }
  retryJob(input) { return this.repository.retryJob(input); }

  async processItem(job) {
    const snapshot = exactJobSnapshot(job);
    try {
      const preview = await this.cropService.preview(snapshot);
      const result = await this.cropService.catalog({
        ...snapshot,
        preview_sha256: preview.contentSha256,
        preview_path: preview.storagePath,
        preview_byte_size: preview.byteSize,
        preview_width: preview.imageWidth,
        preview_height: preview.imageHeight,
        preview_crop_box: preview.cropBox,
      });
      const completed = await this.repository.completeJob(job, result);
      return {
        status: completed
          ? (result.derivativeCreated ? "ready" : "already_current")
          : "source_changed",
        assetId: Number(job.asset_id),
        derivativeId: result.derivative?.id == null ? null : Number(result.derivative.id),
      };
    } catch (error) {
      const disposition = vehicleCropLiveFailureDisposition(error, job);
      await this.repository.failClaimedJob(job, {
        status: disposition.status,
        errorCode: disposition.code,
        errorDetails: { message: disposition.message },
        retryable: disposition.retryable,
      });
      if (!disposition.retryable) {
        this.logger?.warn?.("Automatic canonical Overview vehicle crop terminalized", {
          assetId: Number(job.asset_id),
          status: disposition.status,
          errorCode: disposition.code,
        });
      }
      return {
        status: disposition.status,
        assetId: Number(job.asset_id),
        errorCode: disposition.code,
      };
    }
  }

  async processBatch({ limit = 1 } = {}) {
    if (this.processing) {
      return { busy: true, processed: 0, succeeded: 0, failed: 0, status: "busy" };
    }
    this.processing = true;
    try {
      await this.repository.reclaimExpiredClaims();
      const activation = await this.repository.getActivation();
      if (activation.state !== "active") {
        return {
          busy: false,
          processed: 0,
          succeeded: 0,
          failed: 0,
          status: "idle",
          activation: activation.state,
        };
      }
      const bounded = Math.min(5, Math.max(1, Number.parseInt(String(limit), 10) || 1));
      const discovered = await this.repository.materializeCandidates({
        limit: Math.max(25, bounded * 5),
      });
      const results = [];
      for (let index = 0; index < bounded; index += 1) {
        const job = await this.repository.claimNext();
        if (!job) break;
        results.push(await this.processItem(job));
      }
      const succeeded = results.filter((item) => (
        ["ready", "already_current"].includes(item.status)
      )).length;
      return {
        busy: false,
        processed: results.length,
        succeeded,
        failed: results.length - succeeded,
        discovered,
        status: results.length > 0 || discovered > 0 ? "working" : "idle",
        activation: activation.state,
        results,
      };
    } finally {
      this.processing = false;
    }
  }
}

export const vehicleImageCropLiveInternals = Object.freeze({
  LIVE_RETRY_LIMIT,
  TERMINAL_CHANGED_CODES,
  TERMINAL_INVALID_CODES,
  exactJobSnapshot,
  safeError,
});
