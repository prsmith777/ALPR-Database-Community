import sharp from "sharp";

export const DIRECTION_MONOCHROME_CHANNEL_SPREAD = 8;
export const DIRECTION_MONOCHROME_PIXEL_RATIO = 0.9;

function imageBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  const encoded = String(value ?? "").replace(/^data:image\/[^;]+;base64,/i, "").trim();
  return encoded ? Buffer.from(encoded, "base64") : null;
}

export function assessDirectionPixels(rgbPixels, {
  channelSpread = DIRECTION_MONOCHROME_CHANNEL_SPREAD,
  monochromeThreshold = DIRECTION_MONOCHROME_PIXEL_RATIO,
} = {}) {
  if (!rgbPixels || rgbPixels.length === 0 || rgbPixels.length % 3 !== 0) {
    throw new Error("Direction lighting assessment requires interleaved RGB pixels");
  }
  let nearNeutralPixels = 0;
  const pixelCount = rgbPixels.length / 3;
  for (let offset = 0; offset < rgbPixels.length; offset += 3) {
    const red = Number(rgbPixels[offset]);
    const green = Number(rgbPixels[offset + 1]);
    const blue = Number(rgbPixels[offset + 2]);
    if (Math.max(red, green, blue) - Math.min(red, green, blue) <= channelSpread) {
      nearNeutralPixels += 1;
    }
  }
  const monochromeRatio = Number((nearNeutralPixels / pixelCount).toFixed(4));
  const monochrome = monochromeRatio >= monochromeThreshold;
  return {
    eligible: !monochrome,
    evaluated: true,
    monochrome,
    monochromeRatio,
    reason: monochrome ? "monochrome_night_capture" : null,
  };
}

export async function assessDirectionImageEligibility(value, {
  imageProcessor = sharp,
} = {}) {
  const source = imageBuffer(value);
  if (!source?.length) {
    return {
      eligible: true,
      evaluated: false,
      monochrome: false,
      monochromeRatio: null,
      reason: "image_unavailable",
    };
  }
  const pixels = await imageProcessor(source)
    .resize(48, 32, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
  return assessDirectionPixels(pixels);
}
