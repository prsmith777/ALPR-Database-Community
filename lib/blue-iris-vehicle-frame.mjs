import crypto from "node:crypto";
import path from "node:path";

import sharp from "sharp";

import { BlueIrisError } from "./blue-iris.mjs";
import {
  cosineSimilarity,
  vehicleReidEngine,
} from "./vehicle-reid.mjs";
import {
  analyzeVehicleMotionDirection,
  VEHICLE_MOTION_DIRECTION_ALGORITHM,
} from "./vehicle-motion-direction.mjs";

export const VEHICLE_FRAME_SELECTION_ALGORITHM = "blue-iris-vehicle-frame-v4-guarded";
export const VEHICLE_MOTION_SAMPLE_INTERVAL_MS = 100;
export const VEHICLE_MOTION_ALERT_PADDING_MS = 500;
export const VEHICLE_MOTION_MAX_WINDOW_MS = 6_000;
export const VEHICLE_MOTION_ANCHOR_MAX_OFFSET_MS = 750;

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

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function createVehicleMotionSampleWindow({
  readTimestamp,
  alert = null,
  intervalMs = VEHICLE_MOTION_SAMPLE_INTERVAL_MS,
  paddingMs = VEHICLE_MOTION_ALERT_PADDING_MS,
  maxWindowMs = VEHICLE_MOTION_MAX_WINDOW_MS,
} = {}) {
  const readMs = new Date(readTimestamp).getTime();
  if (!Number.isFinite(readMs)) throw new Error("A valid plate-read timestamp is required.");
  const boundedInterval = Math.max(50, Math.trunc(Number(intervalMs) || VEHICLE_MOTION_SAMPLE_INTERVAL_MS));
  const boundedPadding = Math.max(0, Math.trunc(Number(paddingMs) || 0));
  const boundedWindow = Math.max(boundedInterval, Math.trunc(Number(maxWindowMs) || VEHICLE_MOTION_MAX_WINDOW_MS));
  const alertStartMs = new Date(alert?.timestamp).getTime();
  const alertDurationMs = optionalFiniteNumber(alert?.msec);
  const hasAlertWindow = Number.isFinite(alertStartMs) && alertDurationMs > 0;
  let startOffsetMs = hasAlertWindow
    ? alertStartMs - readMs - boundedPadding
    : -boundedWindow / 2;
  let endOffsetMs = hasAlertWindow
    ? alertStartMs - readMs + alertDurationMs + boundedPadding
    : boundedWindow / 2;

  if (endOffsetMs - startOffsetMs > boundedWindow) {
    const midpoint = (startOffsetMs + endOffsetMs) / 2;
    startOffsetMs = midpoint - boundedWindow / 2;
    endOffsetMs = midpoint + boundedWindow / 2;
  }
  if (startOffsetMs > 0) {
    endOffsetMs -= startOffsetMs;
    startOffsetMs = 0;
  } else if (endOffsetMs < 0) {
    startOffsetMs -= endOffsetMs;
    endOffsetMs = 0;
  }

  let alignedStart = Math.floor(startOffsetMs / boundedInterval) * boundedInterval;
  let alignedEnd = Math.ceil(endOffsetMs / boundedInterval) * boundedInterval;
  if (alignedEnd - alignedStart > boundedWindow) {
    if (alignedStart <= 0 && alignedStart + boundedWindow >= 0) {
      alignedEnd = alignedStart + boundedWindow;
    } else {
      alignedStart = alignedEnd - boundedWindow;
    }
  }
  const offsets = [];
  for (let offset = alignedStart; offset <= alignedEnd; offset += boundedInterval) offsets.push(offset);
  return {
    offsets,
    source: hasAlertWindow ? "blue_iris_alert" : "bounded_fallback",
    intervalMs: boundedInterval,
    startOffsetMs: alignedStart,
    endOffsetMs: alignedEnd,
    durationMs: alignedEnd - alignedStart,
    alertDurationMs: hasAlertWindow ? alertDurationMs : null,
  };
}

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

