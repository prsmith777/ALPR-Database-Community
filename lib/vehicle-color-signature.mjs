export const COLOR_SAMPLE_WIDTH = 16;
export const COLOR_SAMPLE_HEIGHT = 16;
export const COLOR_SIGNATURE_HEX_LENGTH = 40;
export const COLOR_SIGNATURE_VERSION = 2;

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


