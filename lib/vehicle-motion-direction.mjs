import sharp from "sharp";

export const VEHICLE_MOTION_DIRECTION_ALGORITHM = "plate-anchored-motion-v3-dense-shadow";

const MOTION_FRAME_WIDTH = 160;
const NIGHT_MONOCHROME_RATIO = 0.9;
const DAY_MONOCHROME_RATIO = 0.82;
const MIN_TRACK_POINTS = 4;
const MIN_TRACK_SPAN_MS = 300;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rounded(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

export function classifyMotionCaptureMode(rgbPixels, { neutralSpread = 8 } = {}) {
  if (!rgbPixels?.length || rgbPixels.length % 3 !== 0) {
    return { captureMode: "unknown", monochromeRatio: null };
  }
  let neutral = 0;
  const pixelCount = rgbPixels.length / 3;
  for (let offset = 0; offset < rgbPixels.length; offset += 3) {
    const red = Number(rgbPixels[offset]);
    const green = Number(rgbPixels[offset + 1]);
    const blue = Number(rgbPixels[offset + 2]);
    if (Math.max(red, green, blue) - Math.min(red, green, blue) <= neutralSpread) neutral += 1;
  }
  const monochromeRatio = rounded(neutral / pixelCount, 4);
  return {
    captureMode: monochromeRatio >= NIGHT_MONOCHROME_RATIO
      ? "night_monochrome"
      : monochromeRatio <= DAY_MONOCHROME_RATIO
        ? "day_color"
        : "unknown",
    monochromeRatio,
  };
}

async function assessCaptureMode(frame, imageProcessor) {
  const rendered = await imageProcessor(frame.buffer)
    .resize({ width: MOTION_FRAME_WIDTH, withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = rendered.data;
  const channels = Number(rendered.info?.channels || 3);
  if (!pixels?.length || channels < 3) throw new Error("Motion frame pixels are unavailable");
  if (channels === 3) return classifyMotionCaptureMode(pixels);
  const rgb = Buffer.allocUnsafe((pixels.length / channels) * 3);
  for (let pixel = 0; pixel < pixels.length / channels; pixel += 1) {
    rgb[pixel * 3] = pixels[pixel * channels];
    rgb[pixel * 3 + 1] = pixels[pixel * channels + 1];
    rgb[pixel * 3 + 2] = pixels[pixel * channels + 2];
  }
  return classifyMotionCaptureMode(rgb);
}

function median(values) {
  const ordered = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[midpoint]
    : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

function robustLinearFit(points, key) {
  const slopes = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const elapsed = points[right].offsetMs - points[left].offsetMs;
      if (elapsed !== 0) slopes.push((points[right][key] - points[left][key]) / elapsed);
    }
  }
  const slope = median(slopes);
  const intercept = median(points.map((point) => point[key] - slope * point.offsetMs));
  return { slope, intercept };
}

function unknownObservation({
  captureMode,
  sampleCount,
  trackedCount = 0,
  tracker = "none",
  errorCode,
  confidence = null,
  vector = null,
  diagnostics = {},
}) {
  return {
    status: "unknown",
    captureMode,
    imageDirection: "unknown",
    confidence,
    sampleCount,
    trackedCount,
    tracker,
    errorCode,
    vector,
    diagnostics,
  };
}

function summarizeTrajectory(points, {
  sampleCount,
  monochromeRatio,
  anchorOffsetMs = null,
  anchorSource = null,
  anchorDistance = null,
  samplingDiagnostics = null,
} = {}) {
  const anchorDiagnostics = {
    monochromeRatio,
    anchorOffsetMs,
    anchorSource,
    anchorDistance,
    sampling: samplingDiagnostics,
  };
  const ordered = [...points]
    .filter((point) => [point.offsetMs, point.x, point.y].every(Number.isFinite))
    .sort((left, right) => left.offsetMs - right.offsetMs);
  const spanMs = ordered.length > 1 ? ordered.at(-1).offsetMs - ordered[0].offsetMs : 0;
  if (ordered.length < MIN_TRACK_POINTS || spanMs < MIN_TRACK_SPAN_MS) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      trackedCount: ordered.length,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "INSUFFICIENT_TRACK",
      diagnostics: anchorDiagnostics,
    });
  }

  const fitX = robustLinearFit(ordered, "x");
  const fitY = robustLinearFit(ordered, "y");
  const deltaX = fitX.slope * spanMs;
  const deltaY = fitY.slope * spanMs;
  const travel = Math.hypot(deltaX, deltaY);
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  const imageDirection = horizontal
    ? deltaX >= 0 ? "right" : "left"
    : deltaY >= 0 ? "down" : "up";
  const unitX = travel > 0 ? deltaX / travel : 0;
  const unitY = travel > 0 ? deltaY / travel : 0;
  let consistentSteps = 0;
  let opposedSteps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const stepX = ordered[index].x - ordered[index - 1].x;
    const stepY = ordered[index].y - ordered[index - 1].y;
    const projected = stepX * unitX + stepY * unitY;
    if (projected >= -0.002) consistentSteps += 1;
    else opposedSteps += 1;
  }
  const consistency = consistentSteps / Math.max(1, consistentSteps + opposedSteps);
  let residualSquared = 0;
  for (const point of ordered) {
    const predictedX = fitX.intercept + fitX.slope * point.offsetMs;
    const predictedY = fitY.intercept + fitY.slope * point.offsetMs;
    residualSquared += (point.x - predictedX) ** 2 + (point.y - predictedY) ** 2;
  }
  const residual = Math.sqrt(residualSquared / ordered.length);
  const averageMatch = ordered.reduce(
    (sum, point) => sum + (Number.isFinite(point.matchConfidence) ? point.matchConfidence : 0.78),
    0
  ) / ordered.length;
  const sampleScore = clamp((ordered.length - 3) / 7, 0, 1);
  const spanScore = clamp(spanMs / 1_000, 0, 1);
  const travelScore = clamp((travel - 0.035) / 0.125, 0, 1);
  const fitScore = clamp(1 - residual / 0.055, 0, 1);
  const confidence = rounded(
    sampleScore * 0.16
      + spanScore * 0.12
      + travelScore * 0.24
      + consistency * 0.22
      + fitScore * 0.16
      + clamp(averageMatch, 0, 1) * 0.1,
    4
  );
  const vector = {
    deltaX: rounded(deltaX),
    deltaY: rounded(deltaY),
    travel: rounded(travel),
    spanMs,
    dominantAxis: horizontal ? "horizontal" : "vertical",
    consistency: rounded(consistency, 4),
    residual: rounded(residual),
  };
  const diagnostics = {
    ...anchorDiagnostics,
    averageMatch: rounded(averageMatch, 4),
    trackedOffsetsMs: ordered.map((point) => point.offsetMs),
    edgeClippedCount: ordered.filter((point) => point.edgeClipped).length,
  };
  if (travel < 0.035) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      trackedCount: ordered.length,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "INSUFFICIENT_MOTION",
      vector,
      diagnostics,
    });
  }
  if (confidence < 0.64 || consistency < 0.72) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      trackedCount: ordered.length,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "LOW_MOTION_CONFIDENCE",
      confidence,
      vector,
      diagnostics,
    });
  }
  return {
    status: "ready",
    captureMode: "day_color",
    imageDirection,
    confidence,
    sampleCount,
    trackedCount: ordered.length,
    tracker: "plate_anchored_vehicle_detection",
    errorCode: null,
    vector,
    diagnostics,
  };
}

