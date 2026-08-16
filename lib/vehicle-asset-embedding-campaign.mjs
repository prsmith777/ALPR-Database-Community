const TERMINAL_INVALID_CODES = new Set([
  "VEHICLE_ASSET_EMBEDDING_INVALID_SOURCE",
  "VEHICLE_ASSET_EMBEDDING_INVALID_OUTPUT",
  "VEHICLE_ASSET_EMBEDDING_CONFLICT",
]);

const TERMINAL_CHANGED_CODES = new Set([
  "VEHICLE_ASSET_EMBEDDING_SOURCE_CHANGED",
  "VEHICLE_ASSET_EMBEDDING_PREVIEW_CHANGED",
]);

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_ASSET_EMBEDDING_FAILED").trim().slice(0, 80),
    message: String(error?.message || "Canonical crop embedding failed").trim().slice(0, 500),
  };
}

export function vehicleAssetEmbeddingFailureDisposition(error, job) {
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
    status: details.code === "VEHICLE_ASSET_EMBEDDING_SOURCE_MISSING" && exhausted
      ? "invalid"
      : "failed",
    retryable: !exhausted,
  };
}

export class VehicleAssetEmbeddingCampaignService {
  constructor({ repository, embeddingService, logger = console } = {}) {
    if (!repository || !embeddingService) {
      throw new Error("Vehicle asset embedding campaign dependencies are required");
    }
    this.repository = repository;
    this.embeddingService = embeddingService;
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
      const preview = await this.embeddingService.preview(job);
      const completed = await this.repository.completePreviewJob(job, preview);
      return { status: completed ? "previewed" : "source_changed", derivativeId: Number(job.derivative_id) };
    } catch (error) {
      const disposition = vehicleAssetEmbeddingFailureDisposition(error, job);
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

  async processEmbeddingJob(job) {
    try {
      const result = await this.embeddingService.catalog(job);
      const completed = await this.repository.completeEmbeddingJob(job, result);
      return {
        status: completed
          ? (result.embeddingCreated ? "ready" : "already_current")
          : "source_changed",
        derivativeId: Number(job.derivative_id),
      };
    } catch (error) {
      const disposition = vehicleAssetEmbeddingFailureDisposition(error, job);
      await this.repository.failJob(job, {
        stage: "embed",
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
          const job = await this.repository.claimEmbeddingJob();
          if (!job) break;
          results.push(await this.processEmbeddingJob(job));
        }
        await this.repository.settleRun(run.id);
      }
      const succeeded = results.filter((result) => (
        ["previewed", "ready", "already_current"].includes(result.status)
      )).length;
      return {
        busy: false,
        runId: Number(run.id),
        phase: run.status === "previewing" ? "preview" : "embed",
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

export const vehicleAssetEmbeddingCampaignInternals = Object.freeze({
  TERMINAL_CHANGED_CODES,
  TERMINAL_INVALID_CODES,
  safeError,
});
