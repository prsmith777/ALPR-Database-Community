import { colorSignatureReliability, isColorSignature } from "./image-similarity.mjs";

export const VEHICLE_COLOR_PROVIDER = "local-hsv-histogram";
export const VEHICLE_COLOR_MODEL = "vehicle-color-hsv-v1";

function signatureBytes(signature) {
  if (!isColorSignature(signature)) throw new Error("Invalid vehicle color signature");
  return Array.from({ length: 20 }, (_, index) => Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16));
}

function dominant(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const maximum = Math.max(...values);
  return { index: values.indexOf(maximum), share: total ? maximum / total : 0 };
}

const HUE_LABELS = Object.freeze([
  "red", "orange", "yellow", "yellow", "green", "green",
  "blue", "blue", "blue", "purple", "purple", "red",
]);

export function inferVehicleColor(signature) {
  const bytes = signatureBytes(signature);
  const hue = bytes.slice(0, 12);
  const saturation = bytes.slice(12, 16);
  const value = bytes.slice(16, 20);
  const reliability = colorSignatureReliability(signature);
  const dominantSaturation = dominant(saturation);
  const dominantValue = dominant(value);
  const dominantHue = dominant(hue);

  let color;
  let confidence;
  if (reliability < 0.18 || dominantSaturation.index === 0) {
    color = dominantValue.index === 0 ? "black" : dominantValue.index === 3 ? "white" : "gray";
    confidence = 0.45 + dominantSaturation.share * dominantValue.share * 0.5;
  } else {
    color = HUE_LABELS[dominantHue.index];
    const darkShare = value[0] / Math.max(1, value.reduce((sum, entry) => sum + entry, 0));
    if ((color === "orange" || color === "yellow") && darkShare >= 0.3) color = "brown";
    confidence = 0.45 + dominantHue.share * 0.35 + reliability * 0.2;
  }
  confidence = Number(Math.min(0.99, Math.max(0, confidence)).toFixed(4));
  if (confidence < 0.58) {
    return { status: "unknown", value: null, confidence, reliability, signature };
  }
  return { status: "ready", value: color, confidence, reliability, signature };
}
