import crypto from "node:crypto";
import sharp from "sharp";

import {
  canonicalVehicleImageAssetPath,
  overviewAssetCandidateReason,
  overviewAssetSourceDetails,
  overviewSourceCameraName,
} from "./vehicle-image-asset-model.mjs";

function catalogError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

const SNAPSHOT_FIELDS = Object.freeze([
  "id",
  "camera_name",
  "timestamp",
  "vehicle_image_status",
  "vehicle_image_path",
  "vehicle_image_timestamp",
  "vehicle_image_score",
  "vehicle_image_detection_confidence",
  "vehicle_image_detection_box",
  "vehicle_image_width",
  "vehicle_image_height",
  "vehicle_image_sampled_count",
  "vehicle_image_selection_metadata",
  "vehicle_image_source_kind",
  "vehicle_image_source_read_id",
  "vehicle_image_updated_at",
]);

function sameSnapshot(left, right) {
  if (!left || !right) return false;
  return SNAPSHOT_FIELDS.every((field) => canonicalJson(left[field] ?? null)
    === canonicalJson(right[field] ?? null));
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSnapshotMetadata(readSnapshot) {
  const confidence = readSnapshot.vehicle_image_detection_confidence;
  if (confidence != null && (
    typeof confidence !== "number" || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1
  )) {
    throw catalogError(
      "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
      "Overview detection confidence is invalid"
    );
  }
  for (const field of ["vehicle_image_width", "vehicle_image_height"]) {
    const value = readSnapshot[field];
    if (value != null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
        "Overview source dimensions are invalid"
      );
    }
  }
  const sampledCount = readSnapshot.vehicle_image_sampled_count;
  if (sampledCount != null && (!Number.isSafeInteger(sampledCount) || sampledCount < 0)) {
    throw catalogError(
      "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
      "Overview sampled-frame count is invalid"
    );
  }
  for (const field of ["vehicle_image_detection_box", "vehicle_image_selection_metadata"]) {
    const value = readSnapshot[field];
    if (value != null && !isJsonObject(value)) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_INVALID_METADATA",
        "Overview selection metadata is invalid"
      );
    }
  }
}

async function inspectJpeg(buffer) {
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw catalogError("VEHICLE_IMAGE_ASSET_INVALID_IMAGE", "Overview asset is not a readable image");
  }
  if (
    metadata.format !== "jpeg"
    || !Number.isSafeInteger(metadata.width)
    || metadata.width <= 0
    || !Number.isSafeInteger(metadata.height)
    || metadata.height <= 0
  ) {
    throw catalogError("VEHICLE_IMAGE_ASSET_INVALID_JPEG", "Overview asset must be a valid JPEG image");
  }
  return {
    mediaType: "image/jpeg",
    width: metadata.width,
    height: metadata.height,
  };
}

export class VehicleImageAssetCatalogService {
  constructor({ repository, fileStorage, imageInspector = inspectJpeg } = {}) {
    if (!repository) throw new Error("Vehicle image asset catalog requires a repository");
    if (!fileStorage) throw new Error("Vehicle image asset catalog requires file storage");
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.imageInspector = imageInspector;
  }