function normalizedPlateBoxForFrame(plateBox, {
  plateImageWidth = null,
  plateImageHeight = null,
  frameWidth,
  frameHeight,
} = {}) {
  if (!plateBox) return null;
  const left = Number(plateBox.left ?? plateBox.xMin ?? plateBox[0]);
  const top = Number(plateBox.top ?? plateBox.yMin ?? plateBox[1]);
  const right = Number(plateBox.right ?? plateBox.xMax ?? (
    Number.isFinite(Number(plateBox.width)) ? left + Number(plateBox.width) : plateBox[2]
  ));
  const bottom = Number(plateBox.bottom ?? plateBox.yMax ?? (
    Number.isFinite(Number(plateBox.height)) ? top + Number(plateBox.height) : plateBox[3]
  ));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  const sourceWidth = Number(plateImageWidth);
  const sourceHeight = Number(plateImageHeight);
  const width = Number(frameWidth);
  const height = Number(frameHeight);
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (![sourceWidth, sourceHeight].every(Number.isFinite) || sourceWidth <= 0 || sourceHeight <= 0) {
    return [left, top, right, bottom];
  }
  return [
    left / sourceWidth * width,
    top / sourceHeight * height,
    right / sourceWidth * width,
    bottom / sourceHeight * height,
  ];
}

function distanceFromPointToDetection(point, detection) {
  const deltaX = point.x < detection.left
    ? detection.left - point.x
    : point.x > detection.right
      ? point.x - detection.right
      : 0;
  const deltaY = point.y < detection.top
    ? detection.top - point.y
    : point.y > detection.bottom
      ? point.y - detection.bottom
      : 0;
  return Math.hypot(deltaX, deltaY);
}

