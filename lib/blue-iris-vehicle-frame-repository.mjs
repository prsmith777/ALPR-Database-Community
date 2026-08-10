import crypto from "node:crypto";

import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";

const OVERVIEW_RECOVERY_WHERE_SQL = `
  vehicle_image_queue_kind = 'overview'
  AND vehicle_image_path IS NULL
  AND COALESCE(vehicle_image_recovery_count, 0) = 0
  AND "timestamp" >= $1::timestamptz
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
        'OVERVIEW_PROCESSING_DEADLINE','OVERVIEW_PROFILE_CHANGED','EXPORT_TIMEOUT',
        'EXPORT_UNAVAILABLE','EXPORT_FAILED','EXPORT_DURATION_TOO_SHORT',
        'EXPORT_PROBE_INVALID','EXPORT_FRAME_COUNT_INVALID','EXPORT_INVALID',
        'MEDIA_TOOL_TIMEOUT','MEDIA_TOOL_FAILED','HTTP_ERROR','CONNECTION_FAILED'
      )
    ))
  )`;

function normalizeOverviewRecoveryStart({ startAt = null, sinceHours = 48 } = {}) {
  const boundedHours = Math.min(168, Math.max(1, Number.parseInt(String(sinceHours), 10) || 48));
  const recoveryStart = startAt == null || String(startAt).trim() === ""
    ? new Date(Date.now() - boundedHours * 60 * 60 * 1_000)
    : new Date(startAt);
  if (!Number.isFinite(recoveryStart.getTime())) {
    throw new Error("A valid overview recovery start time is required.");
  }
  return recoveryStart.toISOString();
}

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
              source_role, expected_delta_ms, tolerance_ms, priority, enabled, revision,
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
              source_role, expected_delta_ms, tolerance_ms, priority, enabled, revision,
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
           revision = CASE WHEN ROW(
             vehicle_overview_pair_profiles.source_role,
             vehicle_overview_pair_profiles.expected_delta_ms,
             vehicle_overview_pair_profiles.tolerance_ms,
             vehicle_overview_pair_profiles.priority,
             vehicle_overview_pair_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.source_role, EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN vehicle_overview_pair_profiles.revision + 1
             ELSE vehicle_overview_pair_profiles.revision END,
           updated_at = CASE WHEN ROW(
             vehicle_overview_pair_profiles.source_role,
             vehicle_overview_pair_profiles.expected_delta_ms,
             vehicle_overview_pair_profiles.tolerance_ms,
             vehicle_overview_pair_profiles.priority,
             vehicle_overview_pair_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.source_role, EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN CURRENT_TIMESTAMP ELSE vehicle_overview_pair_profiles.updated_at END
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

  async getStreetPairSharingSettings() {
    const result = await this.pool.query(
      `SELECT mode, observation_started_at, updated_by_user_id, created_at, updated_at
       FROM public.vehicle_overview_pair_sharing_settings
       WHERE singleton = TRUE`
    );
    return result.rows?.[0] || {
      mode: "off",
      observation_started_at: null,
      updated_by_user_id: null,
      created_at: null,
      updated_at: null,
    };
  }

  async setStreetPairSharingMode(mode, actor = null) {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (!["off", "shadow", "active"].includes(normalizedMode)) {
      throw new Error("Street pair sharing mode must be off, shadow, or active.");
    }
    return this.withTransaction(async (repository) => {
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      const result = await repository.pool.query(
        `UPDATE public.vehicle_overview_pair_sharing_settings
         SET mode = $1, updated_by_user_id = $2::bigint, updated_at = CURRENT_TIMESTAMP
         WHERE singleton = TRUE
         RETURNING mode, observation_started_at, updated_at`,
        [normalizedMode, actorId]
      );
      const saved = result.rows?.[0] || null;
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.overview_pair_sharing_mode',
                   'vehicle_overview_pair_sharing_settings', 'singleton', 'succeeded', $2::jsonb)`,
        [actorId, JSON.stringify({ mode: normalizedMode })]
      );
      return saved;
    });
  }

  async listStreetPairSharingReads({ startedAt = null } = {}) {
    const result = await this.pool.query(
      `WITH targets AS (
         SELECT reads.*
         FROM public.plate_reads reads
         WHERE reads."timestamp" >= COALESCE($1::timestamptz, CURRENT_TIMESTAMP)
           AND reads.vehicle_image_path IS NULL
           AND reads.vehicle_image_queue_kind = 'overview'
           AND reads.vehicle_image_status IN ('failed','unavailable')
           AND reads.vehicle_image_retryable = FALSE
           AND reads.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
           AND reads.vehicle_image_claim_token IS NULL
           AND reads.bi_trigger_direction_status = 'ready'
           AND NULLIF(BTRIM(reads.bi_trigger_direction_label), '') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_overview_read_shares sharing
             WHERE sharing.target_read_id = reads.id
           )
         ORDER BY reads."timestamp", reads.id
         LIMIT 100
       ), bounds AS (
         SELECT MIN("timestamp") - INTERVAL '12 seconds' AS started_at,
                MAX("timestamp") + INTERVAL '12 seconds' AS ended_at
         FROM targets
       ), sources AS (
         SELECT reads.*
         FROM public.plate_reads reads, bounds
         WHERE bounds.started_at IS NOT NULL
           AND reads."timestamp" BETWEEN bounds.started_at AND bounds.ended_at
           AND reads.vehicle_image_status = 'ready'
           AND reads.vehicle_image_source_kind = 'overview_primary'
           AND NULLIF(BTRIM(reads.vehicle_image_path), '') IS NOT NULL
           AND reads.bi_trigger_direction_status = 'ready'
           AND NULLIF(BTRIM(reads.bi_trigger_direction_label), '') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_overview_read_shares sharing
             WHERE sharing.source_read_id = reads.id
               AND sharing.status IN ('proposed','processing','applied')
           )
       )
       SELECT * FROM targets
       UNION ALL
       SELECT * FROM sources
       ORDER BY "timestamp", id`,
      [startedAt]
    );
    return result.rows || [];
  }

  async recordStreetPairSharingDecisions(decisions = []) {
    if (!Array.isArray(decisions) || decisions.length === 0) return 0;
    return this.withTransaction(async (repository) => {
      let recorded = 0;
      for (const decision of decisions.slice(0, 100)) {
        const metadata = decision.metadata || {};
        const result = await repository.pool.query(
          `INSERT INTO public.vehicle_overview_read_shares (
             decision_identity, source_read_id, target_read_id, status, decision_reason,
             plate_number_snapshot, direction_label_snapshot,
             source_camera_name_snapshot, target_camera_name_snapshot,
             overview_camera_name_snapshot, source_profile_id, source_profile_revision,
             target_profile_id, target_profile_revision, source_image_path_snapshot,
             source_anchor_at, target_anchor_at, anchor_delta_ms, decision_metadata, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,
             CURRENT_TIMESTAMP
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            decision.decisionIdentity,
            decision.sourceReadId || null,
            decision.targetReadId,
            decision.status,
            decision.reason,
            metadata.plateNumber || null,
            metadata.directionLabel || null,
            metadata.sourceCameraName || null,
            metadata.targetCameraName || null,
            metadata.overviewCameraName || null,
            metadata.sourceProfileId || null,
            metadata.sourceProfileRevision || null,
            metadata.targetProfileId || null,
            metadata.targetProfileRevision || null,
            metadata.sourceImagePath || null,
            metadata.sourceAnchorAt || null,
            metadata.targetAnchorAt || null,
            metadata.anchorDeltaMs ?? null,
            JSON.stringify(metadata),
          ]
        );
        recorded += result.rowCount || 0;
      }
      return recorded;
    });
  }

  async claimNextStreetPairShare() {
    const claimToken = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT sharing.id
         FROM public.vehicle_overview_read_shares sharing
         JOIN public.vehicle_overview_pair_sharing_settings settings
           ON settings.singleton = TRUE AND settings.mode = 'active'
         JOIN public.plate_reads source ON source.id = sharing.source_read_id
         JOIN public.plate_reads target ON target.id = sharing.target_read_id
         WHERE sharing.status = 'proposed'
           AND sharing.attempt_count < 1
           AND source.vehicle_image_status = 'ready'
           AND source.vehicle_image_source_kind = 'overview_primary'
           AND source.vehicle_image_path = sharing.source_image_path_snapshot
           AND source.vehicle_image_selection_metadata->>'profileId' = sharing.source_profile_id::text
           AND source.vehicle_image_selection_metadata->>'profileRevision' = sharing.source_profile_revision::text
           AND target.vehicle_image_selection_metadata->>'profileId' = sharing.target_profile_id::text
           AND target.vehicle_image_selection_metadata->>'profileRevision' = sharing.target_profile_revision::text
           AND target.vehicle_image_path IS NULL
           AND target.vehicle_image_queue_kind = 'overview'
           AND target.vehicle_image_status IN ('failed','unavailable')
           AND target.vehicle_image_retryable = FALSE
           AND target.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
           AND target.vehicle_image_claim_token IS NULL
           AND LOWER(BTRIM(source.plate_number)) = LOWER(BTRIM(sharing.plate_number_snapshot))
           AND LOWER(BTRIM(target.plate_number)) = LOWER(BTRIM(sharing.plate_number_snapshot))
           AND LOWER(BTRIM(source.bi_trigger_direction_label)) = LOWER(BTRIM(sharing.direction_label_snapshot))
           AND LOWER(BTRIM(target.bi_trigger_direction_label)) = LOWER(BTRIM(sharing.direction_label_snapshot))
           AND LOWER(BTRIM(source.camera_name)) = LOWER(BTRIM(sharing.source_camera_name_snapshot))
           AND LOWER(BTRIM(target.camera_name)) = LOWER(BTRIM(sharing.target_camera_name_snapshot))
           AND LOWER(BTRIM(source.vehicle_image_selection_metadata->>'sourceCameraName')) = LOWER(BTRIM(sharing.overview_camera_name_snapshot))
           AND LOWER(BTRIM(target.vehicle_image_selection_metadata->>'sourceCameraName')) = LOWER(BTRIM(sharing.overview_camera_name_snapshot))
         ORDER BY target."timestamp", target.id
         FOR UPDATE OF sharing SKIP LOCKED
         LIMIT 1
       ), claimed AS (
         UPDATE public.vehicle_overview_read_shares sharing
         SET status = 'processing', claim_token = $1::uuid,
             attempt_count = sharing.attempt_count + 1,
             error_code = NULL, error_details = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate
         WHERE sharing.id = candidate.id
         RETURNING sharing.*
       )
       SELECT claimed.*, target."timestamp" AS target_read_timestamp
       FROM claimed
       JOIN public.plate_reads target ON target.id = claimed.target_read_id`,
      [claimToken]
    );
    return result.rows?.[0] || null;
  }

  async applyStreetPairShare(sharingId, claimToken, targetImagePath) {
    const result = await this.pool.query(
      `WITH copied AS (
         UPDATE public.plate_reads target
         SET vehicle_image_status = 'ready',
             vehicle_image_path = $3,
             vehicle_image_timestamp = source.vehicle_image_timestamp,
             vehicle_image_score = source.vehicle_image_score,
             vehicle_image_detection_confidence = source.vehicle_image_detection_confidence,
             vehicle_image_detection_box = source.vehicle_image_detection_box,
             vehicle_image_width = source.vehicle_image_width,
             vehicle_image_height = source.vehicle_image_height,
             vehicle_image_sampled_count = source.vehicle_image_sampled_count,
             vehicle_image_selection_metadata = jsonb_build_object(
               'algorithm', 'street-overview-pair-sharing-v1',
               'pairShare', sharing.decision_metadata,
               'sourceSelection', COALESCE(source.vehicle_image_selection_metadata, '{}'::jsonb)
             ),
             vehicle_image_source_kind = 'overview_pair_share',
             vehicle_image_source_read_id = source.id,
             vehicle_image_retryable = FALSE,
             vehicle_image_error_code = NULL,
             vehicle_image_claim_token = NULL,
             vehicle_image_next_attempt_at = NULL,
             vehicle_image_heartbeat_at = NULL,
             vehicle_image_processing_deadline_at = NULL,
             vehicle_image_hard_deadline_at = NULL,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_overview_read_shares sharing
         JOIN public.plate_reads source ON source.id = sharing.source_read_id
         WHERE sharing.id = $1
           AND sharing.status = 'processing'
           AND sharing.claim_token = $2::uuid
           AND target.id = sharing.target_read_id
           AND source.vehicle_image_status = 'ready'
           AND source.vehicle_image_source_kind = 'overview_primary'
           AND source.vehicle_image_path = sharing.source_image_path_snapshot
           AND source.vehicle_image_selection_metadata->>'profileId' = sharing.source_profile_id::text
           AND source.vehicle_image_selection_metadata->>'profileRevision' = sharing.source_profile_revision::text
           AND target.vehicle_image_selection_metadata->>'profileId' = sharing.target_profile_id::text
           AND target.vehicle_image_selection_metadata->>'profileRevision' = sharing.target_profile_revision::text
           AND target.vehicle_image_path IS NULL
           AND target.vehicle_image_queue_kind = 'overview'
           AND target.vehicle_image_status IN ('failed','unavailable')
           AND target.vehicle_image_retryable = FALSE
           AND target.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
           AND target.vehicle_image_claim_token IS NULL
           AND LOWER(BTRIM(source.plate_number)) = LOWER(BTRIM(sharing.plate_number_snapshot))
           AND LOWER(BTRIM(target.plate_number)) = LOWER(BTRIM(sharing.plate_number_snapshot))
           AND LOWER(BTRIM(source.bi_trigger_direction_label)) = LOWER(BTRIM(sharing.direction_label_snapshot))
           AND LOWER(BTRIM(target.bi_trigger_direction_label)) = LOWER(BTRIM(sharing.direction_label_snapshot))
           AND LOWER(BTRIM(source.camera_name)) = LOWER(BTRIM(sharing.source_camera_name_snapshot))
           AND LOWER(BTRIM(target.camera_name)) = LOWER(BTRIM(sharing.target_camera_name_snapshot))
           AND LOWER(BTRIM(source.vehicle_image_selection_metadata->>'sourceCameraName')) = LOWER(BTRIM(sharing.overview_camera_name_snapshot))
           AND LOWER(BTRIM(target.vehicle_image_selection_metadata->>'sourceCameraName')) = LOWER(BTRIM(sharing.overview_camera_name_snapshot))
         RETURNING target.id
       ), applied AS (
         UPDATE public.vehicle_overview_read_shares sharing
         SET status = 'applied', target_image_path = $3, claim_token = NULL,
             applied_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         FROM copied
         WHERE sharing.id = $1 AND sharing.claim_token = $2::uuid
         RETURNING sharing.id, sharing.source_read_id, sharing.target_read_id
       )
       SELECT * FROM applied`,
      [sharingId, claimToken, targetImagePath]
    );
    return result.rows?.[0] || null;
  }

  async markStreetPairShareFailed(sharingId, claimToken, {
    errorCode,
    errorDetails = null,
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.vehicle_overview_read_shares
       SET status = 'failed', claim_token = NULL, error_code = $3,
           error_details = $4::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing' AND claim_token = $2::uuid
       RETURNING id`,
      [
        sharingId,
        claimToken,
        String(errorCode || "PAIR_SHARE_FAILED").slice(0, 80),
        errorDetails ? JSON.stringify(errorDetails) : null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async getEntryFallbackSettings() {
    const result = await this.pool.query(
      `SELECT mode, observation_started_at, updated_by_user_id, created_at, updated_at
       FROM public.vehicle_entry_fallback_settings
       WHERE singleton = TRUE`
    );
    return result.rows?.[0] || {
      mode: "off",
      observation_started_at: null,
      updated_by_user_id: null,
      created_at: null,
      updated_at: null,
    };
  }

  async setEntryFallbackMode(mode, { observationStartedAt = null, actor = null } = {}) {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (!["off", "shadow", "active"].includes(normalizedMode)) {
      throw new Error("Entry fallback mode must be off, shadow, or active.");
    }
    return this.withTransaction(async (repository) => {
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      const result = await repository.pool.query(
        `UPDATE public.vehicle_entry_fallback_settings
         SET mode = $1,
             observation_started_at = COALESCE($2::timestamptz, observation_started_at),
             updated_by_user_id = $3::bigint,
             updated_at = CURRENT_TIMESTAMP
         WHERE singleton = TRUE
         RETURNING mode, observation_started_at, updated_at`,
        [normalizedMode, observationStartedAt, actorId]
      );
      const saved = result.rows?.[0] || null;
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.entry_fallback_mode',
                   'vehicle_entry_fallback_settings', 'singleton', 'succeeded', $2::jsonb)`,
        [actorId, JSON.stringify({
          mode: normalizedMode,
          observationStartedAt: saved?.observation_started_at || null,
        })]
      );
      return saved;
    });
  }

  async getEntryFallbackStatus() {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT settings.mode, settings.observation_started_at, settings.updated_at,
                COUNT(decision.id) FILTER (WHERE decision.status = 'proposed')::integer AS proposed,
                COUNT(decision.id) FILTER (WHERE decision.status = 'processing')::integer AS processing,
                COUNT(decision.id) FILTER (WHERE decision.status = 'applied')::integer AS applied,
                COUNT(decision.id) FILTER (WHERE decision.status = 'rejected')::integer AS rejected,
                COUNT(decision.id) FILTER (WHERE decision.status = 'failed')::integer AS failed
         FROM public.vehicle_entry_fallback_settings settings
         LEFT JOIN public.vehicle_entry_fallback_decisions decision ON TRUE
         WHERE settings.singleton = TRUE
         GROUP BY settings.mode, settings.observation_started_at, settings.updated_at`
      ),
      this.pool.query(
        `SELECT id, target_read_id, source_read_id, corroborating_read_ids,
                status, decision_reason, route_name_snapshot, target_plate_snapshot,
                target_camera_name_snapshot, target_direction_label_snapshot,
                source_direction_label_snapshot, source_camera_names_snapshot,
                plate_evidence_class, actual_delta_ms, timing_error_ms,
                error_code, created_at, updated_at, applied_at
         FROM public.vehicle_entry_fallback_decisions
         ORDER BY created_at DESC, id DESC
         LIMIT 20`
      ),
    ]);
    const row = counts.rows?.[0] || {};
    return {
      mode: row.mode || "off",
      observationStartedAt: row.observation_started_at || null,
      updatedAt: row.updated_at || null,
      proposed: Number(row.proposed || 0),
      processing: Number(row.processing || 0),
      applied: Number(row.applied || 0),
      rejected: Number(row.rejected || 0),
      failed: Number(row.failed || 0),
      recent: (recent.rows || []).map((item) => ({
        id: Number(item.id),
        targetReadId: Number(item.target_read_id),
        sourceReadId: item.source_read_id == null ? null : Number(item.source_read_id),
        corroboratingReadIds: (item.corroborating_read_ids || []).map(Number),
        status: item.status,
        reason: item.decision_reason,
        routeName: item.route_name_snapshot,
        targetPlate: item.target_plate_snapshot,
        targetCameraName: item.target_camera_name_snapshot,
        targetDirectionLabel: item.target_direction_label_snapshot,
        sourceDirectionLabel: item.source_direction_label_snapshot,
        sourceCameraNames: item.source_camera_names_snapshot || [],
        plateEvidenceClass: item.plate_evidence_class,
        actualDeltaMs: item.actual_delta_ms == null ? null : Number(item.actual_delta_ms),
        timingErrorMs: item.timing_error_ms == null ? null : Number(item.timing_error_ms),
        errorCode: item.error_code,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        appliedAt: item.applied_at,
      })),
    };
  }

  async listEntryRouteProfiles() {
    const result = await this.pool.query(
      `SELECT id, route_name, target_camera_name, target_direction_label,
              source_direction_label, source_camera_names, expected_delta_ms,
              tolerance_ms, event_window_ms, minimum_source_count,
              priority, enabled, revision, created_at, updated_at
       FROM public.vehicle_entry_route_profiles
       ORDER BY priority, route_name, id`
    );
    return result.rows || [];
  }

  async saveEntryRouteProfile(input = {}, actor = null) {
    return this.withTransaction(async (repository) => {
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      const sourceCameraNames = [...new Set(
        (Array.isArray(input.sourceCameraNames) ? input.sourceCameraNames : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )];
      const result = await repository.pool.query(
        `INSERT INTO public.vehicle_entry_route_profiles (
           route_name, target_camera_name, target_direction_label,
           source_direction_label, source_camera_names, expected_delta_ms,
           tolerance_ms, event_window_ms, minimum_source_count,
           priority, enabled, updated_by_user_id, updated_at
         ) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,$12::bigint,CURRENT_TIMESTAMP)
         ON CONFLICT (target_camera_key, target_direction_key)
         DO UPDATE SET route_name = EXCLUDED.route_name,
           source_direction_label = EXCLUDED.source_direction_label,
           source_camera_names = EXCLUDED.source_camera_names,
           expected_delta_ms = EXCLUDED.expected_delta_ms,
           tolerance_ms = EXCLUDED.tolerance_ms,
           event_window_ms = EXCLUDED.event_window_ms,
           minimum_source_count = EXCLUDED.minimum_source_count,
           priority = EXCLUDED.priority,
           enabled = EXCLUDED.enabled,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           revision = CASE WHEN ROW(
             vehicle_entry_route_profiles.route_name,
             vehicle_entry_route_profiles.source_direction_label,
             vehicle_entry_route_profiles.source_camera_names,
             vehicle_entry_route_profiles.expected_delta_ms,
             vehicle_entry_route_profiles.tolerance_ms,
             vehicle_entry_route_profiles.event_window_ms,
             vehicle_entry_route_profiles.minimum_source_count,
             vehicle_entry_route_profiles.priority,
             vehicle_entry_route_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.route_name, EXCLUDED.source_direction_label,
             EXCLUDED.source_camera_names, EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.event_window_ms,
             EXCLUDED.minimum_source_count, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN vehicle_entry_route_profiles.revision + 1
             ELSE vehicle_entry_route_profiles.revision END,
           updated_at = CASE WHEN ROW(
             vehicle_entry_route_profiles.route_name,
             vehicle_entry_route_profiles.source_direction_label,
             vehicle_entry_route_profiles.source_camera_names,
             vehicle_entry_route_profiles.expected_delta_ms,
             vehicle_entry_route_profiles.tolerance_ms,
             vehicle_entry_route_profiles.event_window_ms,
             vehicle_entry_route_profiles.minimum_source_count,
             vehicle_entry_route_profiles.priority,
             vehicle_entry_route_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.route_name, EXCLUDED.source_direction_label,
             EXCLUDED.source_camera_names, EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.event_window_ms,
             EXCLUDED.minimum_source_count, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN CURRENT_TIMESTAMP ELSE vehicle_entry_route_profiles.updated_at END
         RETURNING *`,
        [
          String(input.routeName || "").trim(),
          String(input.targetCameraName || "").trim(),
          String(input.targetDirectionLabel || "").trim(),
          String(input.sourceDirectionLabel || "").trim(),
          sourceCameraNames,
          input.expectedDeltaMs,
          input.toleranceMs,
          input.eventWindowMs,
          input.minimumSourceCount,
          input.priority,
          input.enabled !== false,
          actorId,
        ]
      );
      const saved = result.rows?.[0] || null;
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.entry_route_profile',
                   'vehicle_entry_route_profile', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({
          routeName: saved.route_name,
          targetCameraName: saved.target_camera_name,
          targetDirectionLabel: saved.target_direction_label,
          sourceDirectionLabel: saved.source_direction_label,
          sourceCameraNames: saved.source_camera_names,
          expectedDeltaMs: Number(saved.expected_delta_ms),
          toleranceMs: Number(saved.tolerance_ms),
          eventWindowMs: Number(saved.event_window_ms),
          enabled: saved.enabled === true,
        })]
      );
      return saved;
    });
  }

  async deleteEntryRouteProfile(profileId, actor = null) {
    return this.withTransaction(async (repository) => {
      const result = await repository.pool.query(
        `DELETE FROM public.vehicle_entry_route_profiles profile
         WHERE profile.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_entry_fallback_decisions decision
             WHERE decision.route_profile_id = profile.id
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
         ) VALUES ($1::bigint, 'browser', 'vehicle.entry_route_profile_deleted',
                   'vehicle_entry_route_profile', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(deleted.id), JSON.stringify({ routeName: deleted.route_name })]
      );
      return true;
    });
  }

  async listEntryFallbackTargets({ startedAt = null } = {}) {
    const result = await this.pool.query(
      `SELECT reads.*,
              route.id AS route_profile_id, route.route_name,
              route.revision AS route_revision,
              route.target_camera_name AS route_target_camera_name,
              route.target_direction_label AS route_target_direction_label,
              route.source_direction_label AS route_source_direction_label,
              route.source_camera_names AS route_source_camera_names,
              route.expected_delta_ms AS route_expected_delta_ms,
              route.tolerance_ms AS route_tolerance_ms,
              route.event_window_ms AS route_event_window_ms,
              route.minimum_source_count AS route_minimum_source_count,
              route.priority AS route_priority
       FROM public.plate_reads reads
       JOIN public.vehicle_entry_route_profiles route
         ON route.enabled = TRUE
        AND route.target_camera_key = LOWER(BTRIM(reads.camera_name))
        AND route.target_direction_key = LOWER(BTRIM(reads.bi_trigger_direction_label))
       WHERE reads."timestamp" >= COALESCE($1::timestamptz, CURRENT_TIMESTAMP)
         AND reads.vehicle_image_path IS NULL
         AND reads.vehicle_image_queue_kind = 'overview'
         AND reads.vehicle_image_status IN ('failed','unavailable')
         AND reads.vehicle_image_retryable = FALSE
         AND reads.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
         AND reads.vehicle_image_claim_token IS NULL
         AND reads.bi_trigger_direction_status = 'ready'
         AND NULLIF(BTRIM(reads.bi_trigger_direction_label), '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_entry_fallback_decisions decision
           WHERE decision.target_read_id = reads.id
             AND decision.route_profile_id = route.id
             AND decision.route_profile_revision = route.revision
         )
       ORDER BY reads."timestamp", reads.id, route.priority, route.id
       LIMIT 100`,
      [startedAt]
    );
    return result.rows || [];
  }

  async listEntryFallbackSourceReads(targets = []) {
    if (!Array.isArray(targets) || targets.length === 0) return [];
    const requested = targets.map((target) => {
      const targetAt = new Date(target.timestamp).getTime();
      const expected = Number(target.route_expected_delta_ms || 0);
      const tolerance = Number(target.route_tolerance_ms || 3000);
      const eventWindow = Number(target.route_event_window_ms || 3000);
      return {
        targetReadId: Number(target.id),
        sourceCameraNames: target.route_source_camera_names || [],
        sourceDirectionLabel: target.route_source_direction_label,
        windowStart: new Date(targetAt + expected - tolerance - eventWindow).toISOString(),
        windowEnd: new Date(targetAt + expected + tolerance + eventWindow).toISOString(),
      };
    });
    const result = await this.pool.query(
      `WITH requested AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS request(
           "targetReadId" integer,
           "sourceCameraNames" text[],
           "sourceDirectionLabel" text,
           "windowStart" timestamptz,
           "windowEnd" timestamptz
         )
       )
       SELECT request."targetReadId" AS target_read_id,
              reads.id, reads.plate_number, reads.observed_plate,
              reads.camera_name, reads."timestamp", reads.image_path,
              reads.bi_trigger_direction_status, reads.bi_trigger_direction_label,
              asset.crop_box, asset.image_width, asset.image_height,
              asset.detection_confidence,
              (color.read_id IS NOT NULL) AS color_evaluated,
              color.color_reason
       FROM requested request
       JOIN public.plate_reads reads
         ON reads."timestamp" BETWEEN request."windowStart" AND request."windowEnd"
        AND reads.bi_trigger_direction_status = 'ready'
        AND LOWER(BTRIM(reads.bi_trigger_direction_label)) = LOWER(BTRIM(request."sourceDirectionLabel"))
        AND EXISTS (
          SELECT 1 FROM unnest(request."sourceCameraNames") source_camera(camera_name)
          WHERE LOWER(BTRIM(source_camera.camera_name)) = LOWER(BTRIM(reads.camera_name))
        )
       JOIN LATERAL (
         SELECT assets.crop_box, assets.image_width, assets.image_height,
                assets.detection_confidence
         FROM public.capture_assets assets
         WHERE assets.read_id = reads.id
           AND assets.asset_type = 'vehicle_crop'
           AND assets.status = 'ready'
         ORDER BY assets.indexed_at DESC NULLS LAST, assets.id DESC
         LIMIT 1
       ) asset ON TRUE
       LEFT JOIN LATERAL (
         SELECT observation.read_id, observation.raw_result->>'reason' AS color_reason
         FROM public.vehicle_attribute_observations observation
         WHERE observation.read_id = reads.id
           AND observation.attribute_key = 'color'
         ORDER BY observation.evaluated_at DESC, observation.id DESC
         LIMIT 1
       ) color ON TRUE
       WHERE NULLIF(BTRIM(reads.image_path), '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_entry_fallback_decisions used
           WHERE used.status IN ('proposed','processing','applied')
             AND (
               used.source_read_id = reads.id
               OR used.corroborating_read_ids @> ARRAY[reads.id]::integer[]
             )
         )
       ORDER BY request."targetReadId", reads."timestamp", reads.id`,
      [JSON.stringify(requested)]
    );
    return result.rows || [];
  }

  async recordEntryFallbackDecisions(decisions = []) {
    if (!Array.isArray(decisions) || decisions.length === 0) return 0;
    return this.withTransaction(async (repository) => {
      let recorded = 0;
      for (const decision of decisions.slice(0, 100)) {
        const metadata = decision.metadata || {};
        const result = await repository.pool.query(
          `INSERT INTO public.vehicle_entry_fallback_decisions (
             decision_identity, source_event_key, route_profile_id, route_profile_revision,
             target_read_id, source_read_id, corroborating_read_ids, status, decision_reason,
             route_name_snapshot, target_plate_snapshot, target_camera_name_snapshot,
             target_direction_label_snapshot, source_direction_label_snapshot,
             source_camera_names_snapshot, source_image_path_snapshot,
             source_timestamp_snapshot, source_detection_confidence,
             source_detection_box, source_image_width, source_image_height,
             plate_evidence_class, expected_delta_ms, actual_delta_ms, timing_error_ms,
             decision_score, decision_margin, decision_metadata, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7::integer[],$8,$9,$10,$11,$12,$13,$14,$15::text[],
             $16,$17::timestamptz,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,
             CURRENT_TIMESTAMP
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            decision.decisionIdentity,
            decision.sourceEventKey,
            decision.routeProfileId,
            decision.routeRevision,
            decision.targetReadId,
            decision.sourceReadId,
            decision.corroboratingReadIds || [],
            decision.status,
            decision.reason,
            metadata.routeName || "Unknown route",
            metadata.targetPlate || null,
            metadata.targetCameraName || null,
            metadata.targetDirectionLabel || null,
            metadata.sourceDirectionLabel || null,
            metadata.sourceCameraNames || [],
            metadata.chosenSourceImagePath || null,
            metadata.chosenSourceTimestamp || null,
            metadata.chosenDetectionConfidence ?? null,
            metadata.chosenDetectionBox ? JSON.stringify(metadata.chosenDetectionBox) : null,
            metadata.chosenImageWidth || null,
            metadata.chosenImageHeight || null,
            metadata.plateEvidenceClass || null,
            metadata.expectedDeltaMs ?? null,
            metadata.actualDeltaMs ?? null,
            metadata.timingErrorMs ?? null,
            metadata.score ?? null,
            metadata.scoreMargin ?? null,
            JSON.stringify(metadata),
          ]
        );
        recorded += result.rowCount || 0;
      }
      return recorded;
    });
  }

  async claimNextEntryFallback() {
    const claimToken = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT decision.id
         FROM public.vehicle_entry_fallback_decisions decision
         JOIN public.vehicle_entry_fallback_settings settings
           ON settings.singleton = TRUE AND settings.mode = 'active'
         JOIN public.vehicle_entry_route_profiles route
           ON route.id = decision.route_profile_id
          AND route.enabled = TRUE
          AND route.revision = decision.route_profile_revision
         JOIN public.plate_reads source ON source.id = decision.source_read_id
         JOIN public.plate_reads target ON target.id = decision.target_read_id
         WHERE decision.status = 'proposed'
           AND decision.attempt_count < 1
           AND decision.source_event_key IS NOT NULL
           AND source.image_path = decision.source_image_path_snapshot
           AND source.bi_trigger_direction_status = 'ready'
           AND LOWER(BTRIM(source.bi_trigger_direction_label)) = LOWER(BTRIM(decision.source_direction_label_snapshot))
           AND target.vehicle_image_path IS NULL
           AND target.vehicle_image_queue_kind = 'overview'
           AND target.vehicle_image_status IN ('failed','unavailable')
           AND target.vehicle_image_retryable = FALSE
           AND target.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
           AND target.vehicle_image_claim_token IS NULL
           AND target.bi_trigger_direction_status = 'ready'
           AND LOWER(BTRIM(target.camera_name)) = LOWER(BTRIM(decision.target_camera_name_snapshot))
           AND LOWER(BTRIM(target.bi_trigger_direction_label)) = LOWER(BTRIM(decision.target_direction_label_snapshot))
           AND LOWER(BTRIM(target.plate_number)) = LOWER(BTRIM(decision.target_plate_snapshot))
         ORDER BY target."timestamp", target.id, decision.id
         FOR UPDATE OF decision SKIP LOCKED
         LIMIT 1
       ), claimed AS (
         UPDATE public.vehicle_entry_fallback_decisions decision
         SET status = 'processing', claim_token = $1::uuid,
             attempt_count = decision.attempt_count + 1,
             error_code = NULL, error_details = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate
         WHERE decision.id = candidate.id
         RETURNING decision.*
       )
       SELECT claimed.*, target."timestamp" AS target_read_timestamp
       FROM claimed
       JOIN public.plate_reads target ON target.id = claimed.target_read_id`,
      [claimToken]
    );
    return result.rows?.[0] || null;
  }

  async applyEntryFallback(decisionId, claimToken, targetImagePath) {
    const result = await this.pool.query(
      `WITH copied AS (
         UPDATE public.plate_reads target
         SET vehicle_image_status = 'ready',
             vehicle_image_path = $3,
             vehicle_image_timestamp = decision.source_timestamp_snapshot,
             vehicle_image_score = decision.decision_score,
             vehicle_image_detection_confidence = decision.source_detection_confidence,
             vehicle_image_detection_box = decision.source_detection_box,
             vehicle_image_width = decision.source_image_width,
             vehicle_image_height = decision.source_image_height,
             vehicle_image_sampled_count = cardinality(decision.corroborating_read_ids) + 1,
             vehicle_image_selection_metadata = jsonb_build_object(
               'algorithm', 'entry-lpr-route-fallback-v1',
               'entryFallback', decision.decision_metadata
             ),
             vehicle_image_source_kind = 'entry_lpr_fallback',
             vehicle_image_source_read_id = decision.source_read_id,
             vehicle_image_retryable = FALSE,
             vehicle_image_error_code = NULL,
             vehicle_image_claim_token = NULL,
             vehicle_image_next_attempt_at = NULL,
             vehicle_image_heartbeat_at = NULL,
             vehicle_image_processing_deadline_at = NULL,
             vehicle_image_hard_deadline_at = NULL,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_entry_fallback_decisions decision
         JOIN public.plate_reads source ON source.id = decision.source_read_id
         WHERE decision.id = $1
           AND decision.status = 'processing'
           AND decision.claim_token = $2::uuid
           AND target.id = decision.target_read_id
           AND source.image_path = decision.source_image_path_snapshot
           AND target.vehicle_image_path IS NULL
           AND target.vehicle_image_queue_kind = 'overview'
           AND target.vehicle_image_status IN ('failed','unavailable')
           AND target.vehicle_image_retryable = FALSE
           AND target.vehicle_image_error_code IN ('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE')
           AND target.vehicle_image_claim_token IS NULL
         RETURNING target.id
       ), applied AS (
         UPDATE public.vehicle_entry_fallback_decisions decision
         SET status = 'applied', target_image_path = $3, claim_token = NULL,
             applied_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         FROM copied
         WHERE decision.id = $1 AND decision.claim_token = $2::uuid
         RETURNING decision.id, decision.source_read_id, decision.target_read_id
       )
       SELECT * FROM applied`,
      [decisionId, claimToken, targetImagePath]
    );
    return result.rows?.[0] || null;
  }

  async markEntryFallbackFailed(decisionId, claimToken, {
    errorCode,
    errorDetails = null,
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.vehicle_entry_fallback_decisions
       SET status = 'failed', claim_token = NULL, error_code = $3,
           error_details = $4::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing' AND claim_token = $2::uuid
       RETURNING id`,
      [
        decisionId,
        claimToken,
        String(errorCode || "ENTRY_FALLBACK_FAILED").slice(0, 80),
        errorDetails ? JSON.stringify(errorDetails) : null,
      ]
    );
    return result.rows?.[0] || null;
  }

  async getOverviewStatus() {
    const [reads, exports, sources, recent, pairSharing, recentShares] = await Promise.all([
      this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE vehicle_image_status = 'pending')::integer AS pending,
         COUNT(*) FILTER (WHERE vehicle_image_status = 'processing')::integer AS processing,
         COUNT(*) FILTER (WHERE vehicle_image_status = 'ready')::integer AS ready,
         COUNT(*) FILTER (WHERE vehicle_image_error_code = 'MULTIPLE_VEHICLES_VISIBLE')::integer AS ambiguous,
         COUNT(*) FILTER (WHERE vehicle_image_status = 'unavailable'
           AND COALESCE(vehicle_image_error_code, '') <> 'NIGHTTIME_UNAVAILABLE')::integer AS unavailable,
         COUNT(*) FILTER (WHERE vehicle_image_error_code = 'NIGHTTIME_UNAVAILABLE')::integer AS nighttime_skipped,
         COUNT(*) FILTER (WHERE vehicle_image_status = 'failed')::integer AS failed,
         MIN("timestamp") FILTER (WHERE vehicle_image_status IN ('pending','processing')) AS oldest_outstanding_at
       FROM public.plate_reads
       WHERE vehicle_image_queue_kind = 'overview'
          OR vehicle_image_source_kind = 'overview_primary'
          OR vehicle_image_error_code IN (
            'NIGHTTIME_UNAVAILABLE','MULTIPLE_VEHICLES_VISIBLE','VEHICLE_NOT_VISIBLE',
            'RECORDING_UNAVAILABLE','OVERVIEW_PROCESSING_DEADLINE','EXPORT_TIMEOUT',
            'EXPORT_UNAVAILABLE','EXPORT_FAILED','EXPORT_START_UNCERTAIN','EXPORT_CLAIM_LOST'
          )`
      ),
      this.pool.query(
        `SELECT
           COUNT(*)::integer AS total,
           COUNT(*) FILTER (WHERE status IN ('starting','exporting','ready'))::integer AS active,
           COUNT(*) FILTER (WHERE status = 'downloaded')::integer AS downloaded,
           COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
           COALESCE(SUM(automatic_start_count), 0)::integer AS automatic_starts,
           COUNT(*) FILTER (WHERE automatic_start_count > 1)::integer AS duplicate_start_violations,
           MAX(updated_at) AS last_transition_at
         FROM public.blue_iris_timeline_exports`
      ),
      this.pool.query(
      `SELECT DISTINCT source_camera_name
       FROM public.vehicle_overview_pair_profiles
       WHERE enabled = TRUE AND source_role = 'primary'
       ORDER BY source_camera_name`
      ),
      this.pool.query(
        `SELECT reads.id AS read_id, reads.plate_number, reads.camera_name,
                reads."timestamp" AS read_timestamp,
                reads.vehicle_image_status, reads.vehicle_image_attempt_count,
                reads.vehicle_image_recovery_count, reads.vehicle_image_error_code,
                reads.vehicle_image_claim_token, reads.vehicle_image_next_attempt_at,
                reads.vehicle_image_heartbeat_at, reads.vehicle_image_hard_deadline_at,
                exports.export_token, exports.export_key, exports.status AS export_status,
                exports.automatic_start_count, exports.start_requested_at,
                exports.last_checked_at, (exports.remote_uri IS NOT NULL) AS remote_uri_known,
                exports.video_width, exports.video_height, exports.media_duration_ms,
                exports.error_code AS export_error_code, exports.updated_at AS export_updated_at
         FROM public.plate_reads reads
         LEFT JOIN LATERAL (
           SELECT timeline.*
           FROM public.blue_iris_timeline_exports timeline
           WHERE timeline.read_id = reads.id
           ORDER BY timeline.updated_at DESC, timeline.id DESC
           LIMIT 1
         ) exports ON TRUE
         WHERE reads.vehicle_image_queue_kind = 'overview'
            OR reads.vehicle_image_source_kind = 'overview_primary'
         ORDER BY reads."timestamp" DESC, reads.id DESC
         LIMIT 25`
      ),
      this.pool.query(
        `SELECT settings.mode, settings.observation_started_at, settings.updated_at,
                COUNT(sharing.id) FILTER (WHERE sharing.status = 'proposed')::integer AS proposed,
                COUNT(sharing.id) FILTER (WHERE sharing.status = 'processing')::integer AS processing,
                COUNT(sharing.id) FILTER (WHERE sharing.status = 'applied')::integer AS applied,
                COUNT(sharing.id) FILTER (WHERE sharing.status = 'rejected')::integer AS rejected,
                COUNT(sharing.id) FILTER (WHERE sharing.status = 'failed')::integer AS failed
         FROM public.vehicle_overview_pair_sharing_settings settings
         LEFT JOIN public.vehicle_overview_read_shares sharing ON TRUE
         WHERE settings.singleton = TRUE
         GROUP BY settings.mode, settings.observation_started_at, settings.updated_at`
      ),
      this.pool.query(
        `SELECT sharing.id, sharing.source_read_id, sharing.target_read_id,
                sharing.status, sharing.decision_reason, sharing.plate_number_snapshot,
                sharing.direction_label_snapshot, sharing.source_camera_name_snapshot,
                sharing.target_camera_name_snapshot, sharing.anchor_delta_ms,
                sharing.error_code, sharing.created_at, sharing.updated_at, sharing.applied_at
         FROM public.vehicle_overview_read_shares sharing
         ORDER BY sharing.created_at DESC, sharing.id DESC
         LIMIT 20`
      ),
    ]);
    const row = reads.rows?.[0] || {};
    const exportRow = exports.rows?.[0] || {};
    const pairSharingRow = pairSharing.rows?.[0] || {};
    return {
      pending: Number(row.pending || 0),
      processing: Number(row.processing || 0),
      ready: Number(row.ready || 0),
      ambiguous: Number(row.ambiguous || 0),
      unavailable: Number(row.unavailable || 0),
      nighttimeSkipped: Number(row.nighttime_skipped || 0),
      failed: Number(row.failed || 0),
      oldestOutstandingAt: row.oldest_outstanding_at || null,
      exports: {
        total: Number(exportRow.total || 0),
        active: Number(exportRow.active || 0),
        downloaded: Number(exportRow.downloaded || 0),
        failed: Number(exportRow.failed || 0),
        automaticStarts: Number(exportRow.automatic_starts || 0),
        duplicateStartViolations: Number(exportRow.duplicate_start_violations || 0),
        lastTransitionAt: exportRow.last_transition_at || null,
      },
      recentJobs: (recent.rows || []).map((item) => ({
        readId: Number(item.read_id),
        plateNumber: item.plate_number,
        cameraName: item.camera_name,
        readTimestamp: item.read_timestamp,
        readStatus: item.vehicle_image_status,
        attemptCount: Number(item.vehicle_image_attempt_count || 0),
        recoveryCount: Number(item.vehicle_image_recovery_count || 0),
        readErrorCode: item.vehicle_image_error_code,
        claimToken: item.vehicle_image_claim_token,
        nextAttemptAt: item.vehicle_image_next_attempt_at,
        heartbeatAt: item.vehicle_image_heartbeat_at,
        hardDeadlineAt: item.vehicle_image_hard_deadline_at,
        exportToken: item.export_token,
        exportKey: item.export_key,
        exportStatus: item.export_status,
        automaticStartCount: Number(item.automatic_start_count || 0),
        startRequestedAt: item.start_requested_at,
        lastCheckedAt: item.last_checked_at,
        remoteUriKnown: item.remote_uri_known === true,
        width: item.video_width === null || item.video_width === undefined
          ? null : Number(item.video_width),
        height: item.video_height === null || item.video_height === undefined
          ? null : Number(item.video_height),
        durationMs: item.media_duration_ms === null || item.media_duration_ms === undefined
          ? null : Number(item.media_duration_ms),
        exportErrorCode: item.export_error_code,
        exportUpdatedAt: item.export_updated_at,
      })),
      pairSharing: {
        mode: pairSharingRow.mode || "off",
        observationStartedAt: pairSharingRow.observation_started_at || null,
        updatedAt: pairSharingRow.updated_at || null,
        proposed: Number(pairSharingRow.proposed || 0),
        processing: Number(pairSharingRow.processing || 0),
        applied: Number(pairSharingRow.applied || 0),
        rejected: Number(pairSharingRow.rejected || 0),
        failed: Number(pairSharingRow.failed || 0),
        recent: (recentShares.rows || []).map((item) => ({
          id: Number(item.id),
          sourceReadId: item.source_read_id == null ? null : Number(item.source_read_id),
          targetReadId: Number(item.target_read_id),
          status: item.status,
          reason: item.decision_reason,
          plateNumber: item.plate_number_snapshot,
          directionLabel: item.direction_label_snapshot,
          sourceCameraName: item.source_camera_name_snapshot,
          targetCameraName: item.target_camera_name_snapshot,
          anchorDeltaMs: item.anchor_delta_ms == null ? null : Number(item.anchor_delta_ms),
          errorCode: item.error_code,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          appliedAt: item.applied_at,
        })),
      },
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
                 profile.revision AS overview_profile_revision,
                 profile.updated_at AS overview_profile_updated_at
         FROM public.plate_reads reads
         LEFT JOIN LATERAL (
            SELECT id, source_camera_name, expected_delta_ms, tolerance_ms,
                   priority, revision, updated_at
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
               AND COALESCE(reads.vehicle_image_attempt_count, 0) < 2
               AND COALESCE(reads.vehicle_image_next_attempt_at, reads.vehicle_image_updated_at)
                   <= CURRENT_TIMESTAMP)
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
                  candidate.overview_profile_priority, candidate.overview_profile_revision,
                  candidate.overview_profile_updated_at`,
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
           ))::integer AS historical_outstanding,
           COUNT(*) FILTER (WHERE vehicle_image_queue_kind = 'overview' AND (
             vehicle_image_status = 'processing'
             OR (vehicle_image_status = 'pending' AND COALESCE(vehicle_image_attempt_count, 0) < 2)
             OR (vehicle_image_status = 'failed' AND vehicle_image_retryable = TRUE
               AND COALESCE(vehicle_image_attempt_count, 0) < 2)
           ))::integer AS overview_outstanding
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
      liveOutstanding: Number(row.live_outstanding || 0) + Number(row.overview_outstanding || 0),
      overviewOutstanding: Number(row.overview_outstanding || 0),
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
           vehicle_image_recovery_count = LEAST(COALESCE(vehicle_image_recovery_count, 0) + 1, 20),
           vehicle_image_last_recovered_at = CURRENT_TIMESTAMP,
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
         AND COALESCE(vehicle_image_recovery_count, 0) < 20
         AND (
           vehicle_image_queue_kind IS DISTINCT FROM 'overview'
           OR (
             COALESCE(vehicle_image_error_code, '') IN (
               'RECORDING_UNAVAILABLE','TIMEOUT','OVERVIEW_PROCESSING_DEADLINE',
               'OVERVIEW_PROFILE_CHANGED','EXPORT_TIMEOUT','EXPORT_UNAVAILABLE',
               'EXPORT_FAILED','EXPORT_DURATION_TOO_SHORT','EXPORT_PROBE_INVALID',
               'EXPORT_FRAME_COUNT_INVALID','EXPORT_INVALID',
               'MEDIA_TOOL_TIMEOUT','MEDIA_TOOL_FAILED','HTTP_ERROR','CONNECTION_FAILED'
             )
           )
         )
         AND vehicle_image_status IN ('failed', 'unavailable')
       RETURNING id, vehicle_image_status, vehicle_image_queue_kind,
                 vehicle_image_attempt_count, vehicle_image_retryable`,
      [readId]
    );
    return result.rows?.[0] || null;
  }

  async recoverIncompleteOverviewReads({ startAt = null, sinceHours = 48 } = {}) {
    const recoveryStartAt = normalizeOverviewRecoveryStart({ startAt, sinceHours });
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = 'pending',
           vehicle_image_attempt_count = 0,
           vehicle_image_recovery_count = COALESCE(vehicle_image_recovery_count, 0) + 1,
           vehicle_image_last_recovered_at = CURRENT_TIMESTAMP,
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
       WHERE ${OVERVIEW_RECOVERY_WHERE_SQL}
       RETURNING id`,
      [recoveryStartAt]
    );
    return { queued: result.rowCount || 0, startAt: recoveryStartAt };
  }

  async previewIncompleteOverviewReads({ startAt = null, sinceHours = 48 } = {}) {
    const recoveryStartAt = normalizeOverviewRecoveryStart({ startAt, sinceHours });
    const result = await this.pool.query(
      `SELECT COUNT(*)::integer AS eligible,
              MIN("timestamp") AS oldest_at,
              MAX("timestamp") AS newest_at,
              COUNT(*) FILTER (WHERE vehicle_image_status = 'pending')::integer AS pending,
              COUNT(*) FILTER (WHERE vehicle_image_status = 'processing')::integer AS expired_processing,
              COUNT(*) FILTER (WHERE vehicle_image_status IN ('failed','unavailable'))::integer AS operational_failures
       FROM public.plate_reads
       WHERE ${OVERVIEW_RECOVERY_WHERE_SQL}`,
      [recoveryStartAt]
    );
    const row = result.rows?.[0] || {};
    return {
      startAt: recoveryStartAt,
      eligible: Number(row.eligible || 0),
      oldestAt: row.oldest_at || null,
      newestAt: row.newest_at || null,
      pending: Number(row.pending || 0),
      expiredProcessing: Number(row.expired_processing || 0),
      operationalFailures: Number(row.operational_failures || 0),
    };
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
    exportKey,
    readId,
    claimToken,
    sourceCameraName,
    requestedStartAt,
    requestedDurationMs,
    hardDeadlineAt = null,
    pairProfileId = null,
    profileRevision = null,
    algorithmRevision = null,
  }) {
    const normalizedExportKey = String(exportKey || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedExportKey)) {
      throw new Error("A stable SHA-256 timeline export key is required.");
    }
    const exportToken = crypto.randomUUID();
    const reusable = await this.pool.query(
      `WITH active_read AS MATERIALIZED (
         SELECT id
         FROM public.plate_reads
         WHERE id = $2
           AND vehicle_image_status = 'processing'
           AND vehicle_image_claim_token = $3::uuid
           AND vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
         FOR SHARE
       )
       UPDATE public.blue_iris_timeline_exports exports
       SET export_key = $1,
           claim_token = $3::uuid,
           pair_profile_id = COALESCE($7::bigint, pair_profile_id),
           profile_revision = COALESCE($8::bigint, profile_revision),
           algorithm_revision = COALESCE($9, algorithm_revision),
           hard_deadline_at = GREATEST(
             hard_deadline_at,
             COALESCE($6::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
           ),
           updated_at = CURRENT_TIMESTAMP
       FROM active_read
       WHERE exports.id = (
         SELECT existing.id
         FROM public.blue_iris_timeline_exports existing
         WHERE existing.export_key IS NULL
           AND existing.read_id = $2
           AND LOWER(BTRIM(existing.source_camera_name)) = LOWER(BTRIM($4))
           AND existing.requested_start_at = $5::timestamptz
           AND existing.requested_duration_ms = $10
         ORDER BY (existing.remote_uri IS NOT NULL) DESC,
                  (existing.remote_path IS NOT NULL) DESC,
                  existing.created_at ASC,
                  existing.id ASC
         LIMIT 1
       )
         AND NOT EXISTS (
           SELECT 1 FROM public.blue_iris_timeline_exports keyed
           WHERE keyed.export_key = $1
         )
       RETURNING exports.*`,
      [
        normalizedExportKey,
        readId,
        claimToken,
        String(sourceCameraName || "").trim(),
        requestedStartAt,
        hardDeadlineAt,
        pairProfileId,
        profileRevision,
        algorithmRevision,
        requestedDurationMs,
      ]
    );
    if (reusable.rows?.[0]) return reusable.rows[0];

    await this.pool.query(
      `WITH active_read AS MATERIALIZED (
         SELECT id
         FROM public.plate_reads
         WHERE id = $3
           AND vehicle_image_status = 'processing'
           AND vehicle_image_claim_token = $4::uuid
           AND vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
         FOR SHARE
       )
       INSERT INTO public.blue_iris_timeline_exports (
         export_token, export_key, read_id, claim_token, source_camera_name,
         requested_start_at, requested_duration_ms, status, hard_deadline_at,
         pair_profile_id, profile_revision, algorithm_revision
       ) SELECT
         $1::uuid,$2,$3,$4::uuid,$5,$6::timestamptz,$7,'starting',
         COALESCE($8::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
         $9::bigint,$10::bigint,$11
       FROM active_read
       ON CONFLICT DO NOTHING`,
      [
        exportToken,
        normalizedExportKey,
        readId,
        claimToken,
        String(sourceCameraName || "").trim(),
        requestedStartAt,
        requestedDurationMs,
        hardDeadlineAt,
        pairProfileId,
        profileRevision,
        algorithmRevision,
      ]
    );
    const result = await this.pool.query(
      `WITH active_read AS MATERIALIZED (
         SELECT id
         FROM public.plate_reads
         WHERE id = $4
           AND vehicle_image_status = 'processing'
           AND vehicle_image_claim_token = $2::uuid
           AND vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
         FOR SHARE
       )
       UPDATE public.blue_iris_timeline_exports exports
       SET claim_token = $2::uuid,
           hard_deadline_at = GREATEST(
             hard_deadline_at,
             COALESCE($3::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
           ),
           updated_at = CURRENT_TIMESTAMP
       FROM active_read
       WHERE exports.export_key = $1
       RETURNING exports.*`,
      [normalizedExportKey, claimToken, hardDeadlineAt, readId]
    );
    return result.rows?.[0] || null;
  }

  async claimTimelineExportStart(exportToken, claimToken, preexistingRemotePaths = []) {
    const normalizedPaths = [...new Set((Array.isArray(preexistingRemotePaths)
      ? preexistingRemotePaths
      : []).map((value) => String(value || "").trim()).filter(Boolean))];
    const result = await this.pool.query(
      `WITH active_read AS MATERIALIZED (
         SELECT exports.id AS export_id
         FROM public.blue_iris_timeline_exports exports
         JOIN public.plate_reads reads ON reads.id = exports.read_id
         WHERE exports.export_token = $1::uuid
           AND exports.claim_token = $2::uuid
           AND reads.vehicle_image_status = 'processing'
           AND reads.vehicle_image_claim_token = $2::uuid
           AND reads.vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
         FOR SHARE OF reads
       )
       UPDATE public.blue_iris_timeline_exports exports
       SET automatic_start_count = 1,
           start_requested_at = CURRENT_TIMESTAMP,
           preexisting_remote_paths = $3::jsonb,
           status = 'starting',
           error_code = NULL,
           error_details = NULL,
           updated_at = CURRENT_TIMESTAMP
       FROM active_read
       WHERE exports.id = active_read.export_id
         AND exports.automatic_start_count = 0
         AND exports.remote_uri IS NULL
       RETURNING exports.*`,
      [exportToken, claimToken, JSON.stringify(normalizedPaths)]
    );
    return result.rows?.[0] || null;
  }

  async getTimelineExport(exportToken) {
    const result = await this.pool.query(
      `SELECT * FROM public.blue_iris_timeline_exports
       WHERE export_token = $1::uuid`,
      [exportToken]
    );
    return result.rows?.[0] || null;
  }

  async recordTimelineExportRemote(exportToken, remote = {}, { claimToken = null } = {}) {
    const rawUtc = Number(remote.utc);
    const remoteUtcMs = Number.isFinite(rawUtc)
      ? Math.round(rawUtc < 1_000_000_000_000 ? rawUtc * 1_000 : rawUtc)
      : null;
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
       SET remote_path = COALESCE($2, remote_path),
           remote_uri = COALESCE($3, remote_uri),
            status = CASE WHEN $4::boolean THEN 'ready' ELSE 'exporting' END,
            progress = $5,
            file_size_bytes = COALESCE($6, file_size_bytes),
            remote_utc_ms = COALESCE($7, remote_utc_ms),
            remote_duration_ms = COALESCE($8, remote_duration_ms),
            remote_status = COALESCE($9, remote_status),
            last_checked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
       WHERE export_token = $1::uuid
         AND claim_token = $10::uuid
         AND status IN ('starting','exporting','ready','failed')
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
        claimToken,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markTimelineExportDownloaded(exportToken, media = {}, { claimToken = null } = {}) {
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
       SET status = 'downloaded', remote_uri = COALESCE($2, remote_uri),
           file_size_bytes = COALESCE($3, file_size_bytes),
           video_width = $4, video_height = $5, media_duration_ms = $6,
           downloaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           error_code = NULL, error_details = NULL, next_delete_attempt_at = NULL
       WHERE export_token = $1::uuid
         AND claim_token = $7::uuid
         AND deleted_at IS NULL
         AND status IN ('starting','exporting','ready','downloaded')
       RETURNING *`,
      [
        exportToken,
        media.uri || null,
        media.fileSize ?? null,
        media.width ?? null,
        media.height ?? null,
        media.durationMs ?? null,
        claimToken,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markTimelineExportFailed(exportToken, {
    errorCode,
    errorDetails = null,
  } = {}, { claimToken = null } = {}) {
    const result = await this.pool.query(
      `UPDATE public.blue_iris_timeline_exports
        SET status = 'failed',
            error_code = $2, error_details = $3::jsonb,
            next_delete_attempt_at = NULL,
            updated_at = CURRENT_TIMESTAMP
       WHERE export_token = $1::uuid
         AND claim_token = $4::uuid
         AND deleted_at IS NULL
         AND status <> 'downloaded'
       RETURNING *`,
      [
        exportToken,
        String(errorCode || "TIMELINE_EXPORT_FAILED").slice(0, 80),
        errorDetails ? JSON.stringify(errorDetails) : null,
        claimToken,
      ]
    );
    return result.rows?.[0] || null;
  }

  async markReady(readId, frame, {
    claimToken = null,
    exportToken = null,
    profileSnapshot = null,
  } = {}) {
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
         AND ($13::uuid IS NULL OR EXISTS (
           SELECT 1
           FROM public.blue_iris_timeline_exports exports
           WHERE exports.export_token = $13::uuid
             AND exports.read_id = $1
             AND exports.claim_token = $12::uuid
             AND exports.status = 'downloaded'
             AND exports.pair_profile_id IS NOT DISTINCT FROM $14::bigint
             AND exports.profile_revision IS NOT DISTINCT FROM $15::bigint
         ))
       RETURNING id`,
      [
        readId, frame.framePath, frame.frameTimestamp, frame.frameScore,
        frame.detectionConfidence, JSON.stringify(frame.detectionBox), frame.imageWidth,
        frame.imageHeight, frame.sampledCount, JSON.stringify(frame.selectionMetadata || {}),
        frame.sourceKind || "legacy_plate_camera", claimToken,
        exportToken,
        profileSnapshot?.id ?? null,
        profileSnapshot?.revision ?? null,
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
       RETURNING id`,
      [
        readId, status, errorCode, retryable, nextAttemptAt,
        selectionMetadata ? JSON.stringify(selectionMetadata) : null,
        claimToken,
      ]
    );
    return result.rows?.[0] || null;
  }

  async releaseOverviewReadClaim(readId, claimToken, {
    errorCode = "OVERVIEW_PROFILE_CHANGED",
  } = {}) {
    const result = await this.pool.query(
      `UPDATE public.plate_reads
       SET vehicle_image_status = CASE
             WHEN COALESCE(vehicle_image_attempt_count, 0) >= 2 THEN 'failed'
             ELSE 'pending'
           END,
           vehicle_image_error_code = $3,
           vehicle_image_retryable = COALESCE(vehicle_image_attempt_count, 0) < 2,
            vehicle_image_claim_token = NULL,
            vehicle_image_heartbeat_at = NULL, vehicle_image_processing_deadline_at = NULL,
            vehicle_image_hard_deadline_at = NULL,
           vehicle_image_next_attempt_at = CASE
             WHEN COALESCE(vehicle_image_attempt_count, 0) < 2
               THEN CURRENT_TIMESTAMP + INTERVAL '30 seconds'
             ELSE NULL
           END,
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