  async inspectSnapshot(readSnapshot, { revalidate = true } = {}) {
    const readId = Number(readSnapshot?.id);
    if (!Number.isSafeInteger(readId) || readId <= 0) {
      throw catalogError("VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED", "Overview read snapshot is invalid");
    }
    if (revalidate) {
      const current = await this.repository.getRead(readId);
      if (!current || !sameSnapshot(current, readSnapshot)) {
        throw catalogError(
          "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
          "Overview image changed after the catalog preview was frozen"
        );
      }
    }
    const ineligibleReason = overviewAssetCandidateReason(readSnapshot);
    if (ineligibleReason) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
        "Overview image is no longer eligible for the canonical catalog"
      );
    }
    validateSnapshotMetadata(readSnapshot);
    const sourcePath = String(readSnapshot.vehicle_image_path).trim();
    const source = await this.fileStorage.getImage(sourcePath);
    if (!Buffer.isBuffer(source) || source.length === 0) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_SOURCE_MISSING",
        "Ready Overview image could not be read from storage"
      );
    }
    const contentSha256 = crypto.createHash("sha256").update(source).digest("hex");
    const storagePath = canonicalVehicleImageAssetPath(contentSha256);
    const inspection = await this.imageInspector(source);
    return {
      readSnapshot,
      source,
      sourcePath,
      contentSha256,
      storagePath,
      mediaType: inspection.mediaType,
      byteSize: source.length,
      imageWidth: inspection.width,
      imageHeight: inspection.height,
    };
  }

  async previewSnapshot(readSnapshot) {
    const inspected = await this.inspectSnapshot(readSnapshot);
    return {
      readId: Number(readSnapshot.id),
      contentSha256: inspected.contentSha256,
      storagePath: inspected.storagePath,
      mediaType: inspected.mediaType,
      byteSize: inspected.byteSize,
      imageWidth: inspected.imageWidth,
      imageHeight: inspected.imageHeight,
    };
  }

  async catalogSnapshot({
    readSnapshot,
    expectedContentSha256,
    expectedByteSize,
    expectedImageWidth,
    expectedImageHeight,
  } = {}) {
    const inspected = await this.inspectSnapshot(readSnapshot);
    if (
      inspected.contentSha256 !== String(expectedContentSha256 || "")
      || inspected.byteSize !== Number(expectedByteSize)
      || inspected.imageWidth !== Number(expectedImageWidth)
      || inspected.imageHeight !== Number(expectedImageHeight)
    ) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
        "Overview image bytes changed after the catalog preview was completed"
      );
    }
    return this.catalogInspectedSnapshot(inspected);
  }

  async catalogInspectedSnapshot(inspected) {
    const read = inspected.readSnapshot;
    const sourceDetails = overviewAssetSourceDetails(read.vehicle_image_source_kind);
    if (!sourceDetails) {
      throw catalogError(
        "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED",
        "Overview source kind is no longer eligible for the canonical catalog"
      );
    }
    if (typeof this.fileStorage.saveDerivedImageIfAbsent !== "function") {
      throw new Error("Vehicle image asset catalog requires create-if-absent derived storage");
    }
    return this.repository.withStorageWriter(async (writerRepository) => {
      const storage = await this.fileStorage.saveDerivedImageIfAbsent(
        inspected.storagePath,
        inspected.source
      );
      const registration = await writerRepository.registerAssetForRead({
        readSnapshot: read,
        asset: {
          contentSha256: inspected.contentSha256,
          storagePath: inspected.storagePath,
          mediaType: inspected.mediaType,
          byteSize: inspected.byteSize,
          imageWidth: inspected.imageWidth,
          imageHeight: inspected.imageHeight,
        },
        link: {
          sourceKind: read.vehicle_image_source_kind,
          sourceReadId: read.vehicle_image_source_read_id ?? null,
          relationship: sourceDetails.relationship,
          identityEligible: sourceDetails.identityEligible,
          overviewContext: sourceDetails.overviewContext,
          capturedAt: read.vehicle_image_timestamp ?? null,
          readCameraName: read.camera_name ?? null,
          sourceCameraName: overviewSourceCameraName(read),
          sourcePathSnapshot: inspected.sourcePath,
          sourceUpdatedAt: read.vehicle_image_updated_at ?? null,
          detectionConfidence: read.vehicle_image_detection_confidence ?? null,
          detectionBox: read.vehicle_image_detection_box ?? null,
          selectionMetadata: read.vehicle_image_selection_metadata ?? {},
        },
      });
      return {
        status: "cataloged",
        readId: Number(read.id),
        contentSha256: inspected.contentSha256,
        storagePath: inspected.storagePath,
        canonicalFileCreated: Boolean(storage?.created),
        assetCreated: registration.assetCreated,
        linkCreated: registration.linkCreated,
        linkUpdated: registration.linkUpdated,
        asset: registration.asset,
      };
    });
  }

  async catalogRead(readId) {
    const read = await this.repository.getRead(readId);
    if (!read) return { status: "missing", readId: Number(readId) };

    const ineligibleReason = overviewAssetCandidateReason(read);
    if (ineligibleReason) {
      return { status: "ineligible", readId: Number(read.id), reason: ineligibleReason };
    }

    const inspected = await this.inspectSnapshot(read, { revalidate: false });
    return this.catalogInspectedSnapshot(inspected);
  }

}

export const vehicleImageAssetCatalogInternals = Object.freeze({
  SNAPSHOT_FIELDS,
  canonicalJson,
  inspectJpeg,
  sameSnapshot,
  validateSnapshotMetadata,
});
