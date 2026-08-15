import { failureDisposition } from "./vehicle-image-asset-catalog-campaign.mjs";

const LIVE_RETRY_LIMIT = 5;

function catalogStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class VehicleImageAssetLiveCatalogService {
  constructor({ repository, catalog, logger = console } = {}) {
    if (!repository || !catalog) {
      throw new Error("Automatic canonical Overview catalog dependencies are required");
    }
    this.repository = repository;
    this.catalog = catalog;
    this.logger = logger;
    this.processing = false;
  }

  async getOverview() {
    return this.repository.getOverview();
  }

  async setEnabled(input) {
    return this.repository.setEnabled(input);
  }

  async retryJob(input) {
    return this.repository.retryJob(input);
  }

  async processItem(job) {
    try {
      const result = await this.catalog.catalogRead(job.read_id);
      if (result.status === "missing") {
        throw catalogStateError(
          "VEHICLE_IMAGE_ASSET_SNAPSHOT_CHANGED",
          "Overview read was removed before automatic cataloging"
        );
      }
      if (result.status === "ineligible") {
        throw catalogStateError(
          "VEHICLE_IMAGE_ASSET_SNAPSHOT_CHANGED",
          "Overview read is no longer eligible for automatic cataloging"
        );
      }
      const completed = await this.repository.completeJob(job, result);
      return {
        status: completed ? "cataloged" : "superseded",
        readId: Number(job.read_id),
        assetId: result.asset?.id == null ? null : Number(result.asset.id),
      };
    } catch (error) {
      const disposition = failureDisposition(error, {
        ...job,
        retry_limit: LIVE_RETRY_LIMIT,
      });
      await this.repository.failClaimedJob(job, {
        status: disposition.status,
        errorCode: disposition.code,
        errorDetails: { message: disposition.message },
        retryable: disposition.retryable,
      });
      if (!disposition.retryable) {
        this.logger?.warn?.("Automatic canonical Overview catalog item terminalized", {
          readId: Number(job.read_id),
          status: disposition.status,
          errorCode: disposition.code,
        });
      }
      return {
        status: disposition.status,
        readId: Number(job.read_id),
        errorCode: disposition.code,
      };
    }
  }

  async processBatch({ limit = 5 } = {}) {
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
      const boundedLimit = Math.min(25, Math.max(1, Number.parseInt(String(limit), 10) || 5));
      const discovered = await this.repository.materializeCandidates({
        limit: Math.max(25, boundedLimit * 5),
      });
      const results = [];
      for (let index = 0; index < boundedLimit; index += 1) {
        const job = await this.repository.claimNext();
        if (!job) break;
        results.push(await this.processItem(job));
      }
      const failed = results.filter((result) => result.status !== "cataloged").length;
      return {
        busy: false,
        processed: results.length,
        succeeded: results.length - failed,
        failed,
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

export const vehicleImageAssetLiveCatalogInternals = Object.freeze({
  LIVE_RETRY_LIMIT,
  catalogStateError,
});
