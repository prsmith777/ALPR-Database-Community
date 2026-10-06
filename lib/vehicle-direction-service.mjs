import {
  VEHICLE_DIRECTION_CLASSIFIER, classifyVehicleOrientation, directionFromOrientation,
  normalizeDirectionProfile, normalizeOrientation, DIRECTION_EMBEDDING_MODEL,
} from "./vehicle-direction.mjs";
import { VEHICLE_COLOR_MODEL, VEHICLE_COLOR_PROVIDER } from "./vehicle-attributes.mjs";
import { BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM } from "./blue-iris-trigger-direction.mjs";

function normalizeBatchSize(value) { return Math.min(25, Math.max(1, Number(value) || 5)); }
function publicAsset(asset) {
  return {
    readId: Number(asset.read_id), plateNumber: asset.plate_number,
    observedPlate: asset.observed_plate || asset.plate_number,
    cameraName: asset.camera_name || "Unknown camera",
    timestamp: asset.timestamp instanceof Date ? asset.timestamp.toISOString() : asset.timestamp,
    imageUrl: `/images/${asset.derived_path}`,
  };
}

export class VehicleDirectionService {
  constructor({ repository, directionNotifier = null, changeNotifier = null, logger = console } = {}) {
    if (!repository) throw new Error("Vehicle direction requires a repository");
    this.repository = repository;
    this.directionNotifier = directionNotifier;
    this.changeNotifier = changeNotifier;
    this.logger = logger;
    this.directionBatchPromise = null;
  }

