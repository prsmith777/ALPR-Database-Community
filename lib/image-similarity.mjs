export const CAPTURE_ASSET_ALGORITHM = "vehicle_reid_0001_v1";
export const DEFAULT_MAX_HAMMING_DISTANCE = 14;
export const MAX_SEARCH_CANDIDATES = 5000;
export const COLOR_SAMPLE_WIDTH = 16;
export const COLOR_SAMPLE_HEIGHT = 16;
export const COLOR_SIGNATURE_HEX_LENGTH = 40;
export const COLOR_SIGNATURE_VERSION = 2;
export const MAX_VISUAL_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_VISUAL_UPLOAD_PIXELS = 40_000_000;
export const ALLOWED_VISUAL_UPLOAD_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const DEFAULT_CAMERA_CROP_PROFILE = Object.freeze({
  cropMode: "full_frame",
  contextPercent: 100,
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
    contextPercent: Number.isFinite(context)
      ? clamp(Math.round(context), 40, 100)
      : DEFAULT_CAMERA_CROP_PROFILE.contextPercent,
    verticalOffsetPercent: Number.isFinite(verticalOffset)
      ? clamp(Math.round(verticalOffset), -25, 25)
      : DEFAULT_CAMERA_CROP_PROFILE.verticalOffsetPercent,
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

function quantizeHistogram(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => total > 0 ? Math.round(value / total * 255) : 0);
}

function rgbToHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === r) hue = ((g - b) / delta) % 6;
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  return {
    hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

export function createColorSignature(rgbPixels) {
  const expectedLength = COLOR_SAMPLE_WIDTH * COLOR_SAMPLE_HEIGHT * 3;
  if (!rgbPixels || rgbPixels.length !== expectedLength) {
    throw new Error("Color signature requires an exact 16 by 16 RGB pixel buffer");
  }
  const hue = Array(12).fill(0);
  const saturation = Array(4).fill(0);
  const value = Array(4).fill(0);
  for (let offset = 0; offset < rgbPixels.length; offset += 3) {
    const pixel = offset / 3;
    const x = pixel % COLOR_SAMPLE_WIDTH;
    const y = Math.floor(pixel / COLOR_SAMPLE_WIDTH);
    const normalizedX = (x + 0.5) / COLOR_SAMPLE_WIDTH;
    const normalizedY = (y + 0.5) / COLOR_SAMPLE_HEIGHT;
    const centerDistance = Math.sqrt(
      ((normalizedX - 0.5) / 0.56) ** 2 + ((normalizedY - 0.46) / 0.52) ** 2
    );
    const vehicleWeight = Math.max(0.12, 1 - centerDistance * 0.72);
    const hsv = rgbToHsv(rgbPixels[offset], rgbPixels[offset + 1], rgbPixels[offset + 2]);
    const hueBin = Math.min(11, Math.floor(hsv.hue / 30));
    const saturationBin = Math.min(3, Math.floor(hsv.saturation * 4));
    const valueBin = Math.min(3, Math.floor(hsv.value * 4));
    // Hue is undefined for gray pixels. The previous fixed contribution made
    // white, gray, and black scenery look artificially red because hue zero
    // falls in the red bin. Only credible chroma now contributes to hue.
    if (hsv.saturation >= 0.16 && hsv.value >= 0.08) {
      hue[hueBin] += vehicleWeight * hsv.saturation ** 1.5;
    }
    saturation[saturationBin] += vehicleWeight;
    value[valueBin] += vehicleWeight;
  }
  return [...quantizeHistogram(hue), ...quantizeHistogram(saturation), ...quantizeHistogram(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isColorSignature(signature) {
  return new RegExp(`^[0-9a-f]{${COLOR_SIGNATURE_HEX_LENGTH}}$`, "i").test(signature || "");
}

function signatureBytes(signature) {
  if (!isColorSignature(signature)) {
    throw new Error("Invalid color signature");
  }
  return Array.from({ length: COLOR_SIGNATURE_HEX_LENGTH / 2 }, (_, index) =>
    Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16)
  );
}

function histogramDistance(left, right, start, length) {
  let difference = 0;
  for (let index = start; index < start + length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return Math.min(1, difference / 510);
}

export function colorSignatureDistance(leftSignature, rightSignature) {
  const left = signatureBytes(leftSignature);
  const right = signatureBytes(rightSignature);
  const hueDistance = histogramDistance(left, right, 0, 12);
  const saturationDistance = histogramDistance(left, right, 12, 4);
  const valueDistance = histogramDistance(left, right, 16, 4);
  return Number((hueDistance * 0.5 + saturationDistance * 0.35 + valueDistance * 0.15).toFixed(4));
}

export function colorSignatureReliability(signature) {
  const bytes = signatureBytes(signature);
  const saturation = bytes.slice(12, 16);
  const total = saturation.reduce((sum, value) => sum + value, 0);
  if (!total) return 0;
  return Number(((saturation[1] * 0.25 + saturation[2] * 0.7 + saturation[3]) / total).toFixed(4));
}

export function explainSimilarity({
  sourceSha256,
  candidateSha256,
  distance,
  colorDistance = null,
  colorReliability = null,
}) {
  const exact = Boolean(sourceSha256 && sourceSha256 === candidateSha256);
  const normalizedDistance = clamp(Number(distance), 0, 64);
  const structuralScore = Number(((1 - normalizedDistance / 64) * 100).toFixed(1));
  const normalizedColorDistance = colorDistance !== null && colorDistance !== undefined && Number.isFinite(Number(colorDistance))
    ? clamp(Number(colorDistance), 0, 1)
    : null;
  const colorScore = normalizedColorDistance === null
    ? null
    : Number(((1 - normalizedColorDistance) * 100).toFixed(1));
  const normalizedColorReliability = colorScore === null
    ? null
    : clamp(Number(colorReliability) || 0, 0, 1);
  const reliableColor = normalizedColorReliability !== null && normalizedColorReliability >= 0.18;
  const score = exact
    ? 100
    : colorScore === null
      ? structuralScore
      : reliableColor
        ? Number((structuralScore * 0.55 + colorScore * 0.45).toFixed(1))
        : Number((structuralScore * 0.85 + colorScore * 0.15).toFixed(1));
  return {
    exact,
    distance: normalizedDistance,
    colorDistance: normalizedColorDistance,
    colorReliability: normalizedColorReliability,
    structuralScore,
    colorScore,
    score,
    signalCount: colorScore === null ? 1 : 2,
    rankingVersion: colorScore === null
        ? "structure-v1"
        : "vehicle-focus-v2",
    label: exact
      ? "Exact duplicate"
      : reliableColor && colorScore >= 82 && score >= 90 && normalizedDistance <= 6
        ? "Very strong visual match"
        : reliableColor && colorScore >= 72 && score >= 82 && normalizedDistance <= 10
          ? "Strong visual match"
          : colorScore === null && normalizedDistance <= 5
            ? "Near-identical structure"
            : "Visual candidate",
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

export function decodeVisualUploadDataUrl(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_VISUAL_UPLOAD_BYTES * 4 / 3) + 128) {
    const error = new Error("Upload must be a JPEG, PNG, or WebP image no larger than 5 MB");
    error.code = "UPLOAD_TOO_LARGE";
    throw error;
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || !ALLOWED_VISUAL_UPLOAD_TYPES.includes(match[1].toLowerCase())) {
    const error = new Error("Upload must be a JPEG, PNG, or WebP image");
    error.code = "INVALID_VISUAL_UPLOAD";
    throw error;
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_VISUAL_UPLOAD_BYTES) {
    const error = new Error("Upload must be a JPEG, PNG, or WebP image no larger than 5 MB");
    error.code = "UPLOAD_TOO_LARGE";
    throw error;
  }
  return { buffer, mimeType: match[1].toLowerCase() };
}