export function analyzeDayDetectionMotion({
  track = [],
  sampleCount = track.length,
  monochromeRatio = null,
  anchorOffsetMs = null,
  anchorSource = null,
  anchorDistance = null,
  samplingDiagnostics = null,
} = {}) {
  const anchorCandidate = track.find((candidate) => candidate?.motionAnchor === true)
    || track.find((candidate) => candidate?.detection?.containsPlate);
  if (!anchorCandidate) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "PLATE_ANCHOR_NOT_DETECTED",
      diagnostics: { monochromeRatio, anchorOffsetMs, anchorSource, anchorDistance, sampling: samplingDiagnostics },
    });
  }
  const points = track
    .filter((candidate) => (
      candidate?.detection
      && Number(candidate.continuityScore ?? 1) >= 0.28
    ))
    .map((candidate) => ({
      offsetMs: Number(candidate.offsetMs),
      x: (Number(candidate.detection.left) + Number(candidate.detection.right)) / 2,
      y: (Number(candidate.detection.top) + Number(candidate.detection.bottom)) / 2,
      matchConfidence: Number(candidate.continuityScore ?? 1),
      edgeClipped: [
        candidate.detection.left,
        candidate.detection.top,
        1 - candidate.detection.right,
        1 - candidate.detection.bottom,
      ].some((margin) => Number(margin) <= 0.01),
    }));
  return summarizeTrajectory(points, {
    sampleCount,
    monochromeRatio,
    anchorOffsetMs: optionalFiniteNumber(anchorOffsetMs)
      ?? optionalFiniteNumber(anchorCandidate.offsetMs),
    anchorSource: anchorSource
      || anchorCandidate.motionAnchorSource
      || "stored_plate_containment",
    anchorDistance: optionalFiniteNumber(anchorDistance)
      ?? optionalFiniteNumber(anchorCandidate.motionAnchorDistance),
    samplingDiagnostics,
  });
}

