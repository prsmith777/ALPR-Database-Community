const TERMINAL_INVALID_CODES = new Set([
  "VEHICLE_IMAGE_CROP_INVALID_BOX",
  "VEHICLE_IMAGE_CROP_INVALID_SOURCE",
  "VEHICLE_IMAGE_CROP_INVALID_HASH",
]);

const TERMINAL_CHANGED_CODES = new Set([
  "VEHICLE_IMAGE_CROP_SOURCE_CHANGED",
  "VEHICLE_IMAGE_CROP_PREVIEW_CHANGED",
]);

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_IMAGE_CROP_FAILED").trim().slice(0, 80),
    message: String(error?.message || "Canonical Overview vehicle crop failed")
      .trim().slice(0, 500),
  };
}

export function vehicleCropFailureDisposition(error, job) {
  const details = safeError(error);
  if (TERMINAL_INVALID_CODES.has(details.code)) {
    return { ...details, status: "invalid", retryable: false };
  }
  if (TERMINAL_CHANGED_CODES.has(details.code)) {
    return { ...details, status: "source_changed", retryable: false };
  }
  const exhausted = Number(job?.attempt_count || 0) >= 3;
  return {
    ...details,
    status: details.code === "VEHICLE_IMAGE_CROP_SOURCE_MISSING" && exhausted
      ? "invalid"
      : "failed",
    retryable: !exhausted,
  };
}

export class VehicleImageCropCampaignService {
  constructor({ repository, cropService, liveCrop = null, logger = console } = {}) {
    if (!repository || !cropService) {
      throw new Error("Vehicle crop campaign dependencies are required");
    }
    this.repository = repository;
    this.cropService = cropService;
    this.liveCrop = liveCrop;
    this.logger = logger;
    this.processing = false;
  }

  async createPreview(input) {
    const live = await this.liveCrop?.getOverview?.();
    if (live?.enabled === true) {
      throw new Error(
        "Disable automatic vehicle cropping before creating an operator crop preview."
      );
    }
    return this.repository.createPreview(input);
  }
  confirmBatch(input) { return this.repository.confirmBatch(input); }
  setPaused(input) { return this.repository.setPaused(input); }
  cancel(input) { return this.repository.cancel(input); }
  retryJob(input) { return this.repository.retryJob(input); }
  async getOverview() {
    const [overview, live] = await Promise.all([
      this.repository.getOverview(),
      this.liveCrop?.getOverview?.() ?? null,
    ]);
    return { ...overview, live };
  }

  async setLiveEnabled(input) {
    if (!this.liveCrop?.setEnabled) {
      throw new Error("Automatic vehicle cropping is unavailable.");
    }
    return this.liveCrop.setEnabled(input);
  }

  async retryLiveJob(input) {
    if (!this.liveCrop?.retryJob) {
      throw new Error("Automatic vehicle cropping is unavailable.");
    }
    return this.liveCrop.retryJob(input);
  }

  async processPreviewJob(job) {
    try {
      const preview = await this.cropService.preview(job);
      const completed = await this.repository.completePreviewJob(job, preview);
      return { status: completed ? "previewed" : "source_changed", assetId: Number(job.asset_id) };
    } catch (error) {
      const disposition = vehicleCropFailureDisposition(error, job);
      await this.repository.failJob(job, {
        stage: "preview",
        status: disposition.status,
        errorCode: disposition.code,
        message: disposition.message,
        retryable: disposition.retryable,
      });
      return { status: disposition.status, assetId: Number(job.asset_id), errorCode: disposition.code };
    }
  }

  async processCatalogJob(job) {
    try {
      const result = await this.cropService.catalog(job);
      const completed = await this.repository.completeCatalogJob(job, result);
      return {
        status: completed
          ? (result.derivativeCreated ? "ready" : "already_current")
          : "source_changed",
        assetId: Number(job.asset_id),
      };
    } catch (error) {
      const disposition = vehicleCropFailureDisposition(error, job);
      await this.repository.failJob(job, {
        stage: "catalog",
        status: disposition.status,
        errorCode: disposition.code,
        message: disposition.message,
        retryable: disposition.retryable,
      });
      return { status: disposition.status, assetId: Number(job.asset_id), errorCode: disposition.code };
    }
  }

  async processBatch({ limit = 5 } = {}) {
    if (this.processing) return { busy: true, processed: 0, failed: 0 };
    this.processing = true;
    try {
      await this.repository.reclaimExpiredClaims();
      const run = await this.repository.getLatestRun();
      if (!run || !["previewing", "running"].includes(run.status)) {
        return { busy: false, status: "idle", processed: 0, failed: 0 };
      }
      const bounded = Math.min(25, Math.max(1, Number(limit) || 5));
      const results = [];
      if (run.status === "previewing") {
        for (let index = 0; index < bounded; index += 1) {
          const job = await this.repository.claimPreviewJob();
          if (!job) break;
          results.push(await this.processPreviewJob(job));
        }
        await this.repository.finalizePreview(run.id);
      } else {
        for (let index = 0; index < bounded; index += 1) {
          const job = await this.repository.claimCatalogJob();
          if (!job) break;
          results.push(await this.processCatalogJob(job));
        }
        await this.repository.settleRun(run.id);
      }
      const succeeded = results.filter((result) => (
        ["previewed", "ready", "already_current"].includes(result.status)
      )).length;
      return {
        busy: false,
        runId: Number(run.id),
        phase: run.status === "previewing" ? "preview" : "catalog",
        processed: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      };
    } finally {
      this.processing = false;
    }
  }
}

export const vehicleImageCropCampaignInternals = Object.freeze({
  TERMINAL_CHANGED_CODES,
  TERMINAL_INVALID_CODES,
  safeError,
});
