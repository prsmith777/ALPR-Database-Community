const TERMINAL_SUPERSEDED_CODES = new Set([
  "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
  "VEHICLE_IMAGE_ASSET_SNAPSHOT_CHANGED",
]);

const TERMINAL_INVALID_CODES = new Set([
  "VEHICLE_IMAGE_ASSET_INVALID_IMAGE",
  "VEHICLE_IMAGE_ASSET_INVALID_JPEG",
  "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
]);

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_IMAGE_ASSET_CATALOG_FAILED")
      .trim().slice(0, 80),
    message: String(error?.message || "Canonical Overview catalog work failed")
      .trim().slice(0, 500),
  };
}

function failureDisposition(error, item) {
  const details = safeError(error);
  if (TERMINAL_SUPERSEDED_CODES.has(details.code)) {
    return { status: "superseded", retryable: false, ...details };
  }
  if (TERMINAL_INVALID_CODES.has(details.code)) {
    return { status: "invalid", retryable: false, ...details };
  }
  if (details.code === "VEHICLE_IMAGE_ASSET_SOURCE_MISSING") {
    const exhausted = Number(item?.attempt_count || 0) >= 3;
    return {
      status: exhausted ? "unavailable" : "failed",
      retryable: !exhausted,
      ...details,
    };
  }
  return { status: "failed", retryable: true, ...details };
}

export class VehicleImageAssetCatalogCampaignService {
  constructor({ repository, catalog, logger = console } = {}) {
    if (!repository || !catalog) {
      throw new Error("Vehicle image asset catalog campaign dependencies are required");
    }
    this.repository = repository;
    this.catalog = catalog;
    this.logger = logger;
    this.processing = false;
  }

  async createPreview({ actorUserId }) {
    return this.repository.createPreview({ actorUserId });
  }

  async confirmBatch(input) {
    return this.repository.confirmBatch(input);
  }

  async setPaused(input) {
    return this.repository.setPaused(input);
  }

  async cancel(input) {
    return this.repository.cancel(input);
  }

  async retryItem(input) {
    return this.repository.retryItem(input);
  }

  async getOverview() {
    return this.repository.getOverview();
  }

  async processPreviewItem(item) {
    try {
      const preview = await this.catalog.previewSnapshot(item.readSnapshot);
      const completed = await this.repository.completePreviewItem(item, preview);
      return { status: completed ? "previewed" : "superseded", readId: Number(item.read_id) };
    } catch (error) {
      const disposition = failureDisposition(error, item);
      await this.repository.failClaimedItem(item, {
        stage: "preview",
        status: disposition.status,
        errorCode: disposition.code,
        errorDetails: { message: disposition.message },
        retryable: disposition.retryable,
      });
      return { status: disposition.status, readId: Number(item.read_id), errorCode: disposition.code };
    }
  }

  async processCatalogItem(item) {
    try {
      const result = await this.catalog.catalogSnapshot({
        readSnapshot: item.readSnapshot,
        expectedContentSha256: item.preview_sha256,
        expectedByteSize: item.preview_byte_size,
        expectedImageWidth: item.preview_width,
        expectedImageHeight: item.preview_height,
      });
      const completed = await this.repository.completeCatalogItem(item, result);
      return {
        status: completed
          ? (result.assetCreated || result.linkCreated || result.linkUpdated
            ? "cataloged"
            : "already_current")
          : "superseded",
        readId: Number(item.read_id),
      };
    } catch (error) {
      const disposition = failureDisposition(error, item);
      await this.repository.failClaimedItem(item, {
        stage: "catalog",
        status: disposition.status,
        errorCode: disposition.code,
        errorDetails: { message: disposition.message },
        retryable: disposition.retryable,
      });
      return { status: disposition.status, readId: Number(item.read_id), errorCode: disposition.code };
    }
  }

  async processBatch({ limit = 5 } = {}) {
    if (this.processing) return { busy: true, processed: 0, succeeded: 0, failed: 0 };
    this.processing = true;
    try {
      await this.repository.reclaimExpiredClaims();
      const run = await this.repository.getLatestRun();
      if (!run || !["previewing", "running"].includes(run.status)) {
        return { busy: false, processed: 0, succeeded: 0, failed: 0, status: "idle" };
      }
      const boundedLimit = Math.min(25, Math.max(1, Number.parseInt(String(limit), 10) || 5));
      const results = [];
      if (run.phase === "preview") {
        await this.repository.materializePreviewWindow({
          runId: run.id,
          limit: Math.max(25, boundedLimit * 5),
        });
        for (let index = 0; index < boundedLimit; index += 1) {
          const item = await this.repository.claimPreviewItem();
          if (!item) break;
          results.push(await this.processPreviewItem(item));
        }
        await this.repository.finalizePreview(run.id);
      } else if (run.phase === "catalog") {
        for (let index = 0; index < boundedLimit; index += 1) {
          const item = await this.repository.claimCatalogItem();
          if (!item) break;
          results.push(await this.processCatalogItem(item));
        }
        await this.repository.settleCatalogRun(run.id);
      }
      const failed = results.filter((result) => !["previewed", "cataloged", "already_current"].includes(result.status)).length;
      return {
        busy: false,
        processed: results.length,
        succeeded: results.length - failed,
        failed,
        phase: run.phase,
        runId: Number(run.id),
        results,
      };
    } finally {
      this.processing = false;
    }
  }
}

export const vehicleImageAssetCatalogCampaignInternals = Object.freeze({
  TERMINAL_INVALID_CODES,
  TERMINAL_SUPERSEDED_CODES,
  failureDisposition,
  safeError,
});