export async function analyzeVehicleMotionDirection({
  frames = [],
  track = [],
  anchorOffsetMs = null,
  anchorSource = null,
  anchorDistance = null,
  samplingDiagnostics = null,
  imageProcessor = sharp,
} = {}) {
  const requestedAnchorOffset = optionalFiniteNumber(anchorOffsetMs);
  const exactAnchorFrame = requestedAnchorOffset !== null
    ? frames.find((frame) => Number(frame.offsetMs) === requestedAnchorOffset)
    : null;
  const nearestAnchorFrame = [...frames]
    .filter((frame) => Number.isFinite(Number(frame.offsetMs)))
    .sort((left, right) => (
      Math.abs(Number(left.offsetMs)) - Math.abs(Number(right.offsetMs))
      || Number(left.offsetMs) - Number(right.offsetMs)
    ))[0] || null;
  const anchorFrame = exactAnchorFrame || nearestAnchorFrame;
  if (!anchorFrame) {
    return unknownObservation({
      captureMode: "unknown",
      sampleCount: frames.length,
      errorCode: "ANCHOR_FRAME_UNAVAILABLE",
      diagnostics: {
        requestedAnchorOffsetMs: requestedAnchorOffset,
        nearestFrameOffsetMs: nearestAnchorFrame ? Number(nearestAnchorFrame.offsetMs) : null,
        sampling: samplingDiagnostics,
      },
    });
  }
  try {
    const mode = await assessCaptureMode(anchorFrame, imageProcessor);
    if (mode.captureMode === "night_monochrome") {
      return unknownObservation({
        captureMode: "night_monochrome",
        sampleCount: frames.length,
        errorCode: "NIGHT_DIRECTION_DISABLED",
        diagnostics: {
          monochromeRatio: mode.monochromeRatio,
          anchorOffsetMs: Number(anchorFrame.offsetMs),
          anchorSource,
          anchorDistance,
          sampling: samplingDiagnostics,
        },
      });
    }
    if (mode.captureMode !== "day_color") {
      return unknownObservation({
        captureMode: "unknown",
        sampleCount: frames.length,
        errorCode: "CAPTURE_MODE_AMBIGUOUS",
        diagnostics: {
          monochromeRatio: mode.monochromeRatio,
          anchorOffsetMs: Number(anchorFrame.offsetMs),
          anchorSource,
          anchorDistance,
          sampling: samplingDiagnostics,
        },
      });
    }
    return analyzeDayDetectionMotion({
      track,
      sampleCount: frames.length,
      monochromeRatio: mode.monochromeRatio,
      anchorOffsetMs: Number(anchorFrame.offsetMs),
      anchorSource,
      anchorDistance,
      samplingDiagnostics,
    });
  } catch (error) {
    return {
      status: "failed",
      captureMode: "unknown",
      imageDirection: "unknown",
      confidence: null,
      sampleCount: frames.length,
      trackedCount: 0,
      tracker: "none",
      errorCode: "MOTION_ANALYSIS_FAILED",
      vector: null,
      diagnostics: { message: String(error?.message || error).slice(0, 300) },
    };
  }
}
