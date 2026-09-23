import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";
import { isOverviewAssetCandidate } from "./vehicle-image-asset-model.mjs";

const READ_SNAPSHOT_COLUMNS = `
  reads.id,
  reads.camera_name,
  reads."timestamp"::text AS "timestamp",
  reads.vehicle_image_status,
  reads.vehicle_image_path,
  reads.vehicle_image_timestamp::text AS vehicle_image_timestamp,
  reads.vehicle_image_score,
  reads.vehicle_image_detection_confidence,
  reads.vehicle_image_detection_box,
  reads.vehicle_image_width,
  reads.vehicle_image_height,
  reads.vehicle_image_sampled_count,
  reads.vehicle_image_selection_metadata,
  reads.vehicle_image_source_kind,
  reads.vehicle_image_source_read_id,
  reads.vehicle_image_updated_at::text AS vehicle_image_updated_at`;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(`${label} must be a positive integer`);
    error.code = "INVALID_VEHICLE_IMAGE_ASSET_INPUT";
    throw error;
  }
  return number;
}

function jsonParameter(value) {
  return value == null ? null : JSON.stringify(value);
}

function conflictError(message, code = "VEHICLE_IMAGE_ASSET_CONFLICT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class VehicleImageAssetRepository {
  constructor({ pool, executor = null, storageWriterLockHeld = false } = {}) {
    if (!pool && !executor) {
      throw new Error("Vehicle image asset repository requires a database executor");
    }
    this.pool = pool;
    this.executor = executor;
    this.storageWriterLockHeld = storageWriterLockHeld === true;
  }

  async query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async withStorageWriter(operation) {
    if (typeof operation !== "function") {
      throw new Error("Vehicle image asset storage operation must be a function");
    }
    if (this.executor) {
      if (!this.storageWriterLockHeld) {
        throw new Error("Vehicle image asset writes require the shared storage cleanup lock");
      }
      return operation(this);
    }
    return withStorageCleanupWriterLock(this.pool, (client) =>
      operation(new VehicleImageAssetRepository({
        executor: client,
        storageWriterLockHeld: true,
      }))
    );
  }

  async getRead(readId) {
    const result = await this.query(
      `SELECT ${READ_SNAPSHOT_COLUMNS}
       FROM public.plate_reads reads
       WHERE reads.id = $1`,
      [positiveInteger(readId, "Read id")]
    );
    return result.rows?.[0] || null;
  }

  async getAssetForRead(readId) {
    const result = await this.query(
      `SELECT assets.*, links.source_kind, links.source_read_id,
              links.relationship, links.identity_eligible,
              links.overview_context, links.captured_at, links.read_camera_name,
              links.source_camera_name, links.source_path_snapshot,
              links.source_updated_at,
              links.detection_confidence, links.detection_box,
              links.selection_metadata, links.created_at AS linked_at,
              links.updated_at AS link_updated_at
       FROM public.vehicle_image_asset_reads links
       JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
       JOIN public.plate_reads reads ON reads.id = links.read_id
       WHERE links.read_id = $1
         AND reads.vehicle_image_status = 'ready'
         AND reads.vehicle_image_path = links.source_path_snapshot
         AND reads.vehicle_image_source_kind = links.source_kind
         AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at`,
      [positiveInteger(readId, "Read id")]
    );
    return result.rows?.[0] || null;
  }

  async registerAssetForRead({ readSnapshot, asset, link }) {
    if (!this.executor || !this.storageWriterLockHeld) {
      throw new Error("Vehicle image asset registration requires the shared storage cleanup lock");
    }
    const readId = positiveInteger(readSnapshot?.id, "Read id");
    await this.query("BEGIN");
    try {
      const current = await this.query(
        `SELECT ${READ_SNAPSHOT_COLUMNS}
         FROM public.plate_reads reads
         WHERE reads.id = $1
           AND reads.camera_name IS NOT DISTINCT FROM $2
           AND reads."timestamp" IS NOT DISTINCT FROM $3::timestamptz
           AND reads.vehicle_image_status IS NOT DISTINCT FROM $4
           AND reads.vehicle_image_path IS NOT DISTINCT FROM $5
           AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM $6::timestamptz
           AND reads.vehicle_image_score IS NOT DISTINCT FROM $7::real
           AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM $8::real
           AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM $9::jsonb
           AND reads.vehicle_image_width IS NOT DISTINCT FROM $10::integer
           AND reads.vehicle_image_height IS NOT DISTINCT FROM $11::integer
           AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM $12::smallint
           AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM $13::jsonb
           AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM $14
           AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM $15::integer
           AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM $16::timestamptz
         FOR UPDATE`,
        [
          readId,
          readSnapshot.camera_name ?? null,
          readSnapshot.timestamp ?? null,
          readSnapshot.vehicle_image_status ?? null,
          readSnapshot.vehicle_image_path ?? null,
          readSnapshot.vehicle_image_timestamp ?? null,
          readSnapshot.vehicle_image_score ?? null,
          readSnapshot.vehicle_image_detection_confidence ?? null,
          jsonParameter(readSnapshot.vehicle_image_detection_box),
          readSnapshot.vehicle_image_width ?? null,
          readSnapshot.vehicle_image_height ?? null,
          readSnapshot.vehicle_image_sampled_count ?? null,
          jsonParameter(readSnapshot.vehicle_image_selection_metadata),
          readSnapshot.vehicle_image_source_kind ?? null,
          readSnapshot.vehicle_image_source_read_id ?? null,
          readSnapshot.vehicle_image_updated_at ?? null,
        ]
      );
      const lockedRead = current.rows?.[0];
      if (!lockedRead || !isOverviewAssetCandidate(lockedRead)) {
        throw conflictError(
          "Vehicle image changed before its canonical asset could be linked",
          "VEHICLE_IMAGE_ASSET_SNAPSHOT_CHANGED"
        );
      }

      const inserted = await this.query(
        `INSERT INTO public.vehicle_image_assets (
           content_sha256, storage_path, media_type, byte_size,
           image_width, image_height
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (content_sha256) DO NOTHING
         RETURNING *`,
        [
          asset.contentSha256,
          asset.storagePath,
          asset.mediaType,
          asset.byteSize,
          asset.imageWidth,
          asset.imageHeight,
        ]
      );
      let assetRow = inserted.rows?.[0] || null;
      const assetCreated = Boolean(assetRow);
      if (!assetRow) {
        const existing = await this.query(
          `SELECT * FROM public.vehicle_image_assets
           WHERE content_sha256 = $1
           FOR SHARE`,
          [asset.contentSha256]
        );
        assetRow = existing.rows?.[0] || null;
      }
      if (!assetRow) {
        throw conflictError("Canonical vehicle image asset could not be loaded");
      }
      if (
        assetRow.storage_path !== asset.storagePath
        || assetRow.media_type !== asset.mediaType
        || Number(assetRow.byte_size) !== Number(asset.byteSize)
        || Number(assetRow.image_width) !== Number(asset.imageWidth)
        || Number(assetRow.image_height) !== Number(asset.imageHeight)
      ) {
        throw conflictError("Canonical vehicle image asset metadata does not match its content identity");
      }

      const currentLink = await this.query(
        `SELECT asset_id, source_kind, source_path_snapshot,
                source_updated_at::text AS source_updated_at
         FROM public.vehicle_image_asset_reads
         WHERE read_id = $1
         FOR UPDATE`,
        [readId]
      );
      const existingLink = currentLink.rows?.[0] || null;
      const linkedAssetId = existingLink?.asset_id;
      const sourceUpdatedAt = link.sourceUpdatedAt ?? null;
      const sameSourceUpdatedAt = existingLink
        ? (existingLink.source_updated_at == null && sourceUpdatedAt == null)
          || String(existingLink.source_updated_at) === String(sourceUpdatedAt)
        : false;
      const linkIsCurrent = existingLink
        && Number(linkedAssetId) === Number(assetRow.id)
        && existingLink.source_kind === link.sourceKind
        && existingLink.source_path_snapshot === link.sourcePathSnapshot
        && sameSourceUpdatedAt;

      let linkCreated = false;
      let linkUpdated = false;
      if (!existingLink) {
        const linked = await this.query(
          `INSERT INTO public.vehicle_image_asset_reads (
             asset_id, read_id, source_kind, source_read_id, relationship,
             identity_eligible, overview_context, captured_at,
             read_camera_name, source_camera_name, source_path_snapshot,
             source_updated_at, detection_confidence, detection_box,
             selection_metadata
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
             $9, $10, $11, $12::timestamptz, $13::real, $14::jsonb,
             $15::jsonb
           )
           ON CONFLICT (asset_id, read_id) DO NOTHING
           RETURNING asset_id`,
          [
            assetRow.id,
            readId,
            link.sourceKind,
            link.sourceReadId,
            link.relationship,
            link.identityEligible,
            link.overviewContext,
            link.capturedAt,
            link.readCameraName,
            link.sourceCameraName,
            link.sourcePathSnapshot,
            sourceUpdatedAt,
            link.detectionConfidence,
            jsonParameter(link.detectionBox),
            jsonParameter(link.selectionMetadata || {}),
          ]
        );
        linkCreated = Boolean(linked.rows?.[0]);
      } else if (!linkIsCurrent) {
        const updated = await this.query(
          `UPDATE public.vehicle_image_asset_reads
           SET asset_id = $2, source_kind = $3, source_read_id = $4,
               relationship = $5, identity_eligible = $6,
               overview_context = $7, captured_at = $8::timestamptz,
               read_camera_name = $9, source_camera_name = $10,
               source_path_snapshot = $11, source_updated_at = $12::timestamptz,
               detection_confidence = $13::real, detection_box = $14::jsonb,
               selection_metadata = $15::jsonb,
               updated_at = CURRENT_TIMESTAMP
           WHERE read_id = $1
           RETURNING asset_id`,
          [
            readId,
            assetRow.id,
            link.sourceKind,
            link.sourceReadId,
            link.relationship,
            link.identityEligible,
            link.overviewContext,
            link.capturedAt,
            link.readCameraName,
            link.sourceCameraName,
            link.sourcePathSnapshot,
            sourceUpdatedAt,
            link.detectionConfidence,
            jsonParameter(link.detectionBox),
            jsonParameter(link.selectionMetadata || {}),
          ]
        );
        if (!updated.rows?.[0]) {
          throw conflictError("Canonical vehicle image read link could not be refreshed");
        }
        linkUpdated = true;
      }

      await this.query("COMMIT");
      return { asset: assetRow, assetCreated, linkCreated, linkUpdated };
    } catch (error) {
      try {
        await this.query("ROLLBACK");
      } catch {
        // Preserve the registration failure.
      }
      throw error;
    }
  }
}

export const vehicleImageAssetRepositoryInternals = Object.freeze({
  READ_SNAPSHOT_COLUMNS,
});
