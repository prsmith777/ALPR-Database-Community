import path from "node:path";

import sharp from "sharp";
import openvino from "openvino-node";

export const VEHICLE_REID_MODEL = "vehicle-reid-0001-ir-fp16-v1";
export const VEHICLE_DETECTOR_MODEL = "vehicle-detection-0202-fp16-v1";
export const VEHICLE_EMBEDDING_LENGTH = 512;
export const VEHICLE_EMBEDDING_BYTES = VEHICLE_EMBEDDING_LENGTH * Float32Array.BYTES_PER_ELEMENT;
export const VEHICLE_DETECTION_THRESHOLD = 0.4;

const DETECTOR_SIZE = 512;
const REID_SIZE = 208;
const { Core, Tensor } = openvino.addon;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedBox(box) {
  if (!box) return null;
  const left = Number(box.left ?? box.xMin ?? box[0]);
  const top = Number(box.top ?? box.yMin ?? box[1]);
  const width = Number(box.width ?? ((box.xMax ?? box[2]) - left));
  const height = Number(box.height ?? ((box.yMax ?? box[3]) - top));
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

export function selectVehicleDetection(detections, { imageWidth, imageHeight, plateBox = null } = {}) {
  const width = Number(imageWidth);
  const height = Number(imageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const plate = normalizedBox(plateBox);
  const plateCenter = plate
    ? { x: (plate.left + plate.width / 2) / width, y: (plate.top + plate.height / 2) / height }
    : null;

  const candidates = (detections || [])
    .filter((detection) => Number(detection.confidence) >= VEHICLE_DETECTION_THRESHOLD)
    .map((detection) => {
      const left = clamp(Number(detection.left), 0, 1);
      const top = clamp(Number(detection.top), 0, 1);
      const right = clamp(Number(detection.right), left, 1);
      const bottom = clamp(Number(detection.bottom), top, 1);
      const area = Math.max(0, (right - left) * (bottom - top));
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const containsPlate = Boolean(plateCenter
        && plateCenter.x >= left && plateCenter.x <= right
        && plateCenter.y >= top && plateCenter.y <= bottom);
      const centerDistance = Math.hypot(centerX - 0.5, centerY - 0.5) / Math.SQRT1_2;
      const score = (containsPlate ? 10 : 0)
        + Number(detection.confidence) * 0.65
        + Math.sqrt(area) * 0.3
        + (1 - clamp(centerDistance, 0, 1)) * 0.05;
      return { ...detection, left, top, right, bottom, area, containsPlate, selectionScore: score };
    })
    .filter((detection) => detection.area > 0.0025)
    .sort((left, right) => right.selectionScore - left.selectionScore);

  return candidates[0] || null;
}

export function normalizeEmbedding(values) {
  if (!values || values.length !== VEHICLE_EMBEDDING_LENGTH) {
    throw new Error(`Vehicle embedding must contain ${VEHICLE_EMBEDDING_LENGTH} values`);
  }
  let magnitudeSquared = 0;
  for (const value of values) magnitudeSquared += Number(value) ** 2;
  const magnitude = Math.sqrt(magnitudeSquared);
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) {
    throw new Error("Vehicle embedding has zero magnitude");
  }
  return Float32Array.from(values, (value) => Number(value) / magnitude);
}

export function encodeVehicleEmbedding(values) {
  const normalized = normalizeEmbedding(values);
  const buffer = Buffer.allocUnsafe(VEHICLE_EMBEDDING_BYTES);
  normalized.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function decodeVehicleEmbedding(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
  if (!buffer || buffer.length !== VEHICLE_EMBEDDING_BYTES) return null;
  const embedding = new Float32Array(VEHICLE_EMBEDDING_LENGTH);
  for (let index = 0; index < VEHICLE_EMBEDDING_LENGTH; index += 1) {
    embedding[index] = buffer.readFloatLE(index * 4);
  }
  return embedding;
}

export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue ** 2;
    rightMagnitude += rightValue ** 2;
  }
  const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
  return denominator > Number.EPSILON ? clamp(dot / denominator, -1, 1) : null;
}

export function explainVehicleSimilarity({ sourceSha256, candidateSha256, similarity }) {
  const exact = Boolean(sourceSha256 && sourceSha256 === candidateSha256);
  const normalizedSimilarity = Number.isFinite(Number(similarity))
    ? clamp(Number(similarity), -1, 1)
    : null;
  return {
    exact,
    plateConfirmed: false,
    similarity: normalizedSimilarity === null ? null : Number(normalizedSimilarity.toFixed(4)),
    score: exact ? 100 : Number((Math.max(0, normalizedSimilarity || 0) * 100).toFixed(1)),
    rankingVersion: VEHICLE_REID_MODEL,
    label: exact ? "Exact duplicate" : "Vehicle ReID candidate",
  };
}

