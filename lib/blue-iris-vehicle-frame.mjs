import path from "node:path";

import sharp from "sharp";

import { BlueIrisError } from "./blue-iris.mjs";
import {
  cosineSimilarity,
  vehicleReidEngine,
} from "./vehicle-reid.mjs";

export const VEHICLE_FRAME_SELECTION_ALGORITHM = "blue-iris-vehicle-frame-v4-guarded";

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

function softTrackCandidates(candidates, anchor) {
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
  }

  async analyzeOffsets({ camera, baseMs, offsets, plateBox = null, primarySample = false }) {
    const candidates = [];
    const failures = [];
    for (const offsetMs of offsets) {
      try {
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
        const dimensions = {
          imageWidth: metadata.width,
          imageHeight: metadata.height,
          plateBox: offsetMs === 0 ? plateBox : null,
        };
        const detections = typeof this.detector.detectAll === "function"
          ? await this.detector.detectAll(oriented, dimensions)
          : [await this.detector.detect(oriented, dimensions)].filter(Boolean);
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
    return { candidates, failures };
  }

  async selectBestFrame({ camera, timestamp, plateBox = null }) {
    const baseMs = new Date(timestamp).getTime();
    if (!Number.isFinite(baseMs)) throw new Error("A valid plate-read timestamp is required.");
    const primary = await this.analyzeOffsets({
      camera,
      baseMs,
      offsets: this.sampleOffsetsMs,
      plateBox,
      primarySample: true,
    });
    let candidates = primary.candidates;
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
      });
      candidates = [...candidates, ...extension.candidates];
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
      });
      candidates = [...candidates, ...deepExtension.candidates];
      failures = [...failures, ...deepExtension.failures];
      selection = selectBestTrackedVehicleFrame(candidates);
    }

    const sampledCount = this.sampleOffsetsMs.length
      + (shouldExtend ? this.extensionOffsetsMs.length : 0)
      + (shouldDeepExtend ? this.deepExtensionOffsetsMs.length : 0);

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
      };
    }
    const unavailable = failures.length === sampledCount
      && failures.every((error) => error?.code === "RECORDING_UNAVAILABLE");
    if (unavailable) {
      throw new BlueIrisError(
        "RECORDING_UNAVAILABLE",
        "Blue Iris no longer has viewable recording data around this plate read."
      );
    }
    if (failures.length === sampledCount) throw failures[0];
    throw new BlueIrisError(
      "VEHICLE_NOT_VISIBLE",
      "No complete vehicle was detected in the bounded Blue Iris sample window."
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
      await this.fileStorage.saveDerivedImage(framePath, selected.best.buffer);
      const previousPath = read.vehicle_image_path;
      try {
        await this.repository.markReady(read.id, {
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
}

export const blueIrisVehicleFrameInternals = Object.freeze({ derivedPath, detectionBox });