  async getDirectionSetup(cameraName = null, options = {}) {
    const includeBackfill = options?.includeBackfill !== false;
    const includeCaptures = options?.includeCaptures !== false;
    const includeBlueIrisTriggerDirection = options?.includeBlueIrisTriggerDirection !== false;
    const [profiles, backfill] = await Promise.all([
      this.repository.listDirectionProfiles(DIRECTION_EMBEDDING_MODEL),
      includeBackfill && typeof this.repository.getDirectionBackfillStatus === "function"
        ? this.repository.getDirectionBackfillStatus(DIRECTION_EMBEDDING_MODEL, VEHICLE_DIRECTION_CLASSIFIER)
        : Promise.resolve({ eligible: 0, populated: 0, completed: 0, pending: 0, ready: 0, unknown: 0, failed: 0 }),
    ]);
    const selectedName = String(cameraName || profiles[0]?.camera_name || "").trim();
    const selected = profiles.find((profile) => profile.camera_name === selectedName) || profiles[0] || null;
    const [captures, blueIrisTriggerDirection] = await Promise.all([
      selected && includeCaptures
        ? this.repository.listDirectionCalibrationCaptures(selected.camera_name, DIRECTION_EMBEDDING_MODEL, 24)
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
      backfill,
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
        sourceEmbeddingId: Number(capture.embedding_id),
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

  async recordOrientationLabel({ readId, sourceEmbeddingId, orientation, actor } = {}) {
    const asset = await this.repository.getAsset(Number(readId));
    if (!asset?.vehicle_embedding || asset.embedding_model !== DIRECTION_EMBEDDING_MODEL) {
      const error = new Error("This capture must be indexed with the current Vehicle ReID model first.");
      error.code = "VEHICLE_DIRECTION_ASSET_UNAVAILABLE";
      throw error;
    }
    if (sourceEmbeddingId !== undefined && (!Number.isSafeInteger(Number(sourceEmbeddingId))
      || Number(sourceEmbeddingId) <= 0 || Number(sourceEmbeddingId) !== Number(asset.embedding_id))) {
      const error = new Error("Direction image changed; refresh before labeling.");
      error.code = "VEHICLE_DIRECTION_ASSET_UNAVAILABLE";
      throw error;
    }
    const eligibility = typeof this.repository.getDirectionImageEligibility === "function"
      ? await this.repository.getDirectionImageEligibility(Number(readId)) : null;
    if (eligibility?.eligible === false) {
      const error = new Error("Monochrome nighttime crops cannot be used as direction training.");
      error.code = "VEHICLE_DIRECTION_ASSET_UNAVAILABLE";
      throw error;
    }
    const reviewedOrientation = normalizeOrientation(orientation);
    const saved = await this.repository.saveOrientationLabel({
      readId: Number(readId),
      cameraName: asset.camera_name,
      embeddingModel: DIRECTION_EMBEDDING_MODEL,
      sourceEmbeddingId: asset.embedding_id,
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
      if (!asset?.vehicle_embedding || asset.embedding_model !== DIRECTION_EMBEDDING_MODEL) return null;
      const profile = await this.repository.getDirectionProfile(asset.camera_name);
      if (!profile) return null;
      const unavailable = {
        status: "unknown",
        orientation: "unknown",
        confidence: null,
        counts: { front: 0, rear: 0, reason: "monochrome_night_capture" },
      };
      const applied = await this.repository.saveDirectionObservation({
        readId: Number(readId),
        cameraName: asset.camera_name,
        embeddingModel: DIRECTION_EMBEDDING_MODEL,
        sourceEmbeddingId: asset.embedding_id,
        classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
        profileVersion: Number(profile.profile_version),
        result: unavailable,
        directionLabel: null,
      });
      if (applied === false) return null;
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
    if (!asset?.vehicle_embedding || asset.embedding_model !== DIRECTION_EMBEDDING_MODEL) return null;
    const profile = await this.repository.getDirectionProfile(asset.camera_name);
    if (!profile) return null;
    const samples = await this.repository.listOrientationSamples(asset.camera_name, DIRECTION_EMBEDDING_MODEL);
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
    const applied = await this.repository.saveDirectionObservation({
      readId: Number(readId),
      cameraName: asset.camera_name,
      embeddingModel: DIRECTION_EMBEDDING_MODEL,
      sourceEmbeddingId: asset.embedding_id,
      classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
      profileVersion: Number(profile.profile_version),
      result: storedResult,
      directionLabel,
    });
    if (applied === false) return null;
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
      DIRECTION_EMBEDDING_MODEL,
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
      embeddingModel: DIRECTION_EMBEDDING_MODEL,
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
      this.repository.listDirectionAssets(cameraName, DIRECTION_EMBEDDING_MODEL, 250),
      this.repository.getDirectionProfile(cameraName),
      this.repository.listOrientationSamples(cameraName, DIRECTION_EMBEDDING_MODEL),
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
      const applied = await this.repository.saveDirectionObservation({
        readId: Number(asset.read_id),
        cameraName,
        embeddingModel: DIRECTION_EMBEDDING_MODEL,
        sourceEmbeddingId: asset.embedding_id,
        classifierVersion: VEHICLE_DIRECTION_CLASSIFIER,
        profileVersion: Number(profile.profile_version),
        result,
        directionLabel: directionFromOrientation({
          enabled: profile.enabled,
          frontDirectionLabel: profile.front_direction_label,
          rearDirectionLabel: profile.rear_direction_label,
        }, result),
      });
      if (applied === false) continue;
    }
    return { evaluated: assets.length };
  }

  async backfillDirectionBatch({ limit, includeStatus = true, notifyRecent = false } = {}) {
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
        status: includeStatus ? await this.repository.getDirectionBackfillStatus(
          DIRECTION_EMBEDDING_MODEL,
          VEHICLE_DIRECTION_CLASSIFIER
        ) : null,
      };
    }

    this.directionBatchPromise = (async () => {
      const startingStatus = includeStatus
        ? await this.repository.getDirectionBackfillStatus(DIRECTION_EMBEDDING_MODEL, VEHICLE_DIRECTION_CLASSIFIER)
        : { reevaluationPaused: await this.repository.isDirectionReevaluationPaused() };
      const candidates = await this.repository.listDirectionBackfillCandidates(
        DIRECTION_EMBEDDING_MODEL,
        VEHICLE_DIRECTION_CLASSIFIER,
        normalizeBatchSize(limit),
        { includeReevaluation: startingStatus.reevaluationPaused !== true }
      );
      let succeeded = 0;
      let failed = 0;
      for (const candidate of candidates) {
        try {
          const observation = await this.refreshDirectionObservation(Number(candidate.read_id));
          this.changeNotifier?.({ readId: Number(candidate.read_id), reason: "vehicle_direction" });
          if (notifyRecent && observation?.status === "ready" && observation.notificationRequired !== false && this.directionNotifier) {
            const read = await this.repository.getRead(Number(candidate.read_id));
            const age = Date.now() - new Date(read?.timestamp).getTime();
            if (age >= 0 && age <= 5 * 60_000) await this.directionNotifier({ read, observation });
          }
          if (typeof this.repository.clearDirectionBackfillFailure === "function") {
            await this.repository.clearDirectionBackfillFailure(Number(candidate.read_id));
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          if (typeof this.repository.recordDirectionBackfillFailure === "function") {
            await this.repository.recordDirectionBackfillFailure({
              readId: Number(candidate.read_id),
              embeddingModel: DIRECTION_EMBEDDING_MODEL,
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
        status: includeStatus ? await this.repository.getDirectionBackfillStatus(
          DIRECTION_EMBEDDING_MODEL,
          VEHICLE_DIRECTION_CLASSIFIER
        ) : null,
      };
    })();

    try {
      return await this.directionBatchPromise;
    } finally {
      this.directionBatchPromise = null;
    }
  }

}
