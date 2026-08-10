import crypto from "node:crypto";

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

  async withTransaction(operation) {
    const ownsClient = typeof this.pool.connect === "function";
    const client = ownsClient ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await operation(new BlueIrisVehicleFrameRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async createOverviewCandidate(input = {}) {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO public.vehicle_overview_candidates (
           event_identity, source_camera_name, event_timestamp,
           bi_alert_clip, bi_alert_path, bi_alert_offset_ms, bi_trigger_type,
           daylight_status, monochrome_ratio, status, retryable, error_code,
           updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)
         ON CONFLICT (event_identity) DO NOTHING
         RETURNING *
       )
       SELECT *, FALSE AS duplicate FROM inserted
       UNION ALL
       SELECT existing.*, TRUE AS duplicate
       FROM public.vehicle_overview_candidates existing
       WHERE existing.event_identity = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [
        input.eventIdentity,
        String(input.sourceCameraName || "").trim(),
        input.eventTimestamp,
        input.alertClip || null,
        input.alertPath || null,
        input.alertOffsetMs ?? null,
        input.triggerType || null,
        input.daylightStatus,
        input.monochromeRatio ?? null,
        input.status,
        input.retryable !== false,
        input.errorCode || null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async claimNextOverviewCandidate() {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT id
         FROM public.vehicle_overview_candidates
         WHERE daylight_status = 'daytime'
           AND event_timestamp <= CURRENT_TIMESTAMP - INTERVAL '7 seconds'
           AND frame_path IS NULL
           AND attempt_count < 3
           AND (
             status = 'pending'
             OR (status = 'failed' AND retryable = TRUE
                 AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
             OR (status = 'processing'
                 AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes')
           )
         ORDER BY event_timestamp, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE public.vehicle_overview_candidates overview
       SET status = 'processing',
           attempt_count = overview.attempt_count
             + CASE WHEN overview.status = 'processing' THEN 0 ELSE 1 END,
           error_code = NULL,
           updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE overview.id = candidate.id
       RETURNING overview.*`
    );
    return result.rows?.[0] || null;
  }

  async markOverviewCandidateReady(candidateId, frame) {
    await this.pool.query(
      `UPDATE public.vehicle_overview_candidates
       SET status = 'ready', frame_path = $2, frame_timestamp = $3,
           frame_score = $4, detection_confidence = $5,
           detection_box = $6::jsonb, image_width = $7, image_height = $8,
           sampled_count = $9, selection_metadata = $10::jsonb,
           retryable = FALSE, error_code = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        candidateId, frame.framePath, frame.frameTimestamp, frame.frameScore,
        frame.detectionConfidence, JSON.stringify(frame.detectionBox),
        frame.imageWidth, frame.imageHeight, frame.sampledCount,
        JSON.stringify(frame.selectionMetadata || {}),
      ]
    );
  }

  async markOverviewCandidateFailed(candidateId, { status, errorCode, retryable }) {
    await this.pool.query(
      `UPDATE public.vehicle_overview_candidates
       SET status = $2, error_code = $3, retryable = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [candidateId, status, errorCode, retryable === true]
    );
  }

  async claimNextOverviewAssociation() {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT id
         FROM public.vehicle_overview_candidates
         WHERE frame_path IS NOT NULL
           AND event_timestamp <= CURRENT_TIMESTAMP - INTERVAL '12 seconds'
           AND match_attempt_count < 12
           AND (
             (status = 'ready' AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '5 seconds')
             OR (status = 'matching' AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes')
           )
         ORDER BY event_timestamp, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE public.vehicle_overview_candidates overview
       SET status = 'matching',
           match_attempt_count = overview.match_attempt_count
             + CASE WHEN overview.status = 'matching' THEN 0 ELSE 1 END,
           updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE overview.id = candidate.id
       RETURNING overview.*`
    );
    return result.rows?.[0] || null;
  }

  async listOverviewPairProfiles(sourceCameraName = null) {
    const result = await this.pool.query(
      `SELECT id, source_camera_name, plate_camera_name, direction_label,
              source_role, expected_delta_ms, tolerance_ms, priority, enabled,
              created_at, updated_at
       FROM public.vehicle_overview_pair_profiles
       WHERE ($1::text IS NULL OR LOWER(BTRIM(source_camera_name)) = LOWER(BTRIM($1)))
       ORDER BY source_role, priority, source_camera_name, plate_camera_name, direction_label`,
      [sourceCameraName || null]
    );
    return result.rows || [];
  }

  async listPrimaryOverviewProfilesForRead({ plateCameraName, directionLabel } = {}) {
    const result = await this.pool.query(
      `SELECT id, source_camera_name, plate_camera_name, direction_label,
              source_role, expected_delta_ms, tolerance_ms, priority, enabled,
              created_at, updated_at
       FROM public.vehicle_overview_pair_profiles
       WHERE enabled = TRUE
         AND source_role = 'primary'
         AND LOWER(BTRIM(plate_camera_name)) = LOWER(BTRIM($1))
         AND LOWER(BTRIM(direction_label)) = LOWER(BTRIM($2))
       ORDER BY priority, id`,
      [String(plateCameraName || "").trim(), String(directionLabel || "").trim()]
    );
    return result.rows || [];
  }

  async saveOverviewPairProfile(input = {}, actor = null) {
    return this.withTransaction(async (repository) => {
      const result = await repository.pool.query(
        `INSERT INTO public.vehicle_overview_pair_profiles (
           source_camera_name, plate_camera_name, direction_label, source_role,
           expected_delta_ms, tolerance_ms, priority, enabled, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
         ON CONFLICT (source_camera_name, plate_camera_name, direction_label)
         DO UPDATE SET source_role = EXCLUDED.source_role,
           expected_delta_ms = EXCLUDED.expected_delta_ms,
           tolerance_ms = EXCLUDED.tolerance_ms,
           priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          String(input.sourceCameraName || "").trim(),
          String(input.plateCameraName || "").trim(),
          String(input.directionLabel || "").trim(),
          input.sourceRole,
          input.expectedDeltaMs,
          input.toleranceMs,
          input.priority,
          input.enabled !== false,
        ]
      );
      const saved = result.rows?.[0] || null;
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.overview_profile',
                   'vehicle_overview_pair_profile', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({
          sourceCameraName: saved.source_camera_name,
          plateCameraName: saved.plate_camera_name,
          directionLabel: saved.direction_label,
          sourceRole: saved.source_role,
          expectedDeltaMs: Number(saved.expected_delta_ms),
          toleranceMs: Number(saved.tolerance_ms),
          priority: Number(saved.priority),
          enabled: saved.enabled === true,
        })]
      );
      return saved;
    });
  }

  async deleteOverviewPairProfile(profileId, actor = null) {
    return this.withTransaction(async (repository) => {
      const result = await repository.pool.query(
        `DELETE FROM public.vehicle_overview_pair_profiles profile
         WHERE profile.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_overview_associations association
             WHERE association.pair_profile_id = profile.id
           )
         RETURNING *`,
        [profileId]
      );
      const deleted = result.rows?.[0] || null;
      if (!deleted) return false;
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.overview_profile_deleted',
                   'vehicle_overview_pair_profile', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(deleted.id), JSON.stringify({
          sourceCameraName: deleted.source_camera_name,
          plateCameraName: deleted.plate_camera_name,
          directionLabel: deleted.direction_label,
          sourceRole: deleted.source_role,
        })]
      );
      return true;
    });
  }

  async listOverviewAssociationReads(candidate) {
    const result = await this.pool.query(
      `SELECT reads.id, reads.plate_number, reads.observed_plate,
              reads.camera_name, reads.timestamp,
              reads.bi_trigger_direction_label, reads.vehicle_image_path,
              reads.vehicle_image_status, reads.vehicle_image_queue_kind
       FROM public.plate_reads reads
       WHERE reads.timestamp BETWEEN $1::timestamptz - INTERVAL '30 seconds'
                                 AND $1::timestamptz + INTERVAL '30 seconds'
         AND reads.vehicle_image_path IS NULL
         AND reads.vehicle_image_status = 'pending'
         AND reads.vehicle_image_queue_kind = 'overview'
         AND reads.bi_trigger_direction_status = 'ready'
         AND reads.bi_trigger_direction_label IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_overview_associations association
           WHERE association.read_id = reads.id
         )
       ORDER BY reads.timestamp, reads.id`,
      [candidate.event_timestamp]
    );
    return result.rows || [];
  }

  async associateOverviewRead({ candidate, read, association, framePath, sourceKind }) {
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE public.plate_reads
         SET vehicle_image_status = 'ready', vehicle_image_path = $3,
             vehicle_image_timestamp = $4, vehicle_image_score = $5,
             vehicle_image_detection_confidence = $6,
             vehicle_image_detection_box = $7::jsonb,
             vehicle_image_width = $8, vehicle_image_height = $9,
             vehicle_image_sampled_count = $10,
             vehicle_image_selection_metadata = $11::jsonb,
             vehicle_image_retryable = FALSE, vehicle_image_error_code = NULL,
             vehicle_image_source_kind = $12,
             vehicle_overview_candidate_id = $1,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND vehicle_image_path IS NULL
           AND vehicle_image_queue_kind = 'overview'
         RETURNING id
       ), linked AS (
         INSERT INTO public.vehicle_overview_associations (
           candidate_id, read_id, pair_profile_id, algorithm,
           association_score, actual_delta_ms, timing_error_ms
         )
         SELECT $1, updated.id, $13, $14, $15, $16, $17 FROM updated
         ON CONFLICT (read_id) DO NOTHING
         RETURNING read_id
       )
       SELECT read_id FROM linked`,
      [
        candidate.id, read.id, framePath, candidate.frame_timestamp,
        candidate.frame_score, candidate.detection_confidence,
        JSON.stringify(candidate.detection_box || {}), candidate.image_width,
        candidate.image_height, candidate.sampled_count,
        JSON.stringify({
          ...(candidate.selection_metadata || {}),
          association: association.metadata,
        }),
        sourceKind, association.profileId, association.algorithm,
        association.score, association.actualDeltaMs, association.timingErrorMs,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markOverviewCandidateAssociated(candidateId) {
    await this.pool.query(
      `UPDATE public.vehicle_overview_candidates
       SET status = 'associated', frame_path = NULL, retryable = FALSE,
           error_code = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [candidateId]
    );
  }

  async releaseOverviewCandidateMatch(candidateId, {
    status = "ready",
    errorCode = null,
    preserveAttempts = false,
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.vehicle_overview_candidates
       SET status = CASE
             WHEN $2 = 'ready' AND match_attempt_count >= 12 THEN 'unavailable'
             ELSE $2
           END,
           retryable = CASE
             WHEN $2 = 'ready' AND match_attempt_count >= 12 THEN FALSE
             ELSE retryable
           END,
           error_code = CASE
             WHEN $2 = 'ready' AND match_attempt_count >= 12 THEN 'NO_MATCHING_PLATE_READ'
             ELSE $3
           END,
           match_attempt_count = CASE
             WHEN $4::boolean THEN GREATEST(match_attempt_count - 1, 0)
             ELSE match_attempt_count
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING status, frame_path, error_code`,
      [candidateId, status, errorCode, preserveAttempts === true]
    );
    return result.rows?.[0] || null;
  }

  async discardOverviewCandidateFrame(candidateId) {
    await this.pool.query(
      `UPDATE public.vehicle_overview_candidates
       SET frame_path = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [candidateId]
    );
  }

  async getOverviewStatus() {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
         COUNT(*) FILTER (WHERE status IN ('processing','matching'))::integer AS processing,
         COUNT(*) FILTER (WHERE status = 'ready')::integer AS awaiting_match,
         COUNT(*) FILTER (WHERE status = 'associated')::integer AS associated,
         COUNT(*) FILTER (WHERE status = 'ambiguous')::integer AS ambiguous,
         COUNT(*) FILTER (
           WHERE status = 'unavailable' AND daylight_status = 'daytime'
         )::integer AS unavailable,
         COUNT(*) FILTER (WHERE daylight_status = 'nighttime')::integer AS nighttime_skipped,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed
       FROM public.vehicle_overview_candidates`
    );
    const sources = await this.pool.query(
      `SELECT DISTINCT source_camera_name
       FROM public.vehicle_overview_candidates
       ORDER BY source_camera_name`
    );
    const row = result.rows?.[0] || {};
    return {
      pending: Number(row.pending || 0),
      processing: Number(row.processing || 0),
      awaitingMatch: Number(row.awaiting_match || 0),
      associated: Number(row.associated || 0),
      ambiguous: Number(row.ambiguous || 0),
      unavailable: Number(row.unavailable || 0),
      nighttimeSkipped: Number(row.nighttime_skipped || 0),
      failed: Number(row.failed || 0),
      observedSources: (sources.rows || []).map((item) => item.source_camera_name),
    };
  }

  async expireOverviewReads() {
    const result = await this.pool.query(
      `UPDATE public.plate_reads reads
       SET vehicle_image_status = 'unavailable',
           vehicle_image_retryable = FALSE,
           vehicle_image_error_code = 'NO_MATCHING_DAYTIME_OVERVIEW',
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE reads.vehicle_image_queue_kind = 'overview'
         AND reads.vehicle_image_status = 'pending'
         AND reads.vehicle_image_path IS NULL
         AND reads.timestamp <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_overview_associations association
           WHERE association.read_id = reads.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.vehicle_overview_candidates candidate
           JOIN public.vehicle_overview_pair_profiles profile
             ON profile.enabled = TRUE
            AND LOWER(BTRIM(profile.source_camera_name)) = LOWER(BTRIM(candidate.source_camera_name))
            AND LOWER(BTRIM(profile.plate_camera_name)) = LOWER(BTRIM(reads.camera_name))
            AND LOWER(BTRIM(profile.direction_label)) = LOWER(BTRIM(reads.bi_trigger_direction_label))
           WHERE candidate.daylight_status = 'daytime'
             AND candidate.status IN ('pending','processing','ready','matching')
             AND ABS(
               EXTRACT(EPOCH FROM (candidate.event_timestamp - reads.timestamp)) * 1000
               - profile.expected_delta_ms
             ) <= profile.tolerance_ms
         )
       RETURNING reads.id`
    );
    return result.rowCount || 0;
  }

  async findNearestRead({ cameraName, timestamp, toleranceSeconds = 3 }) {
    const result = await this.pool.query(
      `SELECT id, plate_number, camera_name, "timestamp", crop_coordinates, vehicle_image_path
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
               AND COALESCE(vehicle_image_queue_kind, 'live') IN ('live','manual'))
             OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
               AND COALESCE(vehicle_image_attempt_count, 0) < 3
               AND COALESCE(vehicle_image_queue_kind, 'live') IN ('live','manual')
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
               AND COALESCE(vehicle_image_queue_kind, 'live') IN ('live','manual')
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
                 reads.crop_coordinates, reads.vehicle_image_path, reads.vehicle_image_queue_kind,
                 reads.vehicle_image_attempt_count`,
      [includeHistorical === true]
    );
    return result.rows?.[0] || null;
  }

  async claimNextOverviewRead() {
    const claimToken = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT reads.id,
                profile.id AS overview_profile_id,
                profile.source_camera_name AS overview_source_camera_name,
                profile.expected_delta_ms AS overview_expected_delta_ms,
                profile.tolerance_ms AS overview_tolerance_ms,
                profile.priority AS overview_profile_priority,
                profile.updated_at AS overview_profile_updated_at
         FROM public.plate_reads reads
         LEFT JOIN LATERAL (
           SELECT id, source_camera_name, expected_delta_ms, tolerance_ms,
                  priority, updated_at
           FROM public.vehicle_overview_pair_profiles
           WHERE enabled = TRUE
             AND source_role = 'primary'
             AND tolerance_ms <= 3000
             AND LOWER(BTRIM(source_camera_name)) <> LOWER(BTRIM(plate_camera_name))
             AND LOWER(BTRIM(plate_camera_name)) = LOWER(BTRIM(reads.camera_name))
             AND LOWER(BTRIM(direction_label)) = LOWER(BTRIM(reads.bi_trigger_direction_label))
           ORDER BY priority, id
           LIMIT 1
         ) profile ON TRUE
         WHERE reads.vehicle_image_path IS NULL
           AND reads.vehicle_image_queue_kind = 'overview'
           AND reads.camera_name IS NOT NULL
           AND BTRIM(reads.camera_name) <> ''
           AND reads.bi_trigger_direction_status = 'ready'
           AND reads.bi_trigger_direction_label IS NOT NULL
           AND BTRIM(reads.bi_trigger_direction_label) <> ''
           AND (
             (profile.id IS NOT NULL AND reads."timestamp"
                   + profile.expected_delta_ms * INTERVAL '1 millisecond'
                   + (6000 - profile.tolerance_ms) * INTERVAL '1 millisecond'
                   + INTERVAL '1 second'
                 <= CURRENT_TIMESTAMP - INTERVAL '5 seconds')
             OR (profile.id IS NULL
               AND reads."timestamp" <= CURRENT_TIMESTAMP - INTERVAL '10 seconds')
           )
           AND (
             (reads.vehicle_image_status = 'pending'
               AND COALESCE(reads.vehicle_image_attempt_count, 0) < 2)
             OR (reads.vehicle_image_status = 'failed' AND reads.vehicle_image_retryable = TRUE
               AND COALESCE(reads.vehicle_image_attempt_count, 0) < 2
               AND COALESCE(reads.vehicle_image_next_attempt_at, reads.vehicle_image_updated_at)
                   <= CURRENT_TIMESTAMP)
              OR (reads.vehicle_image_status = 'processing'
                AND COALESCE(reads.vehicle_image_attempt_count, 0) < 2
                AND (
                  COALESCE(
                    reads.vehicle_image_processing_deadline_at,
                    reads.vehicle_image_updated_at + INTERVAL '3 minutes'
                  ) <= CURRENT_TIMESTAMP
                  OR COALESCE(
                    reads.vehicle_image_hard_deadline_at,
                    reads.vehicle_image_updated_at + INTERVAL '5 minutes'
                  ) <= CURRENT_TIMESTAMP
                ))
           )
         ORDER BY reads."timestamp" ASC, reads.id ASC
         FOR UPDATE OF reads SKIP LOCKED
         LIMIT 1
       )
        UPDATE public.plate_reads reads
        SET vehicle_image_status = 'processing',
            vehicle_image_attempt_count = COALESCE(reads.vehicle_image_attempt_count, 0) + 1,
           vehicle_image_error_code = NULL,
           vehicle_image_claim_token = $1::uuid,
            vehicle_image_next_attempt_at = NULL,
            vehicle_image_heartbeat_at = CURRENT_TIMESTAMP,
            vehicle_image_processing_deadline_at = CURRENT_TIMESTAMP + INTERVAL '3 minutes',
            vehicle_image_hard_deadline_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
            vehicle_image_updated_at = CURRENT_TIMESTAMP
       FROM candidate
       WHERE reads.id = candidate.id
       RETURNING reads.id, reads.plate_number, reads.observed_plate,
                 reads.camera_name, reads."timestamp", reads.crop_coordinates,
                 reads.bi_trigger_direction_label, reads.vehicle_image_path,
                  reads.vehicle_image_queue_kind, reads.vehicle_image_attempt_count,
                  reads.vehicle_image_claim_token, reads.vehicle_image_hard_deadline_at,
                 candidate.overview_profile_id, candidate.overview_source_camera_name,
                 candidate.overview_expected_delta_ms, candidate.overview_tolerance_ms,
                 candidate.overview_profile_priority, candidate.overview_profile_updated_at`,
      [claimToken],
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

  async terminalizeExpiredOverviewReads() {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'failed',
           vehicle_image_retryable = FALSE,
           vehicle_image_error_code = 'OVERVIEW_PROCESSING_DEADLINE',
           vehicle_image_claim_token = NULL,
           vehicle_image_next_attempt_at = NULL,
           vehicle_image_heartbeat_at = NULL,
           vehicle_image_processing_deadline_at = NULL,
           vehicle_image_hard_deadline_at = NULL,
           vehicle_image_selection_metadata = COALESCE(vehicle_image_selection_metadata, '{}'::jsonb)
             || jsonb_build_object('failure', jsonb_build_object(
               'code', 'OVERVIEW_PROCESSING_DEADLINE',
               'reason', 'retry_limit_exhausted',
               'terminalizedAt', CURRENT_TIMESTAMP
             )),
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_queue_kind = 'overview'
         AND vehicle_image_status = 'processing'
         AND COALESCE(vehicle_image_attempt_count, 0) >= 2
         AND COALESCE(
           vehicle_image_hard_deadline_at,
           vehicle_image_processing_deadline_at,
           vehicle_image_updated_at + INTERVAL '5 minutes'
         ) <= CURRENT_TIMESTAMP
       RETURNING id`
    );
    return { terminalized: result.rowCount || 0 };
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
            vehicle_image_claim_token = NULL,
            vehicle_image_next_attempt_at = NULL,
            vehicle_image_heartbeat_at = NULL,
            vehicle_image_processing_deadline_at = NULL,
            vehicle_image_hard_deadline_at = NULL,
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
           vehicle_image_claim_token = NULL,
           vehicle_image_next_attempt_at = NULL,
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
           vehicle_image_queue_kind = CASE
             WHEN vehicle_image_queue_kind = 'overview' THEN 'overview'
             ELSE 'manual'
           END,
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = TRUE,
            vehicle_image_error_code = NULL,
            vehicle_image_claim_token = NULL,
            vehicle_image_next_attempt_at = NULL,
            vehicle_image_heartbeat_at = NULL,
            vehicle_image_processing_deadline_at = NULL,
            vehicle_image_hard_deadline_at = NULL,
            vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND vehicle_image_path IS NULL
         AND camera_name IS NOT NULL
         AND BTRIM(camera_name) <> ''
         AND COALESCE(vehicle_image_error_code, '') <> 'NIGHTTIME_UNAVAILABLE'
         AND (vehicle_image_queue_kind <> 'overview' OR vehicle_image_retryable = TRUE)
         AND vehicle_image_status IN ('failed', 'unavailable')
       RETURNING id, vehicle_image_status, vehicle_image_queue_kind,
                 vehicle_image_attempt_count, vehicle_image_retryable`,
      [readId]
    );
    return result.rows?.[0] || null;
  }

  async recoverIncompleteOverviewReads({ sinceHours = 48 } = {}) {
    const boundedHours = Math.min(168, Math.max(1, Number.parseInt(String(sinceHours), 10) || 48));
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending',
           vehicle_image_attempt_count = 0,
           vehicle_image_retryable = TRUE,
           vehicle_image_error_code = NULL,
           vehicle_image_claim_token = NULL,
           vehicle_image_next_attempt_at = NULL,
            vehicle_image_heartbeat_at = NULL,
            vehicle_image_processing_deadline_at = NULL,
            vehicle_image_hard_deadline_at = NULL,
           vehicle_image_selection_metadata = COALESCE(vehicle_image_selection_metadata, '{}'::jsonb)
             || jsonb_build_object('recovery', jsonb_build_object(
               'reason', 'timeline_export_upgrade',
               'queuedAt', CURRENT_TIMESTAMP,
               'previousStatus', vehicle_image_status,
               'previousErrorCode', vehicle_image_error_code
             )),
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_queue_kind = 'overview'
         AND vehicle_image_path IS NULL
         AND "timestamp" >= CURRENT_TIMESTAMP - make_interval(hours => $1)
         AND bi_trigger_direction_status = 'ready'
         AND bi_trigger_direction_label IS NOT NULL
         AND BTRIM(bi_trigger_direction_label) <> ''
          AND (
            vehicle_image_status = 'pending'
            OR (vehicle_image_status = 'processing' AND COALESCE(
              vehicle_image_hard_deadline_at,
              vehicle_image_processing_deadline_at,
              vehicle_image_updated_at + INTERVAL '5 minutes'
            ) <= CURRENT_TIMESTAMP)
            OR (vehicle_image_status IN ('failed','unavailable') AND (
              COALESCE(vehicle_image_error_code, '') IN (
                'RECORDING_UNAVAILABLE','TIMEOUT','FRAME_SELECTION_FAILED',
                'OVERVIEW_PROCESSING_DEADLINE','EXPORT_TIMEOUT',
                'EXPORT_UNAVAILABLE','EXPORT_FAILED','EXPORT_DURATION_TOO_SHORT',
                'EXPORT_PROBE_INVALID','EXPORT_FRAME_COUNT_INVALID','EXPORT_INVALID',
                'MEDIA_TOOL_TIMEOUT','MEDIA_TOOL_FAILED','HTTP_ERROR','CONNECTION_FAILED'
              )
            ))
         )
       RETURNING id`,
      [boundedHours]
    );
    return { queued: result.rowCount || 0, sinceHours: boundedHours };
  }

  async markPending(readId, { queueKind = "manual", incrementAttempt = true } = {}) {
    await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'processing', vehicle_image_error_code = NULL,
           vehicle_image_queue_kind = COALESCE(vehicle_image_queue_kind, $2),
           vehicle_image_attempt_count = COALESCE(vehicle_image_attempt_count, 0) + CASE WHEN $3 THEN 1 ELSE 0 END,
           vehicle_image_retryable = TRUE, vehicle_image_claim_token = NULL,
           vehicle_image_next_attempt_at = NULL, vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND vehicle_image_claim_token IS NULL`,
      [readId, queueKind, incrementAttempt === true]
    );
  }

  async heartbeatOverviewRead(readId, claimToken, { extendSeconds = 180 } = {}) {
    const boundedSeconds = Math.min(300, Math.max(30, Number.parseInt(String(extendSeconds), 10) || 180));
    const result = await this.pool.query(
      `UPDATE public.plate_reads
        SET vehicle_image_heartbeat_at = CURRENT_TIMESTAMP,
            vehicle_image_processing_deadline_at = LEAST(
              CURRENT_TIMESTAMP + make_interval(secs => $3),
              vehicle_image_hard_deadline_at
            ),
            vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
          AND vehicle_image_status = 'processing'
          AND vehicle_image_claim_token = $2::uuid
          AND vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
        RETURNING id, vehicle_image_hard_deadline_at`,
      [readId, claimToken, boundedSeconds]
    );
    return result.rows?.[0] || null;
  }

  async beginTimelineExport({
    readId,
    claimToken,
    sourceCameraName,
    requestedStartAt,
    requestedDurationMs,
    hardDeadlineAt = null,
  }) {
    const exportToken = crypto.randomUUID();
    const result = await this.pool.query(
      `INSERT INTO public.blue_iris_timeline_exports (
         export_token, read_id, claim_token, source_camera_name,
         requested_start_at, requested_duration_ms, status, hard_deadline_at
       ) VALUES (
         $1::uuid,$2,$3::uuid,$4,$5::timestamptz,$6,'starting',
         COALESCE($7::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
       )
       ON CONFLICT (read_id, claim_token) DO UPDATE SET
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        exportToken,
        readId,
        claimToken,
        String(sourceCameraName || "").trim(),
        requestedStartAt,
        requestedDurationMs,
        hardDeadlineAt,
      ]
    );
    return result.rows?.[0] || null;
  }

  async recordTimelineExportRemote(exportToken, remote = {}) {
    const rawUtc = Number(remote.utc);
    const remoteUtcMs = Number.isFinite(rawUtc)
      ? Math.round(rawUtc < 1_000_000_000_000 ? rawUtc * 1_000 : rawUtc)
      : null;
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
       SET remote_path = $2,
           remote_uri = COALESCE($3, remote_uri),
            status = CASE WHEN $4::boolean THEN 'ready' ELSE 'exporting' END,
            progress = $5,
            file_size_bytes = COALESCE($6, file_size_bytes),
            remote_utc_ms = COALESCE($7, remote_utc_ms),
            remote_duration_ms = COALESCE($8, remote_duration_ms),
            remote_status = COALESCE($9, remote_status),
            updated_at = CURRENT_TIMESTAMP
       WHERE export_token = $1::uuid
       RETURNING *`,
      [
        exportToken,
        remote.remotePath || null,
        remote.uri || null,
        remote.complete === true,
        remote.progress ?? null,
        remote.fileSize ?? null,
        remoteUtcMs,
        remote.durationMs ?? null,
        String(remote.status || "").trim() || null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markTimelineExportDownloaded(exportToken, media = {}) {
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
       SET status = 'downloaded', remote_uri = COALESCE($2, remote_uri),
           file_size_bytes = COALESCE($3, file_size_bytes),
           video_width = $4, video_height = $5, media_duration_ms = $6,
           downloaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           error_code = NULL, error_details = NULL, next_delete_attempt_at = NULL
       WHERE export_token = $1::uuid AND deleted_at IS NULL
       RETURNING *`,
      [
        exportToken,
        media.uri || null,
        media.fileSize ?? null,
        media.width ?? null,
        media.height ?? null,
        media.durationMs ?? null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markTimelineExportFailed(exportToken, {
    errorCode,
    errorDetails = null,
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
        SET status = 'failed',
            error_code = $2, error_details = $3::jsonb,
            next_delete_attempt_at = NULL,
            updated_at = CURRENT_TIMESTAMP
       WHERE export_token = $1::uuid AND deleted_at IS NULL
       RETURNING *`,
      [
        exportToken,
        String(errorCode || "TIMELINE_EXPORT_FAILED").slice(0, 80),
        errorDetails ? JSON.stringify(errorDetails) : null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markReady(readId, frame, { claimToken = null, profileSnapshot = null } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'ready', vehicle_image_path = $2,
           vehicle_image_timestamp = $3, vehicle_image_score = $4,
           vehicle_image_detection_confidence = $5, vehicle_image_detection_box = $6::jsonb,
           vehicle_image_width = $7, vehicle_image_height = $8,
           vehicle_image_sampled_count = $9, vehicle_image_error_code = NULL,
           vehicle_image_selection_metadata = $10::jsonb,
           vehicle_image_source_kind = $11,
            vehicle_image_retryable = FALSE, vehicle_image_claim_token = NULL,
            vehicle_image_next_attempt_at = NULL, vehicle_image_heartbeat_at = NULL,
            vehicle_image_processing_deadline_at = NULL, vehicle_image_hard_deadline_at = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND (($12::uuid IS NULL AND vehicle_image_claim_token IS NULL)
           OR vehicle_image_claim_token = $12::uuid)
         AND ($12::uuid IS NULL OR vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP)
         AND ($13::bigint IS NULL OR EXISTS (
           SELECT 1
           FROM public.vehicle_overview_pair_profiles profile
           WHERE profile.id = $13::bigint
             AND profile.enabled = TRUE
             AND profile.source_role = 'primary'
             AND profile.updated_at IS NOT DISTINCT FROM $14::timestamptz
         ))
       RETURNING id`,
      [
        readId, frame.framePath, frame.frameTimestamp, frame.frameScore,
        frame.detectionConfidence, JSON.stringify(frame.detectionBox), frame.imageWidth,
        frame.imageHeight, frame.sampledCount, JSON.stringify(frame.selectionMetadata || {}),
        frame.sourceKind || "legacy_plate_camera", claimToken,
        profileSnapshot?.id || null, profileSnapshot?.updatedAt || null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markFailed(readId, {
    status,
    errorCode,
    retryable,
    claimToken = null,
    nextAttemptAt = null,
    selectionMetadata = null,
    profileSnapshot = null,
  }) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = $2, vehicle_image_error_code = $3,
           vehicle_image_retryable = $4, vehicle_image_next_attempt_at = $5::timestamptz,
           vehicle_image_selection_metadata = COALESCE($6::jsonb, vehicle_image_selection_metadata),
            vehicle_image_claim_token = NULL, vehicle_image_heartbeat_at = NULL,
            vehicle_image_processing_deadline_at = NULL, vehicle_image_hard_deadline_at = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND (($7::uuid IS NULL AND vehicle_image_claim_token IS NULL)
           OR vehicle_image_claim_token = $7::uuid)
         AND ($8::bigint IS NULL OR EXISTS (
           SELECT 1
           FROM public.vehicle_overview_pair_profiles profile
           WHERE profile.id = $8::bigint
             AND profile.enabled = TRUE
             AND profile.source_role = 'primary'
             AND profile.updated_at IS NOT DISTINCT FROM $9::timestamptz
         ))
       RETURNING id`,
      [
        readId, status, errorCode, retryable, nextAttemptAt,
        selectionMetadata ? JSON.stringify(selectionMetadata) : null,
        claimToken, profileSnapshot?.id || null, profileSnapshot?.updatedAt || null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async releaseOverviewReadClaim(readId, claimToken, {
    errorCode = "OVERVIEW_PROFILE_CHANGED",
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending', vehicle_image_error_code = $3,
           vehicle_image_retryable = TRUE,
           vehicle_image_attempt_count = GREATEST(COALESCE(vehicle_image_attempt_count, 1) - 1, 0),
            vehicle_image_claim_token = NULL, vehicle_image_next_attempt_at = NULL,
            vehicle_image_heartbeat_at = NULL, vehicle_image_processing_deadline_at = NULL,
            vehicle_image_hard_deadline_at = NULL,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND vehicle_image_claim_token = $2::uuid
         AND vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
       RETURNING id`,
      [readId, claimToken, errorCode]
    );
    return result.rows?.[0] || null;
  }
}
