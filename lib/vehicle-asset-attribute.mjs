import crypto from "node:crypto";
import fs from "node:fs/promises";

import sharp from "sharp";

import {
  COLOR_SAMPLE_HEIGHT,
  COLOR_SAMPLE_WIDTH,
  COLOR_SIGNATURE_VERSION,
} from "./image-similarity.mjs";
import {
  assessVehicleColorPixels,
  VEHICLE_COLOR_MODEL,
  VEHICLE_COLOR_PROVIDER,
  VEHICLE_TYPE_MODEL,
  VEHICLE_TYPE_PROVIDER,
  VehicleTypeEngine,
} from "./vehicle-attributes.mjs";
import {
  VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
} from "./vehicle-asset-attribute-contract.mjs";

export {
  VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
} from "./vehicle-asset-attribute-contract.mjs";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedObservation(contract, observation, rawResult) {
  const status = observation?.status === "ready" ? "ready" : "unknown";
  const value = status === "ready" && String(observation?.value || "").trim()
    ? String(observation.value).trim()
    : null;
  const rawConfidence = observation?.confidence;
  const confidence = rawConfidence == null ? null : Number(rawConfidence);
  if (
    (status === "ready" && !value)
    || (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
    || !rawResult || Array.isArray(rawResult) || typeof rawResult !== "object"
  ) {
    throw codedError(
      "VEHICLE_ASSET_ATTRIBUTE_INVALID_OUTPUT",
      `Local ${contract.attributeKey} evaluation returned an invalid result.`
    );
  }
  return {
    attributeKey: contract.attributeKey,
    provider: contract.provider,
    modelVersion: contract.modelVersion,
    status,
    value,
    confidence,
    rawResult,
  };
}

export class VehicleAssetAttributeService {
  constructor({
    repository,
    fileStorage,
    vehicleTypeAnalyzer = new VehicleTypeEngine(),
    imageProcessor = sharp,
    readFile = fs.readFile,
  } = {}) {
    if (!repository || !fileStorage || typeof vehicleTypeAnalyzer?.analyze !== "function") {
      throw new Error("Canonical crop attribute dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.vehicleTypeAnalyzer = vehicleTypeAnalyzer;
    this.imageProcessor = imageProcessor;
    this.readFile = readFile;
  }

  async render(job) {
    let fullPath;
    try {
      fullPath = await this.fileStorage.resolveExistingImagePath(job.source_path);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_SOURCE_MISSING",
        `Canonical crop is unavailable: ${String(error?.code || "missing")}`
      );
    }
    let source;
    try {
      source = await this.readFile(fullPath);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_SOURCE_MISSING",
        `Canonical crop cannot be read: ${String(error?.code || "missing")}`
      );
    }
    if (!source?.length || sha256(source) !== String(job.source_sha256)) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_SOURCE_CHANGED",
        "Canonical crop bytes no longer match the immutable derivative identity."
      );
    }
    let metadata;
    try {
      metadata = await this.imageProcessor(source).metadata();
    } catch {
      throw codedError("VEHICLE_ASSET_ATTRIBUTE_INVALID_SOURCE", "Canonical crop JPEG is invalid.");
    }
    if (
      Number(metadata?.width) !== Number(job.source_width)
      || Number(metadata?.height) !== Number(job.source_height)
      || !["jpeg", "jpg"].includes(String(metadata?.format || "").toLowerCase())
    ) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_SOURCE_CHANGED",
        "Canonical crop dimensions or media type changed after preview."
      );
    }

    let color;
    let bodyType;
    try {
      const colorPixels = await this.imageProcessor(source)
        .resize(COLOR_SAMPLE_WIDTH, COLOR_SAMPLE_HEIGHT, { fit: "fill" })
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer();
      color = assessVehicleColorPixels(colorPixels);
      bodyType = await this.vehicleTypeAnalyzer.analyze(source);
    } catch (error) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_INFERENCE_FAILED",
        `Local vehicle attribute evaluation failed: ${String(error?.code || "inference")}`
      );
    }

    if (
      VEHICLE_ASSET_COLOR_ATTRIBUTE.provider !== VEHICLE_COLOR_PROVIDER
      || VEHICLE_ASSET_COLOR_ATTRIBUTE.modelVersion !== VEHICLE_COLOR_MODEL
      || VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.provider !== VEHICLE_TYPE_PROVIDER
      || VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.modelVersion !== VEHICLE_TYPE_MODEL
    ) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_CONFLICT",
        "Local vehicle attribute runtime does not match the frozen provider-neutral contract."
      );
    }

    const result = {
      algorithmVersion: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
      observations: [
        normalizedObservation(VEHICLE_ASSET_COLOR_ATTRIBUTE, color, {
          reliability: color.reliability,
          colorSignatureVersion: COLOR_SIGNATURE_VERSION,
          reason: color.reason,
          monochromeRatio: color.monochromeRatio,
        }),
        normalizedObservation(VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE, bodyType, {
          scores: bodyType.scores || null,
          input: "canonical_vehicle_crop",
        }),
      ],
    };
    const resultJson = canonicalJson(result);
    return {
      result,
      resultSha256: sha256(resultJson),
      resultBytes: Buffer.byteLength(resultJson),
      algorithmVersion: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
    };
  }

  async preview(job) {
    return this.render(job);
  }

  async catalog(job) {
    const rendered = await this.render(job);
    if (
      rendered.resultSha256 !== job.preview_result_sha256
      || Number(rendered.resultBytes) !== Number(job.preview_result_bytes)
      || canonicalJson(rendered.result) !== canonicalJson(job.preview_result)
      || rendered.algorithmVersion !== job.algorithm_version
    ) {
      throw codedError(
        "VEHICLE_ASSET_ATTRIBUTE_PREVIEW_CHANGED",
        "Canonical crop attribute results changed after the confirmed preview."
      );
    }
    return this.repository.registerObservations(job, rendered);
  }
}

export const vehicleAssetAttributeInternals = Object.freeze({
  canonicalJson,
  codedError,
  normalizedObservation,
  sha256,
});
