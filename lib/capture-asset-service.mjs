import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";

import {
  DEFAULT_MAX_HAMMING_DISTANCE,
  calculateVehicleCrop,
  createDHash,
  explainSimilarity,
  hammingDistance,
  normalizeBatchSize,
  normalizeSearchLimit,
} from "./image-similarity.mjs";

function derivedPathFor(read) {
  const date = new Date(read.timestamp || Date.now());
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.posix.join(
    "derived",
    year,
    month,
    day,
    `vehicle_v1_read_${Number(read.id)}.jpg`
  );
}

function publicAsset(asset) {
  return {
    readId: Number(asset.read_id),
    plateNumber: asset.plate_number,
    observedPlate: asset.observed_plate || asset.plate_number,
    cameraName: asset.camera_name || "Unknown camera",
    timestamp:
      asset.timestamp instanceof Date ? asset.timestamp.toISOString() : asset.timestamp,
    imageUrl: `/images/${asset.derived_path}`,
  };
}

function safeIndexErrorCode(error) {
  if (error?.code === "SOURCE_IMAGE_MISSING") return error.code;
  if (error?.name === "Error" && /unsupported image|corrupt|decode/i.test(error.message || "")) {
    return "IMAGE_DECODE_FAILED";
  }
  return "IMAGE_INDEX_FAILED";
}

export class CaptureAssetService {
  constructor({ repository, fileStorage, imageProcessor = sharp, logger = console } = {}) {
    if (!repository || !fileStorage) {
      throw new Error("Capture asset service requires a repository and file storage");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.imageProcessor = imageProcessor;
    this.logger = logger;
    this.batchPromise = null;
  }

  async indexRead(read) {
    const existing = await this.repository.getAsset(read.id);
    if (existing) return existing;

    try {
      const source = await this.fileStorage.getImage(read.image_path);
      if (!source) {
        const error = new Error("Source image is unavailable");
        error.code = "SOURCE_IMAGE_MISSING";
        throw error;
      }

      const metadata = await this.imageProcessor(source).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
      const crop = calculateVehicleCrop({
        width: metadata.width,
        height: metadata.height,
        cropCoordinates: read.crop_coordinates,
      });
      const cropBuffer = await this.imageProcessor(source)
        .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
        .jpeg({ quality: 82 })
        .toBuffer();
      const hashPixels = await this.imageProcessor(cropBuffer)
        .resize(9, 8, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer();
      const derivedPath = derivedPathFor(read);
      await this.fileStorage.saveDerivedImage(derivedPath, cropBuffer);

      await this.repository.recordReady({
        read,
        derivedPath,
        sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
        perceptualHash: createDHash(hashPixels),
        crop,
        imageWidth: metadata.width,
        imageHeight: metadata.height,
      });
      return this.repository.getAsset(read.id);
    } catch (error) {
      const errorCode = safeIndexErrorCode(error);
      await this.repository.recordFailure(read, errorCode);
      this.logger?.warn?.("Capture asset indexing failed", {
        readId: Number(read.id),
        errorCode,
      });
      const failure = new Error("Unable to index this capture");
      failure.code = errorCode;
      throw failure;
    }
  }

  async indexReadById(readId) {
    const normalizedReadId = Number.parseInt(readId, 10);
    if (!Number.isSafeInteger(normalizedReadId) || normalizedReadId < 1) {
      const error = new Error("Capture image not found");
      error.code = "CAPTURE_NOT_FOUND";
      throw error;
    }
    const read = await this.repository.getRead(normalizedReadId);
    if (!read?.image_path) {
      const error = new Error("Capture image not found");
      error.code = "CAPTURE_NOT_FOUND";
      throw error;
    }
    return this.indexRead(read);
  }

  async indexBatch({ limit } = {}) {
    if (this.batchPromise) {
      return { busy: true, processed: 0, succeeded: 0, failed: 0, status: await this.getStatus() };
    }

    this.batchPromise = (async () => {
      const candidates = await this.repository.listIndexCandidates(normalizeBatchSize(limit));
      let succeeded = 0;
      let failed = 0;
      for (const read of candidates) {
        try {
          await this.indexRead(read);
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
      return {
        busy: false,
        processed: candidates.length,
        succeeded,
        failed,
        status: await this.getStatus(),
      };
    })();

    try {
      return await this.batchPromise;
    } finally {
      this.batchPromise = null;
    }
  }

  async search({ readId, cameraNames = [], startDate, endDate, limit } = {}) {
    const source =
      (await this.repository.getAsset(readId)) || (await this.indexReadById(readId));
    const candidates = await this.repository.listSearchCandidates({
      readId: Number(readId),
      cameraNames: [...new Set(cameraNames.filter(Boolean))],
      startDate,
      endDate,
    });
    const matches = candidates
      .map((candidate) => {
        const distance = hammingDistance(source.perceptual_hash, candidate.perceptual_hash);
        const explanation = explainSimilarity({
          sourceSha256: source.source_sha256,
          candidateSha256: candidate.source_sha256,
          distance,
        });
        return { ...publicAsset(candidate), ...explanation };
      })
      .filter((candidate) => candidate.exact || candidate.distance <= DEFAULT_MAX_HAMMING_DISTANCE)
      .sort((left, right) =>
        Number(right.exact) - Number(left.exact) ||
        left.distance - right.distance ||
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
      )
      .slice(0, normalizeSearchLimit(limit));

    return {
      source: publicAsset(source),
      matches,
      searchedCandidates: candidates.length,
      threshold: DEFAULT_MAX_HAMMING_DISTANCE,
    };
  }

  async getStatus() {
    const status = await this.repository.getStatus();
    return {
      total: Number(status.total || 0),
      ready: Number(status.ready || 0),
      failed: Number(status.failed || 0),
      retryable: Number(status.retryable || 0),
      pending: Number(status.pending || 0),
      lastIndexedAt: status.last_indexed_at || null,
    };
  }

  async getBootstrap() {
    const [status, recent, cameras] = await Promise.all([
      this.getStatus(),
      this.repository.listRecent(),
      this.repository.listCameras(),
    ]);
    return {
      status,
      recent: recent.map(publicAsset),
      cameras,
    };
  }
}

export const captureAssetServiceInternals = Object.freeze({
  derivedPathFor,
  publicAsset,
  safeIndexErrorCode,
});
