export const CAPTURE_ASSET_ALGORITHM = "vehicle_crop_dhash_v1";
export const DEFAULT_MAX_HAMMING_DISTANCE = 18;
export const MAX_SEARCH_CANDIDATES = 5000;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeDimension(value, name) {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return Math.floor(dimension);
}

export function calculateVehicleCrop({ width, height, cropCoordinates }) {
  const imageWidth = normalizeDimension(width, "image width");
  const imageHeight = normalizeDimension(height, "image height");
  const coordinates = Array.isArray(cropCoordinates)
    ? cropCoordinates.map(Number)
    : [];

  if (
    coordinates.length !== 4 ||
    coordinates.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    return {
      left: 0,
      top: 0,
      width: imageWidth,
      height: imageHeight,
      mode: "full_frame_fallback",
    };
  }

  const [rawXMin, rawYMin, rawXMax, rawYMax] = coordinates;
  const xMin = clamp(Math.min(rawXMin, rawXMax), 0, imageWidth - 1);
  const xMax = clamp(Math.max(rawXMin, rawXMax), xMin + 1, imageWidth);
  const yMin = clamp(Math.min(rawYMin, rawYMax), 0, imageHeight - 1);
  const yMax = clamp(Math.max(rawYMin, rawYMax), yMin + 1, imageHeight);
  const plateWidth = xMax - xMin;
  const plateHeight = yMax - yMin;
  const centerX = xMin + plateWidth / 2;
  const centerY = yMin + plateHeight / 2;

  // ALPR provides a plate box rather than a vehicle box. This deliberately
  // generous deterministic expansion is a safe first-pass vehicle region.
  const horizontalPadding = Math.max(plateWidth * 3, imageWidth * 0.15);
  const topPadding = Math.max(plateHeight * 5, imageHeight * 0.25);
  const bottomPadding = Math.max(plateHeight * 2, imageHeight * 0.12);
  const left = Math.floor(clamp(centerX - plateWidth / 2 - horizontalPadding, 0, imageWidth - 1));
  const right = Math.ceil(clamp(centerX + plateWidth / 2 + horizontalPadding, left + 1, imageWidth));
  const top = Math.floor(clamp(centerY - plateHeight / 2 - topPadding, 0, imageHeight - 1));
  const bottom = Math.ceil(clamp(centerY + plateHeight / 2 + bottomPadding, top + 1, imageHeight));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    mode: "plate_expand_v1",
  };
}

export function createDHash(grayscalePixels) {
  if (!grayscalePixels || grayscalePixels.length !== 72) {
    throw new Error("dHash requires an exact 9 by 8 grayscale pixel buffer");
  }

  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits <<= 1n;
      const offset = row * 9 + column;
      if (grayscalePixels[offset] > grayscalePixels[offset + 1]) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(leftHash, rightHash) {
  if (!/^[0-9a-f]{16}$/i.test(leftHash || "") || !/^[0-9a-f]{16}$/i.test(rightHash || "")) {
    throw new Error("Invalid perceptual hash");
  }
  let difference = BigInt(`0x${leftHash}`) ^ BigInt(`0x${rightHash}`);
  let distance = 0;
  while (difference) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

export function explainSimilarity({ sourceSha256, candidateSha256, distance }) {
  const exact = Boolean(sourceSha256 && sourceSha256 === candidateSha256);
  const normalizedDistance = clamp(Number(distance), 0, 64);
  const score = Number(((1 - normalizedDistance / 64) * 100).toFixed(1));
  return {
    exact,
    distance: normalizedDistance,
    score,
    label: exact
      ? "Exact duplicate"
      : normalizedDistance <= 6
        ? "Near-identical crop"
        : "Similar vehicle region",
  };
}

export function normalizeSearchLimit(value, fallback = 24) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 1, 100);
}

export function normalizeBatchSize(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 1, 50);
}
