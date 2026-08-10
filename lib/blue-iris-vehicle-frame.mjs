import path from "node:path";

import sharp from "sharp";

import { BlueIrisError } from "./blue-iris.mjs";
import { assessDirectionImageEligibility } from "./direction-image-eligibility.mjs";
import {
  cosineSimilarity,
  vehicleReidEngine,
} from "./vehicle-reid.mjs";
import {
  associationMinimumAgeMs,
  chooseOverviewAssociation,
  OVERVIEW_ASSOCIATION_ALGORITHM,
  overviewSourceTimestamp,
} from "./vehicle-overview-association.mjs";

export const VEHICLE_FRAME_SELECTION_ALGORITHM = "blue-iris-vehicle-frame-v5-overview-foundation";
export const OVERVIEW_PRIMARY_MAX_TOLERANCE_MS = 3_000;
export const OVERVIEW_PRIMARY_SAMPLE_DURATION_MS = 6_000;
export const OVERVIEW_PRIMARY_SAMPLE_INTERVAL_MS = 100;
export const OVERVIEW_FINAL_WIDTH = 3_840;
export const OVERVIEW_FINAL_HEIGHT = 2_160;
export const OVERVIEW_FINAL_REFETCH_MAX_ATTEMPTS = 3;

export const VEHICLE_FRAME_SAMPLE_OFFSETS_MS = Object.freeze([
  -2_000, -1_500, -1_000, -500, 0, 500, 1_000, 1_500, 2_000,
  2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 5_500, 6_000,
]);

export const VEHICLE_FRAME_EXTENSION_OFFSETS_MS = Object.freeze([
  -4_000, -3_500, -3_000, -2_500,
  6_500, 7_000, 7_500, 8_000, 8_500, 9_000, 9_500, 10_000,
]);

export const VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS = Object.freeze([
  -8_000, -7_000, -6_000, -5_000,
  11_000, 12_000, 13_000, 14_000, 15_000, 16_000,
]);

export function overviewVehicleFrameSampleOffsets(toleranceMs = 1_500) {
  const tolerance = Number(toleranceMs);
  if (!Number.isInteger(tolerance) || tolerance < 250 || tolerance > OVERVIEW_PRIMARY_MAX_TOLERANCE_MS) {
    throw new Error(`Primary Overview tolerance must be between 250 and ${OVERVIEW_PRIMARY_MAX_TOLERANCE_MS} milliseconds.`);
  }
  const start = -tolerance;
  return Object.freeze(Array.from(
    { length: OVERVIEW_PRIMARY_SAMPLE_DURATION_MS / OVERVIEW_PRIMARY_SAMPLE_INTERVAL_MS + 1 },
    (_, index) => start + index * OVERVIEW_PRIMARY_SAMPLE_INTERVAL_MS
  ));
}

// Retain a backwards-compatible default for older manual/test callers. Live
// primary Overview work derives the offsets from its claimed profile.
export const OVERVIEW_VEHICLE_FRAME_SAMPLE_OFFSETS_MS = overviewVehicleFrameSampleOffsets();

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function detectionEdgeMargin(detection) {
  return Math.min(
    clamp(Number(detection?.left) || 0, 0, 1),
    clamp(Number(detection?.top) || 0, 0, 1),
    clamp(1 - Number(detection?.right), 0, 1),
    clamp(1 - Number(detection?.bottom), 0, 1)
  );
}

function detectionCompletenessTier(detection) {
  const margin = detectionEdgeMargin(detection);
  if (margin >= 0.04) return 3;
  if (margin >= 0.015) return 2;
  if (margin >= 0.005) return 1;
  return 0;
}

function detectionEdgeContactCount(detection, threshold = 0.005) {
  return [
    clamp(Number(detection?.left) || 0, 0, 1),
    clamp(Number(detection?.top) || 0, 0, 1),
    clamp(1 - Number(detection?.right), 0, 1),
    clamp(1 - Number(detection?.bottom), 0, 1),
  ].filter((margin) => margin < threshold).length;
}

function detectionIntersectionOverUnion(left, right) {
  if (!left || !right) return 0;
  const intersectionLeft = Math.max(Number(left.left), Number(right.left));
  const intersectionTop = Math.max(Number(left.top), Number(right.top));
  const intersectionRight = Math.min(Number(left.right), Number(right.right));
  const intersectionBottom = Math.min(Number(left.bottom), Number(right.bottom));
  const intersection = Math.max(0, intersectionRight - intersectionLeft)
    * Math.max(0, intersectionBottom - intersectionTop);
  const leftArea = Math.max(0, Number(left.right) - Number(left.left))
    * Math.max(0, Number(left.bottom) - Number(left.top));
  const rightArea = Math.max(0, Number(right.right) - Number(right.left))
    * Math.max(0, Number(right.bottom) - Number(right.top));
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

export function productionBaselineVehicleFrameScore(detection) {
  if (!detection) return null;
  const confidence = clamp(Number(detection.confidence) || 0, 0, 1);
  const area = clamp(Number(detection.area) || 0, 0, 1);
  const completeness = clamp(detectionEdgeMargin(detection) / 0.04, 0, 1);
  return Number((confidence * 0.35 + Math.sqrt(area) * 0.45 + completeness * 0.2).toFixed(6));
}

export function vehicleFrameScoreBreakdown(detection, quality = {}) {
  if (!detection) return null;
  const confidence = clamp(Number(detection.confidence) || 0, 0, 1);
  const area = clamp(Number(detection.area) || 0, 0, 1);
  const edgeMargin = detectionEdgeMargin(detection);
  const completeness = clamp((edgeMargin - 0.002) / 0.058, 0, 1);
  const completenessTier = detectionCompletenessTier(detection);
  const areaScore = clamp(Math.sqrt(area / 0.32), 0, 1)
    * (area > 0.82 ? clamp(1 - (area - 0.82) / 0.18, 0.25, 1) : 1);
  const sharpness = clamp(Number(quality.sharpnessScore ?? 0.65), 0, 1);
  const exposure = clamp(Number(quality.exposureScore ?? 0.65), 0, 1);
  const contrast = clamp(Number(quality.contrastScore ?? 0.65), 0, 1);
  const rawScore = confidence * 0.18
    + areaScore * 0.17
    + completeness * 0.3
    + sharpness * 0.18
    + exposure * 0.1
    + contrast * 0.07;
  const truncationMultiplier = completenessTier === 0
    ? 0.3
    : completenessTier === 1
      ? 0.68
      : completenessTier === 2
        ? 0.9
        : 1;
  return {
    score: Number((rawScore * truncationMultiplier).toFixed(6)),
    confidence: Number(confidence.toFixed(4)),
    area: Number(area.toFixed(6)),
    areaScore: Number(areaScore.toFixed(4)),
    edgeMargin: Number(edgeMargin.toFixed(6)),
    completeness: Number(completeness.toFixed(4)),
    completenessTier,
    sharpness: Number(sharpness.toFixed(4)),
    exposure: Number(exposure.toFixed(4)),
    contrast: Number(contrast.toFixed(4)),
  };
}

export function scoreVehicleFrame(detection, quality = {}) {
  return vehicleFrameScoreBreakdown(detection, quality)?.score ?? null;
}

function detectionPixelCrop(detection, width, height) {
  const left = Math.floor(clamp(Number(detection.left), 0, 1) * width);
  const top = Math.floor(clamp(Number(detection.top), 0, 1) * height);
  const right = Math.ceil(clamp(Number(detection.right), 0, 1) * width);
  const bottom = Math.ceil(clamp(Number(detection.bottom), 0, 1) * height);
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, right - left)),
    height: Math.max(1, Math.min(height - top, bottom - top)),
  };
}

