import { BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM } from "./blue-iris-trigger-direction.mjs";
import { VEHICLE_ASSET_EMBEDDING_ALGORITHM as DIRECTION_SOURCE_ALGORITHM } from "./vehicle-asset-embedding-contract.mjs";

const ASSET_TYPE = "vehicle_crop";
function directionImageEligibleSql(readIdExpression) {
  return `NOT EXISTS (
    SELECT 1 FROM public.vehicle_direction_sources source
    JOIN public.vehicle_asset_attribute_observations color
      ON color.derivative_id = source.derivative_id
     AND color.source_sha256 = source.source_sha256
    WHERE source.read_id = ${readIdExpression}
      AND color.attribute_key = 'color'
      AND color.raw_result->>'reason' = 'monochrome_capture'
  )`;
}

export class VehicleDirectionRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("Vehicle direction requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }
  async query(text, values = []) { return (this.executor || this.pool).query(text, values); }

  async getRead(readId) {
    const result = await this.query(
      `SELECT id, plate_number, observed_plate, camera_name, "timestamp",
              image_path, thumbnail_path, crop_coordinates
       FROM public.plate_reads WHERE id = $1`,
      [readId]
    );
    return result.rows[0] || null;
  }

  async getAsset(readId) {
    const result = await this.query(
      `SELECT source.*, reads.plate_number, reads.observed_plate, reads.camera_name, reads.timestamp
       FROM public.vehicle_direction_sources source
       JOIN public.plate_reads reads ON reads.id = source.read_id
       WHERE source.read_id = $1`, [readId]
    );
    return result.rows[0] || null;
  }

  async getPrimaryDirectionObservation(readId, classifierVersion = BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM) {
    const result = await this.query(
      `SELECT status, orientation, orientation_confidence, direction_label,
              profile_version, sample_counts
       FROM public.current_vehicle_direction_observations
       WHERE read_id = $1 AND classifier_version = $2 AND status = 'ready'`,
      [readId, classifierVersion]
    );
    return result.rows[0] || null;
  }

  async getDirectionImageEligibility(readId) {
    const result = await this.query(`SELECT ${directionImageEligibleSql("$1::integer")} AS eligible`, [readId]);
    return { eligible: result.rows[0]?.eligible !== false };
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
       LEFT JOIN public.current_vehicle_orientation_labels labels
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
         LEFT JOIN public.current_vehicle_direction_observations current_direction
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
       FROM public.current_vehicle_orientation_labels labels
       JOIN public.vehicle_direction_sources assets ON assets.read_id = labels.read_id
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
       FROM public.vehicle_direction_sources assets
       JOIN public.plate_reads reads ON reads.id = assets.read_id
       LEFT JOIN public.current_vehicle_orientation_labels labels
         ON labels.read_id = assets.read_id AND labels.embedding_model = $2
       LEFT JOIN public.current_vehicle_direction_observations observations
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
      `SELECT assets.read_id, assets.embedding_id, assets.vehicle_embedding, reads.camera_name
       FROM public.vehicle_direction_sources assets
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

  async isDirectionReevaluationPaused() {
    const result = await this.query("SELECT paused FROM public.vehicle_direction_reevaluation_control WHERE singleton");
    return result.rows[0]?.paused === true;
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
         FROM public.vehicle_direction_sources ca
         JOIN public.plate_reads reads ON reads.id = ca.read_id
         
         JOIN public.camera_direction_profiles profiles
           ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
         LEFT JOIN public.current_vehicle_direction_observations observations
           ON observations.read_id = ca.read_id
         LEFT JOIN public.vehicle_direction_backfill_failures failures
           ON failures.read_id = ca.read_id
          AND failures.embedding_model = $3
          AND failures.classifier_version = $4
          AND failures.profile_version = profiles.profile_version
         LEFT JOIN public.vehicle_direction_reevaluation_queue reevaluation
           ON reevaluation.read_id = ca.read_id
         WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
           AND ca.status = 'ready' AND TRUE
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
      [ASSET_TYPE, DIRECTION_SOURCE_ALGORITHM, embeddingModel, classifierVersion,
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
    const values = [ASSET_TYPE, DIRECTION_SOURCE_ALGORITHM, embeddingModel, classifierVersion,
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
         FROM public.vehicle_direction_sources ca
         JOIN public.plate_reads reads ON reads.id = ca.read_id
         
         JOIN public.camera_direction_profiles profiles
           ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
         LEFT JOIN public.current_vehicle_direction_observations observations
           ON observations.read_id = ca.read_id
         LEFT JOIN public.current_vehicle_orientation_labels labels
           ON labels.read_id = ca.read_id AND labels.embedding_model = $3
         WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
           AND ca.status = 'ready' AND TRUE
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
    const values = [ASSET_TYPE, DIRECTION_SOURCE_ALGORITHM, embeddingModel,
      BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM];
    const cameraFilter = normalizedCameraName
      ? (values.push(normalizedCameraName), `AND LOWER(BTRIM(reads.camera_name)) = LOWER(BTRIM($${values.length}))`)
      : "";
    const targetReads = `SELECT ca.read_id
       FROM public.vehicle_direction_sources ca
       JOIN public.plate_reads reads ON reads.id = ca.read_id
       
       JOIN public.camera_direction_profiles profiles
         ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
       LEFT JOIN public.current_vehicle_orientation_labels labels
         ON labels.read_id = ca.read_id AND labels.embedding_model = $3
       LEFT JOIN public.current_vehicle_direction_observations observations
         ON observations.read_id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND TRUE
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
       FROM public.vehicle_direction_sources ca
       JOIN public.plate_reads reads ON reads.id = ca.read_id
       
       JOIN public.camera_direction_profiles profiles
         ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
       LEFT JOIN public.current_vehicle_direction_observations observations
         ON observations.read_id = ca.read_id
       LEFT JOIN public.vehicle_direction_backfill_failures failures
         ON failures.read_id = ca.read_id
        AND failures.embedding_model = $3
        AND failures.classifier_version = $4
        AND failures.profile_version = profiles.profile_version
       LEFT JOIN public.vehicle_direction_reevaluation_queue reevaluation
         ON reevaluation.read_id = ca.read_id
       WHERE ca.asset_type = $1 AND ca.algorithm_version = $2
         AND ca.status = 'ready' AND TRUE
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
      [ASSET_TYPE, DIRECTION_SOURCE_ALGORITHM, embeddingModel, classifierVersion, limit,
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

  async saveOrientationLabel({ readId, cameraName, embeddingModel, sourceEmbeddingId, orientation, actor }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("Vehicle orientation labeling requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
      const result = await client.query(
        `INSERT INTO public.vehicle_orientation_labels (
           read_id, camera_key, embedding_model, orientation,
           actor_user_id, actor_username, actor_display_name, source_embedding_id
         ) SELECT $1, LOWER(BTRIM($2)), $3, $4, $5::bigint, $6, $7, $8::bigint
           WHERE EXISTS (SELECT 1 FROM public.vehicle_direction_sources
             WHERE read_id = $1 AND embedding_id = $8::bigint)
         
         ON CONFLICT (read_id, embedding_model) DO UPDATE SET
           camera_key = EXCLUDED.camera_key, orientation = EXCLUDED.orientation,
           source_embedding_id = EXCLUDED.source_embedding_id,
           actor_user_id = EXCLUDED.actor_user_id,
           actor_username = EXCLUDED.actor_username,
           actor_display_name = EXCLUDED.actor_display_name,
           revision = public.vehicle_orientation_labels.revision + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING id, read_id, orientation, revision, updated_at`,
        [readId, cameraName, embeddingModel, orientation, actorId,
          String(actor?.username || "legacy-admin").slice(0, 64),
          String(actor?.displayName || "Administrator").slice(0, 120), sourceEmbeddingId]
      );
      const saved = result.rows[0];
      if (!saved) throw new Error("Direction image changed; refresh before labeling.");
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

  async saveDirectionObservation({ readId, cameraName, embeddingModel, sourceEmbeddingId, classifierVersion, profileVersion, result, directionLabel }) {
    await this.query(
      `INSERT INTO public.vehicle_direction_observations (
         read_id, camera_key, embedding_model, classifier_version, profile_version,
         status, orientation, orientation_confidence, direction_label, sample_counts, source_embedding_id
       ) SELECT $1, LOWER(BTRIM($2)), $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $12::bigint
         WHERE EXISTS (SELECT 1 FROM public.vehicle_direction_sources
           WHERE read_id = $1 AND embedding_id = $12::bigint)
       ON CONFLICT (read_id) DO UPDATE SET
         camera_key = EXCLUDED.camera_key, embedding_model = EXCLUDED.embedding_model,
         classifier_version = EXCLUDED.classifier_version, profile_version = EXCLUDED.profile_version,
         status = EXCLUDED.status, orientation = EXCLUDED.orientation,
         orientation_confidence = EXCLUDED.orientation_confidence,
         direction_label = EXCLUDED.direction_label, sample_counts = EXCLUDED.sample_counts,
         source_embedding_id = EXCLUDED.source_embedding_id,
         evaluated_at = CURRENT_TIMESTAMP
       WHERE public.vehicle_direction_observations.classifier_version IS DISTINCT FROM $11`,
      [readId, cameraName, embeddingModel, classifierVersion, profileVersion,
        result.status, result.orientation, result.confidence, directionLabel,
        JSON.stringify(result.counts), BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM, sourceEmbeddingId]
    );
    await this.query(
      "DELETE FROM public.vehicle_direction_reevaluation_queue WHERE read_id = $1",
      [readId]
    );
    await this.clearDirectionBackfillFailure(readId);
  }


}
