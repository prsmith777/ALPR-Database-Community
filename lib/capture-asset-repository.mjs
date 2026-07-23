import {
  CAPTURE_ASSET_ALGORITHM,
  DEFAULT_CAMERA_CROP_PROFILE,
  MAX_SEARCH_CANDIDATES,
  normalizeCameraCropProfile,
} from "./image-similarity.mjs";

const ASSET_TYPE = "vehicle_crop";
const PROFILE_JOIN = `LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(pr.camera_name))`;
const CURRENT_PROFILE = "ca.crop_profile_version = COALESCE(cvp.profile_version, 1)";

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

function publicProfile(row, fallbackCameraName = "") {
  return {
    cameraName: row?.camera_name || fallbackCameraName,
    ...normalizeCameraCropProfile({
      cropMode: row?.crop_mode,
      contextPercent: row?.context_percent,
      verticalOffsetPercent: row?.vertical_offset_percent,
      profileVersion: row?.profile_version,
    }),
  };
}

export class CaptureAssetRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("Capture asset repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }

  async query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async getRead(readId) {
    const result = await this.query(
      `SELECT id, plate_number, observed_plate, camera_name, "timestamp",
              image_path, thumbnail_path, crop_coordinates
       FROM public.plate_reads WHERE id = $1`,
      [readId]
    );
    return result.rows[0] || null;
  }

  async listIndexCandidates(limit, cameraName = null) {
    const values = [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM];
    const cameraFilter = cameraName
      ? (values.push(cameraName), `AND LOWER(BTRIM(pr.camera_name)) = LOWER(BTRIM($${values.length}))`)
      : "";
    values.push(limit);
    const result = await this.query(
      `SELECT pr.id, pr.plate_number, pr.observed_plate, pr.camera_name,
              pr."timestamp", pr.image_path, pr.thumbnail_path, pr.crop_coordinates
       FROM public.plate_reads pr
       ${PROFILE_JOIN}
       LEFT JOIN public.capture_assets ca
         ON ca.read_id = pr.id AND ca.asset_type = $1 AND ca.algorithm_version = $2
       WHERE pr.image_path IS NOT NULL ${cameraFilter}
         AND (ca.id IS NULL OR NOT (${CURRENT_PROFILE})
              OR (ca.status = 'failed' AND ca.attempt_count < 3))
       ORDER BY pr."timestamp" DESC, pr.id DESC
       LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }

  async getAsset(readId) {
    const result = await this.query(
      `SELECT ca.*, pr.plate_number, pr.observed_plate, pr.camera_name,
              pr."timestamp", pr.thumbnail_path, pr.crop_coordinates
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       ${PROFILE_JOIN}
       WHERE ca.read_id = $1 AND ca.asset_type = $2 AND ca.algorithm_version = $3
         AND ca.status = 'ready' AND ${CURRENT_PROFILE}`,
      [readId, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows[0] || null;
  }

  async getCameraProfile(cameraName) {
    const result = await this.query(
      `SELECT camera_name, crop_mode, context_percent, vertical_offset_percent, profile_version
       FROM public.camera_visual_profiles WHERE camera_key = LOWER(BTRIM($1))`,
      [cameraName]
    );
    return publicProfile(result.rows[0], cameraName);
  }

  async saveCameraProfile(cameraName, input) {
    const name = String(cameraName || "").trim();
    if (!name || name.length > 100) {
      const error = new Error("Select a valid camera");
      error.code = "INVALID_CAMERA_PROFILE";
      throw error;
    }
    const profile = normalizeCameraCropProfile(input);
    const changedFromDefault = profile.cropMode !== DEFAULT_CAMERA_CROP_PROFILE.cropMode
      || profile.contextPercent !== DEFAULT_CAMERA_CROP_PROFILE.contextPercent
      || profile.verticalOffsetPercent !== DEFAULT_CAMERA_CROP_PROFILE.verticalOffsetPercent;
    const result = await this.query(
      `INSERT INTO public.camera_visual_profiles (
         camera_key, camera_name, crop_mode, context_percent,
         vertical_offset_percent, profile_version
       ) VALUES (LOWER(BTRIM($1)), $1, $2, $3, $4, $5)
       ON CONFLICT (camera_key) DO UPDATE SET
         camera_name = EXCLUDED.camera_name,
         crop_mode = EXCLUDED.crop_mode,
         context_percent = EXCLUDED.context_percent,
         vertical_offset_percent = EXCLUDED.vertical_offset_percent,
         profile_version = CASE WHEN
           public.camera_visual_profiles.crop_mode IS DISTINCT FROM EXCLUDED.crop_mode OR
           public.camera_visual_profiles.context_percent IS DISTINCT FROM EXCLUDED.context_percent OR
           public.camera_visual_profiles.vertical_offset_percent IS DISTINCT FROM EXCLUDED.vertical_offset_percent
         THEN public.camera_visual_profiles.profile_version + 1
         ELSE public.camera_visual_profiles.profile_version END
       RETURNING camera_name, crop_mode, context_percent, vertical_offset_percent, profile_version`,
      [name, profile.cropMode, profile.contextPercent, profile.verticalOffsetPercent, changedFromDefault ? 2 : 1]
    );
    return publicProfile(result.rows[0], name);
  }

  async listCameraProfiles() {
    const result = await this.query(
      `SELECT cameras.camera_name, cvp.crop_mode, cvp.context_percent,
              cvp.vertical_offset_percent, cvp.profile_version
       FROM (
         SELECT DISTINCT ON (LOWER(BTRIM(camera_name))) camera_name
         FROM public.plate_reads WHERE camera_name IS NOT NULL AND BTRIM(camera_name) <> ''
         ORDER BY LOWER(BTRIM(camera_name)), "timestamp" DESC
       ) cameras
       LEFT JOIN public.camera_visual_profiles cvp
         ON cvp.camera_key = LOWER(BTRIM(cameras.camera_name))
       ORDER BY cameras.camera_name`);
    return result.rows.map((row) => publicProfile(row, row.camera_name));
  }

  async getLatestCameraRead(cameraName) {
    const result = await this.query(
      `SELECT id, plate_number, observed_plate, camera_name, "timestamp",
              image_path, thumbnail_path, crop_coordinates
       FROM public.plate_reads
       WHERE image_path IS NOT NULL AND LOWER(BTRIM(camera_name)) = LOWER(BTRIM($1))
       ORDER BY "timestamp" DESC, id DESC LIMIT 1`,
      [cameraName]
    );
    return result.rows[0] || null;
  }

  async recordReady({ read, derivedPath, sourceSha256, perceptualHash, colorSignature, crop, imageWidth, imageHeight, profileVersion }) {
    const result = await this.query(
      `INSERT INTO public.capture_assets (
         read_id, asset_type, algorithm_version, crop_profile_version, status, source_image_path,
         derived_path, source_sha256, perceptual_hash, color_signature, crop_box,
         image_width, image_height, crop_width, crop_height, indexed_at
       ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, $8, $9, $10::jsonb,
                 $11, $12, $13, $14, CURRENT_TIMESTAMP)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         crop_profile_version = EXCLUDED.crop_profile_version, status = 'ready',
         source_image_path = EXCLUDED.source_image_path, derived_path = EXCLUDED.derived_path,
         source_sha256 = EXCLUDED.source_sha256, perceptual_hash = EXCLUDED.perceptual_hash,
         color_signature = EXCLUDED.color_signature,
         crop_box = EXCLUDED.crop_box, image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height, crop_width = EXCLUDED.crop_width,
         crop_height = EXCLUDED.crop_height, attempt_count = 1, error_code = NULL,
         indexed_at = CURRENT_TIMESTAMP RETURNING *`,
      [read.id, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, profileVersion, read.image_path,
        derivedPath, sourceSha256, perceptualHash, colorSignature, JSON.stringify(crop), imageWidth,
        imageHeight, crop.width, crop.height]
    );
    return result.rows[0];
  }

  async recordFailure(read, errorCode, profileVersion) {
    await this.query(
      `INSERT INTO public.capture_assets (
         read_id, asset_type, algorithm_version, crop_profile_version, status, source_image_path, error_code
       ) VALUES ($1, $2, $3, $4, 'failed', $5, $6)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         crop_profile_version = EXCLUDED.crop_profile_version, status = 'failed',
         source_image_path = EXCLUDED.source_image_path, derived_path = NULL,
         source_sha256 = NULL, perceptual_hash = NULL, color_signature = NULL, crop_box = NULL,
         image_width = NULL, image_height = NULL, crop_width = NULL, crop_height = NULL,
         attempt_count = CASE WHEN public.capture_assets.crop_profile_version = EXCLUDED.crop_profile_version
           THEN public.capture_assets.attempt_count + 1 ELSE 1 END,
         error_code = EXCLUDED.error_code, indexed_at = NULL`,
      [read.id, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, profileVersion, read.image_path, errorCode]
    );
  }

  async getStatus() {
    const result = await this.query(
      `WITH current_assets AS (
         SELECT ca.status, ca.attempt_count, ca.indexed_at
         FROM public.plate_reads pr ${PROFILE_JOIN}
         LEFT JOIN public.capture_assets ca
           ON ca.read_id = pr.id AND ca.asset_type = $1 AND ca.algorithm_version = $2
          AND ${CURRENT_PROFILE}
         WHERE pr.image_path IS NOT NULL
       )
       SELECT COUNT(*)::integer AS total,
         COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
         COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count < 3)::integer AS retryable,
         COUNT(*) FILTER (WHERE status IS NULL)::integer AS pending,
         MAX(indexed_at) FILTER (WHERE status = 'ready') AS last_indexed_at
       FROM current_assets`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows[0];
  }

  async listRecent(limit = 12) {
    const result = await this.query(
      `SELECT ca.read_id, ca.derived_path, pr.plate_number, pr.observed_plate,
              pr.camera_name, pr."timestamp"
       FROM public.capture_assets ca JOIN public.plate_reads pr ON pr.id = ca.read_id
       ${PROFILE_JOIN}
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2 AND ca.status = 'ready'
         AND ${CURRENT_PROFILE}
       ORDER BY pr."timestamp" DESC, pr.id DESC LIMIT $3`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, limit]
    );
    return result.rows;
  }

  async listCameras() {
    const profiles = await this.listCameraProfiles();
    return profiles.map((profile) => profile.cameraName);
  }

  async listSearchCandidates({ readId, cameraNames = [], startDate, endDate }) {
    const values = [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM];
    const conditions = ["ca.asset_type = $1", "ca.algorithm_version = $2", "ca.status = 'ready'", CURRENT_PROFILE];
    const normalizedReadId = Number.parseInt(readId, 10);
    if (Number.isSafeInteger(normalizedReadId) && normalizedReadId > 0) {
      values.push(normalizedReadId);
      conditions.push(`ca.read_id <> $${values.length}`);
    }
    if (cameraNames.length) {
      values.push(cameraNames);
      conditions.push(`pr.camera_name = ANY($${values.length}::text[])`);
    }
    const normalizedStart = dateOrNull(startDate);
    if (normalizedStart) { values.push(normalizedStart); conditions.push(`pr."timestamp" >= $${values.length}::timestamptz`); }
    const normalizedEnd = dateOrNull(endDate);
    if (normalizedEnd) { values.push(normalizedEnd); conditions.push(`pr."timestamp" <= $${values.length}::timestamptz`); }
    values.push(MAX_SEARCH_CANDIDATES);
    const result = await this.query(
      `SELECT ca.read_id, ca.derived_path, ca.source_sha256, ca.perceptual_hash, ca.color_signature,
              pr.plate_number, pr.observed_plate, pr.camera_name, pr."timestamp"
       FROM public.capture_assets ca JOIN public.plate_reads pr ON pr.id = ca.read_id
       ${PROFILE_JOIN}
       WHERE ${conditions.join(" AND ")}
       ORDER BY pr."timestamp" DESC, pr.id DESC LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }
}
