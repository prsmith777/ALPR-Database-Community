const REVIEW_LABELS = Object.freeze([
  "same_vehicle",
  "different_vehicle",
  "unsure",
]);

const SCORE_BANDS = Object.freeze([
  { key: "below 60%", minimum: -1, maximum: 0.6 },
  { key: "60–69.9%", minimum: 0.6, maximum: 0.7 },
  { key: "70–79.9%", minimum: 0.7, maximum: 0.8 },
  { key: "80–89.9%", minimum: 0.8, maximum: 0.9 },
  { key: "90–100%", minimum: 0.9, maximum: 1.000001 },
]);

const COVERAGE_FLOOR = 3;
const OVERLAP_BAND_FLOOR = 5;
const DEFAULT_TIME_ZONE = "America/Denver";

function percent(value, digits = 1) {
  return Number.isFinite(value) ? Number((value * 100).toFixed(digits)) : null;
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

function scoreSummary(rows) {
  const values = rows.map((row) => row.similarityScore);
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

function normalizedText(value, fallback) {
  return String(value || "").trim() || fallback;
}

function normalizedPair(left, right, fallback) {
  return [normalizedText(left, fallback), normalizedText(right, fallback)]
    .sort((a, b) => a.localeCompare(b))
    .join(" ↔ ");
}

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function plateEvidenceKey(row) {
  const low = normalizedPlate(row.evidencePlateLow);
  const high = normalizedPlate(row.evidencePlateHigh);
  if (!low || !high) return "incomplete effective-plate evidence";
  return low === high ? "same effective plate" : "different effective plates";
}

function validTimeZone(value) {
  const candidate = normalizedText(value, DEFAULT_TIME_ZONE);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function localPeriod(timestamp, timeZone) {
  if (!timestamp) return "unknown local time";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown local time";
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date));
  if (!Number.isInteger(hour)) return "unknown local time";
  return hour >= 6 && hour < 20
    ? "daytime hours (06:00–19:59)"
    : "overnight hours (20:00–05:59)";
}

function scoreBandKey(score) {
  return SCORE_BANDS.find((band) => score >= band.minimum && score < band.maximum)?.key
    || "outside valid score range";
}

function normalizeRows(inputRows) {
  return inputRows.map((row) => ({
    label: normalizedText(row.label, "").toLowerCase(),
    similarityScore: Number(row.similarity_score ?? row.similarity),
    evidenceContextLow: normalizedText(row.evidence_context_low, "unknown context"),
    evidenceContextHigh: normalizedText(row.evidence_context_high, "unknown context"),
    evidenceCameraLow: normalizedText(row.evidence_camera_low, "Unknown camera"),
    evidenceCameraHigh: normalizedText(row.evidence_camera_high, "Unknown camera"),
    evidencePlateLow: row.evidence_plate_low || null,
    evidencePlateHigh: row.evidence_plate_high || null,
    evidenceTimestampLow: row.evidence_timestamp_low || null,
    evidenceTimestampHigh: row.evidence_timestamp_high || null,
  })).filter((row) => (
    REVIEW_LABELS.includes(row.label)
    && Number.isFinite(row.similarityScore)
    && row.similarityScore >= -1
    && row.similarityScore <= 1
  ));
}

function grouped(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const current = groups.get(key) || { key, rows: [] };
    current.rows.push(row);
    groups.set(key, current);
  }
  return [...groups.values()].map(({ key, rows: groupRows }) => {
    const same = groupRows.filter((row) => row.label === "same_vehicle");
    const different = groupRows.filter((row) => row.label === "different_vehicle");
    const unsure = groupRows.filter((row) => row.label === "unsure");
    return {
      key,
      total: groupRows.length,
      decisive: same.length + different.length,
      sameVehicle: same.length,
      differentVehicle: different.length,
      unsure: unsure.length,
      sameScores: scoreSummary(same),
      differentScores: scoreSummary(different),
    };
  }).sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

function separationSummary(rows) {
  const same = rows.filter((row) => row.label === "same_vehicle");
  const different = rows.filter((row) => row.label === "different_vehicle");
  if (!same.length || !different.length) {
    return {
      hasBothLabels: false,
      perfectGlobalSeparation: null,
      boundaryGap: null,
      overlapMinimum: null,
      overlapMaximum: null,
      sameInOverlap: 0,
      differentInOverlap: 0,
      unsureInOverlap: 0,
    };
  }
  const minimumSame = Math.min(...same.map((row) => row.similarityScore));
  const maximumDifferent = Math.max(...different.map((row) => row.similarityScore));
  const overlapExists = minimumSame <= maximumDifferent;
  const insideOverlap = (row) => (
    overlapExists
    && row.similarityScore >= minimumSame
    && row.similarityScore <= maximumDifferent
  );
  return {
    hasBothLabels: true,
    perfectGlobalSeparation: !overlapExists,
    boundaryGap: percent(minimumSame - maximumDifferent),
    overlapMinimum: overlapExists ? percent(minimumSame) : null,
    overlapMaximum: overlapExists ? percent(maximumDifferent) : null,
    sameInOverlap: same.filter(insideOverlap).length,
    differentInOverlap: different.filter(insideOverlap).length,
    unsureInOverlap: rows.filter((row) => row.label === "unsure" && insideOverlap(row)).length,
  };
}

function coverageGaps(groups, dimension, minimum) {
  return groups.map((group) => ({
    dimension,
    key: group.key,
    total: group.total,
    sameVehicle: group.sameVehicle,
    differentVehicle: group.differentVehicle,
    unsure: group.unsure,
    neededSameVehicle: Math.max(0, minimum - group.sameVehicle),
    neededDifferentVehicle: Math.max(0, minimum - group.differentVehicle),
  })).filter((group) => (
    group.neededSameVehicle > 0 || group.neededDifferentVehicle > 0
  ));
}

function targetedGaps({ byCameraPair, byLocalPeriod, byScoreBand, separation }) {
  const ordinary = [
    ...coverageGaps(byCameraPair.filter((group) => group.total >= 2), "camera pair", COVERAGE_FLOOR),
    ...coverageGaps(byLocalPeriod, "local capture period", COVERAGE_FLOOR),
  ];
  const overlapBands = separation.overlapMinimum == null
    ? []
    : byScoreBand.filter((group) => {
      const band = SCORE_BANDS.find((item) => item.key === group.key);
      if (!band) return false;
      const overlapMinimum = separation.overlapMinimum / 100;
      const overlapMaximum = separation.overlapMaximum / 100;
      return band.maximum > overlapMinimum && band.minimum <= overlapMaximum;
    }).flatMap((group) => coverageGaps([group], "overlapping score band", OVERLAP_BAND_FLOOR));
  return [...overlapBands, ...ordinary]
    .sort((left, right) => (
      (right.neededSameVehicle + right.neededDifferentVehicle)
      - (left.neededSameVehicle + left.neededDifferentVehicle)
      || right.total - left.total
      || left.key.localeCompare(right.key)
    ))
    .slice(0, 8);
}

export function evaluateVehicleReidV2Reviews(inputRows = [], options = {}) {
  const rows = normalizeRows(inputRows);
  const timeZone = validTimeZone(
    options.timeZone || inputRows.find((row) => row?.evaluation_time_zone)?.evaluation_time_zone
  );
  const same = rows.filter((row) => row.label === "same_vehicle");
  const different = rows.filter((row) => row.label === "different_vehicle");
  const unsure = rows.filter((row) => row.label === "unsure");
  const byScoreBand = grouped(rows, (row) => scoreBandKey(row.similarityScore));
  const byContext = grouped(rows, (row) => normalizedPair(
    row.evidenceContextLow,
    row.evidenceContextHigh,
    "unknown context"
  ));
  const byCameraPair = grouped(rows, (row) => normalizedPair(
    row.evidenceCameraLow,
    row.evidenceCameraHigh,
    "Unknown camera"
  ));
  const byPlateEvidence = grouped(rows, plateEvidenceKey);
  const byLocalPeriod = grouped(rows, (row) => normalizedPair(
    localPeriod(row.evidenceTimestampLow, timeZone),
    localPeriod(row.evidenceTimestampHigh, timeZone),
    "unknown local time"
  ));
  const separation = separationSummary(rows);
  return {
    total: rows.length,
    decisive: same.length + different.length,
    sameVehicle: same.length,
    differentVehicle: different.length,
    unsure: unsure.length,
    timeZone,
    localPeriodDefinition: "Daytime hours are 06:00–19:59; overnight hours are 20:00–05:59.",
    separation,
    byScoreBand,
    byContext,
    byCameraPair,
    byPlateEvidence,
    byLocalPeriod,
    targetedCoverageFloor: COVERAGE_FLOOR,
    targetedOverlapBandFloor: OVERLAP_BAND_FLOOR,
    targetedGaps: targetedGaps({ byCameraPair, byLocalPeriod, byScoreBand, separation }),
    thresholdApplied: false,
    recommendation: null,
    profileWritten: false,
    assignmentWritten: false,
  };
}

export const vehicleReidV2EvaluationInternals = Object.freeze({
  COVERAGE_FLOOR,
  DEFAULT_TIME_ZONE,
  OVERLAP_BAND_FLOOR,
  SCORE_BANDS,
  grouped,
  localPeriod,
  normalizeRows,
  normalizedPair,
  plateEvidenceKey,
  scoreBandKey,
  separationSummary,
  targetedGaps,
  validTimeZone,
});
