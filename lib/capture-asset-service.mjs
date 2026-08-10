import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";

import {
  COLOR_SAMPLE_HEIGHT,
  COLOR_SAMPLE_WIDTH,
  COLOR_SIGNATURE_VERSION,
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
import {
  VEHICLE_DIRECTION_CLASSIFIER,
  classifyVehicleOrientation,
  directionFromOrientation,
  normalizeDirectionProfile,
  normalizeOrientation,
} from "./vehicle-direction.mjs";
import {
  VEHICLE_COLOR_MODEL,
  VEHICLE_COLOR_PROVIDER,
  VEHICLE_TYPE_MODEL,
  VEHICLE_TYPE_PROVIDER,
  assessVehicleColorPixels,
  vehicleTypeEngine,
} from "./vehicle-attributes.mjs";
import {
  VEHICLE_CLUSTER_ALGORITHM,
  chooseShadowCluster,
  normalizeClusterReviewDecision,
} from "./vehicle-clustering.mjs";
import { BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM } from "./blue-iris-trigger-direction.mjs";

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
  constructor({
    repository,
    fileStorage,
    imageProcessor = sharp,
    vehicleMatcher = vehicleReidEngine,
    vehicleTypeAnalyzer = vehicleTypeEngine,
    directionNotifier = null,
    logger = console,
  } = {}) {
    if (!repository || !fileStorage) {
      throw new Error("Capture asset service requires a repository and file storage");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.imageProcessor = imageProcessor;
    this.vehicleMatcher = vehicleMatcher;
    this.vehicleTypeAnalyzer = vehicleTypeAnalyzer;
    this.directionNotifier = typeof directionNotifier === "function" ? directionNotifier : null;
    this.logger = logger;
    this.batchPromise = null;
    this.directionBatchPromise = null;
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
      const [hashPixels, colorPixels] = await Promise.all([
        this.imageProcessor(cropBuffer)
          .resize(9, 8, { fit: "fill" })
          .grayscale()
          .raw()
          .toBuffer(),
        this.imageProcessor(cropBuffer)
          .resize(COLOR_SAMPLE_WIDTH, COLOR_SAMPLE_HEIGHT, { fit: "fill" })
          .removeAlpha()
          .raw()
          .toBuffer(),
      ]);
      const colorObservation = assessVehicleColorPixels(colorPixels);
      const colorSignature = colorObservation.signature;
      const derivedPath = derivedPathFor(read);
      const writeReadyAsset = async (writerRepository = this.repository) => {
        await this.fileStorage.saveDerivedImage(derivedPath, cropBuffer);
        return writerRepository.recordReady({
          read,
          derivedPath,
          sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
          perceptualHash: createDHash(hashPixels),
          colorSignature,
          colorSignatureVersion: COLOR_SIGNATURE_VERSION,
          vehicleEmbedding: encodeVehicleEmbedding(analysis.embedding),
          embeddingModel: analysis.embeddingModel,
          detectorModel: analysis.detectorModel,
          detectionConfidence: analysis.crop.detectionConfidence,
          crop: analysis.crop,
          imageWidth: analysis.imageWidth,
          imageHeight: analysis.imageHeight,
          profileVersion: profile.profileVersion,
        });
      };
      if (typeof this.repository.withDerivedStorageWriterLock === "function") {
        await this.repository.withDerivedStorageWriterLock(writeReadyAsset);
      } else {
        // Test doubles and older third-party repositories retain their
        // existing contract. The bundled production repository always
        // supplies the shared advisory-lock wrapper.
        await writeReadyAsset();
      }
      if (typeof this.repository.saveVehicleAttributeObservation === "function") {
        try {
          await this.repository.saveVehicleAttributeObservation({
            readId: Number(read.id),
            attributeKey: "color",
            status: colorObservation.status,
            attributeValue: colorObservation.value,
            confidence: colorObservation.confidence,
            provider: VEHICLE_COLOR_PROVIDER,
            modelVersion: VEHICLE_COLOR_MODEL,
            rawResult: {
              reliability: colorObservation.reliability,
              colorSignatureVersion: COLOR_SIGNATURE_VERSION,
              reason: colorObservation.reason,
              monochromeRatio: colorObservation.monochromeRatio,
            },
          });
        } catch (attributeError) {
          this.logger?.warn?.("Vehicle attribute evaluation skipped", {
            readId: Number(read.id),
            code: String(attributeError?.code || "ATTRIBUTE_EVALUATION_FAILED"),
          });
        }
        try {
          const typeObservation = await this.vehicleTypeAnalyzer.analyze(cropBuffer);
          await this.repository.saveVehicleAttributeObservation({
            readId: Number(read.id),
            attributeKey: "body_type",
            status: typeObservation.status,
            attributeValue: typeObservation.value,
            confidence: typeObservation.confidence,
            provider: VEHICLE_TYPE_PROVIDER,
            modelVersion: VEHICLE_TYPE_MODEL,
            rawResult: {
              scores: typeObservation.scores,
              input: "detected_vehicle_crop",
            },
          });
        } catch (attributeError) {
          await this.repository.saveVehicleAttributeObservation({
            readId: Number(read.id),
            attributeKey: "body_type",
            status: "failed",
            attributeValue: null,
            confidence: null,
            provider: VEHICLE_TYPE_PROVIDER,
            modelVersion: VEHICLE_TYPE_MODEL,
            rawResult: {},
            errorCode: "VEHICLE_TYPE_INFERENCE_FAILED",
          }).catch(() => {});
          this.logger?.warn?.("Vehicle type evaluation failed", {
            readId: Number(read.id),
            code: String(attributeError?.code || "VEHICLE_TYPE_INFERENCE_FAILED"),
          });
        }
      }
      try {
        const directionObservation = await this.refreshDirectionObservation(read.id, {
          directionEligibility: colorObservation.reason === "monochrome_capture"
            ? { eligible: false, reason: "monochrome_night_capture" }
            : { eligible: true, reason: null },
        });
        if (
          directionObservation?.status === "ready"
          && directionObservation.notificationRequired !== false
          && this.directionNotifier
        ) {
          try {
            await this.directionNotifier({ read, observation: directionObservation });
          } catch (notificationError) {
            this.logger?.warn?.("Vehicle direction notification skipped", {
              readId: Number(read.id),
              code: String(notificationError?.code || "DIRECTION_NOTIFICATION_FAILED"),
            });
          }
        }
      } catch (directionError) {
        this.logger?.warn?.("Vehicle direction evaluation skipped", {
          readId: Number(read.id),
          code: String(directionError?.code || "DIRECTION_EVALUATION_FAILED"),
        });
      }
      try {
        await this.refreshShadowCluster(read.id);
      } catch (clusterError) {
        this.logger?.warn?.("Vehicle shadow clustering skipped", {
          readId: Number(read.id),
          code: String(clusterError?.code || "VEHICLE_CLUSTERING_FAILED"),
        });
      }
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

  async getDirectionSetup(cameraName = null, options = {}) {
    const includeBackfill = options?.includeBackfill !== false;
    const includeCaptures = options?.includeCaptures !== false;
    const includeBlueIrisTriggerDirection = options?.includeBlueIrisTriggerDirection !== false;
    const [profiles, backfill, indexStatus] = await Promise.all([
      this.repository.listDirectionProfiles(VEHICLE_REID_MODEL),
      includeBackfill && typeof this.repository.getDirectionBackfillStatus === "function"
        ? this.repository.getDirectionBackfillStatus(VEHICLE_REID_MODEL, VEHICLE_DIRECTION_CLASSIFIER)
        : Promise.resolve({ eligible: 0, populated: 0, completed: 0, pending: 0, ready: 0, unknown: 0, failed: 0 }),
      includeBackfill
        ? this.getStatus({ includeDirection: false })
        : Promise.resolve({ pending: 0, retryable: 0, failed: 0 }),
    ]);
    const selectedName = String(cameraName || profiles[0]?.camera_name || "").trim();
    const selected = profiles.find((profile) => profile.camera_name === selectedName) || profiles[0] || null;
    const [captures, blueIrisTriggerDirection] = await Promise.all([
      selected && includeCaptures
        ? this.repository.listDirectionCalibrationCaptures(selected.camera_name, VEHICLE_REID_MODEL, 24)
        : Promise.resolve([]),
      selected
        && includeBlueIrisTriggerDirection
        && typeof this.repository.getBlueIrisTriggerDirectionStatus === "function"
        ? this.repository.getBlueIrisTriggerDirectionStatus(selected.camera_name)
        : Promise.resolve({ received: 0, ready: 0, unknown: 0, unmapped: 0, latest_at: null, recent: [] }),
    ]);
    return {
      classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
      minimumSamplesPerView: 3,
      backfill: {
        ...backfill,
        imagesAwaitingIndex: Number(indexStatus.pending || 0) + Number(indexStatus.retryable || 0),
        imageFailures: Number(indexStatus.failed || 0),
      },
      blueIrisTriggerDirection: {
        received: Number(blueIrisTriggerDirection.received || 0),
        ready: Number(blueIrisTriggerDirection.ready || 0),
        unknown: Number(blueIrisTriggerDirection.unknown || 0),
        unmapped: Number(blueIrisTriggerDirection.unmapped || 0),
        latestAt: blueIrisTriggerDirection.latest_at || null,
        recent: (blueIrisTriggerDirection.recent || []).map((read) => ({
          readId: Number(read.read_id),
          plateNumber: read.observed_plate || read.plate_number,
          cameraName: read.camera_name,
          timestamp: read.timestamp,
          triggerType: read.bi_trigger_type,
          status: read.bi_trigger_direction_status,
          directionLabel: read.bi_trigger_direction_label,
          errorCode: read.bi_trigger_direction_error_code,
          currentDirectionLabel: read.current_direction_label,
        })),
      },
      selectedCamera: selected?.camera_name || null,
      profiles: profiles.map((profile) => ({
        cameraName: profile.camera_name,
        configured: Boolean(profile.front_direction_label && profile.rear_direction_label),
        enabled: profile.enabled !== false,
        frontDirectionLabel: profile.front_direction_label || "",
        rearDirectionLabel: profile.rear_direction_label || "",
        minimumConfidence: Number(profile.minimum_confidence || 0.68),
        blueIrisMotionEnabled: profile.blue_iris_motion_enabled === true,
        blueIrisFrontTriggerType: profile.blue_iris_front_trigger_type || "",
        blueIrisRearTriggerType: profile.blue_iris_rear_trigger_type || "",
        blueIrisMotionProfileVersion: Number(profile.blue_iris_motion_profile_version || 1),
        profileVersion: Number(profile.profile_version || 1),
        frontCount: Number(profile.front_count || 0),
        rearCount: Number(profile.rear_count || 0),
      })),
      captures: captures.map((capture) => ({
        ...publicAsset(capture),
        orientation: capture.orientation || null,
        labelRevision: Number(capture.revision || 0),
        prediction: capture.direction_status ? {
          status: capture.direction_status,
          orientation: capture.predicted_orientation,
          confidence: capture.orientation_confidence === null ? null : Number(capture.orientation_confidence),
          directionLabel: capture.direction_label,
        } : null,
      })),
    };
  }

  async saveDirectionProfile(input = {}, actor = null) {
    const profile = normalizeDirectionProfile(input);
    const [read, previous] = await Promise.all([
      this.repository.getLatestCameraRead(profile.cameraName),
      this.repository.getDirectionProfile(profile.cameraName),
    ]);
    if (!read) {
      const error = new Error("Camera has no image captures");
      error.code = "INVALID_DIRECTION_PROFILE";
      throw error;
    }
    const saved = await this.repository.saveDirectionProfile(profile, actor);
    const reidProfileChanged = !previous
      || Number(previous.profile_version) !== Number(saved.profile_version);
    if (reidProfileChanged) await this.refreshCameraDirection(saved.camera_name);
    return saved;
  }

  async recordOrientationLabel({ readId, orientation, actor } = {}) {
    const asset = await this.repository.getAsset(Number(readId));
    if (!asset?.vehicle_embedding || asset.embedding_model !== VEHICLE_REID_MODEL) {
      const error = new Error("This capture must be indexed with the current Vehicle ReID model first.");
      error.code = "VEHICLE_DIRECTION_ASSET_UNAVAILABLE";
      throw error;
    }
    const reviewedOrientation = normalizeOrientation(orientation);
    const saved = await this.repository.saveOrientationLabel({
      readId: Number(readId),
      cameraName: asset.camera_name,
      embeddingModel: VEHICLE_REID_MODEL,
      orientation: reviewedOrientation,
      actor,
    });
    await this.refreshCameraDirection(asset.camera_name);
    const observation = await this.refreshDirectionObservation(Number(readId), {
      reviewedOrientation,
    });
    return { ...saved, observation };
  }

  async refreshDirectionObservation(
    readId,
    { reviewedOrientation = null, directionEligibility = null } = {}
  ) {
    if (typeof this.repository.getDirectionProfile !== "function"
      || typeof this.repository.listOrientationSamples !== "function"
      || typeof this.repository.saveDirectionObservation !== "function") return null;
    const storedEligibility = directionEligibility || (
      typeof this.repository.getDirectionImageEligibility === "function"
        ? await this.repository.getDirectionImageEligibility(
            Number(readId),
            VEHICLE_COLOR_PROVIDER,
            VEHICLE_COLOR_MODEL
          )
        : null
    );
    if (storedEligibility?.eligible === false) {
      const asset = await this.repository.getAsset(Number(readId));
      if (!asset?.vehicle_embedding || asset.embedding_model !== VEHICLE_REID_MODEL) return null;
      const profile = await this.repository.getDirectionProfile(asset.camera_name);
      if (!profile) return null;
      const unavailable = {
        status: "unknown",
        orientation: "unknown",
        confidence: null,
        counts: { front: 0, rear: 0, reason: "monochrome_night_capture" },
      };
      await this.repository.saveDirectionObservation({
        readId: Number(readId),
        cameraName: asset.camera_name,
        embeddingModel: VEHICLE_REID_MODEL,
        classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
        profileVersion: Number(profile.profile_version),
        result: unavailable,
        directionLabel: null,
      });
      return {
        ...unavailable,
        directionLabel: null,
        unavailableReason: "monochrome_night_capture",
        displayLabel: "Unavailable nighttime",
        notificationRequired: false,
      };
    }
    if (typeof this.repository.getPrimaryDirectionObservation === "function") {
      const primary = await this.repository.getPrimaryDirectionObservation(
        Number(readId),
        BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM
      );
      if (primary) {
        return {
          status: primary.status,
          orientation: primary.orientation,
          confidence: primary.orientation_confidence === null
            ? null
            : Number(primary.orientation_confidence),
          directionLabel: primary.direction_label,
          counts: primary.sample_counts || { front: 0, rear: 0 },
          source: "blue_iris_zone_crossing",
          notificationRequired: false,
        };
      }
    }
    const asset = await this.repository.getAsset(Number(readId));
    if (!asset?.vehicle_embedding || asset.embedding_model !== VEHICLE_REID_MODEL) return null;
    const profile = await this.repository.getDirectionProfile(asset.camera_name);
    if (!profile) return null;
    const samples = await this.repository.listOrientationSamples(asset.camera_name, VEHICLE_REID_MODEL);
    const counts = samples.reduce((summary, sample) => {
      if (sample.orientation === "front" || sample.orientation === "rear") {
        summary[sample.orientation] += 1;
      }
      return summary;
    }, { front: 0, rear: 0 });
    const storedReview = samples.find((sample) => Number(sample.read_id) === Number(readId))?.orientation || null;
    const authoritativeOrientation = reviewedOrientation || storedReview;
    const result = authoritativeOrientation
      ? {
          status: "ready",
          orientation: normalizeOrientation(authoritativeOrientation),
          confidence: 1,
          counts,
        }
      : classifyVehicleOrientation({
          embedding: asset.vehicle_embedding,
          samples,
          minimumConfidence: Number(profile.minimum_confidence),
        });
    const storedResult = profile.enabled === false
      ? { ...result, status: "unknown", orientation: "unknown" }
      : result;
    const normalizedProfile = {
      enabled: profile.enabled,
      frontDirectionLabel: profile.front_direction_label,
      rearDirectionLabel: profile.rear_direction_label,
    };
    const directionLabel = directionFromOrientation(normalizedProfile, storedResult);
    await this.repository.saveDirectionObservation({
      readId: Number(readId),
      cameraName: asset.camera_name,
      embeddingModel: VEHICLE_REID_MODEL,
      classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
      profileVersion: Number(profile.profile_version),
      result: storedResult,
      directionLabel,
    });
    return { ...storedResult, directionLabel };
  }

  async previewDirectionReevaluation({ cameraName = null } = {}) {
    if (typeof this.repository.getDirectionReevaluationPreview !== "function") {
      return {
        cameraName: cameraName || null,
        eligible: 0,
        cameraCount: 0,
        manualPreserved: 0,
        queued: 0,
        previousReady: 0,
        previousUnknown: 0,
        alreadyPending: 0,
      };
    }
    return this.repository.getDirectionReevaluationPreview(
      String(cameraName || "").trim() || null,
      VEHICLE_REID_MODEL,
      VEHICLE_DIRECTION_CLASSIFIER
    );
  }

  async queueDirectionReevaluation({ cameraName = null, actor = null } = {}) {
    if (typeof this.repository.queueDirectionReevaluation !== "function") {
      const error = new Error("Historical direction re-evaluation is unavailable.");
      error.code = "DIRECTION_REEVALUATION_UNAVAILABLE";
      throw error;
    }
    return this.repository.queueDirectionReevaluation({
      cameraName: String(cameraName || "").trim() || null,
      embeddingModel: VEHICLE_REID_MODEL,
      classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
      actor,
    });
  }

  async setDirectionReevaluationPaused({ paused, actor = null } = {}) {
    if (typeof this.repository.setDirectionReevaluationPaused !== "function") {
      const error = new Error("Historical direction re-evaluation controls are unavailable.");
      error.code = "DIRECTION_REEVALUATION_CONTROL_UNAVAILABLE";
      throw error;
    }
    return this.repository.setDirectionReevaluationPaused(paused === true, actor);
  }

  async refreshCameraDirection(cameraName) {
    const [assets, profile, samples] = await Promise.all([
      this.repository.listDirectionAssets(cameraName, VEHICLE_REID_MODEL, 250),
      this.repository.getDirectionProfile(cameraName),
      this.repository.listOrientationSamples(cameraName, VEHICLE_REID_MODEL),
    ]);
    if (!profile) return { evaluated: 0 };
    const counts = samples.reduce((summary, sample) => {
      if (sample.orientation === "front" || sample.orientation === "rear") {
        summary[sample.orientation] += 1;
      }
      return summary;
    }, { front: 0, rear: 0 });
    const reviewedOrientations = new Map(
      samples
        .filter((sample) => Number.isSafeInteger(Number(sample.read_id)))
        .map((sample) => [Number(sample.read_id), sample.orientation])
    );
    for (const asset of assets) {
      if (typeof this.repository.getPrimaryDirectionObservation === "function") {
        const primary = await this.repository.getPrimaryDirectionObservation(
          Number(asset.read_id),
          BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM
        );
        if (primary) continue;
      }
      const reviewedOrientation = reviewedOrientations.get(Number(asset.read_id));
      const classified = reviewedOrientation
        ? {
            status: "ready",
            orientation: normalizeOrientation(reviewedOrientation),
            confidence: 1,
            counts,
          }
        : classifyVehicleOrientation({
            embedding: asset.vehicle_embedding,
            samples,
            minimumConfidence: Number(profile.minimum_confidence),
          });
      const result = profile.enabled === false
        ? { ...classified, status: "unknown", orientation: "unknown" }
        : classified;
      await this.repository.saveDirectionObservation({
        readId: Number(asset.read_id),
        cameraName,
        embeddingModel: VEHICLE_REID_MODEL,
        classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
        profileVersion: Number(profile.profile_version),
        result,
        directionLabel: directionFromOrientation({
          enabled: profile.enabled,
          frontDirectionLabel: profile.front_direction_label,
          rearDirectionLabel: profile.rear_direction_label,
        }, result),
      });
    }
    return { evaluated: assets.length };
  }

  async backfillDirectionBatch({ limit } = {}) {
    if (typeof this.repository.listDirectionBackfillCandidates !== "function") {
      return {
        busy: false,
        processed: 0,
        succeeded: 0,
        failed: 0,
        status: { eligible: 0, populated: 0, completed: 0, pending: 0, ready: 0, unknown: 0, failed: 0 },
      };
    }
    if (this.directionBatchPromise) {
      return {
        busy: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        status: await this.repository.getDirectionBackfillStatus(
          VEHICLE_REID_MODEL,
          VEHICLE_DIRECTION_CLASSIFIER
        ),
      };
    }

    this.directionBatchPromise = (async () => {
      const startingStatus = await this.repository.getDirectionBackfillStatus(
        VEHICLE_REID_MODEL,
        VEHICLE_DIRECTION_CLASSIFIER
      );
      const candidates = await this.repository.listDirectionBackfillCandidates(
        VEHICLE_REID_MODEL,
        VEHICLE_DIRECTION_CLASSIFIER,
        normalizeBatchSize(limit),
        { includeReevaluation: startingStatus.reevaluationPaused !== true }
      );
      let succeeded = 0;
      let failed = 0;
      for (const candidate of candidates) {
        try {
          await this.refreshDirectionObservation(Number(candidate.read_id));
          if (typeof this.repository.clearDirectionBackfillFailure === "function") {
            await this.repository.clearDirectionBackfillFailure(Number(candidate.read_id));
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          if (typeof this.repository.recordDirectionBackfillFailure === "function") {
            await this.repository.recordDirectionBackfillFailure({
              readId: Number(candidate.read_id),
              embeddingModel: VEHICLE_REID_MODEL,
              classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
              profileVersion: Number(candidate.profile_version),
              error,
            });
          }
          this.logger?.warn?.("Historical vehicle direction evaluation failed", {
            readId: Number(candidate.read_id),
            code: String(error?.code || "DIRECTION_BACKFILL_FAILED"),
          });
        }
      }
      return {
        busy: false,
        processed: candidates.length,
        succeeded,
        failed,
        status: await this.repository.getDirectionBackfillStatus(
          VEHICLE_REID_MODEL,
          VEHICLE_DIRECTION_CLASSIFIER
        ),
      };
    })();

    try {
      return await this.directionBatchPromise;
    } finally {
      this.directionBatchPromise = null;
    }
  }

  async refreshShadowCluster(readId) {
    if (typeof this.repository.getVehicleClusterAssignment !== "function"
      || typeof this.repository.listVehicleClusterRepresentatives !== "function"
      || typeof this.repository.saveShadowClusterDecision !== "function") return null;
    const normalizedReadId = Number(readId);
    const existing = await this.repository.getVehicleClusterAssignment(normalizedReadId);
    if (existing) return existing;
    const asset = await this.repository.getAsset(normalizedReadId);
    if (!asset?.vehicle_embedding || asset.embedding_model !== VEHICLE_REID_MODEL) return null;
    const candidates = await this.repository.listVehicleClusterRepresentatives(VEHICLE_REID_MODEL, 500);
    const decision = chooseShadowCluster({ embedding: asset.vehicle_embedding, candidates });
    return this.repository.saveShadowClusterDecision({
      readId: normalizedReadId,
      embeddingModel: VEHICLE_REID_MODEL,
      algorithmVersion: VEHICLE_CLUSTER_ALGORITHM,
      decision,
    });
  }

  async clusterRecentUnassigned(limit = 100) {
    const bounded = Math.min(250, Math.max(1, Number.parseInt(limit, 10) || 100));
    const [assets, storedCandidates] = await Promise.all([
      this.repository.listUnassignedVehicleAssets(VEHICLE_REID_MODEL, bounded),
      this.repository.listVehicleClusterRepresentatives(VEHICLE_REID_MODEL, 500),
    ]);
    const candidates = [...storedCandidates];
    let assigned = 0;
    for (const asset of assets) {
      const decision = chooseShadowCluster({ embedding: asset.vehicle_embedding, candidates });
      const saved = await this.repository.saveShadowClusterDecision({
        readId: Number(asset.read_id),
        embeddingModel: VEHICLE_REID_MODEL,
        algorithmVersion: VEHICLE_CLUSTER_ALGORITHM,
        decision,
      });
      if (saved) {
        assigned += 1;
        if (saved.assignment_status === "seed") {
          candidates.unshift({
            cluster_id: Number(saved.cluster_id),
            vehicle_embedding: asset.vehicle_embedding,
          });
          if (candidates.length > 500) candidates.pop();
        }
      }
    }
    const [colors, types] = await Promise.all([
      this.analyzeVehicleColorAssets(assets),
      this.analyzeVehicleTypeAssets(assets),
    ]);
    return { processed: assets.length, assigned, attributes: { colors, types } };
  }

  async analyzeRecentVehicleColors(limit = 100) {
    if (typeof this.repository.listPendingVehicleColorAssets !== "function") {
      return { processed: 0, succeeded: 0, ready: 0, unknown: 0, failed: 0 };
    }
    const assets = await this.repository.listPendingVehicleColorAssets(
      VEHICLE_COLOR_PROVIDER,
      VEHICLE_COLOR_MODEL,
      limit
    );
    return this.analyzeVehicleColorAssets(assets);
  }

  async analyzeVehicleColorAssets(assets) {
    let ready = 0;
    let unknown = 0;
    let failed = 0;
    for (const asset of assets) {
      try {
        const source = await this.fileStorage.getImage(asset.derived_path);
        if (!source) throw new Error("Derived vehicle crop is unavailable");
        const pixels = await this.imageProcessor(source)
          .resize(COLOR_SAMPLE_WIDTH, COLOR_SAMPLE_HEIGHT, { fit: "fill" })
          .removeAlpha()
          .raw()
          .toBuffer();
        const observation = assessVehicleColorPixels(pixels);
        const signature = observation.signature;
        await this.repository.saveCaptureColorSignature(asset.read_id, signature, COLOR_SIGNATURE_VERSION);
        await this.repository.saveVehicleAttributeObservation({
          readId: Number(asset.read_id), attributeKey: "color", status: observation.status,
          attributeValue: observation.value, confidence: observation.confidence,
          provider: VEHICLE_COLOR_PROVIDER, modelVersion: VEHICLE_COLOR_MODEL,
          rawResult: {
            reliability: observation.reliability,
            colorSignatureVersion: COLOR_SIGNATURE_VERSION,
            reason: observation.reason,
            monochromeRatio: observation.monochromeRatio,
          },
        });
        if (observation.status === "ready") ready += 1;
        else unknown += 1;
      } catch {
        failed += 1;
      }
    }
    return { processed: assets.length, succeeded: ready + unknown, ready, unknown, failed };
  }

  async analyzeRecentVehicleTypes(limit = 100) {
    if (typeof this.repository.listPendingVehicleAttributeAssets !== "function") {
      return { processed: 0, succeeded: 0, ready: 0, unknown: 0, failed: 0 };
    }
    const assets = await this.repository.listPendingVehicleAttributeAssets({
      attributeKey: "body_type",
      provider: VEHICLE_TYPE_PROVIDER,
      modelVersion: VEHICLE_TYPE_MODEL,
      limit,
    });
    return this.analyzeVehicleTypeAssets(assets);
  }

  async analyzeVehicleTypeAssets(assets) {
    let ready = 0;
    let unknown = 0;
    let failed = 0;
    for (const asset of assets) {
      try {
        const source = await this.fileStorage.getImage(asset.derived_path);
        if (!source) throw new Error("Derived vehicle crop is unavailable");
        const observation = await this.vehicleTypeAnalyzer.analyze(source);
        await this.repository.saveVehicleAttributeObservation({
          readId: Number(asset.read_id),
          attributeKey: "body_type",
          status: observation.status,
          attributeValue: observation.value,
          confidence: observation.confidence,
          provider: VEHICLE_TYPE_PROVIDER,
          modelVersion: VEHICLE_TYPE_MODEL,
          rawResult: {
            scores: observation.scores,
            input: "detected_vehicle_crop",
          },
        });
        if (observation.status === "ready") ready += 1;
        else unknown += 1;
      } catch {
        failed += 1;
        await this.repository.saveVehicleAttributeObservation({
          readId: Number(asset.read_id),
          attributeKey: "body_type",
          status: "failed",
          attributeValue: null,
          confidence: null,
          provider: VEHICLE_TYPE_PROVIDER,
          modelVersion: VEHICLE_TYPE_MODEL,
          rawResult: {},
          errorCode: "VEHICLE_TYPE_INFERENCE_FAILED",
        }).catch(() => {});
      }
    }
    return {
      processed: assets.length,
      succeeded: ready + unknown,
      ready,
      unknown,
      failed,
    };
  }

  async getVehicleClusterOverview(options = {}) {
    const [result, directionProfiles, visualProfiles, detectionRows, calibration] = await Promise.all([
      this.repository.listVehicleClusterOverview({
        ...options,
        embeddingModel: VEHICLE_REID_MODEL,
        directionClassifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
      }),
      this.repository.listDirectionProfiles(VEHICLE_REID_MODEL),
      this.repository.listCameraProfiles(),
      this.repository.listCameraDetectionStats(),
      this.getCalibrationSummary(),
    ]);
    const timestamp = (value) => value instanceof Date ? value.toISOString() : value;
    const stats = {
      totalClusters: Number(result.stats?.total_clusters || 0),
      filteredClusters: Number(result.stats?.filtered_clusters || 0),
      shadowClusters: Number(result.stats?.shadow_clusters || 0),
      pendingReviews: Number(result.stats?.pending_reviews || 0),
      confirmedAssignments: Number(result.stats?.confirmed_assignments || 0),
      confirmedProfiles: Number(result.stats?.confirmed_profiles || 0),
      pendingPlateAssociations: Number(result.stats?.pending_plate_associations || 0),
      pendingDirectionReviews: Number(result.stats?.pending_direction_reviews || 0),
    };
    const page = (source, total) => ({
      page: source.page,
      pageSize: source.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / source.pageSize)),
    });
    const detectionByCamera = new Map(
      detectionRows.map((row) => [String(row.camera_key || "").trim(), detectorStats(row)])
    );
    const directionAttention = directionProfiles
      .map((profile) => ({
        cameraName: profile.camera_name,
        configured: Boolean(profile.front_direction_label && profile.rear_direction_label),
        enabled: profile.enabled !== false,
        frontCount: Number(profile.front_count || 0),
        rearCount: Number(profile.rear_count || 0),
      }))
      .filter((profile) => !profile.configured || !profile.enabled
        || profile.frontCount < 3 || profile.rearCount < 3);
    const detectorAttention = visualProfiles
      .map((profile) => ({
        cameraName: profile.cameraName,
        detectionStats: detectionByCamera.get(profile.cameraName.trim().toLowerCase()) || detectorStats(),
      }))
      .filter((profile) => profile.detectionStats.shouldReviewFallback);
    return {
      stats,
      clusters: result.clusters.map((cluster) => ({
        id: Number(cluster.id),
        status: cluster.status,
        representativeReadId: Number(cluster.representative_read_id),
        representativeImageUrl: `/images/${cluster.representative_path}`,
        representativePlate: cluster.representative_plate,
        representativeCamera: cluster.representative_camera,
        representativeColor: cluster.representative_color || null,
        representativeColorConfidence: cluster.representative_color_confidence === null
          ? null : Number(cluster.representative_color_confidence),
        representativeBodyType: cluster.representative_body_type || null,
        representativeBodyTypeConfidence: cluster.representative_body_type_confidence === null
          ? null : Number(cluster.representative_body_type_confidence),
        captureCount: Number(cluster.capture_count || 0),
        confirmedCount: Number(cluster.confirmed_count || 0),
        observedPlates: Array.isArray(cluster.observed_plates) ? cluster.observed_plates : [],
        confirmedPlateAssociations: Array.isArray(cluster.confirmed_plate_associations)
          ? cluster.confirmed_plate_associations : [],
        suggestedPlateAssociations: Array.isArray(cluster.suggested_plate_associations)
          ? cluster.suggested_plate_associations : [],
        firstSeen: timestamp(cluster.first_seen),
        lastSeen: timestamp(cluster.last_seen),
      })),
      suggestions: result.suggestions.map((suggestion) => ({
        readId: Number(suggestion.read_id),
        clusterId: Number(suggestion.cluster_id),
        similarity: Number(suggestion.similarity),
        margin: Number(suggestion.similarity_margin),
        revision: Number(suggestion.revision),
        candidateImageUrl: `/images/${suggestion.candidate_path}`,
        candidatePlate: suggestion.candidate_plate,
        candidateCamera: suggestion.candidate_camera,
        candidateTimestamp: timestamp(suggestion.candidate_timestamp),
        representativeImageUrl: `/images/${suggestion.representative_path}`,
        representativePlate: suggestion.representative_plate,
        representativeCamera: suggestion.representative_camera,
      })),
      plateAssociationReviews: result.associations.map((association) => ({
        id: Number(association.id),
        clusterId: Number(association.cluster_id),
        clusterStatus: association.cluster_status,
        plateNumber: association.plate_number,
        evidenceCount: Number(association.evidence_count || 0),
        confidence: association.confidence === null ? null : Number(association.confidence),
        firstSeen: timestamp(association.first_seen_at),
        lastSeen: timestamp(association.last_seen_at),
        revision: Number(association.revision || 1),
        knownName: association.known_name || null,
        tags: Array.isArray(association.tags) ? association.tags : [],
        representativeImageUrl: `/images/${association.representative_path}`,
        representativePlate: association.representative_plate,
        representativeCamera: association.representative_camera,
        evidenceImageUrl: `/images/${association.evidence_path}`,
        evidenceReadId: Number(association.evidence_read_id),
        evidenceCamera: association.evidence_camera,
        evidenceTimestamp: timestamp(association.evidence_timestamp),
      })),
      directionReviews: result.directionReviews.map((capture) => ({
        readId: Number(capture.read_id),
        imageUrl: `/images/${capture.derived_path}`,
        plateNumber: capture.plate_number,
        observedPlate: capture.observed_plate || capture.plate_number,
        cameraName: capture.camera_name,
        timestamp: timestamp(capture.timestamp),
        prediction: capture.direction_status ? {
          status: capture.direction_status,
          orientation: capture.predicted_orientation,
          confidence: capture.orientation_confidence === null
            ? null : Number(capture.orientation_confidence),
          directionLabel: capture.direction_label,
        } : null,
        frontDirectionLabel: capture.front_direction_label,
        rearDirectionLabel: capture.rear_direction_label,
      })),
      pagination: {
        profiles: page(result.pagination.profiles, stats.filteredClusters),
        vehicleReviews: page(result.pagination.vehicleReviews, stats.pendingReviews),
        plateReviews: page(result.pagination.plateReviews, stats.pendingPlateAssociations),
        directionReviews: page(result.pagination.directionReviews, stats.pendingDirectionReviews),
      },
      filters: result.filters,
      cameras: directionProfiles.map((profile) => profile.camera_name),
      attention: {
        direction: directionAttention,
        detector: detectorAttention,
      },
      calibration,
      algorithmVersion: VEHICLE_CLUSTER_ALGORITHM,
      mode: "shadow",
    };
  }

  async getVehicleProfile(clusterId) {
    const normalizedClusterId = Number.parseInt(clusterId, 10);
    if (!Number.isSafeInteger(normalizedClusterId) || normalizedClusterId < 1) return null;
    const result = await this.repository.getVehicleClusterProfile(normalizedClusterId);
    if (!result) return null;
    const timestamp = (value) => value instanceof Date ? value.toISOString() : value;
    const profile = result.profile;
    return {
      id: Number(profile.id),
      status: profile.status,
      representativeReadId: Number(profile.representative_read_id),
      representativeImageUrl: `/images/${profile.representative_path}`,
      representativePlate: profile.representative_plate,
      representativeCamera: profile.representative_camera,
      representativeTimestamp: timestamp(profile.representative_timestamp),
      representativeColor: profile.representative_color || null,
      representativeColorConfidence: profile.representative_color_confidence === null
        ? null : Number(profile.representative_color_confidence),
      representativeBodyType: profile.representative_body_type || null,
      representativeBodyTypeConfidence: profile.representative_body_type_confidence === null
        ? null : Number(profile.representative_body_type_confidence),
      captureCount: Number(profile.capture_count || 0),
      confirmedCount: Number(profile.confirmed_count || 0),
      firstSeen: timestamp(profile.first_seen),
      lastSeen: timestamp(profile.last_seen),
      associations: result.associations.map((association) => ({
        id: Number(association.id),
        plateNumber: association.plate_number,
        status: association.status,
        evidenceCount: Number(association.evidence_count || 0),
        confidence: association.confidence === null ? null : Number(association.confidence),
        firstSeen: timestamp(association.first_seen_at),
        lastSeen: timestamp(association.last_seen_at),
        knownName: association.known_name || null,
        tags: Array.isArray(association.tags) ? association.tags : [],
        revision: Number(association.revision || 1),
        updatedAt: timestamp(association.updated_at),
      })),
      captures: result.captures.map((capture) => ({
        readId: Number(capture.read_id),
        imageUrl: `/images/${capture.derived_path}`,
        plateNumber: capture.plate_number,
        observedPlate: capture.observed_plate || capture.plate_number,
        cameraName: capture.camera_name,
        timestamp: timestamp(capture.timestamp),
        assignmentStatus: capture.assignment_status,
        similarity: capture.similarity === null ? null : Number(capture.similarity),
        similarityMargin: capture.similarity_margin === null ? null : Number(capture.similarity_margin),
        color: capture.vehicle_color || null,
        colorConfidence: capture.vehicle_color_confidence === null
          ? null : Number(capture.vehicle_color_confidence),
        bodyType: capture.vehicle_body_type || null,
        bodyTypeConfidence: capture.vehicle_body_type_confidence === null
          ? null : Number(capture.vehicle_body_type_confidence),
        direction: capture.direction_label || null,
        orientation: capture.orientation || null,
        orientationConfidence: capture.orientation_confidence === null
          ? null : Number(capture.orientation_confidence),
      })),
      algorithmVersion: profile.algorithm_version,
      embeddingModel: profile.embedding_model,
    };
  }

  async reviewVehiclePlateAssociation({ clusterId, plateNumber, decision, actor }) {
    return this.repository.reviewVehiclePlateAssociation({
      clusterId,
      plateNumber,
      decision,
      actor,
    });
  }

  async reviewVehicleCluster({ readId, decision, actor }) {
    const normalizedReadId = Number.parseInt(readId, 10);
    if (!Number.isSafeInteger(normalizedReadId) || normalizedReadId < 1) {
      const error = new Error("Vehicle assignment was not found.");
      error.code = "VEHICLE_CLUSTER_ASSIGNMENT_NOT_FOUND";
      throw error;
    }
    return this.repository.reviewVehicleClusterAssignment({
      readId: normalizedReadId,
      decision: normalizeClusterReviewDecision(decision),
      embeddingModel: VEHICLE_REID_MODEL,
      algorithmVersion: VEHICLE_CLUSTER_ALGORITHM,
      actor,
    });
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

  async getStatus({ includeDirection = true } = {}) {
    const [status, direction, vehicleTypePending, vehicleColorPending] = await Promise.all([
      this.repository.getStatus(),
      includeDirection && typeof this.repository.getDirectionBackfillStatus === "function"
        ? this.repository.getDirectionBackfillStatus(
            VEHICLE_REID_MODEL,
            VEHICLE_DIRECTION_CLASSIFIER
          )
        : Promise.resolve(undefined),
      typeof this.repository.getPendingVehicleAttributeCount === "function"
        ? this.repository.getPendingVehicleAttributeCount({
            attributeKey: "body_type",
            provider: VEHICLE_TYPE_PROVIDER,
            modelVersion: VEHICLE_TYPE_MODEL,
          })
        : Promise.resolve(0),
      typeof this.repository.getPendingVehicleAttributeCount === "function"
        ? this.repository.getPendingVehicleAttributeCount({
            attributeKey: "color",
            provider: VEHICLE_COLOR_PROVIDER,
            modelVersion: VEHICLE_COLOR_MODEL,
          })
        : Promise.resolve(0),
    ]);
    return {
      total: Number(status.total || 0),
      ready: Number(status.ready || 0),
      failed: Number(status.failed || 0),
      retryable: Number(status.retryable || 0),
      pending: Number(status.pending || 0),
      lastIndexedAt: status.last_indexed_at || null,
      ...(direction ? { direction } : {}),
      attributes: {
        vehicleTypePending: Number(vehicleTypePending || 0),
        vehicleColorPending: Number(vehicleColorPending || 0),
      },
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
