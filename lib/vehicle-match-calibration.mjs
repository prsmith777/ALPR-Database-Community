export const VEHICLE_MATCH_FEEDBACK_LABELS = Object.freeze([
  "same_vehicle",
  "different_vehicle",
]);

export class VehicleMatchFeedbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VehicleMatchFeedbackError";
    this.code = code;
  }
}

export function normalizeVehicleMatchReadId(value) {
  const readId = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(readId) || readId < 1) {
    throw new VehicleMatchFeedbackError(
      "INVALID_VEHICLE_MATCH_PAIR",
      "Choose two stored captures to label."
    );
  }
  return readId;
}

export function canonicalVehicleMatchPair(sourceReadId, candidateReadId) {
  const source = normalizeVehicleMatchReadId(sourceReadId);
  const candidate = normalizeVehicleMatchReadId(candidateReadId);
  if (source === candidate) {
    throw new VehicleMatchFeedbackError(
      "INVALID_VEHICLE_MATCH_PAIR",
      "A capture cannot be compared with itself."
    );
  }
  return {
    sourceReadId: source,
    candidateReadId: candidate,
    readIdLow: Math.min(source, candidate),
    readIdHigh: Math.max(source, candidate),
  };
}

export function normalizeVehicleMatchFeedbackLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  if (!VEHICLE_MATCH_FEEDBACK_LABELS.includes(label)) {
    throw new VehicleMatchFeedbackError(
      "INVALID_VEHICLE_MATCH_LABEL",
      "Choose Same vehicle or Different vehicle."
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
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function percent(value, digits = 1) {
  return value === null || !Number.isFinite(value)
    ? null
    : Number((value * 100).toFixed(digits));
}

function scoreSummary(values) {
  if (!values.length) return { average: null, median: null, minimum: null, maximum: null };
  return {
    average: percent(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: percent(percentile(values, 0.5)),
    minimum: percent(Math.min(...values)),
    maximum: percent(Math.max(...values)),
  };
}

function thresholdMetrics(rows, threshold) {
  const same = rows.filter((row) => row.label === "same_vehicle");
  const different = rows.filter((row) => row.label === "different_vehicle");
  const truePositives = same.filter((row) => row.similarity >= threshold).length;
  const falseNegatives = same.length - truePositives;
  const falsePositives = different.filter((row) => row.similarity >= threshold).length;
  const trueNegatives = different.length - falsePositives;
  const recall = same.length ? truePositives / same.length : 0;
  const specificity = different.length ? trueNegatives / different.length : 0;
  const precision = truePositives + falsePositives
    ? truePositives / (truePositives + falsePositives)
    : 1;
  return {
    threshold,
    truePositives,
    falseNegatives,
    falsePositives,
    trueNegatives,
    recall,
    specificity,
    precision,
    balancedAccuracy: (recall + specificity) / 2,
    falsePositiveRate: different.length ? falsePositives / different.length : 0,
  };
}

export function summarizeVehicleMatchFeedback(
  inputRows = [],
  { minimumClassSamples = 3 } = {}
) {
  const rows = inputRows
    .map((row) => ({
      label: String(row.label || "").trim().toLowerCase(),
      similarity: Number(row.similarity_score ?? row.similarity),
    }))
    .filter((row) =>
      VEHICLE_MATCH_FEEDBACK_LABELS.includes(row.label)
      && Number.isFinite(row.similarity)
      && row.similarity >= -1
      && row.similarity <= 1
    );
  const same = rows.filter((row) => row.label === "same_vehicle");
  const different = rows.filter((row) => row.label === "different_vehicle");
  const sufficient = same.length >= minimumClassSamples && different.length >= minimumClassSamples;
  let recommendation = null;

  if (sufficient) {
    const candidates = [...new Set(rows.map((row) => row.similarity))]
      .sort((left, right) => left - right);
    const upper = Math.min(1, Math.max(...candidates) + Number.EPSILON);
    const metrics = [...candidates, upper].map((threshold) => thresholdMetrics(rows, threshold));
    metrics.sort((left, right) =>
      right.balancedAccuracy - left.balancedAccuracy
      || left.falsePositiveRate - right.falsePositiveRate
      || right.threshold - left.threshold
    );
    const best = metrics[0];
    recommendation = {
      threshold: Number(best.threshold.toFixed(4)),
      thresholdPercent: percent(best.threshold),
      balancedAccuracyPercent: percent(best.balancedAccuracy),
      precisionPercent: percent(best.precision),
      recallPercent: percent(best.recall),
      specificityPercent: percent(best.specificity),
      falsePositives: best.falsePositives,
      falseNegatives: best.falseNegatives,
    };
  }

  return {
    total: rows.length,
    sameVehicle: same.length,
    differentVehicle: different.length,
    minimumClassSamples,
    neededSameVehicle: Math.max(0, minimumClassSamples - same.length),
    neededDifferentVehicle: Math.max(0, minimumClassSamples - different.length),
    sufficient,
    sameScores: scoreSummary(same.map((row) => row.similarity)),
    differentScores: scoreSummary(different.map((row) => row.similarity)),
    recommendation,
  };
}

export const vehicleMatchCalibrationInternals = Object.freeze({
  percentile,
  scoreSummary,
  thresholdMetrics,
});
