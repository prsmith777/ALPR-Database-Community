export class BlueIrisVehicleFrameRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findNearestRead({ cameraName, timestamp, toleranceSeconds = 3 }) {
    const result = await this.pool.query(
      `SELECT id, plate_number, camera_name, "timestamp", vehicle_image_path
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
                 reads.vehicle_image_path, reads.vehicle_image_queue_kind,
                 reads.vehicle_image_attempt_count`,
      [includeHistorical === true]
    );
    return result.rows?.[0] || null;
  }

  async getQueueStatus() {
    const [counts, control] = await Promise.all([
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
    ]);
    const row = counts.rows?.[0] || {};
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

  async queueHistorical({ cameraName = null, startDate = null, endDate = null } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending',
           vehicle_image_queue_kind = 'historical',
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = TRUE,
           vehicle_image_error_code = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_path IS NULL
         AND camera_name IS NOT NULL
         AND BTRIM(camera_name) <> ''
         AND ($1::text IS NULL OR LOWER(BTRIM(camera_name)) = LOWER(BTRIM($1)))
         AND ($2::timestamptz IS NULL OR "timestamp" >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR "timestamp" <= $3::timestamptz)
       RETURNING id`,
      [cameraName || null, startDate || null, endDate || null]
    );
    return { queued: result.rowCount || 0 };
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
           vehicle_image_retryable = FALSE, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        readId, frame.framePath, frame.frameTimestamp, frame.frameScore,
        frame.detectionConfidence, JSON.stringify(frame.detectionBox), frame.imageWidth,
        frame.imageHeight, frame.sampledCount,
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