export async function analyzeVehicleFrameQuality({ imageProcessor = sharp, buffer, detection, width, height }) {
  const crop = detectionPixelCrop(detection, width, height);
  const rendered = await imageProcessor(buffer)
    .extract(crop)
    .resize(192, 108, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = rendered?.data || rendered;
  const pixelWidth = Number(rendered?.info?.width || crop.width);
  if (!pixels?.length || pixelWidth < 2) {
    return { sharpnessScore: 0, exposureScore: 0, contrastScore: 0 };
  }

  let sum = 0;
  let sumSquared = 0;
  let dark = 0;
  let bright = 0;
  let gradient = 0;
  let gradientCount = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const value = Number(pixels[index]);
    sum += value;
    sumSquared += value ** 2;
    if (value <= 12) dark += 1;
    if (value >= 243) bright += 1;
    if (index % pixelWidth !== 0) {
      gradient += Math.abs(value - Number(pixels[index - 1]));
      gradientCount += 1;
    }
    if (index >= pixelWidth) {
      gradient += Math.abs(value - Number(pixels[index - pixelWidth]));
      gradientCount += 1;
    }
  }
  const mean = sum / pixels.length;
  const variance = Math.max(0, sumSquared / pixels.length - mean ** 2);
  const stdev = Math.sqrt(variance);
  const normalizedGradient = gradientCount ? gradient / gradientCount / 255 : 0;
  const clippedRatio = (dark + bright) / pixels.length;
  const brightnessBalance = clamp(1 - Math.abs(mean - 127.5) / 127.5, 0, 1);
  return {
    sharpnessScore: Number(clamp((normalizedGradient - 0.012) / 0.09, 0, 1).toFixed(4)),
    exposureScore: Number((brightnessBalance * 0.55 + (1 - clamp(clippedRatio / 0.45, 0, 1)) * 0.45).toFixed(4)),
    contrastScore: Number(clamp(stdev / 58, 0, 1).toFixed(4)),
    meanLuminance: Number(mean.toFixed(2)),
    contrastStdev: Number(stdev.toFixed(2)),
    clippedRatio: Number(clippedRatio.toFixed(4)),
    normalizedGradient: Number(normalizedGradient.toFixed(6)),
  };
}

function chooseAnchorCandidate(candidates) {
  const anchored = candidates.filter((candidate) => candidate.detection.containsPlate);
  const pool = anchored.length
    ? anchored
    : candidates.filter((candidate) => candidate.offsetMs === 0);
  const fallback = pool.length ? pool : candidates;
  return [...fallback].sort((left, right) => (
    Math.abs(left.offsetMs) - Math.abs(right.offsetMs)
    || Number(right.detection.selectionScore || 0) - Number(left.detection.selectionScore || 0)
  ))[0] || null;
}

function candidateCenter(candidate) {
  return {
    x: (Number(candidate?.detection?.left) + Number(candidate?.detection?.right)) / 2,
    y: (Number(candidate?.detection?.top) + Number(candidate?.detection?.bottom)) / 2,
  };
}

function temporalContinuity(candidate, reference) {
  if (!candidate || !reference) return 0.5;
  const current = candidateCenter(candidate);
  const prior = candidateCenter(reference);
  const centerDistance = Math.hypot(current.x - prior.x, current.y - prior.y);
  const areaRatio = Math.min(
    Number(candidate.detection.area) || 0,
    Number(reference.detection.area) || 0
  ) / Math.max(
    Number(candidate.detection.area) || 0,
    Number(reference.detection.area) || 0,
    0.0001
  );
  return clamp((1 - centerDistance / 0.65) * 0.7 + areaRatio * 0.3, 0, 1);
}

function softTrackCandidates(candidates, anchor, { acceptCandidate = null } = {}) {
  if (!anchor) return [];
  const byOffset = new Map();
  for (const candidate of candidates) {
    if (!byOffset.has(candidate.offsetMs)) byOffset.set(candidate.offsetMs, []);
    byOffset.get(candidate.offsetMs).push(candidate);
  }
  const track = [{ ...anchor, trackSimilarity: 1, continuityScore: 1 }];
  const walk = (offsets) => {
    let reference = anchor;
    for (const offset of offsets) {
      const frameCandidates = byOffset.get(offset) || [];
      const ranked = frameCandidates.map((candidate) => {
        const similarity = candidate.embedding && reference.embedding
          ? cosineSimilarity(reference.embedding, candidate.embedding)
          : null;
        const continuity = temporalContinuity(candidate, reference);
        const identity = Number.isFinite(similarity) ? clamp((similarity + 1) / 2, 0, 1) : 0.5;
        const baseline = Number(candidate.baselineScore || 0);
        return {
          candidate,
          similarity,
          continuity,
          rank: continuity * 0.48 + identity * 0.17 + baseline * 0.35,
        };
      }).sort((left, right) => right.rank - left.rank);
      const accepted = typeof acceptCandidate === "function"
        ? ranked.find((candidate) => acceptCandidate(candidate))
        : ranked[0];
      if (!accepted) continue;
      const selected = {
        ...accepted.candidate,
        trackSimilarity: Number.isFinite(accepted.similarity)
          ? Number(accepted.similarity.toFixed(6))
          : null,
        continuityScore: Number(accepted.continuity.toFixed(6)),
      };
      track.push(selected);
      reference = selected;
    }
  };
  walk([...byOffset.keys()].filter((offset) => offset > anchor.offsetMs).sort((a, b) => a - b));
  walk([...byOffset.keys()].filter((offset) => offset < anchor.offsetMs).sort((a, b) => b - a));
  return track;
}

function primaryProductionCandidates(candidates) {
  return candidates.filter((candidate) => candidate.primarySample && candidate.frameRank === 0);
}

function qualityAdvantage(candidate, baseline) {
  if (!candidate || !baseline) return 0;
  const candidateQuality = Number(candidate.quality?.sharpnessScore || 0) * 0.55
    + Number(candidate.quality?.exposureScore || 0) * 0.25
    + Number(candidate.quality?.contrastScore || 0) * 0.2;
  const baselineQuality = Number(baseline.quality?.sharpnessScore || 0) * 0.55
    + Number(baseline.quality?.exposureScore || 0) * 0.25
    + Number(baseline.quality?.contrastScore || 0) * 0.2;
  return candidateQuality - baselineQuality;
}

export function selectGuardedVehicleFrame(candidates) {
  const baselinePool = primaryProductionCandidates(candidates);
  const fallbackPool = baselinePool.length ? baselinePool : candidates.filter((candidate) => candidate.frameRank === 0);
  const baseline = [...fallbackPool].sort((left, right) => (
    Number(right.baselineScore || 0) - Number(left.baselineScore || 0)
    || left.offsetMs - right.offsetMs
  ))[0] || null;
  const anchor = chooseAnchorCandidate(candidates);
  const track = softTrackCandidates(candidates, anchor);
  const challenger = [...track].sort((left, right) => (
    Number(right.score || 0) - Number(left.score || 0)
    || Number(right.baselineScore || 0) - Number(left.baselineScore || 0)
    || Math.abs(left.offsetMs) - Math.abs(right.offsetMs)
  ))[0] || null;

  let best = baseline || challenger;
  let selectionReason = baseline ? "production_baseline" : "guarded_fallback";
  if (baseline && challenger && challenger !== baseline) {
    const areaRatio = Number(challenger.detection.area || 0) / Math.max(Number(baseline.detection.area || 0), 0.0001);
    const baselineDeficit = Number(baseline.baselineScore || 0) - Number(challenger.baselineScore || 0);
    const qualityGain = qualityAdvantage(challenger, baseline);
    const framingGain = detectionEdgeMargin(challenger.detection) - detectionEdgeMargin(baseline.detection);
    const identityAcceptable = challenger.trackSimilarity === null
      || challenger.trackSimilarity === undefined
      || challenger.trackSimilarity >= 0.35;
    const continuityAcceptable = Number(challenger.continuityScore || 0) >= 0.28;
    const qualityUpgrade = baselineDeficit <= 0.035 && areaRatio >= 0.95 && qualityGain >= 0.16;
    const productionScoreUpgrade = baselineDeficit <= -0.04 && (areaRatio >= 0.95 || framingGain >= 0.04);
    const demonstrablyBetter = (qualityUpgrade || productionScoreUpgrade)
      && identityAcceptable
      && continuityAcceptable;
    if (demonstrablyBetter) {
      best = challenger;
      selectionReason = "quality_upgrade";
    }
  }
  return { best, baseline, challenger, anchor, track, trackedCount: track.length, selectionReason };
}

function contiguousOverviewTrack(track, anchor) {
  const ordered = [...track].sort((left, right) => left.offsetMs - right.offsetMs);
  const anchorIndex = ordered.findIndex((candidate) => (
    candidate.offsetMs === anchor.offsetMs
    && candidate.frameRank === anchor.frameRank
  ));
  if (anchorIndex < 0) return [];
  let start = anchorIndex;
  let end = anchorIndex;
  while (start > 0 && ordered[start].offsetMs - ordered[start - 1].offsetMs <= 300) start -= 1;
  while (end + 1 < ordered.length && ordered[end + 1].offsetMs - ordered[end].offsetMs <= 300) end += 1;
  return ordered.slice(start, end + 1);
}

