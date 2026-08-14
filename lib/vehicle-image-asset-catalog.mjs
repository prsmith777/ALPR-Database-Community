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

  async catalogRead(readId) {
    const read = await this.repository.getRead(readId);
    if (!read) return { status: "missing", readId: Number(readId) };

    const ineligibleReason = overviewAssetCandidateReason(read);
    if (ineligibleReason) {
      return { status: "ineligible", readId: Number(read.id), reason: ineligibleReason };
    }

    const sourcePath = String(read.vehicle_image_path).trim();
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
    const sourceDetails = overviewAssetSourceDetails(read.vehicle_image_source_kind);
    if (!sourceDetails) {
      return { status: "ineligible", readId: Number(read.id), reason: "source_kind_not_eligible" };
    }
    if (typeof this.fileStorage.saveDerivedImageIfAbsent !== "function") {
      throw new Error("Vehicle image asset catalog requires create-if-absent derived storage");
    }

    return this.repository.withStorageWriter(async (writerRepository) => {
      const storage = await this.fileStorage.saveDerivedImageIfAbsent(storagePath, source);
      const registration = await writerRepository.registerAssetForRead({
        readSnapshot: read,
        asset: {
          contentSha256,
          storagePath,
          mediaType: inspection.mediaType,
          byteSize: source.length,
          imageWidth: inspection.width,
          imageHeight: inspection.height,
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
          sourcePathSnapshot: sourcePath,
          sourceUpdatedAt: read.vehicle_image_updated_at ?? null,
          detectionConfidence: read.vehicle_image_detection_confidence ?? null,
          detectionBox: read.vehicle_image_detection_box ?? null,
          selectionMetadata: read.vehicle_image_selection_metadata ?? {},
        },
      });
      return {
        status: "cataloged",
        readId: Number(read.id),
        contentSha256,
        storagePath,
        canonicalFileCreated: Boolean(storage?.created),
        assetCreated: registration.assetCreated,
        linkCreated: registration.linkCreated,
        linkUpdated: registration.linkUpdated,
        asset: registration.asset,
      };
    });
  }

}

export const vehicleImageAssetCatalogInternals = Object.freeze({
  inspectJpeg,
});
