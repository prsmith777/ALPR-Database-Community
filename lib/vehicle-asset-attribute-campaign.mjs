const TERMINAL_INVALID_CODES = new Set([
  "VEHICLE_ASSET_ATTRIBUTE_INVALID_SOURCE",
  "VEHICLE_ASSET_ATTRIBUTE_INVALID_OUTPUT",
  "VEHICLE_ASSET_ATTRIBUTE_CONFLICT",
]);

const TERMINAL_CHANGED_CODES = new Set([
  "VEHICLE_ASSET_ATTRIBUTE_SOURCE_CHANGED",
  "VEHICLE_ASSET_ATTRIBUTE_PREVIEW_CHANGED",
]);

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_ASSET_ATTRIBUTE_FAILED").trim().slice(0, 80),
    message: String(error?.message || "Canonical crop attribute failed").trim().slice(0, 500),
  };
}

export function vehicleAssetAttributeFailureDisposition(error, job) {
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
    status: details.code === "VEHICLE_ASSET_ATTRIBUTE_SOURCE_MISSING" && exhausted
      ? "invalid"
      : "failed",
    retryable: !exhausted,
  };
}

export class VehicleAssetAttributeCampaignService {
  constructor({ repository, attributeService, logger = console } = {}) {
    if (!repository || !attributeService) {
      throw new Error("Vehicle asset attribute campaign dependencies are required");
    }
    this.repository = repository;
    this.attributeService = attributeService;
    this.logger = logger;
    this.processing = false;
  }

  createPreview(input) { return this.repository.createPreview(input); }
  confirmBatch(input) { return this.repository.confirmBatch(input); }
  setPaused(input) { return this.repository.setPaused(input); }
  cancel(input) { return this.repository.cancel(input); }
  retryJob(input) { return this.repository.retryJob(input); }
  getOverview() { return this.repository.getOverview(); }

  async processPreviewJob(job) {
    try {
      const preview = await this.attributeService.preview(job);
      const completed = await this.repository.completePreviewJob(job, preview);
      return { status: completed ? "previewed" : "source_changed", derivativeId: Number(job.derivative_id) };
    } catch (error) {
      const disposition = vehicleAssetAttributeFailureDisposition(error, job);
      await this.repository.failJob(job, {
        stage: "preview",
        status: disposition.status,
        errorCode: disposition.code,
        message: disposition.message,
        retryable: disposition.retryable,
      });
      return {
        status: disposition.status,
        derivativeId: Number(job.derivative_id),
        errorCode: disposition.code,
      };
    }
  }

  async processAttributeJob(job) {
    try {
      const result = await this.attributeService.catalog(job);
      const completed = await this.repository.completeAttributeJob(job, result);
      return {
        status: completed
          ? (Number(result.observationsCreated || 0) > 0 ? "ready" : "already_current")
          : "source_changed",
        derivativeId: Number(job.derivative_id),
      };
    } catch (error) {
      const disposition = vehicleAssetAttributeFailureDisposition(error, job);
      await this.repository.failJob(job, {
        stage: "observe",
        status: disposition.status,
        errorCode: disposition.code,
        message: disposition.message,
        retryable: disposition.retryable,
      });
      return {
        status: disposition.status,
        derivativeId: Number(job.derivative_id),
        errorCode: disposition.code,
      };
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
          const job = await this.repository.claimAttributeJob();
          if (!job) break;
          results.push(await this.processAttributeJob(job));
        }
        await this.repository.settleRun(run.id);
      }
      const succeeded = results.filter((result) => (
        ["previewed", "ready", "already_current"].includes(result.status)
      )).length;
      return {
        busy: false,
        runId: Number(run.id),
        phase: run.status === "previewing" ? "preview" : "observe",
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

export const vehicleAssetAttributeCampaignInternals = Object.freeze({
  TERMINAL_CHANGED_CODES,
  TERMINAL_INVALID_CODES,
  safeError,
});

