import crypto from "node:crypto";
import fs from "node:fs/promises";

import sharp from "sharp";

import {
  encodeVehicleEmbedding,
  VEHICLE_EMBEDDING_BYTES,
  VEHICLE_EMBEDDING_LENGTH,
  VEHICLE_REID_MODEL,
  VehicleReidEngine,
} from "./vehicle-reid.mjs";

export const VEHICLE_ASSET_EMBEDDING_ALGORITHM = "canonical-overview-crop-embedding-v1";
export const VEHICLE_ASSET_EMBEDDING_MODEL = VEHICLE_REID_MODEL;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export class VehicleAssetEmbeddingService {
  constructor({
    repository,
    fileStorage,
    engine = new VehicleReidEngine(),
    imageProcessor = sharp,
    readFile = fs.readFile,
  } = {}) {
    if (!repository || !fileStorage || !engine || typeof engine.embed !== "function") {
      throw new Error("Canonical crop embedding dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.engine = engine;
    this.imageProcessor = imageProcessor;
    this.readFile = readFile;
  }

  async render(job) {
    let fullPath;
    try {
      fullPath = await this.fileStorage.resolveExistingImagePath(job.source_path);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_SOURCE_MISSING",
        `Canonical crop is unavailable: ${String(error?.code || "missing")}`
      );
    }
    let source;
    try {
      source = await this.readFile(fullPath);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_SOURCE_MISSING",
        `Canonical crop cannot be read: ${String(error?.code || "missing")}`
      );
    }
    if (!source?.length || sha256(source) !== String(job.source_sha256)) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_SOURCE_CHANGED",
        "Canonical crop bytes no longer match the immutable derivative identity."
      );
    }
    let metadata;
    try {
      metadata = await this.imageProcessor(source).metadata();
    } catch {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_INVALID_SOURCE",
        "Canonical crop JPEG is invalid."
      );
    }
    if (
      Number(metadata?.width) !== Number(job.source_width)
      || Number(metadata?.height) !== Number(job.source_height)
      || !["jpeg", "jpg"].includes(String(metadata?.format || "").toLowerCase())
    ) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_SOURCE_CHANGED",
        "Canonical crop dimensions or media type changed after preview."
      );
    }
    let values;
    try {
      values = await this.engine.embed(source);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_INFERENCE_FAILED",
        `Local vehicle embedding failed: ${String(error?.code || "inference")}`
      );
    }
    let encoded;
    try {
      encoded = encodeVehicleEmbedding(values);
    } catch {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_INVALID_OUTPUT",
        "Local vehicle embedding did not return the required dimensions."
      );
    }
    if (encoded.length !== VEHICLE_EMBEDDING_BYTES) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_INVALID_OUTPUT",
        "Local vehicle embedding did not return the required dimensions."
      );
    }
    return {
      embedding: encoded,
      embeddingSha256: sha256(encoded),
      embeddingDimensions: VEHICLE_EMBEDDING_LENGTH,
      embeddingBytes: VEHICLE_EMBEDDING_BYTES,
      modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
      algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
    };
  }

  async preview(job) {
    const rendered = await this.render(job);
    const { embedding: _embedding, ...preview } = rendered;
    return preview;
  }

  async catalog(job) {
    const rendered = await this.render(job);
    if (
      rendered.embeddingSha256 !== job.preview_embedding_sha256
      || Number(rendered.embeddingDimensions) !== Number(job.preview_embedding_dimensions)
      || Number(rendered.embeddingBytes) !== Number(job.preview_embedding_bytes)
      || rendered.modelName !== job.model_name
      || rendered.algorithmVersion !== job.algorithm_version
    ) {
      throw codedError(
        "VEHICLE_ASSET_EMBEDDING_PREVIEW_CHANGED",
        "Canonical crop embedding changed after the confirmed preview."
      );
    }
    return this.repository.registerEmbedding(job, rendered);
  }
}

export const vehicleAssetEmbeddingInternals = Object.freeze({ codedError, sha256 });
