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

  async listCameraDetectionStats() {
    const result = await this.query(
      `SELECT LOWER(BTRIM(pr.camera_name)) AS camera_key,
              MAX(pr.camera_name) AS camera_name,
              COUNT(*)::integer AS indexed_count,
              COUNT(*) FILTER (WHERE ca.detection_confidence IS NOT NULL)::integer AS detected_count,
              COUNT(*) FILTER (WHERE ca.detection_confidence IS NULL)::integer AS fallback_count,
              AVG(ca.detection_confidence) FILTER (WHERE ca.detection_confidence IS NOT NULL) AS average_confidence
       FROM public.capture_assets ca
       JOIN public.plate_reads pr ON pr.id = ca.read_id
       ${PROFILE_JOIN}
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND ${CURRENT_PROFILE}
         AND pr.camera_name IS NOT NULL AND BTRIM(pr.camera_name) <> ''
       GROUP BY LOWER(BTRIM(pr.camera_name))`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
    return result.rows;
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

  async recordReady({
    read,
    derivedPath,
    sourceSha256,
    perceptualHash,
    vehicleEmbedding,
    embeddingModel,
    detectorModel,
    detectionConfidence,
    crop,
    imageWidth,
    imageHeight,
    profileVersion,
  }) {
    const result = await this.query(
      `INSERT INTO public.capture_assets (
         read_id, asset_type, algorithm_version, crop_profile_version, status, source_image_path,
         derived_path, source_sha256, perceptual_hash, vehicle_embedding, embedding_model,
         detector_model, detection_confidence, crop_box,
         image_width, image_height, crop_width, crop_height, indexed_at
       ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
                  $14, $15, $16, $17, CURRENT_TIMESTAMP)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         crop_profile_version = EXCLUDED.crop_profile_version, status = 'ready',
         source_image_path = EXCLUDED.source_image_path, derived_path = EXCLUDED.derived_path,
         source_sha256 = EXCLUDED.source_sha256, perceptual_hash = EXCLUDED.perceptual_hash,
          vehicle_embedding = EXCLUDED.vehicle_embedding, embedding_model = EXCLUDED.embedding_model,
          detector_model = EXCLUDED.detector_model, detection_confidence = EXCLUDED.detection_confidence,
         crop_box = EXCLUDED.crop_box, image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height, crop_width = EXCLUDED.crop_width,
         crop_height = EXCLUDED.crop_height, attempt_count = 1, error_code = NULL,
         indexed_at = CURRENT_TIMESTAMP RETURNING *`,
      [read.id, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, profileVersion, read.image_path,
        derivedPath, sourceSha256, perceptualHash, vehicleEmbedding, embeddingModel, detectorModel,
        detectionConfidence, JSON.stringify(crop), imageWidth, imageHeight, crop.width, crop.height]
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
          source_sha256 = NULL, perceptual_hash = NULL, color_signature = NULL,
          color_signature_version = NULL, vehicle_embedding = NULL, embedding_model = NULL,
          detector_model = NULL, detection_confidence = NULL, crop_box = NULL,
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
       `SELECT ca.read_id, ca.derived_path, ca.source_sha256, ca.vehicle_embedding,
               ca.embedding_model, ca.detector_model, ca.detection_confidence,
              pr.plate_number, pr.observed_plate, pr.camera_name, pr."timestamp"
       FROM public.capture_assets ca JOIN public.plate_reads pr ON pr.id = ca.read_id
       ${PROFILE_JOIN}
       WHERE ${conditions.join(" AND ")}
       ORDER BY pr."timestamp" DESC, pr.id DESC LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }

  async listMatchFeedbackForSource({ sourceReadId, candidateReadIds = [], embeddingModel }) {
    const source = Number.parseInt(sourceReadId, 10);
    const candidates = [...new Set(candidateReadIds
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value !== source))];
    if (!Number.isSafeInteger(source) || source < 1 || !candidates.length || !embeddingModel) {
      return [];
    }
    const result = await this.query(
      `SELECT CASE WHEN read_id_low = $1 THEN read_id_high ELSE read_id_low END AS candidate_read_id,
              id, label, similarity_score, embedding_model, revision, updated_at,
              actor_username, actor_display_name
       FROM public.vehicle_match_feedback
       WHERE embedding_model = $2
         AND ((read_id_low = $1 AND read_id_high = ANY($3::integer[]))
           OR (read_id_high = $1 AND read_id_low = ANY($3::integer[])))`,
      [source, embeddingModel, candidates]
    );
    return result.rows;
  }

  async listVehicleMatchFeedback(embeddingModel) {
    const result = await this.query(
      `SELECT label, similarity_score
       FROM public.vehicle_match_feedback
       WHERE embedding_model = $1
       ORDER BY updated_at DESC, id DESC`,
      [embeddingModel]
    );
    return result.rows;
  }

  async saveVehicleMatchFeedback({
    readIdLow,
    readIdHigh,
    embeddingModel,
    similarityScore,
    label,
    actor,
  }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle match feedback requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [readIdLow, readIdHigh]
      );
      const previousResult = await client.query(
        `SELECT id, label, similarity_score, revision
         FROM public.vehicle_match_feedback
         WHERE read_id_low = $1 AND read_id_high = $2 AND embedding_model = $3
         FOR UPDATE`,
        [readIdLow, readIdHigh, embeddingModel]
      );
      const previous = previousResult.rows[0] || null;
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      const actorUsername = String(actor?.username || "legacy-admin").slice(0, 64);
      const actorDisplayName = String(actor?.displayName || "Legacy Administrator").slice(0, 120);
      const result = await client.query(
        `INSERT INTO public.vehicle_match_feedback (
           read_id_low, read_id_high, embedding_model, similarity_score, label,
           actor_user_id, actor_username, actor_display_name
         ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
         ON CONFLICT (read_id_low, read_id_high, embedding_model) DO UPDATE SET
           similarity_score = EXCLUDED.similarity_score,
           label = EXCLUDED.label,
           actor_user_id = EXCLUDED.actor_user_id,
           actor_username = EXCLUDED.actor_username,
           actor_display_name = EXCLUDED.actor_display_name,
           revision = public.vehicle_match_feedback.revision + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING id, read_id_low, read_id_high, embedding_model, similarity_score,
                   label, revision, updated_at, actor_username, actor_display_name`,
        [readIdLow, readIdHigh, embeddingModel, similarityScore, label,
          actorId, actorUsername, actorDisplayName]
      );
      const saved = result.rows[0];
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.match_feedback',
                   'vehicle_match_feedback', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({
          readIdLow,
          readIdHigh,
          embeddingModel,
          similarityScore: Number(Number(similarityScore).toFixed(4)),
          previousLabel: previous?.label || null,
          label,
          revision: Number(saved.revision),
        })]
      );
      if (connected) await client.query("COMMIT");
      return saved;
    } catch (error) {
      if (connected) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (connected) client.release();
    }
  }
}
