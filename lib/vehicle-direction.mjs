import { cosineSimilarity, decodeVehicleEmbedding } from "./vehicle-reid.mjs";
import { normalizeBlueIrisDirectionProfile } from "./blue-iris-trigger-direction.mjs";

export const VEHICLE_DIRECTION_CLASSIFIER = "vehicle-reid-orientation-knn-v1";
export const VEHICLE_ORIENTATIONS = Object.freeze(["front", "rear"]);
export const MIN_ORIENTATION_SAMPLES_PER_CLASS = 3;

export class VehicleDirectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanText(value, maximum = 80) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

export function normalizeOrientation(value) {
  const orientation = cleanText(value, 20).toLowerCase();
  if (!VEHICLE_ORIENTATIONS.includes(orientation)) {
    throw new VehicleDirectionError(
      "INVALID_VEHICLE_ORIENTATION",
      "Choose whether this capture shows the front or rear of the vehicle."
    );
  }
  return orientation;
}

export function normalizeDirectionProfile(input = {}) {
  const cameraName = cleanText(input.cameraName, 100);
  const frontDirectionLabel = cleanText(input.frontDirectionLabel);
  const rearDirectionLabel = cleanText(input.rearDirectionLabel);
  const minimumConfidence = Math.min(0.95, Math.max(0.5, Number(input.minimumConfidence) || 0.68));
  if (!cameraName) {
    throw new VehicleDirectionError("INVALID_DIRECTION_PROFILE", "Select a camera.");
  }
  if (!frontDirectionLabel || !rearDirectionLabel) {
    throw new VehicleDirectionError(
      "INVALID_DIRECTION_PROFILE",
      "Enter the direction represented by both a front view and a rear view."
    );
  }
  if (frontDirectionLabel.toLowerCase() === rearDirectionLabel.toLowerCase()) {
    throw new VehicleDirectionError(
      "INVALID_DIRECTION_PROFILE",
      "Front and rear views must represent different directions."
    );
  }
  const blueIrisMotion = normalizeBlueIrisDirectionProfile(input);
  return {
    cameraName,
    enabled: input.enabled !== false,
    frontDirectionLabel,
    rearDirectionLabel,
    minimumConfidence: Number(minimumConfidence.toFixed(2)),
    blueIrisMotionEnabled: blueIrisMotion.enabled,
    blueIrisFrontTriggerType: blueIrisMotion.frontTriggerType,
    blueIrisRearTriggerType: blueIrisMotion.rearTriggerType,
  };
}

function summarizeLabels(samples = []) {
  return samples.reduce((counts, sample) => {
    if (VEHICLE_ORIENTATIONS.includes(sample.orientation)) counts[sample.orientation] += 1;
    return counts;
  }, { front: 0, rear: 0 });
}

export function classifyVehicleOrientation({ embedding, samples = [], minimumConfidence = 0.68 } = {}) {
  const query = embedding instanceof Float32Array ? embedding : decodeVehicleEmbedding(embedding);
  const usable = samples.map((sample) => ({
    orientation: sample.orientation,
    embedding: sample.embedding instanceof Float32Array
      ? sample.embedding
      : decodeVehicleEmbedding(sample.vehicle_embedding ?? sample.embedding),
  })).filter((sample) => VEHICLE_ORIENTATIONS.includes(sample.orientation) && sample.embedding);
  const counts = summarizeLabels(usable);
  if (!query || counts.front < MIN_ORIENTATION_SAMPLES_PER_CLASS || counts.rear < MIN_ORIENTATION_SAMPLES_PER_CLASS) {
    return { status: "collecting", orientation: "unknown", confidence: null, counts };
  }

  const neighbors = usable.map((sample) => ({
    orientation: sample.orientation,
    similarity: cosineSimilarity(query, sample.embedding),
  })).filter((sample) => Number.isFinite(sample.similarity))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 7);
  if (!neighbors.length) return { status: "unknown", orientation: "unknown", confidence: null, counts };

  const votes = { front: 0, rear: 0 };
  for (const neighbor of neighbors) {
    votes[neighbor.orientation] += Math.exp((neighbor.similarity - 0.75) * 8);
  }
  const total = votes.front + votes.rear;
  const orientation = votes.front >= votes.rear ? "front" : "rear";
  const confidence = total > 0 ? Math.max(votes.front, votes.rear) / total : 0;
  if (confidence < minimumConfidence) {
    return { status: "unknown", orientation: "unknown", confidence: Number(confidence.toFixed(4)), counts };
  }
  return { status: "ready", orientation, confidence: Number(confidence.toFixed(4)), counts };
}

export function directionFromOrientation(profile, result) {
  if (!profile?.enabled || result?.status !== "ready") return null;
  if (result.orientation === "front") return profile.frontDirectionLabel || profile.front_direction_label || null;
  if (result.orientation === "rear") return profile.rearDirectionLabel || profile.rear_direction_label || null;
  return null;
}
