import {
  CAPTURE_ASSET_ALGORITHM,
  DEFAULT_CAMERA_CROP_PROFILE,
  MAX_SEARCH_CANDIDATES,
  normalizeCameraCropProfile,
} from "./image-similarity.mjs";
import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";
import { BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM } from "./blue-iris-trigger-direction.mjs";

const ASSET_TYPE = "vehicle_crop";
const PROFILE_JOIN = `LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(pr.camera_name))`;
const READS_PROFILE_JOIN = `LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(reads.camera_name))`;
const CURRENT_PROFILE = "ca.crop_profile_version = COALESCE(cvp.profile_version, 1)";
const DIRECTION_COLOR_PROVIDER = "local-hsv-histogram";
const DIRECTION_COLOR_MODEL = "vehicle-color-hsv-v2";

function directionImageEligibleSql(readIdExpression) {
  return `NOT EXISTS (
    SELECT 1 FROM public.vehicle_attribute_observations direction_color
    WHERE direction_color.read_id = ${readIdExpression}
      AND direction_color.attribute_key = 'color'
      AND direction_color.provider = '${DIRECTION_COLOR_PROVIDER}'
      AND direction_color.model_version = '${DIRECTION_COLOR_MODEL}'
      AND direction_color.raw_result->>'reason' = 'monochrome_capture'
  )`;
}

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