function evaluateOverviewAnchorTrack(candidates, anchor) {
  const tracked = softTrackCandidates(candidates, anchor, {
    acceptCandidate: ({ similarity, continuity }) => (
      continuity >= 0.28
      && (!Number.isFinite(similarity) || similarity >= 0.35)
    ),
  });
  const track = contiguousOverviewTrack(tracked, anchor);
  const meanConfidence = track.length
    ? track.reduce((sum, candidate) => sum + Number(candidate.detection?.confidence || 0), 0) / track.length
    : 0;
  const meanArea = track.length
    ? track.reduce((sum, candidate) => sum + Number(candidate.detection?.area || 0), 0) / track.length
    : 0;
  const complete = track.filter((candidate) => detectionEdgeContactCount(candidate.detection) === 0);
  const oneEdge = track.filter((candidate) => (
    detectionEdgeContactCount(candidate.detection) === 1
    && Number(candidate.detection?.confidence || 0) >= 0.6
    && Number(candidate.detection?.area || 0) >= 0.05
    && Number(candidate.continuityScore ?? 1) >= 0.45
  ));
  const usable = complete.length
    ? complete
    : track.length >= 3 && meanConfidence >= 0.6 ? oneEdge : [];
  const viable = track.length >= 2
    && Number(anchor.detection?.confidence || 0) >= 0.45
    && meanConfidence >= 0.5
    && meanArea >= 0.01
    && usable.length > 0;
  const best = viable ? [...usable].sort((left, right) => (
    Number(right.score || 0) - Number(left.score || 0)
    || Number(right.baselineScore || 0) - Number(left.baselineScore || 0)
    || Math.abs(left.offsetMs) - Math.abs(right.offsetMs)
  ))[0] || null : null;
  return {
    anchor,
    track,
    best,
    viable,
    meanConfidence,
    meanArea,
    usableKind: complete.length ? "complete" : usable.length ? "one_edge" : "none",
  };
}

function distinctOverviewTracks(tracks) {
  const distinct = [];
  for (const track of tracks.sort((left, right) => Number(right.best?.score || 0) - Number(left.best?.score || 0))) {
    const trackKeys = new Set(track.track.map((candidate) => `${candidate.offsetMs}:${candidate.frameRank}`));
    const duplicatesExisting = distinct.some((existing) => {
      const existingKeys = new Set(
        existing.track.map((candidate) => `${candidate.offsetMs}:${candidate.frameRank}`)
      );
      const shared = [...trackKeys].filter((key) => existingKeys.has(key)).length;
      const sharedRatio = shared / Math.max(1, Math.min(trackKeys.size, existingKeys.size));
      return sharedRatio >= 0.5;
    });
    if (duplicatesExisting) continue;
    distinct.push(track);
  }
  return distinct;
}

export function selectAnchoredOverviewVehicleFrame(candidates, { toleranceMs = 1_500 } = {}) {
  const boundedToleranceMs = Math.max(250, Number(toleranceMs) || 1_500);
  const anchorWindowCandidates = candidates.filter(
    (candidate) => Math.abs(candidate.offsetMs) <= boundedToleranceMs
  );
  if (!anchorWindowCandidates.length) {
    return {
      status: "not_visible",
      best: null,
      baseline: null,
      challenger: null,
      anchor: null,
      track: [],
      trackedCount: 0,
      viableTrackCount: 0,
      inToleranceCount: 0,
      selectionReason: "overview_anchor_outside_tolerance",
    };
  }
  // Evaluate every possible anchor inside the configured ownership tolerance.
  // Track overlap below deduplicates repeated detections of the same vehicle;
  // this keeps an early detector speck from suppressing the real track and
  // makes a second temporally offset viable vehicle fail closed.
  const anchorCandidates = anchorWindowCandidates;
  const evaluatedTracks = anchorCandidates.map((anchor) => evaluateOverviewAnchorTrack(candidates, anchor));
  const viableTracks = distinctOverviewTracks(evaluatedTracks.filter((track) => track.viable));
  if (viableTracks.length > 1) {
    return {
      status: "ambiguous",
      best: null,
      baseline: null,
      challenger: null,
      anchor: null,
      track: [],
      trackedCount: 0,
      viableTrackCount: viableTracks.length,
      inToleranceCount: anchorWindowCandidates.length,
      selectionReason: "multiple_vehicles_at_overview_anchor",
    };
  }
  const chosen = viableTracks[0] || null;
  const best = chosen?.best || null;
  return {
    status: best ? "selected" : "not_visible",
    best,
    baseline: null,
    challenger: best,
    anchor: chosen?.anchor || anchorCandidates[0] || null,
    track: chosen?.track || [],
    trackedCount: chosen?.track.length || 0,
    viableTrackCount: viableTracks.length,
    inToleranceCount: anchorWindowCandidates.length,
    selectionReason: best
      ? chosen.usableKind === "one_edge" ? "overview_anchor_track_one_edge" : "overview_anchor_track"
      : evaluatedTracks.length ? "overview_anchor_track_nonviable" : "overview_anchor_track_incomplete",
  };
}

export function selectBestTrackedVehicleFrame(candidates) {
  return selectGuardedVehicleFrame(candidates);
}

function detectionBox(detection) {
  return {
    left: Number(detection.left.toFixed(6)),
    top: Number(detection.top.toFixed(6)),
    right: Number(detection.right.toFixed(6)),
    bottom: Number(detection.bottom.toFixed(6)),
  };
}

export function isLikelyBlueIrisPlaceholder(stats) {
  const entropy = Number(stats?.entropy);
  const deviations = Array.isArray(stats?.channels)
    ? stats.channels.slice(0, 3).map((channel) => Number(channel?.stdev)).filter(Number.isFinite)
    : [];
  if (!Number.isFinite(entropy) || deviations.length < 3) return false;

  const averageDeviation = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  // Blue Iris returns a valid JPEG containing a nearly-flat gray "No video"
  // card when a requested timeline position cannot be decoded. Reject that
  // placeholder before object detection so it cannot win as a false vehicle.
  return entropy < 1 && averageDeviation < 12;
}

function overviewFailureTelemetry({ offsets, candidates, failures, analysis, selection }) {
  const failureCounts = {};
  for (const failure of failures) {
    const code = String(failure?.code || "ANALYSIS_FAILED").slice(0, 80);
    failureCounts[code] = (failureCounts[code] || 0) + 1;
  }
  const completenessTierCounts = [0, 0, 0, 0];
  const edgeContactCounts = [0, 0, 0, 0, 0];
  for (const candidate of candidates) {
    completenessTierCounts[detectionCompletenessTier(candidate.detection)] += 1;
    edgeContactCounts[detectionEdgeContactCount(candidate.detection)] += 1;
  }
  return {
    requestedStartOffsetMs: offsets.length ? Math.min(...offsets) : null,
    requestedEndOffsetMs: offsets.length ? Math.max(...offsets) : null,
    requestedSampleCount: offsets.length,
    successfulSampleCount: Number(analysis.successfulSamples || 0),
    unavailableSampleCount: Number(failureCounts.RECORDING_UNAVAILABLE || 0),
    monochromeSampleCount: Number(analysis.monochromeSamples || 0),
    failedSampleCount: failures.length,
    rawDetectionCount: Number(analysis.rawDetectionCount || 0),
    normalizedDetectionCount: candidates.length,
    inToleranceDetectionCount: Number(selection?.inToleranceCount || 0),
    viableTrackCount: Number(selection?.viableTrackCount || 0),
    trackedDetectionCount: Number(selection?.trackedCount || 0),
    completenessTierCounts,
    edgeContactCounts,
    failureCounts,
    reason: selection?.selectionReason || null,
  };
}

function boundedFinalRefetchFailure(error, attempt) {
  const details = {};
  for (const key of ["identitySimilarity", "detectionOverlap", "detectionContinuity"]) {
    const value = Number(error?.details?.[key]);
    if (Number.isFinite(value)) details[key] = Number(value.toFixed(6));
  }
  return {
    attempt,
    status: "failed",
    errorCode: String(error?.code || "FINAL_FRAME_REFETCH_FAILED").slice(0, 80),
    details: Object.keys(details).length ? details : null,
  };
}

