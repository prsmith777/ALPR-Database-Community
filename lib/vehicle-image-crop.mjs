import crypto from "node:crypto";
import fs from "node:fs/promises";

import sharp from "sharp";

export const VEHICLE_IMAGE_CROP_KIND = "vehicle_crop";
export const VEHICLE_IMAGE_CROP_ALGORITHM = "canonical-overview-detection-box-v1";
export const VEHICLE_IMAGE_CROP_DETECTOR = "blue-iris-overview-selected-vehicle-box";
export const VEHICLE_IMAGE_CROP_PADDING_RATIO = 0.04;
export const VEHICLE_IMAGE_CROP_JPEG_QUALITY = 86;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeOverviewDetectionBox(value) {
  const source = Array.isArray(value)
    ? { left: value[0], top: value[1], right: value[2], bottom: value[3] }
    : value;
  const box = {
    left: Number(source?.left),
    top: Number(source?.top),
    right: Number(source?.right),
    bottom: Number(source?.bottom),
  };
  if (
    !Object.values(box).every(Number.isFinite)
    || box.left < 0 || box.top < 0
    || box.right > 1 || box.bottom > 1
    || box.right <= box.left || box.bottom <= box.top
  ) {
    throw codedError(
      "VEHICLE_IMAGE_CROP_INVALID_BOX",
      "The canonical Overview asset has no valid selected-vehicle box."
    );
  }
  return box;
}

export function paddedVehicleCropBox(
  detectionBox,
  imageWidth,
  imageHeight,
  { paddingRatio = VEHICLE_IMAGE_CROP_PADDING_RATIO } = {}
) {
  const box = normalizeOverviewDetectionBox(detectionBox);
  const width = Number(imageWidth);
  const height = Number(imageHeight);
  const padding = Number(paddingRatio);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw codedError(
      "VEHICLE_IMAGE_CROP_INVALID_SOURCE",
      "The canonical Overview dimensions are invalid."
    );
  }
  if (!Number.isFinite(padding) || padding < 0 || padding > 0.5) {
    throw codedError("VEHICLE_IMAGE_CROP_INVALID_BOX", "Vehicle crop padding is invalid.");
  }
  const boxWidth = box.right - box.left;
  const boxHeight = box.bottom - box.top;
  const left = Math.floor(clamp(box.left - boxWidth * padding, 0, 1) * width);
  const top = Math.floor(clamp(box.top - boxHeight * padding, 0, 1) * height);
  const right = Math.ceil(clamp(box.right + boxWidth * padding, 0, 1) * width);
  const bottom = Math.ceil(clamp(box.bottom + boxHeight * padding, 0, 1) * height);
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, right - left)),
    height: Math.max(1, Math.min(height - top, bottom - top)),
    paddingRatio: padding,
  };
}

export function canonicalVehicleCropPath(contentSha256) {
  const hash = String(contentSha256 || "").trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw codedError("VEHICLE_IMAGE_CROP_INVALID_HASH", "Vehicle crop hash is invalid.");
  }
  return `derived/vehicle-crops/${hash.slice(0, 2)}/${hash}.jpg`;
}

function sameCropBox(left, right) {
  return ["left", "top", "width", "height"].every(
    (key) => Number(left?.[key]) === Number(right?.[key])
  ) && Number(left?.paddingRatio) === Number(right?.paddingRatio);
}

export class VehicleImageCropService {
  constructor({ repository, fileStorage, imageProcessor = sharp, readFile = fs.readFile } = {}) {
    if (!repository || !fileStorage || typeof imageProcessor !== "function") {
      throw new Error("Canonical Overview crop dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.imageProcessor = imageProcessor;
    this.readFile = readFile;
  }

  async render(job) {
    let fullPath;
    try {
      fullPath = await this.fileStorage.resolveExistingImagePath(job.source_path);
    } catch (error) {
      throw codedError(
        "VEHICLE_IMAGE_CROP_SOURCE_MISSING",
        `Canonical Overview source is unavailable: ${String(error?.code || "missing")}`
      );
    }
    let source;
    try {
      source = await this.readFile(fullPath);
    } catch (error) {
      throw codedError(
        "VEHICLE_IMAGE_CROP_SOURCE_MISSING",
        `Canonical Overview source cannot be read: ${String(error?.code || "missing")}`
      );
    }
    if (!source?.length || sha256(source) !== String(job.source_sha256)) {
      throw codedError(
        "VEHICLE_IMAGE_CROP_SOURCE_CHANGED",
        "Canonical Overview bytes no longer match the immutable asset identity."
      );
    }
    let metadata;
    try {
      metadata = await this.imageProcessor(source).metadata();
    } catch {
      throw codedError("VEHICLE_IMAGE_CROP_INVALID_SOURCE", "Canonical Overview JPEG is invalid.");
    }
    if (
      Number(metadata?.width) !== Number(job.source_width)
      || Number(metadata?.height) !== Number(job.source_height)
      || !["jpeg", "jpg"].includes(String(metadata?.format || "").toLowerCase())
    ) {
      throw codedError(
        "VEHICLE_IMAGE_CROP_SOURCE_CHANGED",
        "Canonical Overview dimensions or media type changed after preview."
      );
    }
    const cropBox = paddedVehicleCropBox(
      job.detection_box,
      Number(job.source_width),
      Number(job.source_height)
    );
    let cropBuffer;
    try {
      cropBuffer = await this.imageProcessor(source)
        .extract({
          left: cropBox.left,
          top: cropBox.top,
          width: cropBox.width,
          height: cropBox.height,
        })
        .jpeg({ quality: VEHICLE_IMAGE_CROP_JPEG_QUALITY })
        .toBuffer();
    } catch {
      throw codedError("VEHICLE_IMAGE_CROP_INVALID_BOX", "Vehicle crop could not be rendered.");
    }
    const contentSha256 = sha256(cropBuffer);
    return {
      cropBuffer,
      contentSha256,
      storagePath: canonicalVehicleCropPath(contentSha256),
      byteSize: cropBuffer.length,
      imageWidth: cropBox.width,
      imageHeight: cropBox.height,
      cropBox,
      detectorModel: VEHICLE_IMAGE_CROP_DETECTOR,
      detectionConfidence: job.detection_confidence == null
        ? null
        : Number(job.detection_confidence),
    };
  }

  async preview(job) {
    const rendered = await this.render(job);
    const { cropBuffer: _cropBuffer, ...preview } = rendered;
    return preview;
  }

  async catalog(job) {
    const rendered = await this.render(job);
    if (
      rendered.contentSha256 !== job.preview_sha256
      || rendered.storagePath !== job.preview_path
      || Number(rendered.byteSize) !== Number(job.preview_byte_size)
      || Number(rendered.imageWidth) !== Number(job.preview_width)
      || Number(rendered.imageHeight) !== Number(job.preview_height)
      || !sameCropBox(rendered.cropBox, job.preview_crop_box)
    ) {
      throw codedError(
        "VEHICLE_IMAGE_CROP_PREVIEW_CHANGED",
        "Vehicle crop output changed after the confirmed preview."
      );
    }
    return this.repository.withStorageWriter(async (repository) => {
      const publication = await this.fileStorage.saveDerivedImageIfAbsent(
        rendered.storagePath,
        rendered.cropBuffer
      );
      const registration = await repository.registerDerivative(job, rendered);
      return { ...registration, fileCreated: publication.created === true };
    });
  }
}

export const vehicleImageCropInternals = Object.freeze({ codedError, sameCropBox, sha256 });
