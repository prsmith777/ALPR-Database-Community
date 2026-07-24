import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";

import {
  MAX_VISUAL_UPLOAD_PIXELS,
  calculateVehicleCrop,
  createDHash,
  decodeVisualUploadDataUrl,
  normalizeBatchSize,
  normalizeSearchLimit,
} from "./image-similarity.mjs";
import {
  VEHICLE_REID_MODEL,
  cosineSimilarity,
  decodeVehicleEmbedding,
  encodeVehicleEmbedding,
  explainVehicleSimilarity,
  vehicleReidEngine,
} from "./vehicle-reid.mjs";
import {
  VehicleMatchFeedbackError,
  canonicalVehicleMatchPair,
  normalizeVehicleMatchFeedbackLabel,
  summarizeVehicleMatchFeedback,
} from "./vehicle-match-calibration.mjs";

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
    `vehicle_reid_v1_read_${Number(read.id)}.jpg`
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

function detectorStats(row = {}) {
  const indexedCount = Math.max(0, Number(row.indexed_count || 0));
  const detectedCount = Math.min(indexedCount, Math.max(0, Number(row.detected_count || 0)));
  const fallbackCount = Math.max(0, indexedCount - detectedCount);
  const successRate = indexedCount
    ? Number((detectedCount / indexedCount * 100).toFixed(1))
    : null;
  const averageConfidence = row.average_confidence === null || row.average_confidence === undefined
    ? null
    : Number((Number(row.average_confidence) * 100).toFixed(1));
  const enoughSamples = indexedCount >= 20;
  const shouldReviewFallback = enoughSamples && fallbackCount >= 3 && successRate < 85;
  return {
    indexedCount,
    detectedCount,
    fallbackCount,
    successRate,
    averageConfidence,
    state: shouldReviewFallback ? "review" : enoughSamples ? "healthy" : "collecting",
    shouldReviewFallback,
  };
}

function publicMatchFeedback(row, candidateReadId = row?.candidate_read_id) {
  if (!row) return null;
  return {
    id: Number(row.id),
    candidateReadId: Number(candidateReadId),
    label: row.label,
    similarity: Number(row.similarity_score),
    embeddingModel: row.embedding_model,
    revision: Number(row.revision || 1),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    actorUsername: row.actor_username,
    actorDisplayName: row.actor_display_name,
  };
}

