import sharp from "sharp";

export const VEHICLE_MOTION_DIRECTION_ALGORITHM = "plate-anchored-motion-v1-shadow";

const MOTION_FRAME_WIDTH = 160;
const NIGHT_MONOCHROME_RATIO = 0.9;
const DAY_MONOCHROME_RATIO = 0.82;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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

function linearSlope(points, key) {
  const meanTime = points.reduce((sum, point) => sum + point.offsetMs, 0) / points.length;
  const meanValue = points.reduce((sum, point) => sum + point[key], 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const timeDelta = point.offsetMs - meanTime;
    numerator += timeDelta * (point[key] - meanValue);
    denominator += timeDelta ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
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

function summarizeTrajectory(points, { sampleCount, monochromeRatio } = {}) {
  const ordered = [...points]
    .filter((point) => [point.offsetMs, point.x, point.y].every(Number.isFinite))
    .sort((left, right) => left.offsetMs - right.offsetMs);
  const spanMs = ordered.length > 1 ? ordered.at(-1).offsetMs - ordered[0].offsetMs : 0;
  if (ordered.length < 3 || spanMs < 1_000) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      trackedCount: ordered.length,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "INSUFFICIENT_TRACK",
      diagnostics: { monochromeRatio },
    });
  }

  const slopeX = linearSlope(ordered, "x");
  const slopeY = linearSlope(ordered, "y");
  const deltaX = slopeX * spanMs;
  const deltaY = slopeY * spanMs;
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
  const origin = ordered[0];
  let residualSquared = 0;
  for (const point of ordered) {
    const elapsed = point.offsetMs - origin.offsetMs;
    const predictedX = origin.x + slopeX * elapsed;
    const predictedY = origin.y + slopeY * elapsed;
    residualSquared += (point.x - predictedX) ** 2 + (point.y - predictedY) ** 2;
  }
  const residual = Math.sqrt(residualSquared / ordered.length);
  const averageMatch = ordered.reduce(
    (sum, point) => sum + (Number.isFinite(point.matchConfidence) ? point.matchConfidence : 0.78),
    0
  ) / ordered.length;
  const sampleScore = clamp((ordered.length - 2) / 5, 0, 1);
  const spanScore = clamp(spanMs / 2_500, 0, 1);
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
    monochromeRatio,
    averageMatch: rounded(averageMatch, 4),
    trackedOffsetsMs: ordered.map((point) => point.offsetMs),
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

export function analyzeDayDetectionMotion({ track = [], sampleCount = track.length, monochromeRatio = null } = {}) {
  if (!track.some((candidate) => candidate?.detection?.containsPlate)) {
    return unknownObservation({
      captureMode: "day_color",
      sampleCount,
      tracker: "plate_anchored_vehicle_detection",
      errorCode: "PLATE_ANCHOR_NOT_DETECTED",
      diagnostics: { monochromeRatio },
    });
  }
  const points = track
    .filter((candidate) => (
      candidate?.detection
      && Number(candidate.continuityScore ?? 1) >= 0.28
      && (candidate.trackSimilarity == null || Number(candidate.trackSimilarity) >= 0.2)
    ))
    .map((candidate) => ({
      offsetMs: Number(candidate.offsetMs),
      x: (Number(candidate.detection.left) + Number(candidate.detection.right)) / 2,
      y: (Number(candidate.detection.top) + Number(candidate.detection.bottom)) / 2,
      matchConfidence: Number(candidate.continuityScore ?? 1),
    }));
  return summarizeTrajectory(points, { sampleCount, monochromeRatio });
}

export async function analyzeVehicleMotionDirection({
  frames = [],
  track = [],
  imageProcessor = sharp,
} = {}) {
  const anchorFrame = frames.find((frame) => frame.offsetMs === 0);
  if (!anchorFrame) {
    return unknownObservation({
      captureMode: "unknown",
      sampleCount: frames.length,
      errorCode: "ANCHOR_FRAME_UNAVAILABLE",
    });
  }
  try {
    const mode = await assessCaptureMode(anchorFrame, imageProcessor);
    if (mode.captureMode === "night_monochrome") {
      return unknownObservation({
        captureMode: "night_monochrome",
        sampleCount: frames.length,
        errorCode: "NIGHT_DIRECTION_DISABLED",
        diagnostics: { monochromeRatio: mode.monochromeRatio },
      });
    }
    if (mode.captureMode !== "day_color") {
      return unknownObservation({
        captureMode: "unknown",
        sampleCount: frames.length,
        errorCode: "CAPTURE_MODE_AMBIGUOUS",
        diagnostics: { monochromeRatio: mode.monochromeRatio },
      });
    }
    return analyzeDayDetectionMotion({
      track,
      sampleCount: frames.length,
      monochromeRatio: mode.monochromeRatio,
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
