import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";

export class BlueIrisVehicleFrameRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async withDerivedStorageWriterLock(operation) {
    return withStorageCleanupWriterLock(this.pool, (client) =>
      operation(new BlueIrisVehicleFrameRepository(client))
    );
  }

  async findNearestRead({ cameraName, timestamp, toleranceSeconds = 3 }) {
    const result = await this.pool.query(
      `SELECT id, plate_number, camera_name, "timestamp", image_path, crop_coordinates,
              vehicle_image_path, bi_alert_clip, bi_alert_offset_ms
       FROM public.plate_reads
       WHERE LOWER(BTRIM(camera_name)) = LOWER(BTRIM($1))
         AND "timestamp" BETWEEN $2::timestamptz - make_interval(secs => $3)
                             AND $2::timestamptz + make_interval(secs => $3)
       ORDER BY ABS(EXTRACT(EPOCH FROM ("timestamp" - $2::timestamptz))), id
       LIMIT 1`,
      [String(cameraName || "").trim(), timestamp, Number(toleranceSeconds)]
    );
    return result.rows?.[0] || null;
  }

  async claimNext({ includeHistorical = false } = {}) {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT id
         FROM public.plate_reads
         WHERE vehicle_image_path IS NULL
           AND camera_name IS NOT NULL
           AND BTRIM(camera_name) <> ''
           AND "timestamp" <= CURRENT_TIMESTAMP - INTERVAL '10 seconds'
           AND (
             (vehicle_image_status = 'pending'
               AND COALESCE(vehicle_image_attempt_count, 0) < 3
               AND COALESCE(vehicle_image_queue_kind, 'live') <> 'historical')
             OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
               AND COALESCE(vehicle_image_attempt_count, 0) < 3
               AND COALESCE(vehicle_image_queue_kind, 'live') <> 'historical'
               AND vehicle_image_updated_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
             OR ($1::boolean AND (
               COALESCE(vehicle_image_queue_kind, '') = 'historical' AND (
                 vehicle_image_status = 'pending'
                   AND COALESCE(vehicle_image_attempt_count, 0) < 3
                 OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
                   AND COALESCE(vehicle_image_attempt_count, 0) < 3
                   AND vehicle_image_updated_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
                 OR (vehicle_image_status = 'processing'
                   AND vehicle_image_updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes')
               )
             ))
             OR (vehicle_image_status = 'processing'
               AND COALESCE(vehicle_image_queue_kind, 'live') <> 'historical'
               AND vehicle_image_updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes')
           )
         ORDER BY
           CASE
             WHEN COALESCE(vehicle_image_queue_kind, 'live') = 'live' THEN 0
             WHEN vehicle_image_status = 'processing' THEN 1
             ELSE 2
           END,
           "timestamp" DESC,
           id DESC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE public.plate_reads reads
       SET vehicle_image_status = 'processing',
           vehicle_image_queue_kind = COALESCE(
             reads.vehicle_image_queue_kind,
             'live'
           ),
           vehicle_image_attempt_count = COALESCE(reads.vehicle_image_attempt_count, 0)
             + CASE WHEN reads.vehicle_image_status = 'processing' THEN 0 ELSE 1 END,
           vehicle_image_error_code = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE reads.id = candidate.id
       RETURNING reads.id, reads.plate_number, reads.camera_name, reads."timestamp",
                 reads.image_path, reads.crop_coordinates, reads.vehicle_image_path,
                 reads.bi_alert_clip, reads.bi_alert_offset_ms, reads.vehicle_image_queue_kind,
                 reads.vehicle_image_attempt_count`,
      [includeHistorical === true]
    );
    return result.rows?.[0] || null;
  }

  async getQueueStatus() {
    const [counts, control, motionShadow, recentMotionShadow] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE vehicle_image_status = 'ready')::integer AS ready,
           COUNT(*) FILTER (WHERE vehicle_image_status IN ('pending', 'processing'))::integer AS pending,
           COUNT(*) FILTER (WHERE vehicle_image_status = 'failed')::integer AS failed,
           COUNT(*) FILTER (WHERE vehicle_image_status = 'unavailable')::integer AS unavailable,
           COUNT(*) FILTER (WHERE vehicle_image_status IS NULL AND vehicle_image_path IS NULL)::integer AS historical_missing,
           COUNT(*) FILTER (WHERE vehicle_image_queue_kind = 'live' AND (
             vehicle_image_status = 'processing'
             OR (vehicle_image_status = 'pending' AND COALESCE(vehicle_image_attempt_count, 0) < 3)
             OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
               AND COALESCE(vehicle_image_attempt_count, 0) < 3)
           ))::integer AS live_outstanding,
           COUNT(*) FILTER (WHERE vehicle_image_queue_kind = 'historical' AND (
             vehicle_image_status = 'processing'
             OR (vehicle_image_status = 'pending' AND COALESCE(vehicle_image_attempt_count, 0) < 3)
             OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
               AND COALESCE(vehicle_image_attempt_count, 0) < 3)
           ))::integer AS historical_outstanding
         FROM public.plate_reads
         WHERE camera_name IS NOT NULL AND BTRIM(camera_name) <> ''`
      ),
      this.pool.query(
        `SELECT historical_paused, updated_at
         FROM public.vehicle_frame_processing_control
         WHERE singleton = TRUE`
      ),
      this.pool.query(
        `SELECT
           COUNT(*)::integer AS observed,
           COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
           COUNT(*) FILTER (WHERE status = 'unknown')::integer AS unknown,
           COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
           COUNT(*) FILTER (WHERE capture_mode = 'day_color')::integer AS daytime,
           COUNT(*) FILTER (WHERE error_code = 'NIGHT_DIRECTION_DISABLED')::integer AS night_disabled,
           COUNT(*) FILTER (WHERE error_code = 'PLATE_ANCHOR_NOT_DETECTED')::integer AS anchor_missing,
           COUNT(*) FILTER (WHERE error_code = 'LOW_MOTION_CONFIDENCE')::integer AS low_confidence
         FROM public.vehicle_motion_direction_observations`
      ),
      this.pool.query(
        `SELECT shadow.read_id, reads.plate_number, reads.camera_name,
                reads."timestamp" AS read_timestamp,
                shadow.capture_mode, shadow.status, shadow.image_direction,
                shadow.confidence, shadow.error_code, shadow.evaluated_at,
                COALESCE(current_direction.direction_label, shadow.fallback_direction_label)
                  AS comparison_direction_label,
                COALESCE(current_direction.orientation_confidence, shadow.fallback_direction_confidence)
                  AS comparison_direction_confidence
         FROM public.vehicle_motion_direction_observations shadow
         JOIN public.plate_reads reads ON reads.id = shadow.read_id
         LEFT JOIN public.vehicle_direction_observations current_direction
           ON current_direction.read_id = shadow.read_id
          AND current_direction.status = 'ready'
         ORDER BY shadow.evaluated_at DESC, shadow.read_id DESC
         LIMIT 20`
      ),
    ]);
    const row = counts.rows?.[0] || {};
    const motion = motionShadow.rows?.[0] || {};
    return {
      ready: Number(row.ready || 0),
      pending: Number(row.pending || 0),
      failed: Number(row.failed || 0),
      unavailable: Number(row.unavailable || 0),
      historicalMissing: Number(row.historical_missing || 0),
      liveOutstanding: Number(row.live_outstanding || 0),
      historicalOutstanding: Number(row.historical_outstanding || 0),
      historicalPaused: control.rows?.[0]?.historical_paused !== false,
      controlUpdatedAt: control.rows?.[0]?.updated_at || null,
      motionShadow: {
        observed: Number(motion.observed || 0),
        ready: Number(motion.ready || 0),
        unknown: Number(motion.unknown || 0),
        failed: Number(motion.failed || 0),
        daytime: Number(motion.daytime || 0),
        nightDisabled: Number(motion.night_disabled || 0),
        anchorMissing: Number(motion.anchor_missing || 0),
        lowConfidence: Number(motion.low_confidence || 0),
        recent: (recentMotionShadow.rows || []).map((entry) => ({
          readId: Number(entry.read_id),
          plateNumber: entry.plate_number,
          cameraName: entry.camera_name,
          readTimestamp: entry.read_timestamp instanceof Date
            ? entry.read_timestamp.toISOString()
            : entry.read_timestamp,
          captureMode: entry.capture_mode,
          status: entry.status,
          imageDirection: entry.image_direction,
          confidence: entry.confidence === null ? null : Number(entry.confidence),
          errorCode: entry.error_code,
          evaluatedAt: entry.evaluated_at instanceof Date
            ? entry.evaluated_at.toISOString()
            : entry.evaluated_at,
          comparisonDirectionLabel: entry.comparison_direction_label,
          comparisonDirectionConfidence: entry.comparison_direction_confidence === null
            ? null
            : Number(entry.comparison_direction_confidence),
        })),
      },
    };
  }

  async setHistoricalPaused(paused) {
    const result = await this.pool.query(
      `INSERT INTO public.vehicle_frame_processing_control (
         singleton, historical_paused, updated_at
       ) VALUES (TRUE, $1, CURRENT_TIMESTAMP)
       ON CONFLICT (singleton) DO UPDATE SET
         historical_paused = EXCLUDED.historical_paused,
         updated_at = CURRENT_TIMESTAMP
       RETURNING historical_paused, updated_at`,
      [paused === true]
    );
    return {
      historicalPaused: result.rows?.[0]?.historical_paused === true,
      updatedAt: result.rows?.[0]?.updated_at || null,
    };
  }

  async queueHistorical({ cameraName = null, startDate = null, endDate = null, replaceExisting = false } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending',
           vehicle_image_queue_kind = 'historical',
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = TRUE,
           vehicle_image_error_code = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE (($4::boolean = FALSE AND vehicle_image_path IS NULL)
          OR ($4::boolean = TRUE AND vehicle_image_path IS NOT NULL))
         AND camera_name IS NOT NULL
         AND BTRIM(camera_name) <> ''
         AND ($1::text IS NULL OR LOWER(BTRIM(camera_name)) = LOWER(BTRIM($1)))
         AND ($2::timestamptz IS NULL OR "timestamp" >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR "timestamp" <= $3::timestamptz)
       RETURNING id`,
      [cameraName || null, startDate || null, endDate || null, replaceExisting === true]
    );
    return { queued: result.rowCount || 0 };
  }

  async cancelHistorical({ cameraName = null, startDate = null, endDate = null } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = CASE
             WHEN vehicle_image_path IS NULL THEN NULL
             ELSE 'ready'
           END,
           vehicle_image_queue_kind = NULL,
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = FALSE,
           vehicle_image_error_code = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_queue_kind = 'historical'
         AND vehicle_image_status IN ('pending', 'failed')
         AND ($1::text IS NULL OR LOWER(BTRIM(camera_name)) = LOWER(BTRIM($1)))
         AND ($2::timestamptz IS NULL OR "timestamp" >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR "timestamp" <= $3::timestamptz)
       RETURNING id`,
      [cameraName || null, startDate || null, endDate || null]
    );
    return { cancelled: result.rowCount || 0 };
  }

  async retryRead(readId) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending',
           vehicle_image_queue_kind = 'manual',
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = TRUE,
           vehicle_image_error_code = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND vehicle_image_path IS NULL
         AND camera_name IS NOT NULL
         AND BTRIM(camera_name) <> ''
         AND vehicle_image_status IN ('failed', 'unavailable')
       RETURNING id, vehicle_image_status, vehicle_image_queue_kind,
                 vehicle_image_attempt_count, vehicle_image_retryable`,
      [readId]
    );
    return result.rows?.[0] || null;
  }

  async markPending(readId, { queueKind = "manual", incrementAttempt = true } = {}) {
    await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'processing', vehicle_image_error_code = NULL,
           vehicle_image_queue_kind = COALESCE(vehicle_image_queue_kind, $2),
           vehicle_image_attempt_count = COALESCE(vehicle_image_attempt_count, 0) + CASE WHEN $3 THEN 1 ELSE 0 END,
           vehicle_image_retryable = TRUE, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [readId, queueKind, incrementAttempt === true]
    );
  }

  async markReady(readId, frame) {
    await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'ready', vehicle_image_path = $2,
           vehicle_image_timestamp = $3, vehicle_image_score = $4,
           vehicle_image_detection_confidence = $5, vehicle_image_detection_box = $6::jsonb,
           vehicle_image_width = $7, vehicle_image_height = $8,
           vehicle_image_sampled_count = $9, vehicle_image_error_code = NULL,
           vehicle_image_selection_metadata = $10::jsonb,
           vehicle_image_retryable = FALSE, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        readId, frame.framePath, frame.frameTimestamp, frame.frameScore,
        frame.detectionConfidence, JSON.stringify(frame.detectionBox), frame.imageWidth,
        frame.imageHeight, frame.sampledCount, JSON.stringify(frame.selectionMetadata || {}),
      ]
    );
  }

  async saveMotionDirectionObservation(readId, observation) {
    await this.pool.query(
      `INSERT INTO public.vehicle_motion_direction_observations (
         read_id, camera_key, algorithm_version, capture_mode, status,
         image_direction, confidence, tracker, sampled_count, tracked_count,
         motion_vector, diagnostics, error_code,
         fallback_direction_label, fallback_direction_confidence, evaluated_at
       )
       SELECT reads.id, LOWER(BTRIM(reads.camera_name)), $2, $3, $4,
              $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12,
              fallback.direction_label, fallback.orientation_confidence, CURRENT_TIMESTAMP
       FROM public.plate_reads reads
       LEFT JOIN public.vehicle_direction_observations fallback
         ON fallback.read_id = reads.id
        AND fallback.status = 'ready'
       WHERE reads.id = $1
       ON CONFLICT (read_id) DO UPDATE SET
         camera_key = EXCLUDED.camera_key,
         algorithm_version = EXCLUDED.algorithm_version,
         capture_mode = EXCLUDED.capture_mode,
         status = EXCLUDED.status,
         image_direction = EXCLUDED.image_direction,
         confidence = EXCLUDED.confidence,
         tracker = EXCLUDED.tracker,
         sampled_count = EXCLUDED.sampled_count,
         tracked_count = EXCLUDED.tracked_count,
         motion_vector = EXCLUDED.motion_vector,
         diagnostics = EXCLUDED.diagnostics,
         error_code = EXCLUDED.error_code,
         fallback_direction_label = EXCLUDED.fallback_direction_label,
         fallback_direction_confidence = EXCLUDED.fallback_direction_confidence,
         evaluated_at = EXCLUDED.evaluated_at`,
      [
        readId,
        observation.algorithmVersion,
        observation.captureMode,
        observation.status,
        observation.imageDirection,
        observation.confidence,
        observation.tracker,
        Number(observation.sampleCount || 0),
        Number(observation.trackedCount || 0),
        JSON.stringify(observation.vector || {}),
        JSON.stringify(observation.diagnostics || {}),
        observation.errorCode || null,
      ]
    );
  }

  async markFailed(readId, { status, errorCode, retryable }) {
    await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = $2, vehicle_image_error_code = $3,
           vehicle_image_retryable = $4, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [readId, status, errorCode, retryable]
    );
  }
}
