export const VEHICLE_REID_V2_REVIEW_LABELS = Object.freeze([
  "same_vehicle",
  "different_vehicle",
  "unsure",
]);

export class VehicleReidV2ReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VehicleReidV2ReviewError";
    this.code = code;
  }
}

function positiveId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new VehicleReidV2ReviewError(
      "INVALID_VEHICLE_REID_V2_REVIEW_PAIR",
      "Choose two current canonical crops to review."
    );
  }
  return id;
}

export function canonicalVehicleReidV2ReviewPair(sourceDerivativeId, candidateDerivativeId) {
  const source = positiveId(sourceDerivativeId);
  const candidate = positiveId(candidateDerivativeId);
  if (source === candidate) {
    throw new VehicleReidV2ReviewError(
      "INVALID_VEHICLE_REID_V2_REVIEW_PAIR",
      "A canonical crop cannot be compared with itself."
    );
  }
  return {
    sourceDerivativeId: source,
    candidateDerivativeId: candidate,
    derivativeIdLow: Math.min(source, candidate),
    derivativeIdHigh: Math.max(source, candidate),
  };
}

export function normalizeVehicleReidV2ReviewLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  if (!VEHICLE_REID_V2_REVIEW_LABELS.includes(label)) {
    throw new VehicleReidV2ReviewError(
      "INVALID_VEHICLE_REID_V2_REVIEW_LABEL",
      "Choose Same vehicle, Different vehicle, or Unsure."
    );
  }
  return label;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function percent(value, digits = 1) {
  return Number.isFinite(value) ? Number((value * 100).toFixed(digits)) : null;
}

function scoreSummary(rows) {
  const values = rows.map((row) => Number(row.similarity_score ?? row.similarity))
    .filter((value) => Number.isFinite(value) && value >= -1 && value <= 1);
  if (!values.length) {
    return { average: null, median: null, minimum: null, maximum: null };
  }
  return {
    average: percent(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: percent(percentile(values, 0.5)),
    minimum: percent(Math.min(...values)),
    maximum: percent(Math.max(...values)),
  };
}

function normalizedContext(left, right) {
  return [left, right].map((value) => String(value || "unknown").trim().toLowerCase())
    .sort().join(" ↔ ");
}

function normalizedCameraPair(left, right) {
  return [left, right].map((value) => String(value || "Unknown camera").trim() || "Unknown camera")
    .sort((a, b) => a.localeCompare(b)).join(" ↔ ");
}

function groupedCounts(rows, keyFor) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const current = grouped.get(key) || {
      key,
      total: 0,
      sameVehicle: 0,
      differentVehicle: 0,
      unsure: 0,
    };
    current.total += 1;
    if (row.label === "same_vehicle") current.sameVehicle += 1;
    if (row.label === "different_vehicle") current.differentVehicle += 1;
    if (row.label === "unsure") current.unsure += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

export function summarizeVehicleReidV2Reviews(inputRows = []) {
  const rows = inputRows.map((row) => ({
    ...row,
    label: String(row.label || "").trim().toLowerCase(),
    similarity_score: Number(row.similarity_score ?? row.similarity),
  })).filter((row) => (
    VEHICLE_REID_V2_REVIEW_LABELS.includes(row.label)
    && Number.isFinite(row.similarity_score)
    && row.similarity_score >= -1
    && row.similarity_score <= 1
  ));
  const same = rows.filter((row) => row.label === "same_vehicle");
  const different = rows.filter((row) => row.label === "different_vehicle");
  const unsure = rows.filter((row) => row.label === "unsure");
  return {
    total: rows.length,
    sameVehicle: same.length,
    differentVehicle: different.length,
    unsure: unsure.length,
    sameScores: scoreSummary(same),
    differentScores: scoreSummary(different),
    byContext: groupedCounts(rows, (row) => normalizedContext(
      row.evidence_context_low,
      row.evidence_context_high
    )),
    byCameraPair: groupedCounts(rows, (row) => normalizedCameraPair(
      row.evidence_camera_low,
      row.evidence_camera_high
    )).slice(0, 12),
    thresholdApplied: false,
    recommendation: null,
  };
}

export function publicVehicleReidV2Review(row, candidateDerivativeId = null) {
  if (!row) return null;
  const candidateId = Number(candidateDerivativeId);
  const low = Number(row.derivative_id_low);
  const high = Number(row.derivative_id_high);
  return {
    id: Number(row.id),
    candidateDerivativeId: Number.isSafeInteger(candidateId) && candidateId > 0
      ? candidateId
      : null,
    derivativeIdLow: low,
    derivativeIdHigh: high,
    label: row.label,
    similarity: Number(row.similarity_score),
    modelName: row.embedding_model,
    algorithmVersion: row.algorithm_version,
    revision: Number(row.revision || 1),
    reviewedAt: row.updated_at || null,
    reviewer: {
      username: row.actor_username || null,
      displayName: row.actor_display_name || null,
    },
  };
}

export const vehicleReidV2ReviewInternals = Object.freeze({
  groupedCounts,
  normalizedCameraPair,
  normalizedContext,
  percentile,
  scoreSummary,
});
