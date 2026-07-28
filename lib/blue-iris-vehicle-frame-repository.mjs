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

  async markPending(readId) {
    await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending', vehicle_image_error_code = NULL,
           vehicle_image_retryable = TRUE, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [readId]
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
