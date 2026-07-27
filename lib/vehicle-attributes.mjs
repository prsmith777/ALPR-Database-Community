import path from "node:path";

import sharp from "sharp";
import openvino from "openvino-node";

import {
  colorSignatureReliability,
  createColorSignature,
  isColorSignature,
} from "./image-similarity.mjs";

export const VEHICLE_COLOR_PROVIDER = "local-hsv-histogram";
export const VEHICLE_COLOR_MODEL = "vehicle-color-hsv-v2";
export const VEHICLE_TYPE_PROVIDER = "openvino-open-model-zoo";
export const VEHICLE_TYPE_MODEL = "vehicle-attributes-recognition-barrier-0039-fp16-v1";
export const VEHICLE_TYPE_LABELS = Object.freeze(["car", "bus", "truck", "van"]);
export const VEHICLE_TYPE_CONFIDENCE_THRESHOLD = 0.62;

const VEHICLE_ATTRIBUTE_SIZE = 72;
const { Core, Tensor } = openvino.addon;

const MONOCHROME_CHANNEL_SPREAD = 8;
const MONOCHROME_PIXEL_RATIO = 0.9;

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

export function assessVehicleColorPixels(rgbPixels) {
  if (!rgbPixels || rgbPixels.length === 0 || rgbPixels.length % 3 !== 0) {
    throw new Error("Vehicle color assessment requires interleaved RGB pixels");
  }
  let nearNeutralPixels = 0;
  const pixelCount = rgbPixels.length / 3;
  for (let offset = 0; offset < rgbPixels.length; offset += 3) {
    const red = Number(rgbPixels[offset]);
    const green = Number(rgbPixels[offset + 1]);
    const blue = Number(rgbPixels[offset + 2]);
    if (Math.max(red, green, blue) - Math.min(red, green, blue) <= MONOCHROME_CHANNEL_SPREAD) {
      nearNeutralPixels += 1;
    }
  }
  const monochromeRatio = Number((nearNeutralPixels / pixelCount).toFixed(4));
  const signature = createColorSignature(rgbPixels);
  if (monochromeRatio >= MONOCHROME_PIXEL_RATIO) {
    return {
      status: "unknown",
      value: null,
      confidence: null,
      reliability: 0,
      signature,
      reason: "monochrome_capture",
      monochromeRatio,
    };
  }
  return {
    ...inferVehicleColor(signature),
    reason: null,
    monochromeRatio,
  };
}

function modelPath(name) {
  const root = process.env.VEHICLE_REID_MODEL_DIR
    ? path.resolve(process.env.VEHICLE_REID_MODEL_DIR)
    : path.join(process.cwd(), "models", "visual-search");
  return path.join(root, name);
}

function interleavedRgbToPlanarBgr(rgb, width, height) {
  const pixels = width * height;
  const output = new Float32Array(pixels * 3);
  for (let index = 0; index < pixels; index += 1) {
    output[index] = rgb[index * 3 + 2];
    output[pixels + index] = rgb[index * 3 + 1];
    output[pixels * 2 + index] = rgb[index * 3];
  }
  return output;
}

export function inferVehicleType(scores, threshold = VEHICLE_TYPE_CONFIDENCE_THRESHOLD) {
  const values = Array.from(scores || [], Number);
  if (values.length !== VEHICLE_TYPE_LABELS.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Vehicle type output must contain four finite scores");
  }
  const bestConfidence = Math.max(...values);
  const bestIndex = values.indexOf(bestConfidence);
  const confidence = Number(bestConfidence.toFixed(4));
  const rawScores = Object.fromEntries(
    VEHICLE_TYPE_LABELS.map((label, index) => [label, Number(values[index].toFixed(4))])
  );
  if (confidence < threshold) {
    return { status: "unknown", value: null, confidence, scores: rawScores };
  }
  return {
    status: "ready",
    value: VEHICLE_TYPE_LABELS[bestIndex],
    confidence,
    scores: rawScores,
  };
}

export class VehicleTypeEngine {
  constructor({ imageProcessor = sharp, coreFactory = () => new Core() } = {}) {
    this.imageProcessor = imageProcessor;
    this.coreFactory = coreFactory;
    this.modelPromise = null;
  }

  async model() {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const core = this.coreFactory();
        return core.compileModel(
          modelPath("vehicle-attributes-recognition-barrier-0039.xml"),
          "CPU"
        );
      })().catch((error) => {
        this.modelPromise = null;
        throw error;
      });
    }
    return this.modelPromise;
  }

  async analyze(buffer) {
    const model = await this.model();
    const pixels = await this.imageProcessor(buffer)
      .resize(VEHICLE_ATTRIBUTE_SIZE, VEHICLE_ATTRIBUTE_SIZE, { fit: "fill" })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer();
    const input = interleavedRgbToPlanarBgr(
      pixels,
      VEHICLE_ATTRIBUTE_SIZE,
      VEHICLE_ATTRIBUTE_SIZE
    );
    const request = model.createInferRequest();
    const outputs = request.infer([
      new Tensor(
        "f32",
        [1, 3, VEHICLE_ATTRIBUTE_SIZE, VEHICLE_ATTRIBUTE_SIZE],
        input
      ),
    ]);
    const typeOutput = Object.entries(outputs)
      .find(([name, tensor]) => name === "type" || tensor?.data?.length === 4)?.[1];
    if (!typeOutput?.data) throw new Error("Vehicle type model output is unavailable");
    return inferVehicleType(typeOutput.data);
  }
}

export const vehicleTypeEngine = new VehicleTypeEngine();