export function attachStoredPlateAnchor(candidates, {
  plateBox = null,
  plateImageWidth = null,
  plateImageHeight = null,
  maxOffsetMs = VEHICLE_MOTION_ANCHOR_MAX_OFFSET_MS,
} = {}) {
  if (!plateBox || !candidates.length) return candidates;
  const boundedOffset = Math.max(0, Number(maxOffsetMs) || 0);
  const offsetMagnitudes = [...new Set(candidates
    .map((candidate) => Math.abs(Number(candidate.offsetMs)))
    .filter((offset) => Number.isFinite(offset) && offset <= boundedOffset))]
    .sort((left, right) => left - right);

  for (const magnitude of offsetMagnitudes) {
    const frameOffsets = [...new Set(candidates
      .filter((candidate) => Math.abs(Number(candidate.offsetMs)) === magnitude)
      .map((candidate) => Number(candidate.offsetMs)))]
      .sort((left, right) => left - right);
    const viableFrames = [];
    for (const offsetMs of frameOffsets) {
      const frameCandidates = candidates.filter((candidate) => Number(candidate.offsetMs) === offsetMs);
      const ranked = frameCandidates.map((candidate) => {
        const scaledPlate = normalizedPlateBoxForFrame(plateBox, {
          plateImageWidth,
          plateImageHeight,
          frameWidth: candidate.width,
          frameHeight: candidate.height,
        });
        if (!scaledPlate) return null;
        const plateCenter = {
          x: (scaledPlate[0] + scaledPlate[2]) / 2 / Number(candidate.width),
          y: (scaledPlate[1] + scaledPlate[3]) / 2 / Number(candidate.height),
        };
        return {
          candidate,
          distance: distanceFromPointToDetection(plateCenter, candidate.detection),
        };
      }).filter(Boolean).sort((left, right) => (
        Number(right.candidate.detection.containsPlate) - Number(left.candidate.detection.containsPlate)
        || left.distance - right.distance
        || Number(right.candidate.detection.selectionScore || 0) - Number(left.candidate.detection.selectionScore || 0)
      ));
      const best = ranked[0];
      if (!best) continue;
      // The dense window may span a full alert, but elapsed time must not make
      // a distant vehicle increasingly eligible. Keep proximity conservative;
      // exact plate containment remains preferred at every sampled position.
      const threshold = 0.08 + Math.min(1, magnitude / 750) * 0.04;
      const second = ranked[1];
      const ambiguous = !best.candidate.detection.containsPlate
        && second
        && second.distance <= threshold
        && second.distance - best.distance < 0.035;
      if (best.distance <= threshold && !ambiguous) viableFrames.push(best);
    }
    const selected = viableFrames.sort((left, right) => (
      Number(right.candidate.detection.containsPlate) - Number(left.candidate.detection.containsPlate)
      || left.distance - right.distance
      || Number(right.candidate.detection.selectionScore || 0) - Number(left.candidate.detection.selectionScore || 0)
      || Number(left.candidate.offsetMs) - Number(right.candidate.offsetMs)
    ))[0];
    if (!selected) continue;
    return candidates.map((candidate) => candidate === selected.candidate
      ? {
        ...candidate,
        motionAnchor: true,
        motionAnchorSource: candidate.detection.containsPlate
          ? "scaled_stored_plate_containment"
          : "scaled_stored_plate_proximity",
        motionAnchorDistance: Number(selected.distance.toFixed(6)),
      }
      : candidate);
  }
  return candidates;
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

function chooseMotionAnchorCandidate(candidates, selectionAnchor) {
  return candidates.find((candidate) => candidate.motionAnchor === true)
    || selectionAnchor;
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

function softTrackCandidates(candidates, anchor, { motionMode = false } = {}) {
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
        const detectorConfidence = clamp(Number(candidate.detection?.confidence) || 0, 0, 1);
        return {
          candidate,
          similarity,
          continuity,
          // Saved vehicle views still prefer a complete frame. Direction
          // tracking must not discard the correct vehicle merely because a
          // close pass is clipped by one or more frame edges.
          rank: motionMode
            ? continuity * 0.62 + identity * 0.28 + detectorConfidence * 0.1
            : continuity * 0.48 + identity * 0.17 + baseline * 0.35,
        };
      }).sort((left, right) => right.rank - left.rank);
      if (!ranked[0]) continue;
      const selected = {
        ...ranked[0].candidate,
        trackSimilarity: Number.isFinite(ranked[0].similarity)
          ? Number(ranked[0].similarity.toFixed(6))
          : null,
        continuityScore: Number(ranked[0].continuity.toFixed(6)),
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
  const motionAnchor = chooseMotionAnchorCandidate(candidates, anchor);
  const motionTrack = motionAnchor
    ? softTrackCandidates(candidates, motionAnchor, { motionMode: true })
    : [];
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
  return {
    best,
    baseline,
    challenger,
    anchor,
    track,
    trackedCount: track.length,
    motionAnchor,
    motionTrack,
    selectionReason,
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

function derivedPath(read, frameTimestamp) {
  const date = new Date(frameTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.posix.join("derived", year, month, day, `blue_iris_vehicle_read_${read.id}.jpg`);
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
    motionAnalyzer = analyzeVehicleMotionDirection,
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
    this.motionAnalyzer = motionAnalyzer;
  }

  async resolveMotionSampleWindow({ read, camera }) {
    let alert = null;
    try {
      if (typeof this.client.findMatchingAlert === "function") {
        const match = await this.client.findMatchingAlert({
          camera,
          timestamp: read.timestamp,
          toleranceSeconds: 15,
          clip: read.bi_alert_clip || null,
          offsetMs: read.bi_alert_offset_ms ?? null,
        });
        if (match?.matched) alert = match.alert;
      } else if (typeof this.client.findNearestAlert === "function") {
        const match = await this.client.findNearestAlert({
          camera,
          timestamp: read.timestamp,
          toleranceSeconds: 15,
        });
        if (match?.matched) alert = match.alert;
      }
    } catch {
      // Direction remains diagnostic-only. Alert lookup failure falls back to
      // the bounded six-second window and cannot fail the vehicle-view worker.
    }
    return createVehicleMotionSampleWindow({
      readTimestamp: read.timestamp,
      alert,
    });
  }

  async analyzeOffsets({
    camera,
    baseMs,
    offsets,
    plateBox = null,
    plateImageWidth = null,
    plateImageHeight = null,
    primarySample = false,
    plateBoxAtEveryOffset = false,
    deduplicateFrames = false,
    analyzeQuality = true,
    anchorMaxOffsetMs = VEHICLE_MOTION_ANCHOR_MAX_OFFSET_MS,
    frameCache = null,
  }) {
    const candidates = [];
    const frames = [];
    const failures = [];
    const seenFrameHashes = new Set();
    let duplicateCount = 0;
    for (const offsetMs of offsets) {
      try {
        let normalized = frameCache?.get(offsetMs) || null;
        if (!normalized) {
          const frame = await this.client.fetchTimelineJpeg({
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
          normalized = { frame, oriented, metadata };
          frameCache?.set(offsetMs, normalized);
        }
        const { frame, oriented, metadata } = normalized;
        if (deduplicateFrames) {
          const frameHash = crypto.createHash("sha256").update(oriented).digest("hex");
          if (seenFrameHashes.has(frameHash)) {
            duplicateCount += 1;
            continue;
          }
          seenFrameHashes.add(frameHash);
        }
        frames.push({
          buffer: oriented,
          timestamp: frame.timestamp,
          offsetMs,
          width: metadata.width,
          height: metadata.height,
        });
        const scaledPlateBox = normalizedPlateBoxForFrame(plateBox, {
          plateImageWidth,
          plateImageHeight,
          frameWidth: metadata.width,
          frameHeight: metadata.height,
        });
        const dimensions = {
          imageWidth: metadata.width,
          imageHeight: metadata.height,
          plateBox: plateBoxAtEveryOffset || offsetMs === 0 ? scaledPlateBox : null,
        };
        const detections = typeof this.detector.detectAll === "function"
          ? await this.detector.detectAll(oriented, dimensions)
          : [await this.detector.detect(oriented, dimensions)].filter(Boolean);
        for (const [frameRank, detection] of detections.entries()) {
          let quality = { sharpnessScore: 0.5, exposureScore: 0.5, contrastScore: 0.5 };
          if (analyzeQuality) {
            try {
              quality = await this.qualityAnalyzer({
                imageProcessor: this.imageProcessor,
                buffer: oriented,
                detection,
                width: metadata.width,
                height: metadata.height,
              });
            } catch {
              // Neutral quality keeps motion tracking independent from the
              // saved vehicle-view framing preference.
            }
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
      candidates: attachStoredPlateAnchor(candidates, {
        plateBox,
        plateImageWidth,
        plateImageHeight,
        maxOffsetMs: anchorMaxOffsetMs,
      }),
      frames,
      failures,
      duplicateCount,
    };
  }

  async selectBestFrame({
    camera,
    timestamp,
    plateBox = null,
    plateImageWidth = null,
    plateImageHeight = null,
    motionSampleWindow = null,
  }) {
    const baseMs = new Date(timestamp).getTime();
    if (!Number.isFinite(baseMs)) throw new Error("A valid plate-read timestamp is required.");
    const frameCache = new Map();
    const primary = await this.analyzeOffsets({
      camera,
      baseMs,
      offsets: this.sampleOffsetsMs,
      plateBox,
      plateImageWidth,
      plateImageHeight,
      primarySample: true,
      frameCache,
    });
    let candidates = primary.candidates;
    let frames = primary.frames;
    let failures = primary.failures;
    let selection = selectBestTrackedVehicleFrame(candidates);
    const selectionNeedsMoreSearch = (current) => {
      const primaryOffsets = this.sampleOffsetsMs;
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
    const shouldExtend = this.extensionOffsetsMs.length > 0 && selectionNeedsMoreSearch(selection);
    if (shouldExtend) {
      const extension = await this.analyzeOffsets({
        camera,
        baseMs,
        offsets: this.extensionOffsetsMs,
        plateBox,
        plateImageWidth,
        plateImageHeight,
        frameCache,
      });
      candidates = [...candidates, ...extension.candidates];
      frames = [...frames, ...extension.frames];
      failures = [...failures, ...extension.failures];
      selection = selectBestTrackedVehicleFrame(candidates);
    }
    const shouldDeepExtend = this.deepExtensionOffsetsMs.length > 0 && selectionNeedsMoreSearch(selection);
    if (shouldDeepExtend) {
      const deepExtension = await this.analyzeOffsets({
        camera,
        baseMs,
        offsets: this.deepExtensionOffsetsMs,
        plateBox,
        plateImageWidth,
        plateImageHeight,
        frameCache,
      });
      candidates = [...candidates, ...deepExtension.candidates];
      frames = [...frames, ...deepExtension.frames];
      failures = [...failures, ...deepExtension.failures];
      selection = selectBestTrackedVehicleFrame(candidates);
    }

    const sampledCount = this.sampleOffsetsMs.length
      + (shouldExtend ? this.extensionOffsetsMs.length : 0)
      + (shouldDeepExtend ? this.deepExtensionOffsetsMs.length : 0);
    let motionFrames = frames;
    let motionSelection = selection;
    let motionSamplingDiagnostics = {
      source: "vehicle_view_sparse_fallback",
      intervalMs: null,
      startOffsetMs: frames.length ? Math.min(...frames.map((frame) => frame.offsetMs)) : null,
      endOffsetMs: frames.length ? Math.max(...frames.map((frame) => frame.offsetMs)) : null,
      requestedCount: sampledCount,
      uniqueFrameCount: frames.length,
      duplicateCount: 0,
    };
    if (Array.isArray(motionSampleWindow?.offsets) && motionSampleWindow.offsets.length) {
      const denseMotion = await this.analyzeOffsets({
        camera,
        baseMs,
        offsets: motionSampleWindow.offsets,
        plateBox,
        plateImageWidth,
        plateImageHeight,
        plateBoxAtEveryOffset: true,
        deduplicateFrames: true,
        analyzeQuality: false,
        anchorMaxOffsetMs: Math.min(
          VEHICLE_MOTION_ANCHOR_MAX_OFFSET_MS,
          Math.max(...motionSampleWindow.offsets.map((offset) => Math.abs(Number(offset) || 0)))
        ),
        frameCache,
      });
      motionFrames = denseMotion.frames;
      motionSelection = selectBestTrackedVehicleFrame(denseMotion.candidates);
      motionSamplingDiagnostics = {
        source: motionSampleWindow.source,
        intervalMs: motionSampleWindow.intervalMs,
        startOffsetMs: motionSampleWindow.startOffsetMs,
        endOffsetMs: motionSampleWindow.endOffsetMs,
        requestedCount: motionSampleWindow.offsets.length,
        uniqueFrameCount: denseMotion.frames.length,
        duplicateCount: denseMotion.duplicateCount,
        failureCount: denseMotion.failures.length,
        alertDurationMs: motionSampleWindow.alertDurationMs,
      };
    }
    const motionObservation = await this.motionAnalyzer({
      frames: motionFrames,
      track: motionSelection.motionTrack,
      plateBox,
      anchorOffsetMs: motionSelection.motionAnchor?.offsetMs ?? null,
      anchorSource: motionSelection.motionAnchor?.motionAnchorSource
        || (motionSelection.motionAnchor?.detection?.containsPlate ? "stored_plate_containment" : null),
      anchorDistance: motionSelection.motionAnchor?.motionAnchorDistance ?? null,
      samplingDiagnostics: motionSamplingDiagnostics,
      imageProcessor: this.imageProcessor,
    });

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
        motionObservation,
      };
    }
    const unavailable = failures.length === sampledCount
      && failures.every((error) => error?.code === "RECORDING_UNAVAILABLE");
    if (unavailable) {
      const error = new BlueIrisError(
        "RECORDING_UNAVAILABLE",
        "Blue Iris no longer has viewable recording data around this plate read."
      );
      error.motionObservation = motionObservation;
      throw error;
    }
    if (failures.length === sampledCount) {
      failures[0].motionObservation = motionObservation;
      throw failures[0];
    }
    const error = new BlueIrisError(
      "VEHICLE_NOT_VISIBLE",
      "No complete vehicle was detected in the bounded Blue Iris sample window."
    );
    error.motionObservation = motionObservation;
    throw error;
  }

  async persistMotionObservation(readId, observation) {
    if (!observation || typeof this.repository.saveMotionDirectionObservation !== "function") {
      return { saved: false, errorCode: "MOTION_SHADOW_REPOSITORY_UNAVAILABLE" };
    }
    try {
      await this.repository.saveMotionDirectionObservation(readId, {
        ...observation,
        algorithmVersion: VEHICLE_MOTION_DIRECTION_ALGORITHM,
      });
      return { saved: true, errorCode: null };
    } catch {
      // Shadow persistence must never make the existing vehicle-view pipeline
      // fail or delay read review. Its failure remains visible in the result.
      return { saved: false, errorCode: "MOTION_SHADOW_PERSIST_FAILED" };
    }
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
      let plateImageWidth = null;
      let plateImageHeight = null;
      if (read.image_path && typeof this.fileStorage.getImage === "function") {
        try {
          const sourceImage = await this.fileStorage.getImage(read.image_path);
          if (sourceImage) {
            const sourceMetadata = await this.imageProcessor(sourceImage).metadata();
            plateImageWidth = Number(sourceMetadata.width) || null;
            plateImageHeight = Number(sourceMetadata.height) || null;
          }
        } catch {
          // Missing source dimensions must not break the established vehicle
          // frame pipeline. The unscaled legacy anchor remains a fallback.
        }
      }
      const motionSampleWindow = await this.resolveMotionSampleWindow({ read, camera });
      const selected = await this.selectBestFrame({
        camera,
        timestamp: read.timestamp,
        plateBox: read.crop_coordinates || null,
        plateImageWidth,
        plateImageHeight,
        motionSampleWindow,
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
      const motionShadow = await this.persistMotionObservation(read.id, selected.motionObservation);
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
        motionShadow: {
          ...motionShadow,
          status: selected.motionObservation?.status || null,
          captureMode: selected.motionObservation?.captureMode || null,
          imageDirection: selected.motionObservation?.imageDirection || null,
        },
      };
    } catch (error) {
      const motionShadow = await this.persistMotionObservation(read.id, error?.motionObservation);
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
        motionShadow,
      };
    }
  }
}

export const blueIrisVehicleFrameInternals = Object.freeze({ derivedPath, detectionBox });
