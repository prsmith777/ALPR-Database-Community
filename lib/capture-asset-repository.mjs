import {
  CAPTURE_ASSET_ALGORITHM,
  MAX_SEARCH_CANDIDATES,
} from "./image-similarity.mjs";

const ASSET_TYPE = "vehicle_crop";

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("Invalid date filter");
    error.code = "INVALID_SEARCH_FILTER";
    throw error;
  }
  return date.toISOString();
}

export class CaptureAssetRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("Capture asset repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }

  async query(text, values = []) {
    const executor = this.executor || this.pool;
    return executor.query(text, values);
  }

  async getRead(readId) {
    const result = await this.query(
      `SELECT id, plate_number, observed_plate, camera_name, "timestamp",
              image_path, thumbnail_path, crop_coordinates
       FROM public.plate_reads
       WHERE id = $1`,
      [readId]
    );
    return result.rows[0] || null;
  }

  async listIndexCandidates(limit) {
    const result = await this.query(
      `SELECT pr.id, pr.plate_number, pr.observed_plate, pr.camera_name,
              pr."timestamp", pr.image_path, pr.thumbnail_path, pr.crop_coordinates
       FROM public.plate_reads pr
       LEFT JOIN public.capture_assets ca
         ON ca.read_id = pr.id
        AND ca.asset_type = $1
        AND ca.algorithm_version = $2
       WHERE pr.image_path IS NOT NULL
         AND (ca.id IS NULL OR (ca.status = 'failed' AND ca.attempt_count < 3))
       ORDER BY pr."timestamp" DESC, pr.id DESC
       LIMIT $3`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, limit]
    );
    return result.rows;
  }

  async getAsset(readId) {
    const result = await this.query(
      `SELECT ca.*, pr.plate_number, pr.observed_plate, pr.camera_name,
              pr."timestamp", pr.thumbnail_path, pr.crop_coordinates
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       WHERE ca.read_id = $1
         AND ca.asset_type = $2
         AND ca.algorithm_version = $3
         AND ca.status = 'ready'`,
      [readId, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows[0] || null;
  }

  async recordReady({
    read,
    derivedPath,
    sourceSha256,
    perceptualHash,
    crop,
    imageWidth,
    imageHeight,
  }) {
    const result = await this.query(
      `INSERT INTO public.capture_assets (
         read_id, asset_type, algorithm_version, status, source_image_path,
         derived_path, source_sha256, perceptual_hash, crop_box,
         image_width, image_height, crop_width, crop_height, indexed_at
       ) VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8::jsonb,
                 $9, $10, $11, $12, CURRENT_TIMESTAMP)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         status = 'ready',
         source_image_path = EXCLUDED.source_image_path,
         derived_path = EXCLUDED.derived_path,
         source_sha256 = EXCLUDED.source_sha256,
         perceptual_hash = EXCLUDED.perceptual_hash,
         crop_box = EXCLUDED.crop_box,
         image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height,
         crop_width = EXCLUDED.crop_width,
         crop_height = EXCLUDED.crop_height,
         attempt_count = public.capture_assets.attempt_count + 1,
         error_code = NULL,
         indexed_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        read.id,
        ASSET_TYPE,
        CAPTURE_ASSET_ALGORITHM,
        read.image_path,
        derivedPath,
        sourceSha256,
        perceptualHash,
        JSON.stringify(crop),
        imageWidth,
        imageHeight,
        crop.width,
        crop.height,
      ]
    );
    return result.rows[0];
  }

  async recordFailure(read, errorCode) {
    await this.query(
      `INSERT INTO public.capture_assets (
         read_id, asset_type, algorithm_version, status, source_image_path, error_code
       ) VALUES ($1, $2, $3, 'failed', $4, $5)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         status = 'failed',
         source_image_path = EXCLUDED.source_image_path,
         derived_path = NULL,
         source_sha256 = NULL,
         perceptual_hash = NULL,
         crop_box = NULL,
         image_width = NULL,
         image_height = NULL,
         crop_width = NULL,
         crop_height = NULL,
         attempt_count = public.capture_assets.attempt_count + 1,
         error_code = EXCLUDED.error_code,
         indexed_at = NULL`,
      [read.id, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, read.image_path, errorCode]
    );
  }

  async getStatus() {
    const result = await this.query(
      `WITH indexable AS (
         SELECT COUNT(*)::integer AS total
         FROM public.plate_reads
         WHERE image_path IS NOT NULL
       ), asset_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
           COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
           COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count < 3)::integer AS retryable,
           MAX(indexed_at) FILTER (WHERE status = 'ready') AS last_indexed_at
         FROM public.capture_assets
         WHERE asset_type = $1 AND algorithm_version = $2
       )
       SELECT indexable.total,
              COALESCE(asset_counts.ready, 0)::integer AS ready,
              COALESCE(asset_counts.failed, 0)::integer AS failed,
              COALESCE(asset_counts.retryable, 0)::integer AS retryable,
              GREATEST(indexable.total - COALESCE(asset_counts.ready, 0) - COALESCE(asset_counts.failed, 0), 0)::integer AS pending,
              asset_counts.last_indexed_at
       FROM indexable CROSS JOIN asset_counts`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows[0];
  }

  async listRecent(limit = 12) {
    const result = await this.query(
      `SELECT ca.read_id, ca.derived_path, pr.plate_number, pr.observed_plate,
              pr.camera_name, pr."timestamp"
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2 AND ca.status = 'ready'
       ORDER BY pr."timestamp" DESC, pr.id DESC
       LIMIT $3`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, limit]
    );
    return result.rows;
  }

  async listCameras() {
    const result = await this.query(
      `SELECT DISTINCT pr.camera_name
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND pr.camera_name IS NOT NULL
       ORDER BY pr.camera_name`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows.map((row) => row.camera_name);
  }

  async listSearchCandidates({ readId, cameraNames = [], startDate, endDate }) {
    const values = [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, readId];
    const conditions = [
      "ca.asset_type = $1",
      "ca.algorithm_version = $2",
      "ca.status = 'ready'",
      "ca.read_id <> $3",
    ];
    if (cameraNames.length) {
      values.push(cameraNames);
      conditions.push(`pr.camera_name = ANY($${values.length}::text[])`);
    }
    const normalizedStart = dateOrNull(startDate);
    if (normalizedStart) {
      values.push(normalizedStart);
      conditions.push(`pr."timestamp" >= $${values.length}::timestamptz`);
    }
    const normalizedEnd = dateOrNull(endDate);
    if (normalizedEnd) {
      values.push(normalizedEnd);
      conditions.push(`pr."timestamp" <= $${values.length}::timestamptz`);
    }
    values.push(MAX_SEARCH_CANDIDATES);
    const result = await this.query(
      `SELECT ca.read_id, ca.derived_path, ca.source_sha256, ca.perceptual_hash,
              pr.plate_number, pr.observed_plate, pr.camera_name, pr."timestamp"
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY pr."timestamp" DESC, pr.id DESC
       LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }
}
