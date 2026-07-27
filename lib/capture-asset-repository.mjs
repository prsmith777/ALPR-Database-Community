import {
  CAPTURE_ASSET_ALGORITHM,
  DEFAULT_CAMERA_CROP_PROFILE,
  MAX_SEARCH_CANDIDATES,
  normalizeCameraCropProfile,
} from "./image-similarity.mjs";

const ASSET_TYPE = "vehicle_crop";
const PROFILE_JOIN = `LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(pr.camera_name))`;
const READS_PROFILE_JOIN = `LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(reads.camera_name))`;
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
                profiles.rear_direction_label, profiles.minimum_confidence, profiles.profile_version
       ORDER BY cameras.camera_name`,
      [embeddingModel]
    );
    return result.rows;
  }

  async getDirectionProfile(cameraName) {
    const result = await this.query(
      `SELECT camera_name, enabled, front_direction_label, rear_direction_label,
              minimum_confidence, profile_version
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
           rear_direction_label, minimum_confidence
         ) VALUES (LOWER(BTRIM($1)), $1, $2, $3, $4, $5)
         ON CONFLICT (camera_key) DO UPDATE SET
           camera_name = EXCLUDED.camera_name,
           enabled = EXCLUDED.enabled,
           front_direction_label = EXCLUDED.front_direction_label,
           rear_direction_label = EXCLUDED.rear_direction_label,
           minimum_confidence = EXCLUDED.minimum_confidence,
           profile_version = CASE WHEN
             public.camera_direction_profiles.enabled IS DISTINCT FROM EXCLUDED.enabled OR
             public.camera_direction_profiles.front_direction_label IS DISTINCT FROM EXCLUDED.front_direction_label OR
             public.camera_direction_profiles.rear_direction_label IS DISTINCT FROM EXCLUDED.rear_direction_label OR
             public.camera_direction_profiles.minimum_confidence IS DISTINCT FROM EXCLUDED.minimum_confidence
           THEN public.camera_direction_profiles.profile_version + 1
           ELSE public.camera_direction_profiles.profile_version END,
           updated_at = CURRENT_TIMESTAMP
         RETURNING camera_name, enabled, front_direction_label, rear_direction_label,
                   minimum_confidence, profile_version`,
        [profile.cameraName, profile.enabled, profile.frontDirectionLabel,
          profile.rearDirectionLabel, profile.minimumConfidence]
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

  async listOrientationSamples(cameraName, embeddingModel) {
    const result = await this.query(
      `SELECT labels.read_id, labels.orientation, assets.vehicle_embedding
       FROM public.vehicle_orientation_labels labels
       JOIN public.capture_assets assets ON assets.read_id = labels.read_id
       WHERE labels.camera_key = LOWER(BTRIM($1))
         AND labels.embedding_model = $2
         AND assets.embedding_model = $2
         AND assets.status = 'ready' AND assets.vehicle_embedding IS NOT NULL`,
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
                failures.attempt_count AS failure_attempt_count
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
         WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
           AND ca.status = 'ready' AND ${CURRENT_PROFILE}
           AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
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
              )::integer AS failed
       FROM eligible`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, classifierVersion]
    );
    const row = result.rows[0] || {};
    const eligible = Number(row.eligible || 0);
    const populated = Number(row.populated || 0);
    const failed = Number(row.failed || 0);
    return {
      eligible,
      populated,
      completed: Math.min(eligible, populated + failed),
      pending: Math.max(0, eligible - populated - failed),
      ready: Number(row.ready || 0),
      unknown: Number(row.unknown || 0),
      failed,
    };
  }

  async listDirectionBackfillCandidates(embeddingModel, classifierVersion, limit = 20) {
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
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND ${CURRENT_PROFILE}
         AND ca.embedding_model = $3 AND ca.vehicle_embedding IS NOT NULL
         AND (
           observations.read_id IS NULL OR
           observations.embedding_model IS DISTINCT FROM $3 OR
           observations.classifier_version IS DISTINCT FROM $4 OR
           observations.profile_version IS DISTINCT FROM profiles.profile_version
         )
         AND (failures.read_id IS NULL OR failures.attempt_count < 3)
       ORDER BY ca.read_id ASC
       LIMIT $5`,
      [ASSET_TYPE, CAPTURE_ASSET_ALGORITHM, embeddingModel, classifierVersion, limit]
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
         evaluated_at = CURRENT_TIMESTAMP`,
      [readId, cameraName, embeddingModel, classifierVersion, profileVersion,
        result.status, result.orientation, result.confidence, directionLabel, JSON.stringify(result.counts)]
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

  async saveCaptureColorSignature(readId, colorSignature, colorSignatureVersion) {
    await this.query(
      `UPDATE public.capture_assets SET color_signature = $2, color_signature_version = $3
       WHERE read_id = $1 AND asset_type = $4 AND algorithm_version = $5 AND status = 'ready'`,
      [readId, colorSignature, colorSignatureVersion, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
    );
  }

  async listVehicleClusterOverview({ clusterLimit = 100, reviewLimit = 40 } = {}) {
    const [clusters, suggestions, stats] = await Promise.all([
      this.query(
        `SELECT clusters.id, clusters.status, clusters.embedding_model,
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
                color.confidence AS representative_color_confidence
         FROM public.vehicle_clusters clusters
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $2 AND algorithm_version = $3 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads representative_read ON representative_read.id = clusters.representative_read_id
         LEFT JOIN public.vehicle_cluster_assignments assignments ON assignments.cluster_id = clusters.id
         LEFT JOIN public.plate_reads member_read ON member_read.id = assignments.read_id
         LEFT JOIN LATERAL (
           SELECT attribute_value, confidence FROM public.vehicle_attribute_observations
           WHERE read_id = clusters.representative_read_id AND attribute_key = 'color' AND status = 'ready'
           ORDER BY evaluated_at DESC, id DESC LIMIT 1
         ) color ON TRUE
         WHERE clusters.status <> 'retired'
         GROUP BY clusters.id, representative.derived_path, representative_read.plate_number,
                  representative_read.camera_name, color.attribute_value, color.confidence
         ORDER BY clusters.updated_at DESC, clusters.id DESC LIMIT $1`,
        [clusterLimit, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
      ),
      this.query(
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
             AND asset_type = $2 AND algorithm_version = $3 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) candidate ON TRUE
         JOIN public.plate_reads candidate_read ON candidate_read.id = assignment.read_id
         JOIN LATERAL (
           SELECT derived_path FROM public.capture_assets
           WHERE read_id = clusters.representative_read_id
             AND asset_type = $2 AND algorithm_version = $3 AND status = 'ready'
           ORDER BY indexed_at DESC NULLS LAST, id DESC LIMIT 1
         ) representative ON TRUE
         JOIN public.plate_reads representative_read ON representative_read.id = clusters.representative_read_id
         WHERE assignment.assignment_status = 'suggested'
         ORDER BY assignment.similarity DESC, assignment.updated_at DESC LIMIT $1`,
        [reviewLimit, ASSET_TYPE, CAPTURE_ASSET_ALGORITHM]
      ),
      this.query(
        `SELECT COUNT(*)::integer AS total_clusters,
                COUNT(*) FILTER (WHERE status = 'shadow')::integer AS shadow_clusters,
                (SELECT COUNT(*)::integer FROM public.vehicle_cluster_assignments WHERE assignment_status = 'suggested') AS pending_reviews,
                (SELECT COUNT(*)::integer FROM public.vehicle_cluster_assignments WHERE assignment_status = 'confirmed') AS confirmed_assignments
         FROM public.vehicle_clusters WHERE status <> 'retired'`)
    ]);
    return { clusters: clusters.rows, suggestions: suggestions.rows, stats: stats.rows[0] };
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
