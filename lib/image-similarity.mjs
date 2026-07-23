export const CAPTURE_ASSET_ALGORITHM = "vehicle_crop_dhash_v2";
export const DEFAULT_MAX_HAMMING_DISTANCE = 18;
export const MAX_SEARCH_CANDIDATES = 5000;
export const DEFAULT_CAMERA_CROP_PROFILE = Object.freeze({
  cropMode: "auto",
  contextPercent: 90,
  verticalOffsetPercent: 0,
  profileVersion: 1,
});

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

export function normalizeCameraCropProfile(profile = {}) {
  const cropMode = ["auto", "custom", "full_frame"].includes(profile.cropMode)
    ? profile.cropMode
    : DEFAULT_CAMERA_CROP_PROFILE.cropMode;
  const context = Number(profile.contextPercent);
  const verticalOffset = Number(profile.verticalOffsetPercent);
  const profileVersion = Number.parseInt(profile.profileVersion, 10);
  return {
    cropMode,
    contextPercent: Number.isFinite(context) ? clamp(Math.round(context), 40, 100) : 90,
    verticalOffsetPercent: Number.isFinite(verticalOffset)
      ? clamp(Math.round(verticalOffset), -25, 25)
      : 0,
    profileVersion: Number.isSafeInteger(profileVersion) && profileVersion > 0
      ? profileVersion
      : 1,
  };
}

export function calculateVehicleCrop({ width, height, cropCoordinates, profile }) {
  const imageWidth = normalizeDimension(width, "image width");
  const imageHeight = normalizeDimension(height, "image height");
  const normalizedProfile = normalizeCameraCropProfile(profile);
  const coordinates = Array.isArray(cropCoordinates)
    ? cropCoordinates.map(Number)
    : [];

  if (normalizedProfile.cropMode === "full_frame") {
    return {
      left: 0,
      top: 0,
      width: imageWidth,
      height: imageHeight,
      mode: "full_frame",
      contextPercent: 100,
      verticalOffsetPercent: 0,
      profileVersion: normalizedProfile.profileVersion,
    };
  }

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
      contextPercent: 100,
      verticalOffsetPercent: 0,
      profileVersion: normalizedProfile.profileVersion,
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
  const centerY = yMin + plateHeight / 2 + imageHeight * normalizedProfile.verticalOffsetPercent / 100;
  const plateRatio = plateWidth / imageWidth;
  const contextPercent = normalizedProfile.cropMode === "custom"
    ? normalizedProfile.contextPercent
    : plateRatio >= 0.08 ? 100 : plateRatio >= 0.04 ? 90 : 80;
  const cropWidth = Math.max(1, Math.round(imageWidth * contextPercent / 100));
  const cropHeight = Math.max(1, Math.round(imageHeight * contextPercent / 100));
  const left = Math.floor(clamp(centerX - cropWidth / 2, 0, imageWidth - cropWidth));
  const top = Math.floor(clamp(centerY - cropHeight / 2, 0, imageHeight - cropHeight));

  return {
    left,
    top,
    width: cropWidth,
    height: cropHeight,
    mode: normalizedProfile.cropMode === "custom" ? "custom_context" : "adaptive_context",
    contextPercent,
    verticalOffsetPercent: normalizedProfile.verticalOffsetPercent,
    profileVersion: normalizedProfile.profileVersion,
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