function rankMatches(source, candidates, limit) {
  const sourceEmbedding = decodeVehicleEmbedding(source.vehicle_embedding);
  if (!sourceEmbedding) return [];
  return candidates
    .map((candidate) => {
      const candidateEmbedding = decodeVehicleEmbedding(candidate.vehicle_embedding);
      if (!candidateEmbedding || candidate.embedding_model !== VEHICLE_REID_MODEL) return null;
      const explanation = explainVehicleSimilarity({
        sourceSha256: source.source_sha256,
        candidateSha256: candidate.source_sha256,
        similarity: cosineSimilarity(sourceEmbedding, candidateEmbedding),
      });
      return {
        ...publicAsset(candidate),
        ...explanation,
        detectorConfidence: candidate.detection_confidence === null
          ? null
          : Number(candidate.detection_confidence),
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.exact) - Number(left.exact) ||
      right.score - left.score ||
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
    )
    .slice(0, normalizeSearchLimit(limit));
}

export class CaptureAssetService {
  constructor({ repository, fileStorage, imageProcessor = sharp, vehicleMatcher = vehicleReidEngine, logger = console } = {}) {
    if (!repository || !fileStorage) {
      throw new Error("Capture asset service requires a repository and file storage");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.imageProcessor = imageProcessor;
    this.vehicleMatcher = vehicleMatcher;
    this.logger = logger;
    this.batchPromise = null;
  }

  async indexRead(read) {
    const existing = await this.repository.getAsset(read.id);
    if (existing) return existing;

    const profile = await this.repository.getCameraProfile(read.camera_name);

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
        profile,
      });
      const analysis = await this.vehicleMatcher.analyze(source, {
        plateBox: read.crop_coordinates,
        fallbackCrop: crop,
      });
      const { cropBuffer } = analysis;
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
        vehicleEmbedding: encodeVehicleEmbedding(analysis.embedding),
        embeddingModel: analysis.embeddingModel,
        detectorModel: analysis.detectorModel,
        detectionConfidence: analysis.crop.detectionConfidence,
        crop: analysis.crop,
        imageWidth: analysis.imageWidth,
        imageHeight: analysis.imageHeight,
        profileVersion: profile.profileVersion,
      });
      return this.repository.getAsset(read.id);
    } catch (error) {
      const errorCode = safeIndexErrorCode(error);
      await this.repository.recordFailure(read, errorCode, profile.profileVersion);
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
    return this.indexCandidates({ limit });
  }

  async indexCameraBatch({ cameraName, limit } = {}) {
    const normalizedCamera = String(cameraName || "").trim();
    if (!normalizedCamera) {
      const error = new Error("Select a valid camera");
      error.code = "INVALID_CAMERA_PROFILE";
      throw error;
    }
    return this.indexCandidates({ limit, cameraName: normalizedCamera });
  }

  async indexCandidates({ limit, cameraName = null } = {}) {
    if (this.batchPromise) {
      return { busy: true, processed: 0, succeeded: 0, failed: 0, status: await this.getStatus() };
    }

    this.batchPromise = (async () => {
      const candidates = await this.repository.listIndexCandidates(normalizeBatchSize(limit), cameraName);
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
    const matches = await this.decorateMatchesWithFeedback(
      Number(source.read_id),
      rankMatches(source, candidates, limit)
    );

    return {
      source: publicAsset(source),
      matches,
      searchedCandidates: candidates.length,
      rankingModel: VEHICLE_REID_MODEL,
    };
  }

  async decorateMatchesWithFeedback(sourceReadId, matches) {
    if (!matches.length || typeof this.repository.listMatchFeedbackForSource !== "function") {
      return matches;
    }
    const rows = await this.repository.listMatchFeedbackForSource({
      sourceReadId,
      candidateReadIds: matches.map((match) => match.readId),
      embeddingModel: VEHICLE_REID_MODEL,
    });
    const feedbackByCandidate = new Map(
      rows.map((row) => [Number(row.candidate_read_id), publicMatchFeedback(row)])
    );
    return matches.map((match) => ({
      ...match,
      feedback: feedbackByCandidate.get(match.readId) || null,
    }));
  }

  async getCalibrationSummary() {
    if (typeof this.repository.listVehicleMatchFeedback !== "function") {
      return summarizeVehicleMatchFeedback([]);
    }
    return summarizeVehicleMatchFeedback(
      await this.repository.listVehicleMatchFeedback(VEHICLE_REID_MODEL)
    );
  }

  async recordMatchFeedback({ sourceReadId, candidateReadId, label, actor } = {}) {
    if (typeof this.repository.saveVehicleMatchFeedback !== "function") {
      throw new Error("Vehicle match feedback storage is unavailable");
    }
    const pair = canonicalVehicleMatchPair(sourceReadId, candidateReadId);
    const normalizedLabel = normalizeVehicleMatchFeedbackLabel(label);
    const [source, candidate] = await Promise.all([
      this.repository.getAsset(pair.sourceReadId),
      this.repository.getAsset(pair.candidateReadId),
    ]);
    if (!source || !candidate) {
      throw new VehicleMatchFeedbackError(
        "VEHICLE_MATCH_ASSET_UNAVAILABLE",
        "Both captures must be indexed before they can be labeled."
      );
    }
    if (source.embedding_model !== VEHICLE_REID_MODEL
      || candidate.embedding_model !== VEHICLE_REID_MODEL) {
      throw new VehicleMatchFeedbackError(
        "VEHICLE_MATCH_MODEL_MISMATCH",
        "These captures must be reindexed with the current Vehicle ReID model."
      );
    }
    const sourceEmbedding = decodeVehicleEmbedding(source.vehicle_embedding);
    const candidateEmbedding = decodeVehicleEmbedding(candidate.vehicle_embedding);
    const similarity = cosineSimilarity(sourceEmbedding, candidateEmbedding);
    if (!Number.isFinite(similarity)) {
      throw new VehicleMatchFeedbackError(
        "VEHICLE_MATCH_ASSET_UNAVAILABLE",
        "The stored vehicle descriptors are unavailable."
      );
    }
    const saved = await this.repository.saveVehicleMatchFeedback({
      readIdLow: pair.readIdLow,
      readIdHigh: pair.readIdHigh,
      embeddingModel: VEHICLE_REID_MODEL,
      similarityScore: Number(similarity.toFixed(6)),
      label: normalizedLabel,
      actor,
    });
    return {
      feedback: publicMatchFeedback(saved, pair.candidateReadId),
      calibration: await this.getCalibrationSummary(),
    };
  }

  async searchUpload({ dataUrl, fileName, cameraNames = [], startDate, endDate, limit } = {}) {
    const { buffer, mimeType } = decodeVisualUploadDataUrl(dataUrl);
    let metadata;
    try {
      const processor = this.imageProcessor(buffer, {
        failOn: "error",
        limitInputPixels: MAX_VISUAL_UPLOAD_PIXELS,
      });
      metadata = await processor.metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_VISUAL_UPLOAD_PIXELS) {
        throw new Error("Image dimensions exceed the safe limit");
      }
      if (!new Set(["jpeg", "png", "webp"]).has(metadata.format)) {
        throw new Error("Unsupported image format");
      }
    } catch {
      const error = new Error("The uploaded image could not be decoded safely");
      error.code = "INVALID_VISUAL_UPLOAD";
      throw error;
    }
    let analysis;
    try {
      analysis = await this.vehicleMatcher.analyze(buffer);
    } catch (error) {
      this.logger?.warn?.("Vehicle ReID query failed", { error: error?.message });
      const failure = new Error("The vehicle matching model is temporarily unavailable");
      failure.code = "VISUAL_MODEL_UNAVAILABLE";
      throw failure;
    }
    const source = {
      source_sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      vehicle_embedding: encodeVehicleEmbedding(analysis.embedding),
      embedding_model: analysis.embeddingModel,
    };
    const candidates = await this.repository.listSearchCandidates({
      readId: null,
      cameraNames: [...new Set(cameraNames.filter(Boolean))],
      startDate,
      endDate,
    });
    const safeName = String(fileName || "Uploaded image").trim().slice(0, 120) || "Uploaded image";
    return {
      source: {
        readId: null,
        plateNumber: safeName,
        observedPlate: safeName,
        cameraName: "Uploaded query",
        timestamp: null,
        imageUrl: null,
        uploaded: true,
        mimeType,
        width: metadata.width,
        height: metadata.height,
      },
      matches: rankMatches(source, candidates, limit),
      searchedCandidates: candidates.length,
      rankingModel: VEHICLE_REID_MODEL,
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

  async getCameraSetup() {
    const [profiles, stats] = await Promise.all([
      this.repository.listCameraProfiles(),
      this.repository.listCameraDetectionStats(),
    ]);
    const statsByCamera = new Map(stats.map((row) => [String(row.camera_key || "").trim(), row]));
    return Promise.all(profiles.map(async (profile) => {
      const detectionStats = detectorStats(
        statsByCamera.get(profile.cameraName.trim().toLowerCase())
      );
      const read = await this.repository.getLatestCameraRead(profile.cameraName);
      if (!read?.image_path) return { ...profile, detectionStats, preview: null };
      try {
        const source = await this.fileStorage.getImage(read.image_path);
        if (!source) return { ...profile, detectionStats, preview: null };
        const metadata = await this.imageProcessor(source).metadata();
        if (!metadata.width || !metadata.height) return { ...profile, detectionStats, preview: null };
        return {
          ...profile,
          detectionStats,
          preview: {
            readId: Number(read.id),
            plateNumber: read.plate_number,
            imageUrl: `/images/${read.image_path}`,
            width: metadata.width,
            height: metadata.height,
            cropCoordinates: read.crop_coordinates,
            timestamp: read.timestamp instanceof Date ? read.timestamp.toISOString() : read.timestamp,
          },
        };
      } catch {
        return { ...profile, detectionStats, preview: null };
      }
    }));
  }

  async saveCameraProfile(input = {}) {
    const cameraName = String(input.cameraName || "").trim();
    const read = await this.repository.getLatestCameraRead(cameraName);
    if (!read) {
      const error = new Error("Camera has no image captures");
      error.code = "INVALID_CAMERA_PROFILE";
      throw error;
    }
    return this.repository.saveCameraProfile(cameraName, input);
  }

  async getBootstrap({ includeCameraSetup = false } = {}) {
    const [status, recent, cameras, cameraProfiles, calibration] = await Promise.all([
      this.getStatus(),
      this.repository.listRecent(),
      this.repository.listCameras(),
      includeCameraSetup ? this.getCameraSetup() : Promise.resolve(undefined),
      this.getCalibrationSummary(),
    ]);
    return {
      status,
      recent: recent.map(publicAsset),
      cameras,
      calibration,
      ...(cameraProfiles ? { cameraProfiles } : {}),
    };
  }
}

export const captureAssetServiceInternals = Object.freeze({
  detectorStats,
  derivedPathFor,
  publicAsset,
  publicMatchFeedback,
  safeIndexErrorCode,
  rankMatches,
});