function derivedPath(read, frameTimestamp, claimToken = null) {
  const date = new Date(frameTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const safeToken = String(claimToken || "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
  const suffix = safeToken ? `_${safeToken}` : "";
  return path.posix.join("derived", year, month, day, `blue_iris_vehicle_read_${read.id}${suffix}.jpg`);
}

function overviewCandidatePath(candidate, frameTimestamp) {
  const date = new Date(frameTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.posix.join("derived", year, month, day, `blue_iris_overview_candidate_${candidate.id}.jpg`);
}

async function frameIdentityPixels(imageProcessor, buffer) {
  return imageProcessor(buffer)
    .resize(48, 27, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
}

async function frameIdentitySimilarity(imageProcessor, left, right) {
  const [leftPixels, rightPixels] = await Promise.all([
    frameIdentityPixels(imageProcessor, left),
    frameIdentityPixels(imageProcessor, right),
  ]);
  if (!leftPixels.length || leftPixels.length !== rightPixels.length) return 0;
  let difference = 0;
  for (let index = 0; index < leftPixels.length; index += 1) {
    difference += Math.abs(Number(leftPixels[index]) - Number(rightPixels[index]));
  }
  return clamp(1 - difference / leftPixels.length / 255, 0, 1);
}

export class BlueIrisVehicleFrameService {
  constructor({
    client,
    repository,
    fileStorage,
    detector = vehicleReidEngine,
    imageProcessor = sharp,
    sampleOffsetsMs = VEHICLE_FRAME_SAMPLE_OFFSETS_MS,
    extensionOffsetsMs = sampleOffsetsMs === VEHICLE_FRAME_SAMPLE_OFFSETS_MS
      ? VEHICLE_FRAME_EXTENSION_OFFSETS_MS
      : [],
    deepExtensionOffsetsMs = sampleOffsetsMs === VEHICLE_FRAME_SAMPLE_OFFSETS_MS
      && extensionOffsetsMs === VEHICLE_FRAME_EXTENSION_OFFSETS_MS
      ? VEHICLE_FRAME_DEEP_EXTENSION_OFFSETS_MS
      : [],
    qualityAnalyzer = analyzeVehicleFrameQuality,
    timelineExportService = null,
  }) {
    this.client = client;
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.detector = detector;
    this.imageProcessor = imageProcessor;
    this.sampleOffsetsMs = [...sampleOffsetsMs];
    this.extensionOffsetsMs = [...extensionOffsetsMs];
    this.deepExtensionOffsetsMs = [...deepExtensionOffsetsMs];
    this.qualityAnalyzer = qualityAnalyzer;
    this.timelineExportService = timelineExportService;
  }

  async validateOverviewFinalFrame({ buffer, timestamp, selected, mode }) {
    const metadata = await this.imageProcessor(buffer).metadata();
    if (!metadata.width || !metadata.height) {
      throw new BlueIrisError("FINAL_FRAME_INVALID", "Blue Iris final Vehicle View dimensions are unavailable.");
    }
    const stats = await this.imageProcessor(buffer).stats();
    if (isLikelyBlueIrisPlaceholder(stats)) {
      throw new BlueIrisError("FINAL_FRAME_UNAVAILABLE", "Blue Iris returned a placeholder for the final Vehicle View.");
    }
    const eligibility = await assessDirectionImageEligibility(buffer, {
      imageProcessor: this.imageProcessor,
    });
    if (eligibility.monochrome === true) {
      throw new BlueIrisError("NIGHTTIME_UNAVAILABLE", "Street Overview is monochrome at night.");
    }
    const identitySimilarity = await frameIdentitySimilarity(
      this.imageProcessor,
      selected.buffer,
      buffer
    );
    const dimensions = { imageWidth: metadata.width, imageHeight: metadata.height, plateBox: null };
    const detections = typeof this.detector.detectAll === "function"
      ? await this.detector.detectAll(buffer, dimensions)
      : [await this.detector.detect(buffer, dimensions)].filter(Boolean);
    const matchingDetection = detections.map((detection) => ({
      detection,
      overlap: detectionIntersectionOverUnion(selected.detection, detection),
      continuity: temporalContinuity({ detection }, selected),
    })).sort((left, right) => (
      right.overlap - left.overlap || right.continuity - left.continuity
    ))[0] || null;
    const sameVehicle = matchingDetection
      && (matchingDetection.overlap >= 0.4 || matchingDetection.continuity >= 0.78);
    if (identitySimilarity < 0.82 || !sameVehicle) {
      throw new BlueIrisError(
        "FINAL_FRAME_IDENTITY_MISMATCH",
        "The final Vehicle View did not validate as the selected vehicle.",
        { details: {
          identitySimilarity: Number(identitySimilarity.toFixed(6)),
          detectionOverlap: matchingDetection ? Number(matchingDetection.overlap.toFixed(6)) : null,
          detectionContinuity: matchingDetection ? Number(matchingDetection.continuity.toFixed(6)) : null,
        } }
      );
    }
    return {
      buffer,
      timestamp: timestamp || selected.timestamp,
      width: metadata.width,
      height: metadata.height,
      identitySimilarity: Number(identitySimilarity.toFixed(6)),
      detectionOverlap: Number(matchingDetection.overlap.toFixed(6)),
      detectionContinuity: Number(matchingDetection.continuity.toFixed(6)),
      mode,
    };
  }

  async refetchOverviewFrame({ camera, selected }) {
    const frame = await this.client.fetchTimelineJpeg({
      camera,
      timestamp: selected.timestamp,
      width: OVERVIEW_FINAL_WIDTH,
      height: OVERVIEW_FINAL_HEIGHT,
    });
    return this.validateOverviewFinalFrame({
      buffer: frame.buffer,
      timestamp: selected.timestamp,
      selected,
      mode: "maximum_resolution",
    });
  }

  async analyzeOffsets({
    camera,
    baseMs,
    offsets,
    plateBox = null,
    primarySample = false,
    requireColor = false,
    frameProvider = null,
  }) {
    const candidates = [];
    const failures = [];
    let successfulSamples = 0;
    let rawDetectionCount = 0;
    let monochromeSamples = 0;
    for (const offsetMs of offsets) {
      try {
        const frame = frameProvider
          ? await frameProvider({ offsetMs, timestamp: new Date(baseMs + offsetMs) })
          : await this.client.fetchTimelineJpeg({
              camera,
              timestamp: new Date(baseMs + offsetMs),
            });
        const oriented = await this.imageProcessor(frame.buffer).rotate().jpeg({ quality: 88 }).toBuffer();
        const metadata = await this.imageProcessor(oriented).metadata();
        if (!metadata.width || !metadata.height) throw new Error("Blue Iris frame dimensions are unavailable.");
        const stats = await this.imageProcessor(oriented).stats();
        if (isLikelyBlueIrisPlaceholder(stats)) {
          throw new BlueIrisError(
            "RECORDING_UNAVAILABLE",
            "Blue Iris returned a no-video placeholder for this sample."
          );
        }
        if (requireColor) {
          const eligibility = await assessDirectionImageEligibility(oriented, {
            imageProcessor: this.imageProcessor,
          });
          if (eligibility.monochrome === true) {
            monochromeSamples += 1;
            throw new BlueIrisError(
              "SOURCE_NIGHTTIME_UNAVAILABLE",
              "Street Overview returned a monochrome nighttime frame."
            );
          }
        }
        successfulSamples += 1;
        const dimensions = {
          imageWidth: metadata.width,
          imageHeight: metadata.height,
          plateBox: offsetMs === 0 ? plateBox : null,
        };
        const detections = typeof this.detector.detectAll === "function"
          ? await this.detector.detectAll(oriented, dimensions)
          : [await this.detector.detect(oriented, dimensions)].filter(Boolean);
        rawDetectionCount += detections.length;
        for (const [frameRank, detection] of detections.entries()) {
          let quality;
          try {
            quality = await this.qualityAnalyzer({
              imageProcessor: this.imageProcessor,
              buffer: oriented,
              detection,
              width: metadata.width,
              height: metadata.height,
            });
          } catch {
            quality = { sharpnessScore: 0.5, exposureScore: 0.5, contrastScore: 0.5 };
          }
          let embedding = null;
          if (typeof this.detector.embedDetection === "function") {
            try {
              embedding = (await this.detector.embedDetection(oriented, detection, dimensions))?.embedding || null;
            } catch {
              embedding = null;
            }
          }
          const scoreBreakdown = vehicleFrameScoreBreakdown(detection, quality);
          candidates.push({
            buffer: oriented,
            timestamp: frame.timestamp,
            offsetMs,
            width: metadata.width,
            height: metadata.height,
            detection,
            frameRank,
            primarySample,
            quality,
            embedding,
            scoreBreakdown,
            score: scoreBreakdown.score,
            baselineScore: productionBaselineVehicleFrameScore(detection),
          });
        }
      } catch (error) {
        failures.push(error);
      }
    }
    return {
      candidates,
      failures,
      successfulSamples,
      rawDetectionCount,
      monochromeSamples,
    };
  }

  async selectBestFrame({
    camera,
    timestamp,
    plateBox = null,
    selectionMode = "default",
    anchorToleranceMs = 1_500,
    sampleOffsetsMs = this.sampleOffsetsMs,
    requireColor = false,
    frameProvider = null,
  }) {
    const baseMs = new Date(timestamp).getTime();
    if (!Number.isFinite(baseMs)) throw new Error("A valid plate-read timestamp is required.");
    const requestedOffsets = [...sampleOffsetsMs];
    const primary = await this.analyzeOffsets({
      camera,
      baseMs,
      offsets: requestedOffsets,
      plateBox,
      primarySample: true,
      requireColor,
      frameProvider,
    });
    let candidates = primary.candidates;
    let failures = primary.failures;
    const analysis = {
      successfulSamples: primary.successfulSamples,
      rawDetectionCount: primary.rawDetectionCount,
      monochromeSamples: primary.monochromeSamples,
    };
    const selectFrame = (items) => selectionMode === "overview_anchor"
      ? selectAnchoredOverviewVehicleFrame(items, { toleranceMs: anchorToleranceMs })
      : selectBestTrackedVehicleFrame(items);
    let selection = selectFrame(candidates);
    const selectionNeedsMoreSearch = (current) => {
      const primaryOffsets = requestedOffsets;
      const boundaryOffset = current.best
        && (current.best.offsetMs === Math.min(...primaryOffsets) || current.best.offsetMs === Math.max(...primaryOffsets));
      const nearEvent = Math.abs(Number(current.best?.offsetMs || 0)) <= 500;
      const laterAreaGrowth = current.baseline && candidates.some((candidate) => (
        candidate.offsetMs > current.baseline.offsetMs
        && candidate.offsetMs <= current.baseline.offsetMs + 4_000
        && Number(candidate.detection.area || 0) >= Number(current.baseline.detection.area || 0) * 1.2
      ));
      return (
      !current.best
      || current.best.quality.sharpnessScore < 0.35
      || current.best.baselineScore < 0.58
      || boundaryOffset
      || nearEvent
      || laterAreaGrowth
      );
    };
    const shouldExtend = selectionMode !== "overview_anchor"
      && this.extensionOffsetsMs.length > 0
      && selectionNeedsMoreSearch(selection);
    if (shouldExtend) {
      const extension = await this.analyzeOffsets({
        camera,
        baseMs,
        offsets: this.extensionOffsetsMs,
        plateBox,
        requireColor,
        frameProvider,
      });
      candidates = [...candidates, ...extension.candidates];
      failures = [...failures, ...extension.failures];
      analysis.successfulSamples += extension.successfulSamples;
      analysis.rawDetectionCount += extension.rawDetectionCount;
      analysis.monochromeSamples += extension.monochromeSamples;
      selection = selectFrame(candidates);
    }
    const shouldDeepExtend = selectionMode !== "overview_anchor"
      && this.deepExtensionOffsetsMs.length > 0
      && selectionNeedsMoreSearch(selection);
    if (shouldDeepExtend) {
      const deepExtension = await this.analyzeOffsets({
        camera,
        baseMs,
        offsets: this.deepExtensionOffsetsMs,
        plateBox,
        requireColor,
        frameProvider,
      });
      candidates = [...candidates, ...deepExtension.candidates];
      failures = [...failures, ...deepExtension.failures];
      analysis.successfulSamples += deepExtension.successfulSamples;
      analysis.rawDetectionCount += deepExtension.rawDetectionCount;
      analysis.monochromeSamples += deepExtension.monochromeSamples;
      selection = selectFrame(candidates);
    }

    const sampledCount = requestedOffsets.length
      + (shouldExtend ? this.extensionOffsetsMs.length : 0)
      + (shouldDeepExtend ? this.deepExtensionOffsetsMs.length : 0);
    const analyzedOffsets = [
      ...requestedOffsets,
      ...(shouldExtend ? this.extensionOffsetsMs : []),
      ...(shouldDeepExtend ? this.deepExtensionOffsetsMs : []),
    ];
    const telemetry = overviewFailureTelemetry({
      offsets: analyzedOffsets,
      candidates,
      failures,
      analysis,
      selection,
    });

    if (selection.status === "ambiguous") {
      throw new BlueIrisError(
        "MULTIPLE_VEHICLES_VISIBLE",
        "Multiple vehicles were visible at the configured overview timing anchor.",
        { details: telemetry }
      );
    }
    if (selection.best) {
      return {
        best: selection.best,
        sampledCount,
        detectedCount: candidates.length,
        trackedCount: selection.trackedCount,
        anchorOffsetMs: selection.anchor?.offsetMs ?? null,
        expandedSampling: shouldExtend || shouldDeepExtend,
        deepExpandedSampling: shouldDeepExtend,
        baselineOffsetMs: selection.baseline?.offsetMs ?? null,
        challengerOffsetMs: selection.challenger?.offsetMs ?? null,
        selectionReason: selection.selectionReason,
        telemetry,
      };
    }
    const sourceNighttime = analysis.monochromeSamples > 0
      && analysis.successfulSamples === 0;
    if (sourceNighttime) {
      throw new BlueIrisError(
        "NIGHTTIME_UNAVAILABLE",
        "Street Overview is monochrome at night, so Vehicle View is unavailable.",
        { details: telemetry }
      );
    }
    const unavailable = failures.length === sampledCount
      && failures.every((error) => error?.code === "RECORDING_UNAVAILABLE");
    if (unavailable) {
      throw new BlueIrisError(
        "RECORDING_UNAVAILABLE",
        "Blue Iris has not made recording data available around this plate read.",
        { details: telemetry }
      );
    }
    if (failures.length === sampledCount) {
      const failure = failures[0];
      if (failure && typeof failure === "object") failure.details = telemetry;
      throw failure;
    }
    throw new BlueIrisError(
      "VEHICLE_NOT_VISIBLE",
      "No complete vehicle was detected in the bounded Blue Iris sample window.",
      { details: telemetry }
    );
  }

  async processNearestRead({ camera, cameraName, timestamp, toleranceSeconds = 3 }) {
    const read = await this.repository.findNearestRead({
      cameraName,
      timestamp,
      toleranceSeconds,
    });
    if (!read) {
      return {
        status: "read_not_found",
        errorCode: "READ_NOT_FOUND",
        message: "No ALPR read from this camera matched the selected time closely enough to own the vehicle image.",
      };
    }

    return this.processRead({ read, camera });
  }

  async processRead({ read, camera, alreadyClaimed = false }) {
    if (!read?.id || !read?.timestamp) {
      throw new Error("A persisted plate read is required for vehicle-frame processing.");
    }

    if (!alreadyClaimed) await this.repository.markPending(read.id);
    try {
      const selected = await this.selectBestFrame({
        camera,
        timestamp: read.timestamp,
        plateBox: read.crop_coordinates || null,
      });
      const framePath = derivedPath(read, selected.best.timestamp);
      const previousPath = read.vehicle_image_path;
      const writeReadyFrame = async (writerRepository = this.repository) => {
        await this.fileStorage.saveDerivedImage(framePath, selected.best.buffer);
        try {
          await writerRepository.markReady(read.id, {
            framePath,
            frameTimestamp: selected.best.timestamp,
            frameScore: selected.best.score,
            detectionConfidence: selected.best.detection.confidence,
            detectionBox: detectionBox(selected.best.detection),
            imageWidth: selected.best.width,
            imageHeight: selected.best.height,
            sampledCount: selected.sampledCount,
            selectionMetadata: {
              algorithm: VEHICLE_FRAME_SELECTION_ALGORITHM,
              selectedOffsetMs: selected.best.offsetMs,
              anchorOffsetMs: selected.anchorOffsetMs,
              expandedSampling: selected.expandedSampling,
              deepExpandedSampling: selected.deepExpandedSampling,
              detectedCount: selected.detectedCount,
              trackedCount: selected.trackedCount,
              trackSimilarity: selected.best.trackSimilarity,
              continuityScore: selected.best.continuityScore,
              baselineOffsetMs: selected.baselineOffsetMs,
              challengerOffsetMs: selected.challengerOffsetMs,
              selectionReason: selected.selectionReason,
              baselineScore: selected.best.baselineScore,
              quality: selected.best.quality,
              scoreBreakdown: selected.best.scoreBreakdown,
            },
          });
        } catch (error) {
          await this.fileStorage.deleteImage(framePath, null);
          throw error;
        }
        if (previousPath && previousPath !== framePath) {
          await this.fileStorage.deleteImage(previousPath, null);
        }
      };
      if (typeof this.repository.withDerivedStorageWriterLock === "function") {
        await this.repository.withDerivedStorageWriterLock(writeReadyFrame);
      } else {
        // Test doubles retain the established repository surface. The
        // production repository always wraps this sequence in a shared lock.
        await writeReadyFrame();
      }
      return {
        status: "ready",
        readId: Number(read.id),
        plateNumber: read.plate_number,
        cameraName: read.camera_name,
        readTimestamp: new Date(read.timestamp).toISOString(),
        imageUrl: `/images/${framePath.replaceAll("\\", "/")}`,
        frameTimestamp: selected.best.timestamp,
        frameScore: selected.best.score,
        sampledCount: selected.sampledCount,
        detectedCount: selected.detectedCount,
        trackedCount: selected.trackedCount,
        selectedOffsetMs: selected.best.offsetMs,
        expandedSampling: selected.expandedSampling,
      };
    } catch (error) {
      const terminal = ["RECORDING_UNAVAILABLE", "VEHICLE_NOT_VISIBLE"].includes(error?.code);
      await this.repository.markFailed(read.id, {
        status: terminal ? "unavailable" : "failed",
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
        retryable: !terminal,
      });
      return {
        status: terminal ? "unavailable" : "failed",
        readId: Number(read.id),
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
        message: error instanceof BlueIrisError
          ? error.message
          : "Unable to analyze the sampled Blue Iris frames.",
      };
    }
  }

  async processOverviewRead({ read, profile, camera, alreadyClaimed = false }) {
    if (!read?.id || !read?.timestamp || !profile?.id) {
      throw new Error("A persisted plate read and overview profile are required for processing.");
    }
    if (!alreadyClaimed) {
      throw new Error("Overview reads must be claimed by the durable queue.");
    }
    const claimToken = String(read.vehicle_image_claim_token || "").trim();
    if (!claimToken) throw new Error("Overview reads require a current claim token.");

    const sourceTimestamp = overviewSourceTimestamp(read.timestamp, profile.expected_delta_ms);
    const sampleOffsetsMs = overviewVehicleFrameSampleOffsets(profile.tolerance_ms);
    let timelineExport = null;
    let claimLost = false;
    let heartbeatRunning = false;
    const hardDeadlineMs = new Date(read.vehicle_image_hard_deadline_at || 0).getTime();
    const assertActive = () => {
      if (claimLost) {
        throw new BlueIrisError("OVERVIEW_CLAIM_LOST", "The Vehicle View job is no longer owned by this worker.");
      }
      if (Number.isFinite(hardDeadlineMs) && hardDeadlineMs > 0 && Date.now() >= hardDeadlineMs) {
        throw new BlueIrisError(
          "OVERVIEW_PROCESSING_DEADLINE",
          "Vehicle View processing exceeded its fixed five-minute deadline."
        );
      }
    };
    const sendHeartbeat = async () => {
      if (heartbeatRunning || claimLost) return;
      heartbeatRunning = true;
      try {
        const active = await this.repository.heartbeatOverviewRead(read.id, claimToken);
        if (!active) claimLost = true;
      } catch {
        // A transient database error is retried by the next heartbeat. The immutable
        // hard deadline still prevents this worker from running indefinitely.
      } finally {
        heartbeatRunning = false;
      }
    };
    const heartbeatTimer = typeof this.repository.heartbeatOverviewRead === "function"
      ? setInterval(() => {
          sendHeartbeat().catch(() => {});
        }, 15_000)
      : null;
    heartbeatTimer?.unref?.();
    try {
      if (typeof this.repository.heartbeatOverviewRead === "function") {
        await sendHeartbeat();
      }
      assertActive();
      let frameProvider = null;
      if (this.timelineExportService) {
        const intendedStartAt = new Date(
          new Date(sourceTimestamp).getTime() + sampleOffsetsMs[0]
        ).toISOString();
        timelineExport = await this.timelineExportService.acquire({
          read,
          claimToken,
          camera,
          sourceCameraName: profile.source_camera_name,
          intendedStartAt,
          pairProfileId: profile.id,
          profileRevision: profile.revision,
          assertActive,
        });
        const framesByOffset = new Map(timelineExport.frames.map((frame, index) => [
          sampleOffsetsMs[index],
          {
            buffer: frame.buffer,
            timestamp: new Date(new Date(sourceTimestamp).getTime() + sampleOffsetsMs[index]).toISOString(),
          },
        ]));
        frameProvider = async ({ offsetMs }) => {
          assertActive();
          const frame = framesByOffset.get(offsetMs);
          if (!frame) {
            throw new BlueIrisError(
              "EXPORT_FRAME_COUNT_INVALID",
              "The temporary Blue Iris export is missing a required analysis frame."
            );
          }
          return frame;
        };
      }
      assertActive();
      const selected = await this.selectBestFrame({
        camera,
        timestamp: sourceTimestamp,
        plateBox: null,
        selectionMode: "overview_anchor",
        anchorToleranceMs: profile.tolerance_ms,
        sampleOffsetsMs,
        requireColor: true,
        frameProvider,
      });
      assertActive();
      let finalFrame;
      let finalRefetchError = null;
      const finalRefetchAttempts = [];
      if (timelineExport) {
        assertActive();
        const selectedOffsetMs = selected.best.offsetMs - sampleOffsetsMs[0];
        const finalBuffer = await timelineExport.extractFinalFrame({ selectedOffsetMs });
        finalFrame = await this.validateOverviewFinalFrame({
          buffer: finalBuffer,
          timestamp: selected.best.timestamp,
          selected: selected.best,
          mode: "timeline_export",
        });
        assertActive();
        finalRefetchAttempts.push({
          attempt: 1,
          status: "ready",
          width: finalFrame.width,
          height: finalFrame.height,
          identitySimilarity: finalFrame.identitySimilarity,
          detectionOverlap: finalFrame.detectionOverlap,
          detectionContinuity: finalFrame.detectionContinuity,
        });
      }
      for (let attempt = 1;
        !timelineExport && attempt <= OVERVIEW_FINAL_REFETCH_MAX_ATTEMPTS;
        attempt += 1) {
        try {
          finalFrame = await this.refetchOverviewFrame({ camera, selected: selected.best });
          finalRefetchAttempts.push({
            attempt,
            status: "ready",
            width: finalFrame.width,
            height: finalFrame.height,
            identitySimilarity: finalFrame.identitySimilarity,
            detectionOverlap: finalFrame.detectionOverlap,
            detectionContinuity: finalFrame.detectionContinuity,
          });
          break;
        } catch (error) {
          if (error?.code === "NIGHTTIME_UNAVAILABLE") throw error;
          finalRefetchError = error;
          finalRefetchAttempts.push(boundedFinalRefetchFailure(error, attempt));
        }
      }
      if (!finalFrame) {
        finalFrame = {
          buffer: selected.best.buffer,
          timestamp: selected.best.timestamp,
          width: selected.best.width,
          height: selected.best.height,
          identitySimilarity: null,
          detectionOverlap: null,
          detectionContinuity: null,
          mode: "validated_analysis_fallback",
        };
      }
      const framePath = derivedPath(read, selected.best.timestamp, claimToken);
      const previousPath = read.vehicle_image_path;
      const writeReadyFrame = async (writerRepository = this.repository) => {
        assertActive();
        const save = typeof this.fileStorage.saveDerivedImageAtomic === "function"
          ? this.fileStorage.saveDerivedImageAtomic.bind(this.fileStorage)
          : this.fileStorage.saveDerivedImage.bind(this.fileStorage);
        await save(framePath, finalFrame.buffer);
        try {
          assertActive();
          const ready = await writerRepository.markReady(read.id, {
            framePath,
            frameTimestamp: selected.best.timestamp,
            frameScore: selected.best.score,
            detectionConfidence: selected.best.detection.confidence,
            detectionBox: detectionBox(selected.best.detection),
            imageWidth: finalFrame.width,
            imageHeight: finalFrame.height,
            sampledCount: selected.sampledCount,
            sourceKind: "overview_primary",
            selectionMetadata: {
              algorithm: `${VEHICLE_FRAME_SELECTION_ALGORITHM}-overview-read-100ms`,
              profileId: Number(profile.id),
              sourceCameraName: profile.source_camera_name,
              plateCameraName: read.camera_name,
              directionLabel: read.bi_trigger_direction_label,
              expectedDeltaMs: Number(profile.expected_delta_ms),
              toleranceMs: Number(profile.tolerance_ms),
              profileRevision: Number(profile.revision || 1),
              sourceTimestamp,
              requestedStartOffsetMs: sampleOffsetsMs[0],
              requestedEndOffsetMs: sampleOffsetsMs.at(-1),
              selectedOffsetMs: selected.best.offsetMs,
              anchorOffsetMs: selected.anchorOffsetMs,
              detectedCount: selected.detectedCount,
              trackedCount: selected.trackedCount,
              trackSimilarity: selected.best.trackSimilarity,
              continuityScore: selected.best.continuityScore,
              selectionReason: selected.selectionReason,
              quality: selected.best.quality,
              scoreBreakdown: selected.best.scoreBreakdown,
              telemetry: selected.telemetry,
              acquisition: timelineExport ? {
                mode: "blue_iris_timeline_export",
                exportToken: timelineExport.exportToken,
                requestedStartMs: timelineExport.requestedStartMs,
                remoteStartMs: timelineExport.remoteStartMs,
                trimStartMs: timelineExport.trimStartMs,
                utcVerified: timelineExport.utcVerified,
                remoteRetentionManaged: timelineExport.remoteRetentionManaged === true,
                exportWidth: timelineExport.probe.width,
                exportHeight: timelineExport.probe.height,
                exportDurationMs: timelineExport.probe.durationMs,
                exportCodec: timelineExport.probe.codec,
                exportFileSize: timelineExport.probe.fileSize,
              } : { mode: "legacy_timeline_jpeg" },
                finalImage: {
                  mode: finalFrame.mode,
                  requestedWidth: timelineExport ? timelineExport.probe.width : OVERVIEW_FINAL_WIDTH,
                  requestedHeight: timelineExport ? timelineExport.probe.height : OVERVIEW_FINAL_HEIGHT,
                actualWidth: finalFrame.width,
                actualHeight: finalFrame.height,
                identitySimilarity: finalFrame.identitySimilarity,
                detectionOverlap: finalFrame.detectionOverlap,
                detectionContinuity: finalFrame.detectionContinuity,
                fallbackErrorCode: finalFrame.mode === "validated_analysis_fallback"
                  ? finalRefetchError?.code || "FINAL_FRAME_REFETCH_FAILED"
                  : null,
                attemptCount: finalRefetchAttempts.length,
                attempts: finalRefetchAttempts,
              },
            },
          }, {
            claimToken,
            exportToken: timelineExport?.exportToken || null,
            profileSnapshot: { id: profile.id, revision: Number(profile.revision || 1) },
          });
          if (!ready) {
            await this.fileStorage.deleteImage(framePath, null);
            return false;
          }
        } catch (error) {
          await this.fileStorage.deleteImage(framePath, null);
          throw error;
        }
        if (previousPath && previousPath !== framePath) {
          await this.fileStorage.deleteImage(previousPath, null);
        }
        return true;
      };
      let ready;
      if (typeof this.repository.withDerivedStorageWriterLock === "function") {
        ready = await this.repository.withDerivedStorageWriterLock(writeReadyFrame);
      } else {
        ready = await writeReadyFrame();
      }
      if (!ready) {
        return {
          kind: "overview_read",
          status: "superseded",
          readId: Number(read.id),
        };
      }
      return {
        kind: "overview_read",
        status: "ready",
        readId: Number(read.id),
        sourceCameraName: profile.source_camera_name,
        sourceTimestamp,
        frameTimestamp: selected.best.timestamp,
        frameScore: selected.best.score,
        sampledCount: selected.sampledCount,
        finalImageMode: finalFrame.mode,
      };
    } catch (error) {
      const attemptCount = Number(read.vehicle_image_attempt_count || 0);
      const readAgeMs = Date.now() - new Date(read.timestamp).getTime();
      const code = error?.code || "FRAME_SELECTION_FAILED";
      const freshRecordingRetry = code === "RECORDING_UNAVAILABLE"
        && Number.isFinite(readAgeMs)
        && readAgeMs <= 5 * 60_000;
      const semanticTerminal = [
        "VEHICLE_NOT_VISIBLE",
        "MULTIPLE_VEHICLES_VISIBLE",
        "NIGHTTIME_UNAVAILABLE",
        "EXPORT_RESOLUTION_TOO_LOW",
        "EXPORT_TIMELINE_UNVERIFIED",
        "EXPORT_TIMELINE_MISMATCH",
        "EXPORT_START_UNCERTAIN",
        "MEDIA_TOOL_UNAVAILABLE",
      ].includes(code) || (code === "RECORDING_UNAVAILABLE"
        && !(freshRecordingRetry && attemptCount < 2));
      const transient = freshRecordingRetry || [
        "EXPORT_TIMEOUT",
        "EXPORT_UNAVAILABLE",
        "EXPORT_FAILED",
        "EXPORT_DURATION_TOO_SHORT",
        "EXPORT_PROBE_INVALID",
        "EXPORT_FRAME_COUNT_INVALID",
        "EXPORT_INVALID",
        "FINAL_FRAME_INVALID",
        "MEDIA_TOOL_TIMEOUT",
        "MEDIA_TOOL_FAILED",
        "HTTP_ERROR",
        "CONNECTION_FAILED",
        "TIMEOUT",
        "OVERVIEW_PROCESSING_DEADLINE",
        "FRAME_SELECTION_FAILED",
      ].includes(code);
      const retryable = transient && attemptCount < 2;
      const nextAttemptAt = retryable
        ? new Date(Date.now() + 30_000).toISOString()
        : null;
      const failed = await this.repository.markFailed(read.id, {
        status: semanticTerminal ? "unavailable" : "failed",
        errorCode: code,
        retryable,
        claimToken,
        nextAttemptAt,
        profileSnapshot: { id: profile.id, revision: Number(profile.revision || 1) },
        selectionMetadata: {
          algorithm: `${VEHICLE_FRAME_SELECTION_ALGORITHM}-overview-read-100ms`,
          profileId: Number(profile.id),
          profileRevision: Number(profile.revision || 1),
          sourceCameraName: profile.source_camera_name,
          plateCameraName: read.camera_name,
          directionLabel: read.bi_trigger_direction_label,
          expectedDeltaMs: Number(profile.expected_delta_ms),
          toleranceMs: Number(profile.tolerance_ms),
          sourceTimestamp,
          requestedStartOffsetMs: sampleOffsetsMs[0],
          requestedEndOffsetMs: sampleOffsetsMs.at(-1),
          failure: {
            code,
            telemetry: error?.details || null,
            boundedRecordingRetry: retryable,
            nextAttemptAt,
          },
        },
      });
      if (!failed) {
        return { kind: "overview_read", status: "superseded", readId: Number(read.id) };
      }
      return {
        kind: "overview_read",
        status: retryable ? "retry_scheduled" : semanticTerminal ? "unavailable" : "failed",
        readId: Number(read.id),
        errorCode: code,
        nextAttemptAt,
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await timelineExport?.cleanup?.().catch(() => {});
    }
  }

  async processOverviewCandidate({ candidate, camera, alreadyClaimed = false }) {
    if (!candidate?.id || !candidate?.event_timestamp) {
      throw new Error("A persisted overview candidate is required for processing.");
    }
    if (!alreadyClaimed) {
      throw new Error("Overview candidates must be claimed by the durable queue.");
    }
    try {
      const selected = await this.selectBestFrame({
        camera,
        timestamp: candidate.event_timestamp,
        plateBox: null,
      });
      const framePath = overviewCandidatePath(candidate, selected.best.timestamp);
      const writeReadyFrame = async (writerRepository = this.repository) => {
        await this.fileStorage.saveDerivedImage(framePath, selected.best.buffer);
        try {
          await writerRepository.markOverviewCandidateReady(candidate.id, {
            framePath,
            frameTimestamp: selected.best.timestamp,
            frameScore: selected.best.score,
            detectionConfidence: selected.best.detection.confidence,
            detectionBox: detectionBox(selected.best.detection),
            imageWidth: selected.best.width,
            imageHeight: selected.best.height,
            sampledCount: selected.sampledCount,
            selectionMetadata: {
              algorithm: `${VEHICLE_FRAME_SELECTION_ALGORITHM}-overview-100ms`,
              selectedOffsetMs: selected.best.offsetMs,
              anchorOffsetMs: selected.anchorOffsetMs,
              detectedCount: selected.detectedCount,
              trackedCount: selected.trackedCount,
              selectionReason: selected.selectionReason,
              quality: selected.best.quality,
              scoreBreakdown: selected.best.scoreBreakdown,
            },
          });
        } catch (error) {
          await this.fileStorage.deleteImage(framePath, null);
          throw error;
        }
      };
      if (typeof this.repository.withDerivedStorageWriterLock === "function") {
        await this.repository.withDerivedStorageWriterLock(writeReadyFrame);
      } else {
        await writeReadyFrame();
      }
      return {
        kind: "overview_candidate",
        status: "ready",
        candidateId: Number(candidate.id),
        sourceCameraName: candidate.source_camera_name,
        frameTimestamp: selected.best.timestamp,
        frameScore: selected.best.score,
        sampledCount: selected.sampledCount,
      };
    } catch (error) {
      const terminal = ["RECORDING_UNAVAILABLE", "VEHICLE_NOT_VISIBLE"].includes(error?.code);
      await this.repository.markOverviewCandidateFailed(candidate.id, {
        status: terminal ? "unavailable" : "failed",
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
        retryable: !terminal,
      });
      return {
        kind: "overview_candidate",
        status: terminal ? "unavailable" : "failed",
        candidateId: Number(candidate.id),
        errorCode: error?.code || "FRAME_SELECTION_FAILED",
      };
    }
  }

  async associateOverviewCandidate(candidate) {
    const profiles = (await this.repository.listOverviewPairProfiles(candidate.source_camera_name))
      .filter((profile) => profile.enabled === true);
    if (!profiles.length) {
      const unconfiguredAgeMs = Date.now() - new Date(candidate.event_timestamp).getTime();
      const terminal = unconfiguredAgeMs >= 10 * 60_000;
      const released = await this.repository.releaseOverviewCandidateMatch(candidate.id, {
        status: terminal ? "unavailable" : "ready",
        errorCode: "ASSOCIATION_NOT_CONFIGURED",
        preserveAttempts: !terminal,
      });
      if (terminal && released?.frame_path) {
        await this.fileStorage.deleteImage(released.frame_path, null);
        await this.repository.discardOverviewCandidateFrame(candidate.id);
      }
      return {
        kind: "overview_association",
        status: terminal ? "unavailable" : "not_configured",
        candidateId: Number(candidate.id),
      };
    }
    const ageMs = Date.now() - new Date(candidate.event_timestamp).getTime();
    if (ageMs < associationMinimumAgeMs(profiles)) {
      await this.repository.releaseOverviewCandidateMatch(candidate.id, {
        status: "ready",
        errorCode: "WAITING_FOR_ASSOCIATION_WINDOW",
        preserveAttempts: true,
      });
      return { kind: "overview_association", status: "deferred", candidateId: Number(candidate.id) };
    }
    const reads = await this.repository.listOverviewAssociationReads(candidate);
    const choice = chooseOverviewAssociation({ candidate, reads, profiles });
    if (choice.status === "ambiguous") {
      const released = await this.repository.releaseOverviewCandidateMatch(candidate.id, {
        status: "ambiguous",
        errorCode: choice.reason,
      });
      if (released?.frame_path) {
        await this.fileStorage.deleteImage(released.frame_path, null);
        await this.repository.discardOverviewCandidateFrame(candidate.id);
      }
      return { kind: "overview_association", status: "ambiguous", candidateId: Number(candidate.id) };
    }
    if (choice.status !== "matched") {
      const released = await this.repository.releaseOverviewCandidateMatch(candidate.id, {
        status: "ready",
        errorCode: choice.reason,
      });
      if (released?.status === "unavailable" && released.frame_path) {
        await this.fileStorage.deleteImage(released.frame_path, null);
        await this.repository.discardOverviewCandidateFrame(candidate.id);
      }
      return { kind: "overview_association", status: released?.status || "ready", candidateId: Number(candidate.id) };
    }

    const sourceBuffer = await this.fileStorage.getImage(candidate.frame_path);
    if (!sourceBuffer) {
      await this.repository.markOverviewCandidateFailed(candidate.id, {
        status: "unavailable",
        errorCode: "CANDIDATE_IMAGE_MISSING",
        retryable: false,
      });
      return { kind: "overview_association", status: "unavailable", candidateId: Number(candidate.id) };
    }

    const writtenPaths = [];
    let associated = [];
    try {
      const operation = async (writerRepository) => writerRepository.withTransaction(async (transactionRepository) => {
        const linked = [];
        for (const read of choice.reads) {
          const framePath = derivedPath(read, candidate.frame_timestamp);
          await this.fileStorage.saveDerivedImage(framePath, sourceBuffer);
          writtenPaths.push(framePath);
          const profile = read.profile;
          const role = String(profile.source_role || "primary").toLowerCase();
          const result = await transactionRepository.associateOverviewRead({
            candidate,
            read,
            framePath,
            sourceKind: role === "fallback" ? "overview_fallback" : "overview_primary",
            association: {
              profileId: profile.id,
              algorithm: OVERVIEW_ASSOCIATION_ALGORITHM,
              score: read.associationScore,
              actualDeltaMs: read.actualDeltaMs,
              timingErrorMs: read.timingErrorMs,
              metadata: {
                algorithm: OVERVIEW_ASSOCIATION_ALGORITHM,
                candidateId: Number(candidate.id),
                sourceCameraName: candidate.source_camera_name,
                sourceRole: role,
                expectedDeltaMs: Number(profile.expected_delta_ms),
                toleranceMs: Number(profile.tolerance_ms),
                actualDeltaMs: read.actualDeltaMs,
                timingErrorMs: read.timingErrorMs,
                ambiguityMargin: choice.runnerUpScore === null
                  ? null
                  : Number((choice.runnerUpScore - choice.bestScore).toFixed(6)),
              },
            },
          });
          if (result) {
            linked.push({ readId: Number(read.id), framePath });
          } else {
            await this.fileStorage.deleteImage(framePath, null);
            writtenPaths.splice(writtenPaths.lastIndexOf(framePath), 1);
          }
        }
        if (!linked.length) throw new Error("Overview association lost its eligible plate reads.");
        await transactionRepository.markOverviewCandidateAssociated(candidate.id);
        return linked;
      });
      associated = typeof this.repository.withDerivedStorageWriterLock === "function"
        ? await this.repository.withDerivedStorageWriterLock(operation)
        : await operation(this.repository);
    } catch (error) {
      await Promise.allSettled(writtenPaths.map((framePath) => this.fileStorage.deleteImage(framePath, null)));
      await this.repository.releaseOverviewCandidateMatch(candidate.id, {
        status: "ready",
        errorCode: "ASSOCIATION_WRITE_FAILED",
      });
      throw error;
    }
    await this.fileStorage.deleteImage(candidate.frame_path, null);
    return {
      kind: "overview_association",
      status: "associated",
      candidateId: Number(candidate.id),
      readIds: associated.map((item) => item.readId),
    };
  }
}

export const blueIrisVehicleFrameInternals = Object.freeze({
  derivedPath,
  detectionBox,
  overviewCandidatePath,
});