function boundedPagination(page, pageSize, { defaultSize, maximumSize = 100 } = {}) {
  const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const normalizedSize = Math.min(
    maximumSize,
    Math.max(1, Number.parseInt(pageSize, 10) || defaultSize)
  );
  return {
    page: normalizedPage,
    pageSize: normalizedSize,
    offset: (normalizedPage - 1) * normalizedSize,
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

  async getV1ProducerControl() {
    const result = await this.query(
      `SELECT mode, v1_producer_state, v1_producer_revision,
              v1_producer_reason, v1_producer_changed_at
       FROM public.vehicle_reid_control WHERE singleton = TRUE`
    );
    return result.rows?.[0] || null;
  }

  async withDerivedStorageWriterLock(operation) {
    return withStorageCleanupWriterLock(this.pool, (client) =>
      operation(new CaptureAssetRepository({ executor: client }))
    );
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

  async getPrimaryDirectionObservation(readId, classifierVersion = BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM) {
    const result = await this.query(
      `SELECT status, orientation, orientation_confidence, direction_label,
              profile_version, sample_counts
       FROM public.vehicle_direction_observations
       WHERE read_id = $1 AND classifier_version = $2 AND status = 'ready'`,
      [readId, classifierVersion]
    );
    return result.rows[0] || null;
  }

  async getDirectionImageEligibility(readId, provider, modelVersion) {
    const result = await this.query(
      `SELECT raw_result->>'reason' AS reason
       FROM public.vehicle_attribute_observations
       WHERE read_id = $1 AND attribute_key = 'color'
         AND provider = $2 AND model_version = $3
       ORDER BY evaluated_at DESC, id DESC LIMIT 1`,
      [readId, provider, modelVersion]
    );
    const reason = result.rows[0]?.reason || null;
    return {
      eligible: reason !== "monochrome_capture",
      reason: reason === "monochrome_capture" ? "monochrome_night_capture" : null,
    };
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
    colorSignature,
    colorSignatureVersion,
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
         detector_model, detection_confidence, color_signature, color_signature_version, crop_box,
         image_width, image_height, crop_width, crop_height, indexed_at
       ) VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                  $16, $17, $18, $19, CURRENT_TIMESTAMP)
       ON CONFLICT (read_id, asset_type, algorithm_version) DO UPDATE SET
         crop_profile_version = EXCLUDED.crop_profile_version, status = 'ready',
         source_image_path = EXCLUDED.source_image_path, derived_path = EXCLUDED.derived_path,
         source_sha256 = EXCLUDED.source_sha256, perceptual_hash = EXCLUDED.perceptual_hash,
          vehicle_embedding = EXCLUDED.vehicle_embedding, embedding_model = EXCLUDED.embedding_model,
          detector_model = EXCLUDED.detector_model, detection_confidence = EXCLUDED.detection_confidence,
         color_signature = EXCLUDED.color_signature, color_signature_version = EXCLUDED.color_signature_version,
         crop_box = EXCLUDED.crop_box, image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height, crop_width = EXCLUDED.crop_width,
         crop_height = EXCLUDED.crop_height, attempt_count = 1, error_code = NULL,
         indexed_at = CURRENT_TIMESTAMP RETURNING *`,
      [read.id, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, profileVersion, read.image_path,
        derivedPath, sourceSha256, perceptualHash, vehicleEmbedding, embeddingModel, detectorModel,
        detectionConfidence, colorSignature, colorSignatureVersion, JSON.stringify(crop),
        imageWidth, imageHeight, crop.width, crop.height]
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

  async listDirectionProfiles(embeddingModel) {
    const result = await this.query(
      `SELECT cameras.camera_name, profiles.enabled, profiles.front_direction_label,
              profiles.rear_direction_label, profiles.minimum_confidence,
              profiles.blue_iris_motion_enabled,
              profiles.blue_iris_front_trigger_type,
              profiles.blue_iris_rear_trigger_type,
              profiles.blue_iris_motion_profile_version,
              COALESCE(profiles.profile_version, 1) AS profile_version,
              COUNT(labels.id) FILTER (WHERE labels.orientation = 'front')::integer AS front_count,
              COUNT(labels.id) FILTER (WHERE labels.orientation = 'rear')::integer AS rear_count
       FROM (
         SELECT DISTINCT ON (LOWER(BTRIM(camera_name))) camera_name
         FROM public.plate_reads
         WHERE camera_name IS NOT NULL AND BTRIM(camera_name) <> ''
         ORDER BY LOWER(BTRIM(camera_name)), "timestamp" DESC
       ) cameras
       LEFT JOIN public.camera_direction_profiles profiles
         ON profiles.camera_key = LOWER(BTRIM(cameras.camera_name))
       LEFT JOIN public.vehicle_orientation_labels labels
         ON labels.camera_key = LOWER(BTRIM(cameras.camera_name))
        AND labels.embedding_model = $1
       GROUP BY cameras.camera_name, profiles.enabled, profiles.front_direction_label,
                profiles.rear_direction_label, profiles.minimum_confidence,
                profiles.blue_iris_motion_enabled, profiles.blue_iris_front_trigger_type,
                profiles.blue_iris_rear_trigger_type,
                profiles.blue_iris_motion_profile_version, profiles.profile_version
       ORDER BY cameras.camera_name`,
      [embeddingModel]
    );
    return result.rows;
  }

  async getDirectionProfile(cameraName) {
    const result = await this.query(
      `SELECT camera_name, enabled, front_direction_label, rear_direction_label,
              minimum_confidence, blue_iris_motion_enabled,
              blue_iris_front_trigger_type, blue_iris_rear_trigger_type,
              blue_iris_motion_profile_version, profile_version
       FROM public.camera_direction_profiles
       WHERE camera_key = LOWER(BTRIM($1))`,
      [cameraName]
    );
    return result.rows[0] || null;
  }

  async saveDirectionProfile(profile, actor) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Camera direction setup requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO public.camera_direction_profiles (
           camera_key, camera_name, enabled, front_direction_label,
           rear_direction_label, minimum_confidence, blue_iris_motion_enabled,
           blue_iris_front_trigger_type, blue_iris_rear_trigger_type
         ) VALUES (LOWER(BTRIM($1)), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (camera_key) DO UPDATE SET
           camera_name = EXCLUDED.camera_name,
           enabled = EXCLUDED.enabled,
           front_direction_label = EXCLUDED.front_direction_label,
           rear_direction_label = EXCLUDED.rear_direction_label,
           minimum_confidence = EXCLUDED.minimum_confidence,
           blue_iris_motion_enabled = EXCLUDED.blue_iris_motion_enabled,
           blue_iris_front_trigger_type = EXCLUDED.blue_iris_front_trigger_type,
           blue_iris_rear_trigger_type = EXCLUDED.blue_iris_rear_trigger_type,
           blue_iris_motion_profile_version = CASE WHEN
             public.camera_direction_profiles.front_direction_label IS DISTINCT FROM EXCLUDED.front_direction_label OR
             public.camera_direction_profiles.rear_direction_label IS DISTINCT FROM EXCLUDED.rear_direction_label OR
             public.camera_direction_profiles.blue_iris_motion_enabled IS DISTINCT FROM EXCLUDED.blue_iris_motion_enabled OR
             public.camera_direction_profiles.blue_iris_front_trigger_type IS DISTINCT FROM EXCLUDED.blue_iris_front_trigger_type OR
             public.camera_direction_profiles.blue_iris_rear_trigger_type IS DISTINCT FROM EXCLUDED.blue_iris_rear_trigger_type
           THEN public.camera_direction_profiles.blue_iris_motion_profile_version + 1
           ELSE public.camera_direction_profiles.blue_iris_motion_profile_version END,
           profile_version = CASE WHEN
             public.camera_direction_profiles.enabled IS DISTINCT FROM EXCLUDED.enabled OR
             public.camera_direction_profiles.front_direction_label IS DISTINCT FROM EXCLUDED.front_direction_label OR
             public.camera_direction_profiles.rear_direction_label IS DISTINCT FROM EXCLUDED.rear_direction_label OR
             public.camera_direction_profiles.minimum_confidence IS DISTINCT FROM EXCLUDED.minimum_confidence
           THEN public.camera_direction_profiles.profile_version + 1
           ELSE public.camera_direction_profiles.profile_version END,
           updated_at = CURRENT_TIMESTAMP
         RETURNING camera_name, enabled, front_direction_label, rear_direction_label,
                   minimum_confidence, blue_iris_motion_enabled,
                   blue_iris_front_trigger_type, blue_iris_rear_trigger_type,
                   blue_iris_motion_profile_version, profile_version`,
        [profile.cameraName, profile.enabled, profile.frontDirectionLabel,
          profile.rearDirectionLabel, profile.minimumConfidence,
          profile.blueIrisMotionEnabled, profile.blueIrisFrontTriggerType,
          profile.blueIrisRearTriggerType]
      );
      const saved = result.rows[0];
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.direction_profile',
                   'camera_direction_profile', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(profile.cameraName).trim().toLowerCase(), JSON.stringify({
          cameraName: saved.camera_name,
          enabled: saved.enabled,
          frontDirectionLabel: saved.front_direction_label,
          rearDirectionLabel: saved.rear_direction_label,
          minimumConfidence: Number(saved.minimum_confidence),
          blueIrisMotionEnabled: saved.blue_iris_motion_enabled,
          blueIrisFrontTriggerType: saved.blue_iris_front_trigger_type,
          blueIrisRearTriggerType: saved.blue_iris_rear_trigger_type,
          blueIrisMotionProfileVersion: Number(saved.blue_iris_motion_profile_version),
          profileVersion: Number(saved.profile_version),
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

  async getBlueIrisTriggerDirectionStatus(cameraName) {
    const selectedCamera = String(cameraName || "").trim();
    if (!selectedCamera) {
      return { received: 0, ready: 0, unknown: 0, unmapped: 0, latest_at: null, recent: [] };
    }
    const [summary, recent] = await Promise.all([
      this.query(
        `SELECT
           COUNT(*)::integer AS received,
           COUNT(*) FILTER (WHERE bi_trigger_direction_status = 'ready')::integer AS ready,
           COUNT(*) FILTER (WHERE bi_trigger_direction_status = 'unknown')::integer AS unknown,
           COUNT(*) FILTER (
             WHERE bi_trigger_direction_status = 'unknown'
               AND bi_trigger_direction_error_code = 'TRIGGER_TYPE_UNMAPPED'
           )::integer AS unmapped,
           MAX(timestamp) AS latest_at
         FROM public.plate_reads
         WHERE camera_name = $1
           AND bi_trigger_direction_status IS NOT NULL`,
        [selectedCamera]
      ),
      this.query(
        `SELECT reads.id AS read_id, reads.plate_number, reads.observed_plate,
                reads.camera_name, reads.timestamp, reads.bi_trigger_type,
                reads.bi_trigger_direction_status, reads.bi_trigger_direction_label,
                reads.bi_trigger_direction_error_code,
                current_direction.direction_label AS current_direction_label
         FROM public.plate_reads reads
         LEFT JOIN public.vehicle_direction_observations current_direction
           ON current_direction.read_id = reads.id
         WHERE reads.camera_name = $1
           AND reads.bi_trigger_direction_status IS NOT NULL
         ORDER BY reads.timestamp DESC, reads.id DESC
         LIMIT 20`,
        [selectedCamera]
      ),
    ]);
    return {
      ...(summary.rows[0] || {
      received: 0,
      ready: 0,
      unknown: 0,
      unmapped: 0,
      latest_at: null,
      }),
      recent: recent.rows,
    };
  }

  async listOrientationSamples(cameraName, embeddingModel) {
    const result = await this.query(
      `SELECT labels.read_id, labels.orientation, assets.vehicle_embedding
       FROM public.vehicle_orientation_labels labels
       JOIN public.capture_assets assets ON assets.read_id = labels.read_id
       WHERE labels.camera_key = LOWER(BTRIM($1))
         AND labels.embedding_model = $2
         AND assets.embedding_model = $2
         AND assets.status = 'ready' AND assets.vehicle_embedding IS NOT NULL
         AND ${directionImageEligibleSql("labels.read_id")}`,
      [cameraName, embeddingModel]
    );
    return result.rows;
  }

  async listDirectionCalibrationCaptures(cameraName, embeddingModel, limit = 24) {
    const result = await this.query(
      `SELECT assets.read_id, assets.derived_path, reads.plate_number,
              reads.observed_plate, reads.camera_name, reads."timestamp",
              labels.orientation, labels.revision,
              observations.status AS direction_status,
              observations.orientation AS predicted_orientation,
              observations.orientation_confidence,
              observations.direction_label
       FROM public.capture_assets assets
       JOIN public.plate_reads reads ON reads.id = assets.read_id
       LEFT JOIN public.vehicle_orientation_labels labels
         ON labels.read_id = assets.read_id AND labels.embedding_model = $2
       LEFT JOIN public.vehicle_direction_observations observations
         ON observations.read_id = assets.read_id
       WHERE LOWER(BTRIM(reads.camera_name)) = LOWER(BTRIM($1))
         AND assets.status = 'ready' AND assets.embedding_model = $2
         AND assets.vehicle_embedding IS NOT NULL
         AND ${directionImageEligibleSql("assets.read_id")}
       ORDER BY reads."timestamp" DESC, reads.id DESC LIMIT $3`,
      [cameraName, embeddingModel, limit]
    );
    return result.rows;
  }

  async listDirectionAssets(cameraName, embeddingModel, limit = 250) {
    const result = await this.query(
      `SELECT assets.read_id, assets.vehicle_embedding, reads.camera_name
       FROM public.capture_assets assets
       JOIN public.plate_reads reads ON reads.id = assets.read_id
       WHERE LOWER(BTRIM(reads.camera_name)) = LOWER(BTRIM($1))
         AND assets.status = 'ready' AND assets.embedding_model = $2
         AND assets.vehicle_embedding IS NOT NULL
         AND ${directionImageEligibleSql("assets.read_id")}
       ORDER BY reads."timestamp" DESC, reads.id DESC LIMIT $3`,
      [cameraName, embeddingModel, limit]
    );
    return result.rows;
  }

  async getDirectionBackfillStatus(embeddingModel, classifierVersion) {
    const result = await this.query(
      `WITH eligible AS (
         SELECT ca.read_id, profiles.profile_version,
                observations.read_id AS observation_read_id,
                observations.embedding_model AS observation_embedding_model,
                observations.classifier_version,
                observations.profile_version AS observation_profile_version,
                observations.status,
                failures.attempt_count AS failure_attempt_count,
                reevaluation.read_id AS reevaluation_read_id
         FROM public.capture_assets ca
         JOIN public.plate_reads reads ON reads.id = ca.read_id
         ${READS_PROFILE_JOIN}
         JOIN public.camera_direction_profiles profiles
           ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
         LEFT JOIN public.vehicle_direction_observations observations
           ON observations.read_id = ca.read_id
         LEFT JOIN public.vehicle_direction_backfill_failures failures
           ON failures.read_id = ca.read_id
          AND failures.embedding_model = $3
          AND failures.classifier_version = $4
          AND failures.profile_version = profiles.profile_version
         LEFT JOIN public.vehicle_direction_reevaluation_queue reevaluation
           ON reevaluation.read_id = ca.read_id
         WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
           AND ca.status = 'ready' AND ${CURRENT_PROFILE}
           AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
           AND ${directionImageEligibleSql("ca.read_id")}
           AND NOT (
             observations.classifier_version IS NOT DISTINCT FROM $5
             AND observations.status IS NOT DISTINCT FROM 'ready'
           )
       )
       SELECT COUNT(*)::integer AS eligible,
              COUNT(*) FILTER (
                WHERE observation_read_id IS NOT NULL
                  AND observation_embedding_model = $3
                  AND classifier_version = $4
                  AND observation_profile_version = profile_version
              )::integer AS populated,
              COUNT(*) FILTER (
                WHERE observation_read_id IS NOT NULL
                  AND observation_embedding_model = $3
                  AND classifier_version = $4
                  AND observation_profile_version = profile_version
                  AND status = 'ready'
              )::integer AS ready,
              COUNT(*) FILTER (
                WHERE observation_read_id IS NOT NULL
                  AND observation_embedding_model = $3
                  AND classifier_version = $4
                  AND observation_profile_version = profile_version
                  AND status <> 'ready'
              )::integer AS unknown,
              COUNT(*) FILTER (
                WHERE COALESCE(failure_attempt_count, 0) >= 3
                  AND (
                    reevaluation_read_id IS NOT NULL OR
                    observation_read_id IS NULL OR
                    observation_embedding_model IS DISTINCT FROM $3 OR
                    classifier_version IS DISTINCT FROM $4 OR
                    observation_profile_version IS DISTINCT FROM profile_version
                  )
              )::integer AS failed,
              COUNT(*) FILTER (
                WHERE reevaluation_read_id IS NULL
                  AND (
                    observation_read_id IS NULL OR
                    observation_embedding_model IS DISTINCT FROM $3 OR
                    classifier_version IS DISTINCT FROM $4 OR
                    observation_profile_version IS DISTINCT FROM profile_version
                  )
                  AND COALESCE(failure_attempt_count, 0) < 3
              )::integer AS new_pending,
              COUNT(*) FILTER (
                WHERE reevaluation_read_id IS NOT NULL
                  AND COALESCE(failure_attempt_count, 0) < 3
              )::integer AS reevaluation_pending,
              COALESCE((
                SELECT paused
                FROM public.vehicle_direction_reevaluation_control
                WHERE singleton = TRUE
              ), FALSE) AS reevaluation_paused
       FROM eligible`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, classifierVersion,
        BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM]
    );
    const row = result.rows[0] || {};
    const eligible = Number(row.eligible || 0);
    const populated = Number(row.populated || 0);
    const failed = Number(row.failed || 0);
    const newPending = Number(row.new_pending || 0);
    const reevaluationPending = Number(row.reevaluation_pending || 0);
    const reevaluationPaused = row.reevaluation_paused === true;
    const pending = newPending + reevaluationPending;
    return {
      eligible,
      populated,
      completed: Math.max(0, eligible - pending - failed),
      pending,
      actionablePending: newPending + (reevaluationPaused ? 0 : reevaluationPending),
      newPending,
      reevaluationPending,
      reevaluationPaused,
      ready: Number(row.ready || 0),
      unknown: Number(row.unknown || 0),
      failed,
    };
  }

  async getDirectionReevaluationPreview(cameraName, embeddingModel, classifierVersion) {
    const values = [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, classifierVersion,
      BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM];
    const cameraFilter = cameraName
      ? (values.push(cameraName), `AND LOWER(BTRIM(reads.camera_name)) = LOWER(BTRIM($${values.length}))`)
      : "";
    const result = await this.query(
      `WITH eligible AS (
         SELECT ca.read_id, reads.camera_name,
                observations.read_id AS observation_read_id,
                observations.status,
                observations.embedding_model AS observation_embedding_model,
                observations.classifier_version AS observation_classifier_version,
                observations.profile_version AS observation_profile_version,
                profiles.profile_version,
                labels.read_id AS reviewed_read_id
         FROM public.capture_assets ca
         JOIN public.plate_reads reads ON reads.id = ca.read_id
         ${READS_PROFILE_JOIN}
         JOIN public.camera_direction_profiles profiles
           ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
         LEFT JOIN public.vehicle_direction_observations observations
           ON observations.read_id = ca.read_id
         LEFT JOIN public.vehicle_orientation_labels labels
           ON labels.read_id = ca.read_id AND labels.embedding_model = $3
         WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
           AND ca.status = 'ready' AND ${CURRENT_PROFILE}
           AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
           AND ${directionImageEligibleSql("ca.read_id")}
           AND NOT (
             observations.classifier_version IS NOT DISTINCT FROM $5
             AND observations.status IS NOT DISTINCT FROM 'ready'
           )
           ${cameraFilter}
       )
       SELECT COUNT(*)::integer AS eligible,
              COUNT(DISTINCT LOWER(BTRIM(camera_name)))::integer AS camera_count,
              COUNT(*) FILTER (WHERE reviewed_read_id IS NOT NULL)::integer AS manual_preserved,
              COUNT(*) FILTER (WHERE reviewed_read_id IS NULL)::integer AS queued,
              COUNT(*) FILTER (
                WHERE reviewed_read_id IS NULL AND observation_read_id IS NOT NULL AND status = 'ready'
              )::integer AS previous_ready,
              COUNT(*) FILTER (
                WHERE reviewed_read_id IS NULL AND observation_read_id IS NOT NULL AND status <> 'ready'
              )::integer AS previous_unknown,
              COUNT(*) FILTER (
                WHERE reviewed_read_id IS NULL AND (
                  observation_read_id IS NULL OR
                  observation_embedding_model IS DISTINCT FROM $3 OR
                  observation_classifier_version IS DISTINCT FROM $4 OR
                  observation_profile_version IS DISTINCT FROM profile_version
                )
              )::integer AS already_pending
       FROM eligible`,
      values
    );
    const row = result.rows[0] || {};
    return {
      cameraName: cameraName || null,
      eligible: Number(row.eligible || 0),
      cameraCount: Number(row.camera_count || 0),
      manualPreserved: Number(row.manual_preserved || 0),
      queued: Number(row.queued || 0),
      previousReady: Number(row.previous_ready || 0),
      previousUnknown: Number(row.previous_unknown || 0),
      alreadyPending: Number(row.already_pending || 0),
    };
  }

  async queueDirectionReevaluation({ cameraName = null, embeddingModel, classifierVersion, actor } = {}) {
    const normalizedCameraName = String(cameraName || "").trim() || null;
    const preview = await this.getDirectionReevaluationPreview(
      normalizedCameraName,
      embeddingModel,
      classifierVersion
    );
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Historical direction re-evaluation requires a database client");
    const values = [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel,
      BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM];
    const cameraFilter = normalizedCameraName
      ? (values.push(normalizedCameraName), `AND LOWER(BTRIM(reads.camera_name)) = LOWER(BTRIM($${values.length}))`)
      : "";
    const targetReads = `SELECT ca.read_id
       FROM public.capture_assets ca
       JOIN public.plate_reads reads ON reads.id = ca.read_id
       ${READS_PROFILE_JOIN}
       JOIN public.camera_direction_profiles profiles
         ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
       LEFT JOIN public.vehicle_orientation_labels labels
         ON labels.read_id = ca.read_id AND labels.embedding_model = $3
       LEFT JOIN public.vehicle_direction_observations observations
         ON observations.read_id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND ${CURRENT_PROFILE}
         AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
         AND ${directionImageEligibleSql("ca.read_id")}
         AND labels.read_id IS NULL
         AND NOT (
           observations.classifier_version IS NOT DISTINCT FROM $4
           AND observations.status IS NOT DISTINCT FROM 'ready'
         )
         ${cameraFilter}`;
    try {
      if (connected) await client.query("BEGIN");
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      const queued = await client.query(
        `WITH target_reads AS (${targetReads})
         INSERT INTO public.vehicle_direction_reevaluation_queue (
           read_id, camera_key, requested_by_user_id, requested_at
         )
         SELECT target_reads.read_id, LOWER(BTRIM(reads.camera_name)), $${values.length + 1}::bigint,
                CURRENT_TIMESTAMP
         FROM target_reads
         JOIN public.plate_reads reads ON reads.id = target_reads.read_id
         ON CONFLICT (read_id) DO UPDATE SET
           camera_key = EXCLUDED.camera_key,
           requested_by_user_id = EXCLUDED.requested_by_user_id,
           requested_at = CURRENT_TIMESTAMP
         RETURNING read_id`,
        [...values, actorId]
      );
      const clearedFailures = await client.query(
        `WITH target_reads AS (${targetReads})
         DELETE FROM public.vehicle_direction_backfill_failures failures
         USING target_reads
         WHERE failures.read_id = target_reads.read_id
         RETURNING failures.read_id`,
        values
      );
      await client.query(
        `INSERT INTO public.vehicle_direction_reevaluation_control (
           singleton, paused, updated_by_user_id, updated_at
         ) VALUES (TRUE, FALSE, $1::bigint, CURRENT_TIMESTAMP)
         ON CONFLICT (singleton) DO UPDATE SET
           paused = FALSE,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = CURRENT_TIMESTAMP`,
        [actorId]
      );
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.direction_reevaluation_queued',
                   'vehicle_direction_observations', $2, 'succeeded', $3::jsonb)`,
        [actorId, normalizedCameraName ? normalizedCameraName.toLowerCase() : "all-cameras", JSON.stringify({
          cameraName: normalizedCameraName,
          cameraCount: preview.cameraCount,
          queued: preview.queued,
          manualPreserved: preview.manualPreserved,
          preserved: queued.rows.length,
          previousReady: preview.previousReady,
          previousUnknown: preview.previousUnknown,
          failuresCleared: clearedFailures.rows.length,
          embeddingModel,
          classifierVersion,
        })]
      );
      if (connected) await client.query("COMMIT");
      return {
        ...preview,
        queued: queued.rows.length,
        preserved: queued.rows.length,
        failuresCleared: clearedFailures.rows.length,
      };
    } catch (error) {
      if (connected) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (connected) client.release();
    }
  }

  async setDirectionReevaluationPaused(paused, actor = null) {
    const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
    const result = await this.query(
      `INSERT INTO public.vehicle_direction_reevaluation_control (
         singleton, paused, updated_by_user_id, updated_at
       ) VALUES (TRUE, $1, $2::bigint, CURRENT_TIMESTAMP)
       ON CONFLICT (singleton) DO UPDATE SET
         paused = EXCLUDED.paused,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = CURRENT_TIMESTAMP
       RETURNING paused, updated_at`,
      [paused === true, actorId]
    );
    await this.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1::bigint, 'browser', $2,
                 'vehicle_direction_reevaluation_queue', 'historical', 'succeeded', $3::jsonb)`,
      [actorId,
        paused === true ? "vehicle.direction_reevaluation_paused" : "vehicle.direction_reevaluation_resumed",
        JSON.stringify({ paused: paused === true })]
    );
    return {
      paused: result.rows[0]?.paused === true,
      updatedAt: result.rows[0]?.updated_at || null,
    };
  }

  async listDirectionBackfillCandidates(
    embeddingModel,
    classifierVersion,
    limit = 20,
    { includeReevaluation = true } = {}
  ) {
    const result = await this.query(
      `SELECT ca.read_id, profiles.profile_version
       FROM public.capture_assets ca
       JOIN public.plate_reads reads ON reads.id = ca.read_id
       ${READS_PROFILE_JOIN}
       JOIN public.camera_direction_profiles profiles
         ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
       LEFT JOIN public.vehicle_direction_observations observations
         ON observations.read_id = ca.read_id
       LEFT JOIN public.vehicle_direction_backfill_failures failures
         ON failures.read_id = ca.read_id
        AND failures.embedding_model = $3
        AND failures.classifier_version = $4
        AND failures.profile_version = profiles.profile_version
       LEFT JOIN public.vehicle_direction_reevaluation_queue reevaluation
         ON reevaluation.read_id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND ${CURRENT_PROFILE}
         AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
         AND ${directionImageEligibleSql("ca.read_id")}
         AND (
           (reevaluation.read_id IS NULL AND (
             observations.read_id IS NULL OR
             observations.embedding_model IS DISTINCT FROM $3 OR
             observations.classifier_version IS DISTINCT FROM $4 OR
             observations.profile_version IS DISTINCT FROM profiles.profile_version
           )) OR
           ($6::boolean = TRUE AND reevaluation.read_id IS NOT NULL)
         )
         AND NOT (
           observations.classifier_version IS NOT DISTINCT FROM $7
           AND observations.status IS NOT DISTINCT FROM 'ready'
         )
         AND (failures.read_id IS NULL OR failures.attempt_count < 3)
       ORDER BY
         CASE WHEN reevaluation.read_id IS NULL THEN 0 ELSE 1 END ASC,
         ca.read_id DESC
       LIMIT $5`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, classifierVersion, limit,
        includeReevaluation === true, BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM]
    );
    return result.rows;
  }

  async clearDirectionBackfillFailure(readId) {
    await this.query(
      "DELETE FROM public.vehicle_direction_backfill_failures WHERE read_id = $1",
      [readId]
    );
  }

  async recordDirectionBackfillFailure({
    readId,
    embeddingModel,
    classifierVersion,
    profileVersion,
    error,
  }) {
    await this.query(
      `INSERT INTO public.vehicle_direction_backfill_failures (
         read_id, embedding_model, classifier_version, profile_version,
         error_code, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (read_id) DO UPDATE SET
         embedding_model = EXCLUDED.embedding_model,
         classifier_version = EXCLUDED.classifier_version,
         profile_version = EXCLUDED.profile_version,
         attempt_count = CASE WHEN
           public.vehicle_direction_backfill_failures.embedding_model = EXCLUDED.embedding_model AND
           public.vehicle_direction_backfill_failures.classifier_version = EXCLUDED.classifier_version AND
           public.vehicle_direction_backfill_failures.profile_version = EXCLUDED.profile_version
         THEN public.vehicle_direction_backfill_failures.attempt_count + 1 ELSE 1 END,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         last_failed_at = CURRENT_TIMESTAMP`,
      [readId, embeddingModel, classifierVersion, profileVersion,
        String(error?.code || "DIRECTION_BACKFILL_FAILED").slice(0, 80),
        String(error?.message || "Historical direction evaluation failed").slice(0, 500)]
    );
  }

  async saveOrientationLabel({ readId, cameraName, embeddingModel, orientation, actor }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle orientation labeling requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      const result = await client.query(
        `INSERT INTO public.vehicle_orientation_labels (
           read_id, camera_key, embedding_model, orientation,
           actor_user_id, actor_username, actor_display_name
         ) VALUES ($1, LOWER(BTRIM($2)), $3, $4, $5::bigint, $6, $7)
         ON CONFLICT (read_id, embedding_model) DO UPDATE SET
           camera_key = EXCLUDED.camera_key, orientation = EXCLUDED.orientation,
           actor_user_id = EXCLUDED.actor_user_id,
           actor_username = EXCLUDED.actor_username,
           actor_display_name = EXCLUDED.actor_display_name,
           revision = public.vehicle_orientation_labels.revision + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING id, read_id, orientation, revision, updated_at`,
        [readId, cameraName, embeddingModel, orientation, actorId,
          String(actor?.username || "legacy-admin").slice(0, 64),
          String(actor?.displayName || "Legacy Administrator").slice(0, 120)]
      );
      const saved = result.rows[0];
      await client.query(
        `UPDATE public.camera_direction_profiles
         SET profile_version = profile_version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE camera_key = LOWER(BTRIM($1))`,
        [cameraName]
      );
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.orientation_label',
                   'vehicle_orientation_label', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({ readId, cameraName, embeddingModel, orientation, revision: Number(saved.revision) })]
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

  async saveDirectionObservation({ readId, cameraName, embeddingModel, classifierVersion, profileVersion, result, directionLabel }) {
    await this.query(
      `INSERT INTO public.vehicle_direction_observations (
         read_id, camera_key, embedding_model, classifier_version, profile_version,
         status, orientation, orientation_confidence, direction_label, sample_counts
       ) VALUES ($1, LOWER(BTRIM($2)), $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (read_id) DO UPDATE SET
         camera_key = EXCLUDED.camera_key, embedding_model = EXCLUDED.embedding_model,
         classifier_version = EXCLUDED.classifier_version, profile_version = EXCLUDED.profile_version,
         status = EXCLUDED.status, orientation = EXCLUDED.orientation,
         orientation_confidence = EXCLUDED.orientation_confidence,
         direction_label = EXCLUDED.direction_label, sample_counts = EXCLUDED.sample_counts,
         evaluated_at = CURRENT_TIMESTAMP
       WHERE public.vehicle_direction_observations.classifier_version IS DISTINCT FROM $11`,
      [readId, cameraName, embeddingModel, classifierVersion, profileVersion,
        result.status, result.orientation, result.confidence, directionLabel,
        JSON.stringify(result.counts), BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM]
    );
    await this.query(
      "DELETE FROM public.vehicle_direction_reevaluation_queue WHERE read_id = $1",
      [readId]
    );
    await this.clearDirectionBackfillFailure(readId);
  }

  async saveVehicleAttributeObservation({
    readId,
    attributeKey,
    status,
    attributeValue,
    confidence,
    provider,
    modelVersion,
    rawResult,
    errorCode = null,
  }) {
    const result = await this.query(
      `INSERT INTO public.vehicle_attribute_observations (
         read_id, attribute_key, status, attribute_value, confidence,
         provider, model_version, raw_result, error_code
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (read_id, attribute_key, provider, model_version) DO UPDATE SET
         status = EXCLUDED.status, attribute_value = EXCLUDED.attribute_value,
         confidence = EXCLUDED.confidence, raw_result = EXCLUDED.raw_result,
         error_code = EXCLUDED.error_code, evaluated_at = CURRENT_TIMESTAMP
       RETURNING id, read_id, attribute_key, status, attribute_value,
                 confidence, provider, model_version, evaluated_at`,
      [readId, attributeKey, status, attributeValue, confidence, provider,
        modelVersion, JSON.stringify(rawResult || {}), errorCode]
    );
    return result.rows[0];
  }

  async getVehicleClusterAssignment(readId) {
    const result = await this.query(
      `SELECT read_id, cluster_id, assignment_status, similarity, similarity_margin,
              embedding_model, algorithm_version, revision, updated_at
       FROM public.vehicle_cluster_assignments WHERE read_id = $1`,
      [readId]
    );
    return result.rows[0] || null;
  }

  async listVehicleClusterRepresentatives(embeddingModel, limit = 500) {
    const result = await this.query(
      `SELECT clusters.id AS cluster_id, assets.vehicle_embedding
       FROM public.vehicle_clusters clusters
       JOIN public.capture_assets assets ON assets.read_id = clusters.representative_read_id
       WHERE clusters.status IN ('shadow', 'confirmed')
         AND clusters.embedding_model = $1
         AND assets.status = 'ready' AND assets.embedding_model = $1
         AND assets.vehicle_embedding IS NOT NULL
       ORDER BY clusters.updated_at DESC, clusters.id DESC LIMIT $2`,
      [embeddingModel, limit]
    );
    return result.rows;
  }

  async saveShadowClusterDecision({ readId, embeddingModel, algorithmVersion, decision }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle clustering requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [9021, readId]);
      const existing = await client.query(
        `SELECT read_id, cluster_id, assignment_status, similarity, similarity_margin,
                embedding_model, algorithm_version, revision, updated_at
         FROM public.vehicle_cluster_assignments WHERE read_id = $1 FOR UPDATE`,
        [readId]
      );
      if (existing.rows[0]) {
        if (connected) await client.query("COMMIT");
        return existing.rows[0];
      }
      let clusterId = decision.clusterId;
      let status = "suggested";
      if (decision.decision !== "suggest" || !Number.isSafeInteger(Number(clusterId))) {
        const cluster = await client.query(
          `INSERT INTO public.vehicle_clusters (
             representative_read_id, embedding_model, algorithm_version
           ) VALUES ($1, $2, $3)
           ON CONFLICT (representative_read_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [readId, embeddingModel, algorithmVersion]
        );
        clusterId = Number(cluster.rows[0].id);
        status = "seed";
      }
      const result = await client.query(
        `INSERT INTO public.vehicle_cluster_assignments (
           read_id, cluster_id, assignment_status, similarity, similarity_margin,
           embedding_model, algorithm_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING read_id, cluster_id, assignment_status, similarity, similarity_margin,
                   embedding_model, algorithm_version, revision, updated_at`,
        [readId, clusterId, status, status === "seed" ? null : decision.similarity,
          status === "seed" ? null : decision.margin, embeddingModel, algorithmVersion]
      );
      if (connected) await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      if (connected) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (connected) client.release();
    }
  }

  async listUnassignedVehicleAssets(embeddingModel, limit = 100) {
    const result = await this.query(
      `SELECT assets.read_id, assets.derived_path, assets.vehicle_embedding, assets.embedding_model
       FROM public.capture_assets assets
       JOIN public.plate_reads pr ON pr.id = assets.read_id
       ${PROFILE_JOIN}
       LEFT JOIN public.vehicle_cluster_assignments assignment ON assignment.read_id = assets.read_id
       WHERE assets.status = 'ready' AND assets.embedding_model = $1
         AND assets.asset_type = $2 AND assets.algorithm_version = $3
         AND assets.crop_profile_version = COALESCE(cvp.profile_version, 1)
         AND assets.vehicle_embedding IS NOT NULL AND assignment.read_id IS NULL
       ORDER BY assets.indexed_at ASC, assets.read_id ASC LIMIT $4`,
      [embeddingModel, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, limit]
    );
    return result.rows;
  }

  async listPendingVehicleColorAssets(provider, modelVersion, limit = 100) {
    const result = await this.query(
      `SELECT assets.read_id, assets.derived_path
       FROM public.capture_assets assets
       JOIN public.plate_reads pr ON pr.id = assets.read_id
       ${PROFILE_JOIN}
       LEFT JOIN public.vehicle_attribute_observations observation
         ON observation.read_id = assets.read_id AND observation.attribute_key = 'color'
        AND observation.provider = $1 AND observation.model_version = $2
       WHERE assets.status = 'ready' AND assets.derived_path IS NOT NULL
         AND assets.asset_type = $3 AND assets.algorithm_version = $4
         AND assets.crop_profile_version = COALESCE(cvp.profile_version, 1)
         AND observation.id IS NULL
       ORDER BY assets.indexed_at DESC, assets.read_id DESC LIMIT $5`,
      [provider, modelVersion, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, limit]
    );
    return result.rows;
  }

  async listPendingVehicleAttributeAssets({
    attributeKey,
    provider,
    modelVersion,
    limit = 100,
  }) {
    const boundedLimit = Math.min(250, Math.max(1, Number.parseInt(limit, 10) || 100));
    const result = await this.query(
      `SELECT assets.read_id, assets.derived_path
       FROM public.capture_assets assets
       JOIN public.plate_reads pr ON pr.id = assets.read_id
       ${PROFILE_JOIN}
       LEFT JOIN public.vehicle_attribute_observations observation
         ON observation.read_id = assets.read_id
        AND observation.attribute_key = $1
        AND observation.provider = $2
        AND observation.model_version = $3
       WHERE assets.status = 'ready' AND assets.derived_path IS NOT NULL
         AND assets.asset_type = $4 AND assets.algorithm_version = $5
         AND assets.crop_profile_version = COALESCE(cvp.profile_version, 1)
         AND observation.id IS NULL
       ORDER BY assets.indexed_at DESC, assets.read_id DESC LIMIT $6`,
      [
        String(attributeKey),
        String(provider),
        String(modelVersion),
        ASSET_TYPE,
        CAPTURE_ASSET_ALGORITHM,
        boundedLimit,
      ]
    );
    return result.rows;
  }

  async getPendingVehicleAttributeCount({ attributeKey, provider, modelVersion }) {
    const result = await this.query(
      `SELECT COUNT(*)::integer AS pending
       FROM public.capture_assets assets
       JOIN public.plate_reads pr ON pr.id = assets.read_id
       ${PROFILE_JOIN}
       LEFT JOIN public.vehicle_attribute_observations observation
         ON observation.read_id = assets.read_id
        AND observation.attribute_key = $1
        AND observation.provider = $2
        AND observation.model_version = $3
       WHERE assets.status = 'ready' AND assets.derived_path IS NOT NULL
         AND assets.asset_type = $4 AND assets.algorithm_version = $5
         AND assets.crop_profile_version = COALESCE(cvp.profile_version, 1)
         AND observation.id IS NULL`,
      [
        String(attributeKey),
        String(provider),
        String(modelVersion),
        ASSET_TYPE,
        CAPTURE_ASSET_ALGORITHM,
      ]
    );
    return Number(result.rows[0]?.pending || 0);
  }

  async saveCaptureColorSignature(readId, colorSignature, colorSignatureVersion) {
    await this.query(
      `UPDATE public.capture_assets SET color_signature = $2, color_signature_version = $3
       WHERE read_id = $1 AND asset_type = $4 AND algorithm_version = $5 AND status = 'ready'`,
      [readId, colorSignature, colorSignatureVersion, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
  }

  async refreshVehiclePlateAssociationSuggestion(client, clusterId, plateNumber) {
    const normalizedClusterId = Number(clusterId);
    const normalizedPlate = String(plateNumber || "").trim().toUpperCase();
    if (!Number.isSafeInteger(normalizedClusterId) || normalizedClusterId < 1 || !normalizedPlate) {
      return null;
    }
    const result = await client.query(
      `INSERT INTO public.vehicle_plate_associations (
         cluster_id, plate_number, status, evidence_count, confidence,
         first_seen_at, last_seen_at
       )
       SELECT $1::bigint, $2::varchar, 'suggested', COUNT(*)::integer,
              AVG(assignments.similarity)::real,
              MIN(reads."timestamp"), MAX(reads."timestamp")
       FROM public.vehicle_cluster_assignments assignments
       JOIN public.plate_reads reads ON reads.id = assignments.read_id
       WHERE assignments.cluster_id = $1::bigint
         AND assignments.assignment_status = 'confirmed'
         AND reads.plate_number = $2::varchar
       HAVING COUNT(*) > 0
       ON CONFLICT (cluster_id, plate_number) DO UPDATE SET
         evidence_count = EXCLUDED.evidence_count,
         confidence = EXCLUDED.confidence,
         first_seen_at = EXCLUDED.first_seen_at,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, cluster_id, plate_number, status, evidence_count,
                 confidence, first_seen_at, last_seen_at, revision, updated_at`,
      [normalizedClusterId, normalizedPlate]
    );
    return result.rows[0] || null;
  }

  async listVehicleClusterOverview({
    view = "all",
    reviewQueue = "all",
    profilePage = 1,
    profilePageSize = 50,
    vehicleReviewPage = 1,
    plateReviewPage = 1,
    directionReviewPage = 1,
    reviewPageSize = 20,
    profileStatus = null,
    profileSearch = null,
    profileCamera = null,
    embeddingModel = null,
    directionClassifierVersion = null,
  } = {}) {
    const profilesPage = boundedPagination(profilePage, profilePageSize, { defaultSize: 50 });
    const vehicleReviewsPage = boundedPagination(vehicleReviewPage, reviewPageSize, { defaultSize: 20, maximumSize: 50 });
    const plateReviewsPage = boundedPagination(plateReviewPage, reviewPageSize, { defaultSize: 20, maximumSize: 50 });
    const directionReviewsPage = boundedPagination(directionReviewPage, reviewPageSize, { defaultSize: 20, maximumSize: 50 });
    const normalizedStatus = ["shadow", "confirmed"].includes(String(profileStatus || "").trim().toLowerCase())
      ? String(profileStatus).trim().toLowerCase()
      : null;
    const normalizedSearch = String(profileSearch || "").trim().slice(0, 32) || null;
    const normalizedCamera = String(profileCamera || "").trim().slice(0, 255) || null;
    const normalizedView = ["profiles", "review"].includes(view) ? view : "all";
    const normalizedReviewQueue = ["vehicle", "plates", "direction", "setup"].includes(reviewQueue)
      ? reviewQueue
      : normalizedView === "review" ? "vehicle" : "all";
    const includeProfiles = normalizedView !== "review";
    const includeSuggestions = normalizedView === "all"
      || (normalizedView === "review" && normalizedReviewQueue === "vehicle");
    const includeAssociations = normalizedView === "all"
      || (normalizedView === "review" && normalizedReviewQueue === "plates");
    const includeDirectionReviews = normalizedView === "all"
      || (normalizedView === "review" && normalizedReviewQueue === "direction");
    const [clusters, suggestions, associations, directionReviews, stats] = await Promise.all([
      includeProfiles ? this.query(
        `WITH page_clusters AS MATERIALIZED (
           SELECT clusters.*
           FROM public.vehicle_clusters clusters
           WHERE clusters.status <> 'retired'
             AND ($3::varchar IS NULL OR clusters.status = $3::varchar)
             AND ($4::varchar IS NULL OR EXISTS (
               SELECT 1
               FROM public.vehicle_cluster_assignments filtered_assignments
               JOIN public.plate_reads filtered_reads ON filtered_reads.id = filtered_assignments.read_id
               WHERE filtered_assignments.cluster_id = clusters.id
                 AND (filtered_reads.plate_number ILIKE '%' || $4::varchar || '%'
                      OR filtered_reads.observed_plate ILIKE '%' || $4::varchar || '%')
             ))
             AND ($5::varchar IS NULL OR EXISTS (
               SELECT 1
               FROM public.vehicle_cluster_assignments filtered_assignments
               JOIN public.plate_reads filtered_reads ON filtered_reads.id = filtered_assignments.read_id
               WHERE filtered_assignments.cluster_id = clusters.id
                 AND LOWER(BTRIM(filtered_reads.camera_name)) = LOWER(BTRIM($5::varchar))
             ))
           ORDER BY clusters.updated_at DESC, clusters.id DESC
           LIMIT $6 OFFSET $7
         )
         SELECT clusters.id, clusters.status, clusters.embedding_model,
                clusters.algorithm_version, clusters.representative_read_id,
                representative.derived_path AS representative_path,
                representative_read.plate_number AS representative_plate,
                representative_read.camera_name AS representative_camera,
                COUNT(assignments.read_id)::integer AS capture_count,
                COUNT(assignments.read_id) FILTER (WHERE assignments.assignment_status = 'confirmed')::integer AS confirmed_count,
                MIN(member_read."timestamp") AS first_seen,
                MAX(member_read."timestamp") AS last_seen,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT member_read.plate_number), NULL) AS observed_plates,
                color.attribute_value AS representative_color,
                color.confidence AS representative_color_confidence,
                vehicle_type.attribute_value AS representative_body_type,
                vehicle_type.confidence AS representative_body_type_confidence,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'plateNumber', association.plate_number,
                    'evidenceCount', association.evidence_count,
                    'confidence', association.confidence
                  ) ORDER BY association.updated_at DESC)
                  FROM public.vehicle_plate_associations association
                  WHERE association.cluster_id = clusters.id
                    AND association.status = 'confirmed'
                ), '[]'::jsonb) AS confirmed_plate_associations,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'plateNumber', association.plate_number,
                    'evidenceCount', association.evidence_count,
                    'confidence', association.confidence
                  ) ORDER BY association.updated_at DESC)
                  FROM public.vehicle_plate_associations association
                  WHERE association.cluster_id = clusters.id
                    AND association.status = 'suggested'
                ), '[]'::jsonb) AS suggested_plate_associations
         FROM page_clusters clusters
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $1 AND algorithm_version = $2 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads representative_read ON representative_read.id = clusters.representative_read_id
         LEFT JOIN public.vehicle_cluster_assignments assignments ON assignments.cluster_id = clusters.id
         LEFT JOIN public.plate_reads member_read ON member_read.id = assignments.read_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN status = 'ready' THEN attribute_value END AS attribute_value,
                  CASE WHEN status = 'ready' THEN confidence END AS confidence
           FROM public.vehicle_attribute_observations
           WHERE read_id = clusters.representative_read_id AND attribute_key = 'color'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) color ON TRUE
         LEFT JOIN LATERAL (
           SELECT attribute_value, confidence FROM public.vehicle_attribute_observations
           WHERE read_id = clusters.representative_read_id
             AND attribute_key = 'body_type' AND status = 'ready'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) vehicle_type ON TRUE
         GROUP BY clusters.id, clusters.status, clusters.embedding_model,
                  clusters.algorithm_version, clusters.representative_read_id, clusters.updated_at,
                  representative.derived_path, representative_read.plate_number,
                  representative_read.camera_name, color.attribute_value, color.confidence,
                  vehicle_type.attribute_value, vehicle_type.confidence
         ORDER BY clusters.updated_at DESC, clusters.id DESC`,
        [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, normalizedStatus, normalizedSearch,
          normalizedCamera, profilesPage.pageSize, profilesPage.offset]
      ) : Promise.resolve({ rows: [] }),
      includeSuggestions ? this.query(
        `SELECT assignment.read_id, assignment.cluster_id, assignment.similarity,
                assignment.similarity_margin, assignment.revision,
                candidate.derived_path AS candidate_path,
                candidate_read.plate_number AS candidate_plate,
                candidate_read.camera_name AS candidate_camera,
                candidate_read."timestamp" AS candidate_timestamp,
                representative.derived_path AS representative_path,
                representative_read.plate_number AS representative_plate,
                representative_read.camera_name AS representative_camera
         FROM public.vehicle_cluster_assignments assignment
         JOIN public.vehicle_clusters clusters ON clusters.id = assignment.cluster_id
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = assignment.read_id
             AND asset_type = $1 AND algorithm_version = $2 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) candidate ON TRUE
         JOIN public.plate_reads candidate_read ON candidate_read.id = assignment.read_id
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $1 AND algorithm_version = $2 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads representative_read ON representative_read.id = clusters.representative_read_id
         WHERE assignment.assignment_status = 'suggested'
         ORDER BY assignment.similarity DESC, assignment.updated_at DESC LIMIT $3 OFFSET $4`,
        [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM,
          vehicleReviewsPage.pageSize, vehicleReviewsPage.offset]
      ) : Promise.resolve({ rows: [] }),
      includeAssociations ? this.query(
        `SELECT association.id, association.cluster_id, association.plate_number,
                association.evidence_count, association.confidence,
                association.first_seen_at, association.last_seen_at, association.revision,
                clusters.status AS cluster_status,
                representative.derived_path AS representative_path,
                representative_read.plate_number AS representative_plate,
                representative_read.camera_name AS representative_camera,
                evidence.derived_path AS evidence_path,
                evidence.read_id AS evidence_read_id,
                evidence.camera_name AS evidence_camera,
                evidence."timestamp" AS evidence_timestamp,
                known.name AS known_name,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('name', tags.name, 'color', tags.color) ORDER BY tags.name)
                  FROM public.plate_tags plate_tags
                  JOIN public.tags tags ON tags.id = plate_tags.tag_id
                  WHERE plate_tags.plate_number = association.plate_number
                ), '[]'::jsonb) AS tags
         FROM public.vehicle_plate_associations association
         JOIN public.vehicle_clusters clusters ON clusters.id = association.cluster_id
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $1 AND algorithm_version = $2 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads representative_read ON representative_read.id = clusters.representative_read_id
         JOIN LATERAL (
           SELECT reads.id AS read_id, assets.derived_path, reads.camera_name, reads."timestamp"
           FROM public.vehicle_cluster_assignments assignments
           JOIN public.plate_reads reads ON reads.id = assignments.read_id
           JOIN LATERAL (
             SELECT derived_path FROM public.capture_assets
             WHERE read_id = assignments.read_id
               AND asset_type = $1 AND algorithm_version = $2 AND status = 'ready'
             ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
           ) assets ON TRUE
           WHERE assignments.cluster_id = association.cluster_id
             AND assignments.assignment_status = 'confirmed'
             AND reads.plate_number = association.plate_number
           ORDER BY reads."timestamp" DESC, reads.id DESC LIMIT 1
         ) evidence ON TRUE
         LEFT JOIN public.known_plates known ON known.plate_number = association.plate_number
         WHERE association.status = 'suggested'
         ORDER BY association.updated_at DESC, association.id DESC
         LIMIT $3 OFFSET $4`,
        [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM,
          plateReviewsPage.pageSize, plateReviewsPage.offset]
      ) : Promise.resolve({ rows: [] }),
      includeDirectionReviews ? this.query(
        `SELECT candidates.*
         FROM (
           SELECT assets.read_id, assets.derived_path, reads.plate_number,
                  reads.observed_plate, reads.camera_name, reads."timestamp",
                  observations.status AS direction_status,
                  observations.orientation AS predicted_orientation,
                  observations.orientation_confidence,
                  observations.direction_label,
                  profiles.front_direction_label, profiles.rear_direction_label,
                  ROW_NUMBER() OVER (
                    PARTITION BY LOWER(BTRIM(reads.camera_name))
                    ORDER BY reads."timestamp" DESC, reads.id DESC
                  ) AS camera_rank
           FROM public.capture_assets assets
           JOIN public.plate_reads reads ON reads.id = assets.read_id
           LEFT JOIN public.camera_visual_profiles visual_profiles
             ON visual_profiles.camera_key = LOWER(BTRIM(reads.camera_name))
           JOIN public.camera_direction_profiles profiles
             ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
           LEFT JOIN public.vehicle_orientation_labels labels
             ON labels.read_id = assets.read_id AND labels.embedding_model = $3
           LEFT JOIN public.vehicle_direction_observations observations
             ON observations.read_id = assets.read_id
            AND observations.classifier_version = $4
           WHERE assets.asset_type = $1 AND assets.algorithm_version = $2
             AND assets.status = 'ready' AND assets.embedding_model = $3
             AND assets.vehicle_embedding IS NOT NULL
             AND assets.crop_profile_version = COALESCE(visual_profiles.profile_version, 1)
             AND profiles.enabled = TRUE
             AND NULLIF(BTRIM(profiles.front_direction_label), '') IS NOT NULL
             AND NULLIF(BTRIM(profiles.rear_direction_label), '') IS NOT NULL
             AND labels.id IS NULL
             AND (observations.status IS NULL OR observations.status <> 'ready')
             AND ${directionImageEligibleSql("assets.read_id")}
             AND NOT EXISTS (
               SELECT 1 FROM public.vehicle_direction_observations primary_direction
               WHERE primary_direction.read_id = assets.read_id
                 AND primary_direction.classifier_version = $7
                 AND primary_direction.status = 'ready'
             )
         ) candidates
         ORDER BY candidates.camera_rank, candidates."timestamp" DESC, candidates.read_id DESC
         LIMIT $5 OFFSET $6`,
        [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel,
          directionClassifierVersion, directionReviewsPage.pageSize, directionReviewsPage.offset,
          BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM]
      ) : Promise.resolve({ rows: [] }),
      this.query(
        `SELECT COUNT(*)::integer AS total_clusters,
                COUNT(*) FILTER (WHERE status = 'shadow')::integer AS shadow_clusters,
                COUNT(*) FILTER (WHERE status = 'confirmed')::integer AS confirmed_profiles,
                (SELECT COUNT(*)::integer
                 FROM public.vehicle_clusters filtered_clusters
                 WHERE filtered_clusters.status <> 'retired'
                   AND ($1::varchar IS NULL OR filtered_clusters.status = $1::varchar)
                   AND ($2::varchar IS NULL OR EXISTS (
                     SELECT 1
                     FROM public.vehicle_cluster_assignments filtered_assignments
                     JOIN public.plate_reads filtered_reads ON filtered_reads.id = filtered_assignments.read_id
                     WHERE filtered_assignments.cluster_id = filtered_clusters.id
                       AND (filtered_reads.plate_number ILIKE '%' || $2::varchar || '%'
                            OR filtered_reads.observed_plate ILIKE '%' || $2::varchar || '%')
                   ))
                   AND ($3::varchar IS NULL OR EXISTS (
                     SELECT 1
                     FROM public.vehicle_cluster_assignments filtered_assignments
                     JOIN public.plate_reads filtered_reads ON filtered_reads.id = filtered_assignments.read_id
                     WHERE filtered_assignments.cluster_id = filtered_clusters.id
                       AND LOWER(BTRIM(filtered_reads.camera_name)) = LOWER(BTRIM($3::varchar))
                   ))) AS filtered_clusters,
                (SELECT COUNT(*)::integer FROM public.vehicle_cluster_assignments WHERE assignment_status = 'suggested') AS pending_reviews,
                (SELECT COUNT(*)::integer FROM public.vehicle_cluster_assignments WHERE assignment_status = 'confirmed') AS confirmed_assignments,
                (SELECT COUNT(*)::integer FROM public.vehicle_plate_associations WHERE status = 'suggested') AS pending_plate_associations,
                (SELECT COUNT(*)::integer
                 FROM public.capture_assets assets
                 JOIN public.plate_reads reads ON reads.id = assets.read_id
                 LEFT JOIN public.camera_visual_profiles visual_profiles
                   ON visual_profiles.camera_key = LOWER(BTRIM(reads.camera_name))
                 JOIN public.camera_direction_profiles profiles
                   ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
                 LEFT JOIN public.vehicle_orientation_labels labels
                   ON labels.read_id = assets.read_id AND labels.embedding_model = $6
                 LEFT JOIN public.vehicle_direction_observations observations
                   ON observations.read_id = assets.read_id
                  AND observations.classifier_version = $7
                 WHERE assets.asset_type = $4 AND assets.algorithm_version = $5
                   AND assets.status = 'ready' AND assets.embedding_model = $6
                   AND assets.vehicle_embedding IS NOT NULL
                   AND assets.crop_profile_version = COALESCE(visual_profiles.profile_version, 1)
                   AND profiles.enabled = TRUE
                   AND NULLIF(BTRIM(profiles.front_direction_label), '') IS NOT NULL
                   AND NULLIF(BTRIM(profiles.rear_direction_label), '') IS NOT NULL
                   AND labels.id IS NULL
                   AND (observations.status IS NULL OR observations.status <> 'ready')
                   AND ${directionImageEligibleSql("assets.read_id")}
                   AND NOT EXISTS (
                     SELECT 1 FROM public.vehicle_direction_observations primary_direction
                     WHERE primary_direction.read_id = assets.read_id
                       AND primary_direction.classifier_version = $8
                       AND primary_direction.status = 'ready'
                   )) AS pending_direction_reviews
         FROM public.vehicle_clusters WHERE status <> 'retired'`,
        [normalizedStatus, normalizedSearch, normalizedCamera,
          ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, directionClassifierVersion,
          BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM]
      )
    ]);
    return {
      clusters: clusters.rows,
      suggestions: suggestions.rows,
      associations: associations.rows,
      directionReviews: directionReviews.rows,
      stats: stats.rows[0],
      pagination: {
        profiles: profilesPage,
        vehicleReviews: vehicleReviewsPage,
        plateReviews: plateReviewsPage,
        directionReviews: directionReviewsPage,
      },
      filters: {
        profileStatus: normalizedStatus,
        profileSearch: normalizedSearch,
        profileCamera: normalizedCamera,
      },
    };
  }

  async getVehicleClusterProfile(clusterId, captureLimit = 60) {
    const normalizedClusterId = Number(clusterId);
    if (!Number.isSafeInteger(normalizedClusterId) || normalizedClusterId < 1) return null;
    const boundedLimit = Math.min(100, Math.max(1, Number.parseInt(captureLimit, 10) || 60));
    const [profileResult, associationResult, captureResult] = await Promise.all([
      this.query(
        `SELECT clusters.id, clusters.status, clusters.embedding_model,
                clusters.algorithm_version, clusters.representative_read_id,
                representative.derived_path AS representative_path,
                reads.plate_number AS representative_plate,
                reads.camera_name AS representative_camera,
                reads."timestamp" AS representative_timestamp,
                color.attribute_value AS representative_color,
                color.confidence AS representative_color_confidence,
                vehicle_type.attribute_value AS representative_body_type,
                vehicle_type.confidence AS representative_body_type_confidence,
                COUNT(assignments.read_id)::integer AS capture_count,
                COUNT(assignments.read_id) FILTER (WHERE assignments.assignment_status = 'confirmed')::integer AS confirmed_count,
                MIN(member_read."timestamp") AS first_seen,
                MAX(member_read."timestamp") AS last_seen
         FROM public.vehicle_clusters clusters
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $2 AND algorithm_version = $3 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads reads ON reads.id = clusters.representative_read_id
         LEFT JOIN public.vehicle_cluster_assignments assignments ON assignments.cluster_id = clusters.id
         LEFT JOIN public.plate_reads member_read ON member_read.id = assignments.read_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN status = 'ready' THEN attribute_value END AS attribute_value,
                  CASE WHEN status = 'ready' THEN confidence END AS confidence
           FROM public.vehicle_attribute_observations
           WHERE read_id = clusters.representative_read_id AND attribute_key = 'color'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) color ON TRUE
         LEFT JOIN LATERAL (
           SELECT attribute_value, confidence FROM public.vehicle_attribute_observations
           WHERE read_id = clusters.representative_read_id
             AND attribute_key = 'body_type' AND status = 'ready'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) vehicle_type ON TRUE
         WHERE clusters.id = $1 AND clusters.status <> 'retired'
         GROUP BY clusters.id, representative.derived_path, reads.plate_number,
                  reads.camera_name, reads."timestamp", color.attribute_value, color.confidence,
                  vehicle_type.attribute_value, vehicle_type.confidence`,
        [normalizedClusterId, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
      ),
      this.query(
        `SELECT association.id, association.cluster_id, association.plate_number,
                association.status, association.evidence_count, association.confidence,
                association.first_seen_at, association.last_seen_at,
                association.revision, association.updated_at,
                known.name AS known_name,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('name', tags.name, 'color', tags.color) ORDER BY tags.name)
                  FROM public.plate_tags plate_tags
                  JOIN public.tags tags ON tags.id = plate_tags.tag_id
                  WHERE plate_tags.plate_number = association.plate_number
                ), '[]'::jsonb) AS tags
         FROM public.vehicle_plate_associations association
         LEFT JOIN public.known_plates known ON known.plate_number = association.plate_number
         WHERE association.cluster_id = $1
         ORDER BY CASE association.status WHEN 'suggested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
                  association.updated_at DESC, association.plate_number`,
        [normalizedClusterId]
      ),
      this.query(
        `SELECT assignments.read_id, assignments.assignment_status,
                assignments.similarity, assignments.similarity_margin,
                reads.plate_number, reads.observed_plate, reads.camera_name,
                reads."timestamp", asset.derived_path,
                color.attribute_value AS vehicle_color,
                color.confidence AS vehicle_color_confidence,
                vehicle_type.attribute_value AS vehicle_body_type,
                vehicle_type.confidence AS vehicle_body_type_confidence,
                direction.direction_label, direction.orientation,
                direction.orientation_confidence
         FROM public.vehicle_cluster_assignments assignments
         JOIN public.plate_reads reads ON reads.id = assignments.read_id
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = assignments.read_id
             AND asset_type = $2 AND algorithm_version = $3 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) asset ON TRUE
         LEFT JOIN LATERAL (
           SELECT CASE WHEN status = 'ready' THEN attribute_value END AS attribute_value,
                  CASE WHEN status = 'ready' THEN confidence END AS confidence
           FROM public.vehicle_attribute_observations
           WHERE read_id = assignments.read_id AND attribute_key = 'color'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) color ON TRUE
         LEFT JOIN LATERAL (
           SELECT attribute_value, confidence FROM public.vehicle_attribute_observations
           WHERE read_id = assignments.read_id
             AND attribute_key = 'body_type' AND status = 'ready'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) vehicle_type ON TRUE
         LEFT JOIN public.vehicle_direction_observations direction ON direction.read_id = assignments.read_id
         WHERE assignments.cluster_id = $1
         ORDER BY reads."timestamp" DESC, assignments.read_id DESC
         LIMIT $4`,
        [normalizedClusterId, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, boundedLimit]
      ),
    ]);
    if (!profileResult.rows[0]) return null;
    return {
      profile: profileResult.rows[0],
      associations: associationResult.rows,
      captures: captureResult.rows,
    };
  }

  async reviewVehicleClusterAssignment({ readId, decision, embeddingModel, algorithmVersion, actor }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle cluster review requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const currentResult = await client.query(
        `SELECT read_id, cluster_id, assignment_status, similarity, revision
         FROM public.vehicle_cluster_assignments WHERE read_id = $1 FOR UPDATE`,
        [readId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        const error = new Error("Vehicle assignment was not found.");
        error.code = "VEHICLE_CLUSTER_ASSIGNMENT_NOT_FOUND";
        throw error;
      }
      let clusterId = Number(current.cluster_id);
      let status = "confirmed";
      let similarity = current.similarity;
      if (decision === "separate") {
        const cluster = await client.query(
          `INSERT INTO public.vehicle_clusters (
             representative_read_id, embedding_model, algorithm_version
           ) VALUES ($1, $2, $3)
           ON CONFLICT (representative_read_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [readId, embeddingModel, algorithmVersion]
        );
        clusterId = Number(cluster.rows[0].id);
        status = "seed";
        similarity = null;
      }
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      const savedResult = await client.query(
        `UPDATE public.vehicle_cluster_assignments SET
           cluster_id = $2, assignment_status = $3::varchar, similarity = $4,
           similarity_margin = CASE WHEN $3::varchar = 'seed' THEN NULL ELSE similarity_margin END,
           actor_user_id = $5::bigint, actor_username = $6, actor_display_name = $7,
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE read_id = $1
         RETURNING read_id, cluster_id, assignment_status, similarity,
                   similarity_margin, revision, updated_at`,
        [readId, clusterId, status, similarity, actorId,
          String(actor?.username || "legacy-admin").slice(0, 64),
          String(actor?.displayName || "Legacy Administrator").slice(0, 120)]
      );
      const saved = savedResult.rows[0];
      let plateAssociation = null;
      if (decision === "confirm") {
        const plateResult = await client.query(
          `SELECT plate_number FROM public.plate_reads WHERE id = $1`,
          [readId]
        );
        plateAssociation = await this.refreshVehiclePlateAssociationSuggestion(
          client,
          Number(saved.cluster_id),
          plateResult.rows[0]?.plate_number
        );
      }
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.cluster_review',
                   'vehicle_cluster_assignment', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(readId), JSON.stringify({
          readId,
          decision,
          previousClusterId: Number(current.cluster_id),
          clusterId: Number(saved.cluster_id),
          previousStatus: current.assignment_status,
          assignmentStatus: saved.assignment_status,
          revision: Number(saved.revision),
          plateAssociationId: plateAssociation?.id ? Number(plateAssociation.id) : null,
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

  async reviewVehiclePlateAssociation({ clusterId, plateNumber, decision, actor }) {
    const normalizedClusterId = Number(clusterId);
    const normalizedPlate = String(plateNumber || "").trim().toUpperCase();
    const normalizedDecision = String(decision || "").trim().toLowerCase();
    if (!Number.isSafeInteger(normalizedClusterId) || normalizedClusterId < 1
      || !normalizedPlate || !new Set(["confirm", "reject"]).has(normalizedDecision)) {
      const error = new Error("Choose Confirm association or Reject association.");
      error.code = "INVALID_VEHICLE_PLATE_ASSOCIATION_REVIEW";
      throw error;
    }
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle plate review requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const currentResult = await client.query(
        `SELECT id, cluster_id, plate_number, status, evidence_count, confidence, revision
         FROM public.vehicle_plate_associations
         WHERE cluster_id = $1::bigint AND plate_number = $2::varchar
         FOR UPDATE`,
        [normalizedClusterId, normalizedPlate]
      );
      const current = currentResult.rows[0];
      if (!current) {
        const error = new Error("Vehicle plate association was not found.");
        error.code = "VEHICLE_PLATE_ASSOCIATION_NOT_FOUND";
        throw error;
      }
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      const status = normalizedDecision === "confirm" ? "confirmed" : "rejected";
      const savedResult = await client.query(
        `UPDATE public.vehicle_plate_associations SET
           status = $3::varchar, actor_user_id = $4::bigint,
           actor_username = $5, actor_display_name = $6,
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE cluster_id = $1::bigint AND plate_number = $2::varchar
         RETURNING id, cluster_id, plate_number, status, evidence_count,
                   confidence, first_seen_at, last_seen_at, revision, updated_at`,
        [normalizedClusterId, normalizedPlate, status, actorId,
          String(actor?.username || "legacy-admin").slice(0, 64),
          String(actor?.displayName || "Legacy Administrator").slice(0, 120)]
      );
      await client.query(
        `UPDATE public.vehicle_clusters SET
           status = CASE WHEN EXISTS (
             SELECT 1 FROM public.vehicle_plate_associations association
             WHERE association.cluster_id = $1::bigint AND association.status = 'confirmed'
           ) THEN 'confirmed' ELSE 'shadow' END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::bigint AND status <> 'retired'`,
        [normalizedClusterId]
      );
      const saved = savedResult.rows[0];
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.plate_association_review',
                   'vehicle_plate_association', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({
          clusterId: normalizedClusterId,
          plateNumber: normalizedPlate,
          decision: normalizedDecision,
          previousStatus: current.status,
          status: saved.status,
          evidenceCount: Number(saved.evidence_count),
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