function interleavedToPlanar(rgb, width, height, channelOrder) {
  const pixels = width * height;
  const output = new Float32Array(pixels * 3);
  const offsets = channelOrder === "bgr" ? [2, 1, 0] : [0, 1, 2];
  for (let index = 0; index < pixels; index += 1) {
    output[index] = rgb[index * 3 + offsets[0]];
    output[pixels + index] = rgb[index * 3 + offsets[1]];
    output[pixels * 2 + index] = rgb[index * 3 + offsets[2]];
  }
  return output;
}

async function imageTensor(buffer, size, channelOrder) {
  const pixels = await sharp(buffer)
    .resize(size, size, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
  return interleavedToPlanar(pixels, size, size, channelOrder);
}

function modelPath(name) {
  const root = process.env.VEHICLE_REID_MODEL_DIR
    ? path.resolve(process.env.VEHICLE_REID_MODEL_DIR)
    : path.join(process.cwd(), "models", "visual-search");
  return path.join(root, name);
}

function paddedPixelCrop(detection, width, height) {
  const horizontalPadding = (detection.right - detection.left) * 0.04;
  const verticalPadding = (detection.bottom - detection.top) * 0.04;
  const left = Math.floor(clamp(detection.left - horizontalPadding, 0, 1) * width);
  const top = Math.floor(clamp(detection.top - verticalPadding, 0, 1) * height);
  const right = Math.ceil(clamp(detection.right + horizontalPadding, 0, 1) * width);
  const bottom = Math.ceil(clamp(detection.bottom + verticalPadding, 0, 1) * height);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    mode: "vehicle_detector",
    detectionConfidence: Number(Number(detection.confidence).toFixed(4)),
    containsPlateAnchor: Boolean(detection.containsPlate),
  };
}

export class VehicleReidEngine {
  constructor({ imageProcessor = sharp, coreFactory = () => new Core() } = {}) {
    this.imageProcessor = imageProcessor;
    this.coreFactory = coreFactory;
    this.modelsPromise = null;
  }

  async models() {
    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        const core = this.coreFactory();
        const [detector, reid] = await Promise.all([
          core.compileModel(modelPath("vehicle-detection-0202.xml"), "CPU"),
          core.compileModel(modelPath("vehicle-reid-0001.xml"), "CPU"),
        ]);
        return { detector, reid };
      })().catch((error) => {
        this.modelsPromise = null;
        throw error;
      });
    }
    return this.modelsPromise;
  }

  async detect(buffer, dimensions) {
    const { detector } = await this.models();
    const input = await imageTensor(buffer, DETECTOR_SIZE, "bgr");
    const request = detector.createInferRequest();
    const outputs = request.infer([new Tensor("f32", [1, 3, DETECTOR_SIZE, DETECTOR_SIZE], input)]);
    const values = Object.values(outputs)[0]?.data;
    const detections = [];
    for (let offset = 0; values && offset + 6 < values.length; offset += 7) {
      if (Number(values[offset]) < 0) break;
      detections.push({
        label: Number(values[offset + 1]),
        confidence: Number(values[offset + 2]),
        left: Number(values[offset + 3]),
        top: Number(values[offset + 4]),
        right: Number(values[offset + 5]),
        bottom: Number(values[offset + 6]),
      });
    }
    return selectVehicleDetection(detections, dimensions);
  }

  async embed(buffer) {
    const { reid } = await this.models();
    const input = await imageTensor(buffer, REID_SIZE, "rgb");
    const request = reid.createInferRequest();
    const outputs = request.infer([new Tensor("f32", [1, 3, REID_SIZE, REID_SIZE], input)]);
    const values = Object.values(outputs)[0]?.data;
    return normalizeEmbedding(values);
  }

  async analyze(buffer, { plateBox = null, fallbackCrop = null } = {}) {
    const oriented = await this.imageProcessor(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    const metadata = await this.imageProcessor(oriented).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
    const detection = await this.detect(oriented, {
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      plateBox,
    });
    const fallback = normalizedBox(fallbackCrop) || {
      left: 0,
      top: 0,
      width: metadata.width,
      height: metadata.height,
    };
    const crop = detection
      ? paddedPixelCrop(detection, metadata.width, metadata.height)
      : {
        left: Math.floor(clamp(fallback.left, 0, metadata.width - 1)),
        top: Math.floor(clamp(fallback.top, 0, metadata.height - 1)),
        width: Math.floor(clamp(fallback.width, 1, metadata.width)),
        height: Math.floor(clamp(fallback.height, 1, metadata.height)),
        mode: `${fallbackCrop?.mode || "full_frame"}_detector_fallback`,
        detectionConfidence: null,
        containsPlateAnchor: false,
      };
    crop.width = Math.min(crop.width, metadata.width - crop.left);
    crop.height = Math.min(crop.height, metadata.height - crop.top);
    const cropBuffer = await this.imageProcessor(oriented)
      .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
      .jpeg({ quality: 86 })
      .toBuffer();
    return {
      crop,
      cropBuffer,
      embedding: await this.embed(cropBuffer),
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      detectorModel: VEHICLE_DETECTOR_MODEL,
      embeddingModel: VEHICLE_REID_MODEL,
    };
  }
}

export const vehicleReidEngine = new VehicleReidEngine();
