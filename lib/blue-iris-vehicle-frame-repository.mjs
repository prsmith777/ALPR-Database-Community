import crypto from "node:crypto";

import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const ENTRY_HISTORY_PROFILE_KIND = "entry_history";
const ENTRY_HISTORY_SOURCE_KIND = "entry_overview_history";
const ENTRY_HISTORY_CONTEXT = "entry";
const ENTRY_HISTORY_CAMERA_NAME = "Entry Overview";
const ENTRY_HISTORY_CAMERA_SHORT_NAME = "Cam143";
const ENTRY_HISTORY_TOLERANCE_MS = 3_000;
const ENTRY_HISTORY_MAX_BATCH = 500;
const ENTRY_HISTORY_MAX_OPERATOR_RETRIES = 1;
const ENTRY_HISTORY_OPERATOR_RETRY_CODES = Object.freeze([
  "EXPORT_TIMEOUT",
  "EXPORT_UNAVAILABLE",
  "EXPORT_FAILED",
  "EXPORT_DURATION_TOO_SHORT",
  "EXPORT_PROBE_INVALID",
  "EXPORT_FRAME_COUNT_INVALID",
  "EXPORT_INVALID",
  "FINAL_FRAME_INVALID",
  "MEDIA_TOOL_TIMEOUT",
  "MEDIA_TOOL_FAILED",
  "HTTP_ERROR",
  "CONNECTION_FAILED",
  "TIMEOUT",
  "OVERVIEW_PROCESSING_DEADLINE",
  "ENTRY_HISTORY_PROCESSING_DEADLINE",
  "FRAME_SELECTION_FAILED",
  "BLUE_IRIS_INITIALIZATION_FAILED",
]);
const ENTRY_HISTORY_PLATE_CAMERAS = new Map([
  ["entry lpr 1", "Entry LPR 1"],
  ["entry lpr 2", "Entry LPR 2"],
]);

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value)
  ).digest("hex");
}

function normalizeEntryHistoryCamera(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const canonical = ENTRY_HISTORY_PLATE_CAMERAS.get(normalized);
  if (!canonical) throw new Error("Entry history supports only Entry LPR 1 and Entry LPR 2.");
  return canonical;
}

function isEntryHistoryPlateCamera(value) {
  return ENTRY_HISTORY_PLATE_CAMERAS.has(String(value || "").trim().toLowerCase());
}

function normalizeEntryHistoryCameras(values = ["Entry LPR 1", "Entry LPR 2"]) {
  const input = Array.isArray(values) ? values : [values];
  const cameras = [...new Set(input.map(normalizeEntryHistoryCamera))].sort();
  if (!cameras.length) throw new Error("At least one Entry LPR camera is required.");
  return cameras;
}

function normalizeIso(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`A valid ${label} is required.`);
  return parsed.toISOString();
}

function boundedEntryHistoryBatch(value) {
  return Math.min(
    ENTRY_HISTORY_MAX_BATCH,
    Math.max(1, Number.parseInt(String(value), 10) || 50),
  );
}

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
        'MEDIA_TOOL_TIMEOUT','MEDIA_TOOL_FAILED','HTTP_ERROR','CONNECTION_FAILED',
        'BLUE_IRIS_INITIALIZATION_FAILED'
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
              source_role, overview_context, source_camera_short_name,
              expected_delta_ms, tolerance_ms,
              priority, enabled, revision,
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
              source_role, overview_context, source_camera_short_name,
              expected_delta_ms, tolerance_ms,
              priority, enabled, revision,
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
    const overviewContext = String(input.overviewContext || "street").trim().toLowerCase() === "entry"
      ? "entry"
      : "street";
    const sourceCameraShortName = String(input.sourceCameraShortName || "").trim() || null;
    return this.withTransaction(async (repository) => {
      let plateCameraName = String(input.plateCameraName || "").trim();
      let directionLabel = String(input.directionLabel || "").trim();
      let sourceCameraName = String(input.sourceCameraName || "").trim();
      if (input.sourceRole === "primary" && input.enabled !== false) {
        const identity = `vehicle-overview-primary:${plateCameraName.toLowerCase()}:${directionLabel.toLowerCase()}`;
        await repository.pool.query("SELECT pg_advisory_xact_lock(hashtext($1))", [identity]);
        const existing = await repository.pool.query(
          `SELECT id, source_camera_name, plate_camera_name, direction_label
           FROM public.vehicle_overview_pair_profiles
           WHERE enabled = TRUE AND source_role = 'primary'
             AND LOWER(BTRIM(plate_camera_name)) = LOWER(BTRIM($1))
             AND LOWER(BTRIM(direction_label)) = LOWER(BTRIM($2))
           ORDER BY id
           FOR UPDATE`,
          [plateCameraName, directionLabel]
        );
        const conflict = (existing.rows || []).find((profile) => (
          String(profile.source_camera_name || "").trim().toLowerCase()
            !== sourceCameraName.toLowerCase()
        ));
        if (conflict) {
          throw new Error(
            `Disable the existing ${conflict.source_camera_name} primary profile for this camera and direction first.`
          );
        }
        const canonical = (existing.rows || [])[0] || null;
        if (canonical) {
          sourceCameraName = canonical.source_camera_name;
          plateCameraName = canonical.plate_camera_name;
          directionLabel = canonical.direction_label;
        }
      }
      const result = await repository.pool.query(
         `INSERT INTO public.vehicle_overview_pair_profiles (
           source_camera_name, plate_camera_name, direction_label, source_role,
           overview_context, source_camera_short_name, expected_delta_ms,
           tolerance_ms, priority, enabled, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
         ON CONFLICT (source_camera_name, plate_camera_name, direction_label)
         DO UPDATE SET source_role = EXCLUDED.source_role,
           overview_context = EXCLUDED.overview_context,
           source_camera_short_name = EXCLUDED.source_camera_short_name,
           expected_delta_ms = EXCLUDED.expected_delta_ms,
           tolerance_ms = EXCLUDED.tolerance_ms,
           priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
           revision = CASE WHEN ROW(
             vehicle_overview_pair_profiles.source_role,
             vehicle_overview_pair_profiles.overview_context,
             vehicle_overview_pair_profiles.source_camera_short_name,
             vehicle_overview_pair_profiles.expected_delta_ms,
             vehicle_overview_pair_profiles.tolerance_ms,
             vehicle_overview_pair_profiles.priority,
             vehicle_overview_pair_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.source_role, EXCLUDED.overview_context, EXCLUDED.source_camera_short_name,
             EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN vehicle_overview_pair_profiles.revision + 1
             ELSE vehicle_overview_pair_profiles.revision END,
           updated_at = CASE WHEN ROW(
             vehicle_overview_pair_profiles.source_role,
             vehicle_overview_pair_profiles.overview_context,
             vehicle_overview_pair_profiles.source_camera_short_name,
             vehicle_overview_pair_profiles.expected_delta_ms,
             vehicle_overview_pair_profiles.tolerance_ms,
             vehicle_overview_pair_profiles.priority,
             vehicle_overview_pair_profiles.enabled
           ) IS DISTINCT FROM ROW(
             EXCLUDED.source_role, EXCLUDED.overview_context, EXCLUDED.source_camera_short_name,
             EXCLUDED.expected_delta_ms,
             EXCLUDED.tolerance_ms, EXCLUDED.priority, EXCLUDED.enabled
           ) THEN CURRENT_TIMESTAMP ELSE vehicle_overview_pair_profiles.updated_at END
         RETURNING *`,
        [
          sourceCameraName,
          plateCameraName,
          directionLabel,
          input.sourceRole,
          overviewContext,
          sourceCameraShortName,
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
           overviewContext: saved.overview_context,
           sourceCameraShortName: saved.source_camera_short_name,
          expectedDeltaMs: Number(saved.expected_delta_ms),
          toleranceMs: Number(saved.tolerance_ms),
          priority: Number(saved.priority),
          enabled: saved.enabled === true,
        })]
      );
      return saved;
    });
  }

  async listEntryOverviewHistoryProfiles({ enabledOnly = false } = {}) {
    const result = await this.pool.query(
      `SELECT id, profile_key, revision, profile_kind, source_kind,
              overview_context, source_camera_name, source_camera_short_name,
              plate_camera_name, expected_delta_ms, tolerance_ms,
              algorithm_revision, enabled, supersedes_profile_id,
              created_at, disabled_at
       FROM public.vehicle_entry_overview_history_profiles
       WHERE ($1::boolean = FALSE OR enabled = TRUE)
       ORDER BY LOWER(BTRIM(plate_camera_name)), revision DESC, id DESC`,
      [enabledOnly === true],
    );
    return result.rows || [];
  }

  async saveEntryOverviewHistoryProfile(input = {}) {
    const plateCameraName = normalizeEntryHistoryCamera(input.plateCameraName);
    const expectedDeltaMs = Number.parseInt(String(input.expectedDeltaMs), 10);
    if (!Number.isSafeInteger(expectedDeltaMs) || Math.abs(expectedDeltaMs) > 30_000) {
      throw new Error("Entry history expected delta must be an integer between -30000 and 30000 ms.");
    }
    const algorithmRevision = String(input.algorithmRevision || "entry-overview-history-v1").trim();
    if (!algorithmRevision) throw new Error("An Entry history algorithm revision is required.");
    const profileKey = sha256({
      profileKind: ENTRY_HISTORY_PROFILE_KIND,
      sourceCameraName: ENTRY_HISTORY_CAMERA_NAME,
      sourceCameraShortName: ENTRY_HISTORY_CAMERA_SHORT_NAME,
      plateCameraName: plateCameraName.toLowerCase(),
    });
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`entry-overview-history-profile:${plateCameraName.toLowerCase()}`],
      );
      const current = await repository.pool.query(
        `SELECT *
         FROM public.vehicle_entry_overview_history_profiles
         WHERE enabled = TRUE
           AND LOWER(BTRIM(plate_camera_name)) = LOWER(BTRIM($1))
         ORDER BY revision DESC, id DESC
         FOR UPDATE`,
        [plateCameraName],
      );
      if (current.rowCount > 1) {
        throw new Error(`Multiple enabled Entry history profiles exist for ${plateCameraName}.`);
      }
      const active = current.rows?.[0] || null;
      if (active
        && Number(active.expected_delta_ms) === expectedDeltaMs
        && String(active.algorithm_revision) === algorithmRevision) {
        return active;
      }
      if (active) {
        await repository.pool.query(
          `UPDATE public.vehicle_entry_overview_history_profiles
           SET enabled = FALSE, disabled_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND enabled = TRUE`,
          [active.id],
        );
      }
      const inserted = await repository.pool.query(
        `INSERT INTO public.vehicle_entry_overview_history_profiles (
           profile_key, revision, profile_kind, source_kind, overview_context,
           source_camera_name, source_camera_short_name, plate_camera_name,
           expected_delta_ms, tolerance_ms, algorithm_revision,
           enabled, supersedes_profile_id
         ) VALUES (
           $1,
           COALESCE((SELECT MAX(revision) + 1
                     FROM public.vehicle_entry_overview_history_profiles
                     WHERE profile_key = $1), 1),
           'entry_history','entry_overview_history','entry',
           'Entry Overview','Cam143',$2,$3,3000,$4,TRUE,$5
         )
         RETURNING *`,
        [profileKey, plateCameraName, expectedDeltaMs, algorithmRevision, active?.id ?? null],
      );
      return inserted.rows[0];
    });
  }

  async previewEntryOverviewBackfillRun({
    startAt,
    endAt,
    plateCameraNames = ["Entry LPR 1", "Entry LPR 2"],
    batchSize = 50,
    daylightProvider = "local-hsv-histogram",
    daylightModel = "vehicle-color-hsv-v2",
    algorithmRevision = "entry-overview-history-v1",
  } = {}) {
    const start = normalizeIso(startAt, "Entry history start time");
    const end = normalizeIso(endAt, "Entry history end time");
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      throw new Error("Entry history end time must be after its start time.");
    }
    const cameras = normalizeEntryHistoryCameras(plateCameraNames);
    const boundedBatch = boundedEntryHistoryBatch(batchSize);
    const provider = String(daylightProvider || "").trim();
    const model = String(daylightModel || "").trim();
    const algorithm = String(algorithmRevision || "").trim();
    if (!provider || !model || !algorithm) {
      throw new Error("Entry history daylight and algorithm revisions are required.");
    }
    return this.withTransaction(async (repository) => {
      const profilesResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_entry_overview_history_profiles
         WHERE enabled = TRUE
           AND LOWER(BTRIM(plate_camera_name)) = ANY($1::text[])
         ORDER BY LOWER(BTRIM(plate_camera_name)), id
         FOR SHARE`,
        [cameras.map((camera) => camera.toLowerCase())],
      );
      const profiles = profilesResult.rows || [];
      if (profiles.length !== cameras.length) {
        const configured = new Set(profiles.map((row) => String(row.plate_camera_name).trim().toLowerCase()));
        const missing = cameras.filter((camera) => !configured.has(camera.toLowerCase()));
        throw new Error(`Configure an immutable Entry history profile for: ${missing.join(", ")}.`);
      }
      const profileSnapshot = profiles.map((row) => ({
        id: Number(row.id),
        profileKey: String(row.profile_key).trim(),
        revision: Number(row.revision),
        profileKind: row.profile_kind,
        sourceKind: row.source_kind,
        overviewContext: row.overview_context,
        sourceCameraName: row.source_camera_name,
        sourceCameraShortName: row.source_camera_short_name,
        plateCameraName: row.plate_camera_name,
        expectedDeltaMs: Number(row.expected_delta_ms),
        toleranceMs: Number(row.tolerance_ms),
        algorithmRevision: row.algorithm_revision,
      }));
      const scope = {
        startAt: start,
        endAt: end,
        plateCameraNames: cameras,
        profiles: profileSnapshot,
        daylightProvider: provider,
        daylightModel: model,
        algorithmRevision: algorithm,
      };
      const scopeKey = sha256(scope);
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`entry-overview-history-preview:${scopeKey}`],
      );
      const existing = await repository.pool.query(
        `SELECT id FROM public.vehicle_entry_overview_backfill_runs
         WHERE scope_key = $1 AND status <> 'cancelled'`,
        [scopeKey],
      );
      if (existing.rows?.[0]) {
        return repository.getEntryOverviewBackfillRun(existing.rows[0].id);
      }
      const readsResult = await repository.pool.query(
        `SELECT reads.id, reads.camera_name, reads."timestamp",
                reads.vehicle_image_path, reads.vehicle_image_status,
                reads.vehicle_image_queue_kind, reads.vehicle_image_attempt_count,
                reads.vehicle_image_retryable, reads.vehicle_image_error_code,
                reads.vehicle_image_source_kind, reads.vehicle_overview_candidate_id,
                reads.vehicle_image_source_read_id, reads.vehicle_image_timestamp,
                reads.vehicle_image_score, reads.vehicle_image_detection_confidence,
                reads.vehicle_image_detection_box, reads.vehicle_image_width,
                reads.vehicle_image_height, reads.vehicle_image_sampled_count,
                reads.vehicle_image_selection_metadata,
                observation.status AS daylight_observation_status,
                observation.raw_result AS daylight_raw_result,
                observation.error_code AS daylight_error_code,
                observation.evaluated_at AS daylight_evaluated_at
         FROM public.plate_reads reads
         LEFT JOIN LATERAL (
           SELECT status, raw_result, error_code, evaluated_at
           FROM public.vehicle_attribute_observations
           WHERE read_id = reads.id AND attribute_key = 'color'
             AND provider = $4 AND model_version = $5
           ORDER BY evaluated_at DESC, id DESC
           LIMIT 1
         ) observation ON TRUE
         WHERE reads."timestamp" >= $1::timestamptz
           AND reads."timestamp" < $2::timestamptz
           AND LOWER(BTRIM(reads.camera_name)) = ANY($3::text[])
         ORDER BY reads."timestamp", reads.id`,
        [start, end, cameras.map((camera) => camera.toLowerCase()), provider, model],
      );
      const profilesByCamera = new Map(profiles.map((row) => [
        String(row.plate_camera_name).trim().toLowerCase(), row,
      ]));
      const jobs = (readsResult.rows || []).map((read) => {
        const profile = profilesByCamera.get(String(read.camera_name).trim().toLowerCase());
        const readTimestamp = new Date(read.timestamp).toISOString();
        const anchorAt = new Date(
          new Date(readTimestamp).getTime() + Number(profile.expected_delta_ms),
        ).toISOString();
        const prior = {
          imagePath: read.vehicle_image_path ?? null,
          imageStatus: read.vehicle_image_status ?? null,
          queueKind: read.vehicle_image_queue_kind ?? null,
          attemptCount: read.vehicle_image_attempt_count == null
            ? null : Number(read.vehicle_image_attempt_count),
          retryable: read.vehicle_image_retryable ?? null,
          errorCode: read.vehicle_image_error_code ?? null,
          sourceKind: read.vehicle_image_source_kind ?? null,
          overviewCandidateId: read.vehicle_overview_candidate_id == null
            ? null : Number(read.vehicle_overview_candidate_id),
          sourceReadId: read.vehicle_image_source_read_id == null
            ? null : Number(read.vehicle_image_source_read_id),
          imageTimestamp: read.vehicle_image_timestamp
            ? new Date(read.vehicle_image_timestamp).toISOString() : null,
          imageScore: read.vehicle_image_score ?? null,
          detectionConfidence: read.vehicle_image_detection_confidence ?? null,
          detectionBox: read.vehicle_image_detection_box ?? null,
          imageWidth: read.vehicle_image_width == null ? null : Number(read.vehicle_image_width),
          imageHeight: read.vehicle_image_height == null ? null : Number(read.vehicle_image_height),
          sampledCount: read.vehicle_image_sampled_count == null
            ? null : Number(read.vehicle_image_sampled_count),
          selectionMetadata: read.vehicle_image_selection_metadata ?? null,
        };
        const raw = jsonObject(read.daylight_raw_result);
        const protectedView = Boolean(String(prior.imagePath || "").trim())
          && ["entry_overview_primary", "entry_overview_history"].includes(prior.sourceKind);
        const liveBusy = (["pending", "processing"].includes(prior.imageStatus)
          && ["live", "manual", "overview", "historical"].includes(prior.queueKind))
          || (prior.imageStatus === "failed" && prior.retryable === true
            && ["live", "manual", "overview", "historical"].includes(prior.queueKind));
        let daylightStatus = "eligible";
        if (protectedView) daylightStatus = "preserved";
        else if (liveBusy) daylightStatus = "live_busy";
        else if (raw.reason === "monochrome_capture"
          || prior.errorCode === "NIGHTTIME_UNAVAILABLE") daylightStatus = "nighttime";
        else if (!read.daylight_observation_status
          || read.daylight_observation_status === "failed") daylightStatus = "needs_preflight";
        const daylightEvidence = {
          evaluated: Boolean(read.daylight_observation_status),
          eligible: daylightStatus === "eligible",
          status: read.daylight_observation_status || null,
          reason: raw.reason || null,
          errorCode: read.daylight_error_code || null,
          evaluatedAt: read.daylight_evaluated_at
            ? new Date(read.daylight_evaluated_at).toISOString() : null,
        };
        return {
          readId: Number(read.id),
          semanticKey: sha256({
            readId: Number(read.id),
            sourceCameraShortName: ENTRY_HISTORY_CAMERA_SHORT_NAME,
            anchorAt,
            profileKey: String(profile.profile_key).trim(),
            profileRevision: Number(profile.revision),
            algorithmRevision: algorithm,
          }),
          profile,
          plateCameraName: read.camera_name,
          readTimestamp,
          anchorAt,
          daylightStatus,
          daylightEvidence,
          prior,
          priorStateFingerprint: sha256(prior),
        };
      });
      const previewFingerprint = sha256({
        scope,
        jobs: jobs.map((job) => ({
          semanticKey: job.semanticKey,
          priorStateFingerprint: job.priorStateFingerprint,
          daylightStatus: job.daylightStatus,
          daylightEvidence: job.daylightEvidence,
        })),
      });
      const runResult = await repository.pool.query(
        `INSERT INTO public.vehicle_entry_overview_backfill_runs (
           scope_key, preview_fingerprint, status, start_at, end_at,
           plate_camera_names, profile_snapshot, daylight_provider,
           daylight_model, algorithm_revision, batch_size
         ) VALUES ($1,$2,'previewed',$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
         RETURNING id`,
        [scopeKey, previewFingerprint, start, end, JSON.stringify(cameras),
          JSON.stringify(profileSnapshot), provider, model, algorithm, boundedBatch],
      );
      const runId = runResult.rows[0].id;
      if (jobs.length) {
        const payload = jobs.map((job) => ({
          read_id: job.readId,
          semantic_key: job.semanticKey,
          profile_id: Number(job.profile.id),
          profile_key: String(job.profile.profile_key).trim(),
          profile_revision: Number(job.profile.revision),
          plate_camera_name: job.plateCameraName,
          read_timestamp: job.readTimestamp,
          anchor_at: job.anchorAt,
          expected_delta_ms: Number(job.profile.expected_delta_ms),
          algorithm_revision: algorithm,
          daylight_status: job.daylightStatus,
          daylight_evidence: job.daylightEvidence,
          prior_state_fingerprint: job.priorStateFingerprint,
          ...Object.fromEntries(Object.entries(job.prior).map(([key, value]) => [
            `prior_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, value,
          ])),
        }));
        const inserted = await repository.pool.query(
          `INSERT INTO public.vehicle_entry_overview_backfill_jobs (
             run_id, read_id, semantic_key, profile_id, profile_key, profile_revision,
             profile_kind, source_kind, overview_context, source_camera_name,
             source_camera_short_name, plate_camera_name, read_timestamp,
             anchor_at, expected_delta_ms, tolerance_ms, algorithm_revision,
             daylight_provider, daylight_model, daylight_status, daylight_evidence,
             prior_state_fingerprint, prior_image_path, prior_image_status,
             prior_queue_kind, prior_attempt_count, prior_retryable,
             prior_error_code, prior_source_kind, prior_image_timestamp,
             prior_overview_candidate_id, prior_source_read_id,
             prior_image_score, prior_detection_confidence, prior_detection_box,
             prior_image_width, prior_image_height, prior_sampled_count,
             prior_selection_metadata
           )
           SELECT $1, item.read_id, item.semantic_key, item.profile_id,
                  item.profile_key, item.profile_revision, 'entry_history',
                  'entry_overview_history', 'entry', 'Entry Overview', 'Cam143',
                  item.plate_camera_name, item.read_timestamp, item.anchor_at,
                  item.expected_delta_ms, 3000, item.algorithm_revision,
                  $3, $4, item.daylight_status, item.daylight_evidence,
                  item.prior_state_fingerprint, item.prior_image_path,
                  item.prior_image_status, item.prior_queue_kind,
                  item.prior_attempt_count, item.prior_retryable,
                  item.prior_error_code, item.prior_source_kind,
                  item.prior_image_timestamp, item.prior_overview_candidate_id,
                  item.prior_source_read_id, item.prior_image_score,
                  item.prior_detection_confidence, item.prior_detection_box,
                  item.prior_image_width, item.prior_image_height,
                  item.prior_sampled_count, item.prior_selection_metadata
           FROM jsonb_to_recordset($2::jsonb) AS item(
             read_id integer, semantic_key char(64), profile_id bigint,
             profile_key char(64), profile_revision bigint,
             plate_camera_name text, read_timestamp timestamptz, anchor_at timestamptz,
             expected_delta_ms integer, algorithm_revision text,
             daylight_status text, daylight_evidence jsonb,
             prior_state_fingerprint char(64), prior_image_path text,
             prior_image_status text, prior_queue_kind text,
             prior_attempt_count smallint, prior_retryable boolean,
             prior_error_code text, prior_source_kind text,
             prior_image_timestamp timestamptz, prior_image_score real,
             prior_overview_candidate_id bigint, prior_source_read_id integer,
             prior_detection_confidence real, prior_detection_box jsonb,
             prior_image_width integer, prior_image_height integer,
             prior_sampled_count smallint, prior_selection_metadata jsonb
           )
           ON CONFLICT (run_id, read_id) DO NOTHING
           RETURNING id`,
          [runId, JSON.stringify(payload), provider, model],
        );
        if (inserted.rowCount !== jobs.length) {
          throw new Error("Entry history preview materialization was incomplete.");
        }
      }
      return repository.getEntryOverviewBackfillRun(runId);
    });
  }

  async getEntryOverviewBackfillRun(runId, { jobLimit = 100 } = {}) {
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(jobLimit), 10) || 100));
    const runResult = await this.pool.query(
      `SELECT * FROM public.vehicle_entry_overview_backfill_runs WHERE id = $1`,
      [runId],
    );
    const run = runResult.rows?.[0] || null;
    if (!run) return null;
    const countsResult = await this.pool.query(
      `SELECT COUNT(*)::integer AS total,
              COUNT(*) FILTER (WHERE daylight_status = 'eligible')::integer AS eligible,
              COUNT(*) FILTER (WHERE daylight_status = 'needs_preflight')::integer AS needs_preflight,
              COUNT(*) FILTER (WHERE daylight_status = 'nighttime')::integer AS nighttime,
              COUNT(*) FILTER (WHERE daylight_status = 'unverified')::integer AS unverified,
              COUNT(*) FILTER (WHERE daylight_status = 'live_busy')::integer AS live_busy,
              COUNT(*) FILTER (WHERE daylight_status = 'preserved')::integer AS preserved,
              COUNT(*) FILTER (WHERE prior_image_path IS NULL
                AND daylight_status IN ('eligible','needs_preflight'))::integer AS missing_candidates,
              COUNT(*) FILTER (WHERE prior_image_path IS NOT NULL
                AND daylight_status IN ('eligible','needs_preflight'))::integer AS upgrade_candidates,
              COUNT(*) FILTER (WHERE status = 'previewed')::integer AS previewed,
              COUNT(*) FILTER (WHERE status = 'previewed'
                AND daylight_status IN ('eligible','needs_preflight'))::integer AS previewable_remaining,
              COUNT(*) FILTER (WHERE status = 'queued')::integer AS queued,
              COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
              COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
              COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
              COUNT(*) FILTER (WHERE status = 'unavailable')::integer AS unavailable,
              COUNT(*) FILTER (WHERE status = 'superseded')::integer AS superseded,
              COUNT(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled,
              MIN(read_timestamp) AS oldest_at,
              MAX(read_timestamp) AS newest_at
       FROM public.vehicle_entry_overview_backfill_jobs
       WHERE run_id = $1`,
      [runId],
    );
    const jobsResult = await this.pool.query(
      `SELECT id, run_id, read_id, semantic_key, profile_id, profile_key,
              profile_revision, profile_kind, source_kind, overview_context,
              source_camera_name, source_camera_short_name, plate_camera_name,
              read_timestamp, anchor_at, expected_delta_ms, tolerance_ms,
              algorithm_revision, daylight_provider, daylight_model,
              daylight_status, daylight_evidence, status, attempt_count,
              retryable, error_code, error_details, operator_retry_count,
              operator_retry_at, operator_retry_error_code, prior_state_fingerprint,
              prior_image_path, prior_image_status, prior_queue_kind,
              prior_source_kind, confirmed_at, ready_at, updated_at
       FROM public.vehicle_entry_overview_backfill_jobs
       WHERE run_id = $1
       ORDER BY read_timestamp, id
       LIMIT $2`,
      [runId, limit],
    );
    const counts = countsResult.rows?.[0] || {};
    return {
      ...run,
      counts: Object.fromEntries([
        "total", "eligible", "needs_preflight", "nighttime", "unverified", "live_busy", "preserved",
        "missing_candidates", "upgrade_candidates",
        "previewed", "previewable_remaining", "queued", "processing", "ready", "failed",
        "unavailable", "superseded", "cancelled",
      ].map((key) => [key, Number(counts[key] || 0)])),
      oldest_at: counts.oldest_at || null,
      newest_at: counts.newest_at || null,
      jobs: jobsResult.rows || [],
    };
  }

  async getLatestEntryOverviewBackfillRun({ jobLimit = 100 } = {}) {
    const result = await this.pool.query(
      `SELECT id
       FROM public.vehicle_entry_overview_backfill_runs
       ORDER BY CASE WHEN status IN ('previewed','running','paused') THEN 0 ELSE 1 END,
                created_at DESC, id DESC
       LIMIT 1`,
    );
    const runId = result.rows?.[0]?.id || null;
    return runId == null ? null : this.getEntryOverviewBackfillRun(runId, { jobLimit });
  }

  async listEntryOverviewBackfillRetryCandidates({ limit = 25 } = {}) {
    const boundedLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 25));
    const result = await this.pool.query(
      `SELECT jobs.id, jobs.run_id, jobs.read_id, jobs.plate_camera_name,
              jobs.read_timestamp, jobs.error_code, jobs.attempt_count,
              jobs.operator_retry_count, jobs.operator_retry_at,
              jobs.prior_image_path, reads.plate_number
       FROM public.vehicle_entry_overview_backfill_jobs jobs
       JOIN public.plate_reads reads ON reads.id = jobs.read_id
       WHERE jobs.status = 'failed'
         AND jobs.retryable = FALSE
         AND jobs.attempt_count >= 2
         AND jobs.operator_retry_count < $1
         AND jobs.error_code = ANY($2::text[])
         AND reads.vehicle_image_backfill_job_id IS NULL
         AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
         AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
         AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
         AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
         AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
         AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
         AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
         AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
         AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
         AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
         AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
         AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
         AND (
           (NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NOT NULL
             AND reads.vehicle_image_status IS NOT DISTINCT FROM jobs.prior_image_status
             AND reads.vehicle_image_queue_kind IS NOT DISTINCT FROM jobs.prior_queue_kind
             AND reads.vehicle_image_attempt_count IS NOT DISTINCT FROM jobs.prior_attempt_count
             AND reads.vehicle_image_retryable IS NOT DISTINCT FROM jobs.prior_retryable
             AND reads.vehicle_image_error_code IS NOT DISTINCT FROM jobs.prior_error_code)
           OR
           (NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
             AND reads.vehicle_image_status = 'failed'
             AND reads.vehicle_image_queue_kind IS NULL
             AND reads.vehicle_image_attempt_count = jobs.attempt_count
             AND reads.vehicle_image_retryable = FALSE
             AND reads.vehicle_image_error_code = jobs.error_code)
         )
       ORDER BY jobs.updated_at DESC, jobs.id DESC
       LIMIT $3`,
      [ENTRY_HISTORY_MAX_OPERATOR_RETRIES, ENTRY_HISTORY_OPERATOR_RETRY_CODES, boundedLimit],
    );
    return result.rows || [];
  }

  async retryEntryOverviewBackfillJob(jobId) {
    const normalizedJobId = Number.parseInt(String(jobId), 10);
    if (!Number.isSafeInteger(normalizedJobId) || normalizedJobId <= 0) {
      throw new Error("A valid failed Entry Overview import is required.");
    }
    return this.withTransaction(async (repository) => {
      const jobResult = await repository.pool.query(
        `SELECT jobs.*
         FROM public.vehicle_entry_overview_backfill_jobs jobs
         JOIN public.vehicle_entry_overview_backfill_runs runs ON runs.id = jobs.run_id
         WHERE jobs.id = $1
         FOR UPDATE OF jobs, runs`,
        [normalizedJobId],
      );
      const job = jobResult.rows?.[0] || null;
      if (!job) throw new Error("This failed Entry Overview import was not found.");
      if (job.status !== "failed" || job.retryable === true || Number(job.attempt_count) < 2) {
        throw new Error("Only a terminal Entry Overview import failure can be retried.");
      }
      if (!ENTRY_HISTORY_OPERATOR_RETRY_CODES.includes(String(job.error_code || ""))) {
        throw new Error("This failure is not a retry-safe import or processing error.");
      }
      if (Number(job.operator_retry_count || 0) >= ENTRY_HISTORY_MAX_OPERATOR_RETRIES) {
        throw new Error("This import has already used its one manual retry cycle.");
      }
      const active = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_entry_overview_backfill_jobs active_jobs
           WHERE active_jobs.status IN ('queued','processing')
              OR (active_jobs.status = 'failed' AND active_jobs.retryable = TRUE)
         ) AS has_active_history`,
      );
      if (active.rows?.[0]?.has_active_history === true) {
        throw new Error("Wait for the current Entry Overview history work to finish before retrying this import.");
      }
      const readResult = await repository.pool.query(
        `UPDATE public.plate_reads reads
         SET vehicle_image_status = 'pending',
             vehicle_image_queue_kind = 'overview_backfill',
             vehicle_image_attempt_count = 0,
             vehicle_image_retryable = TRUE,
             vehicle_image_error_code = NULL,
             vehicle_image_claim_token = NULL,
             vehicle_image_next_attempt_at = NULL,
             vehicle_image_heartbeat_at = NULL,
             vehicle_image_processing_deadline_at = NULL,
             vehicle_image_hard_deadline_at = NULL,
             vehicle_image_backfill_job_id = jobs.id,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_entry_overview_backfill_jobs jobs
         WHERE jobs.id = $1 AND reads.id = jobs.read_id
           AND reads.vehicle_image_backfill_job_id IS NULL
           AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
           AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
           AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
           AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
           AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
           AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
           AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
           AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
           AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
           AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
           AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
           AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           AND (
             (NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NOT NULL
               AND reads.vehicle_image_status IS NOT DISTINCT FROM jobs.prior_image_status
               AND reads.vehicle_image_queue_kind IS NOT DISTINCT FROM jobs.prior_queue_kind
               AND reads.vehicle_image_attempt_count IS NOT DISTINCT FROM jobs.prior_attempt_count
               AND reads.vehicle_image_retryable IS NOT DISTINCT FROM jobs.prior_retryable
               AND reads.vehicle_image_error_code IS NOT DISTINCT FROM jobs.prior_error_code)
             OR
             (NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
               AND reads.vehicle_image_status = 'failed'
               AND reads.vehicle_image_queue_kind IS NULL
               AND reads.vehicle_image_attempt_count = jobs.attempt_count
               AND reads.vehicle_image_retryable = FALSE
               AND reads.vehicle_image_error_code = jobs.error_code)
           )
         RETURNING reads.id`,
        [normalizedJobId],
      );
      if (readResult.rowCount !== 1) {
        throw new Error("The plate read or its current vehicle view changed; refresh before retrying.");
      }
      const retried = await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_jobs
         SET status = 'queued', attempt_count = 0, retryable = TRUE,
             claim_token = NULL, heartbeat_at = NULL,
             processing_deadline_at = NULL, hard_deadline_at = NULL,
             next_attempt_at = NULL,
             operator_retry_count = operator_retry_count + 1,
             operator_retry_at = CURRENT_TIMESTAMP,
             operator_retry_error_code = error_code,
             error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'failed' AND retryable = FALSE
           AND operator_retry_count < $2
         RETURNING *`,
        [normalizedJobId, ENTRY_HISTORY_MAX_OPERATOR_RETRIES],
      );
      if (retried.rowCount !== 1) {
        throw new Error("This import could not be placed into a bounded manual retry cycle.");
      }
      await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_runs
         SET status = 'running', completed_at = NULL, cancelled_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [job.run_id],
      );
      await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_runs runs
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE runs.status = 'previewed'
           AND runs.id <> $1
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_entry_overview_backfill_jobs idle_jobs
             WHERE idle_jobs.run_id = runs.id
               AND idle_jobs.status = 'previewed'
               AND idle_jobs.daylight_status IN ('eligible','needs_preflight')
           )`,
        [job.run_id],
      );
      return retried.rows[0];
    });
  }

  async confirmEntryOverviewBackfillRun({ runId, previewFingerprint, limit = null } = {}) {
    const fingerprint = String(previewFingerprint || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("The exact Entry history preview fingerprint is required.");
    }
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_entry_overview_backfill_runs
         WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      const run = runResult.rows?.[0] || null;
      if (!run) throw new Error("Entry history preview was not found.");
      if (String(run.preview_fingerprint).trim() !== fingerprint) {
        throw new Error("Entry history preview changed; preview again before confirming.");
      }
      if (!["previewed", "running", "paused"].includes(run.status)) {
        throw new Error(`Entry history run cannot be confirmed while ${run.status}.`);
      }
      const activeBatch = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1
           FROM public.vehicle_entry_overview_backfill_jobs jobs
           WHERE jobs.run_id = $1
             AND (
               jobs.status IN ('queued','processing')
               OR (jobs.status = 'failed' AND jobs.retryable = TRUE)
             )
         ) AS has_active_batch`,
        [runId],
      );
      if (activeBatch.rows?.[0]?.has_active_batch === true) {
        throw new Error("Entry history run already has an active batch; wait for it to finish before queuing the next batch.");
      }
      const boundedLimit = Math.min(
        Number(run.batch_size),
        boundedEntryHistoryBatch(limit ?? run.batch_size),
      );
      const selected = await repository.pool.query(
        `SELECT * FROM public.vehicle_entry_overview_backfill_jobs
         WHERE run_id = $1 AND status = 'previewed'
           AND daylight_status IN ('eligible','needs_preflight')
         ORDER BY read_timestamp, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [runId, boundedLimit],
      );
      let queued = 0;
      let superseded = 0;
      for (const job of selected.rows || []) {
        const update = await repository.pool.query(
          `UPDATE public.plate_reads reads
           SET vehicle_image_status = 'pending',
               vehicle_image_queue_kind = 'overview_backfill',
               vehicle_image_attempt_count = 0,
               vehicle_image_retryable = TRUE,
               vehicle_image_error_code = NULL,
               vehicle_image_claim_token = NULL,
               vehicle_image_next_attempt_at = NULL,
               vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_backfill_job_id = $2,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           WHERE reads.id = $1
             AND reads.vehicle_image_backfill_job_id IS NULL
             AND reads.vehicle_image_path IS NOT DISTINCT FROM $3
             AND reads.vehicle_image_status IS NOT DISTINCT FROM $4
             AND reads.vehicle_image_queue_kind IS NOT DISTINCT FROM $5
             AND reads.vehicle_image_attempt_count IS NOT DISTINCT FROM $6
             AND reads.vehicle_image_retryable IS NOT DISTINCT FROM $7
             AND reads.vehicle_image_error_code IS NOT DISTINCT FROM $8
             AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM $9
             AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM $10::timestamptz
             AND reads.vehicle_image_score IS NOT DISTINCT FROM $11::real
             AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM $12::real
             AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM $13::jsonb
             AND reads.vehicle_image_width IS NOT DISTINCT FROM $14::integer
             AND reads.vehicle_image_height IS NOT DISTINCT FROM $15::integer
             AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM $16::smallint
             AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM $17::jsonb
             AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM $18::bigint
             AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM $19::integer
           RETURNING reads.id`,
          [job.read_id, job.id, job.prior_image_path, job.prior_image_status,
            job.prior_queue_kind, job.prior_attempt_count, job.prior_retryable,
            job.prior_error_code, job.prior_source_kind, job.prior_image_timestamp,
            job.prior_image_score, job.prior_detection_confidence,
            job.prior_detection_box == null ? null : JSON.stringify(job.prior_detection_box),
            job.prior_image_width, job.prior_image_height, job.prior_sampled_count,
            job.prior_selection_metadata == null ? null : JSON.stringify(job.prior_selection_metadata),
            job.prior_overview_candidate_id, job.prior_source_read_id],
        );
        if (update.rowCount === 1) {
          await repository.pool.query(
            `UPDATE public.vehicle_entry_overview_backfill_jobs
             SET status = 'queued', retryable = TRUE, confirmed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'previewed'`,
            [job.id],
          );
          queued += 1;
        } else {
          await repository.pool.query(
            `UPDATE public.vehicle_entry_overview_backfill_jobs
             SET status = 'superseded', retryable = FALSE,
                 error_code = 'ENTRY_HISTORY_SOURCE_CHANGED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'previewed'`,
            [job.id],
          );
          superseded += 1;
        }
      }
      await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_runs
         SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'running' END,
             confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId],
      );
      await repository.completeEntryOverviewBackfillRunIfIdle(runId);
      return { runId: Number(runId), queued, superseded, limit: boundedLimit };
    });
  }

  async claimNextEntryOverviewBackfillJob({ requireNoLiveWork = true } = {}) {
    const claimToken = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT jobs.id
         FROM public.vehicle_entry_overview_backfill_jobs jobs
         JOIN public.vehicle_entry_overview_backfill_runs runs ON runs.id = jobs.run_id
         JOIN public.plate_reads reads ON reads.id = jobs.read_id
         WHERE runs.status = 'running'
           AND jobs.daylight_status IN ('eligible','needs_preflight')
           AND jobs.attempt_count < 2
           AND reads.vehicle_image_backfill_job_id = jobs.id
           AND reads.vehicle_image_queue_kind = 'overview_backfill'
           AND reads.vehicle_image_claim_token IS NOT DISTINCT FROM jobs.claim_token
           AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
           AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
           AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
           AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
           AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
           AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
           AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
           AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
           AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
           AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
           AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
           AND reads.vehicle_image_attempt_count = jobs.attempt_count
           AND reads.vehicle_image_retryable = TRUE
           AND reads.vehicle_image_error_code IS NOT DISTINCT FROM jobs.error_code
           AND (
             (jobs.status = 'queued' AND reads.vehicle_image_status = 'pending')
             OR (jobs.status = 'failed' AND reads.vehicle_image_status = 'failed'
                 AND jobs.retryable = TRUE
                 AND jobs.next_attempt_at <= CURRENT_TIMESTAMP)
             OR (jobs.status = 'processing' AND reads.vehicle_image_status = 'processing'
                 AND COALESCE(
                   jobs.hard_deadline_at, jobs.processing_deadline_at,
                   jobs.updated_at + INTERVAL '5 minutes'
                 ) <= CURRENT_TIMESTAMP)
           )
           AND ($1::boolean = FALSE OR NOT EXISTS (
             SELECT 1 FROM public.plate_reads live
             WHERE live.vehicle_image_path IS NULL
               AND live.camera_name IS NOT NULL
               AND BTRIM(live.camera_name) <> ''
               AND (
                 (COALESCE(live.vehicle_image_queue_kind, 'live') IN ('live','manual')
                   AND (
                     live.vehicle_image_status = 'processing'
                     OR (live.vehicle_image_status = 'pending'
                       AND COALESCE(live.vehicle_image_attempt_count, 0) < 3)
                     OR (live.vehicle_image_status = 'failed'
                       AND live.vehicle_image_retryable = TRUE
                       AND COALESCE(live.vehicle_image_attempt_count, 0) < 3)
                   ))
                 OR (live.vehicle_image_queue_kind = 'overview'
                   AND live.bi_trigger_direction_status = 'ready'
                   AND live.bi_trigger_direction_label IS NOT NULL
                   AND BTRIM(live.bi_trigger_direction_label) <> ''
                   AND (
                     live.vehicle_image_status = 'processing'
                     OR (live.vehicle_image_status = 'pending'
                       AND COALESCE(live.vehicle_image_attempt_count, 0) < 2)
                     OR (live.vehicle_image_status = 'failed'
                       AND live.vehicle_image_retryable = TRUE
                       AND COALESCE(live.vehicle_image_attempt_count, 0) < 2)
                   ))
               )
           ))
         ORDER BY jobs.read_timestamp, jobs.id
         FOR UPDATE OF jobs, reads SKIP LOCKED
         LIMIT 1
       ), claimed_job AS (
         UPDATE public.vehicle_entry_overview_backfill_jobs jobs
         SET status = 'processing', attempt_count = jobs.attempt_count + 1,
             retryable = TRUE, claim_token = $2::uuid,
             heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP + INTERVAL '3 minutes',
             hard_deadline_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
             next_attempt_at = NULL, error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM candidate
         WHERE jobs.id = candidate.id
         RETURNING jobs.*
       ), claimed_read AS (
         UPDATE public.plate_reads reads
         SET vehicle_image_status = 'processing',
             vehicle_image_attempt_count = claimed_job.attempt_count,
             vehicle_image_retryable = TRUE,
             vehicle_image_claim_token = $2::uuid,
             vehicle_image_heartbeat_at = CURRENT_TIMESTAMP,
             vehicle_image_processing_deadline_at = claimed_job.processing_deadline_at,
             vehicle_image_hard_deadline_at = claimed_job.hard_deadline_at,
             vehicle_image_next_attempt_at = NULL,
             vehicle_image_error_code = NULL,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         FROM claimed_job
         WHERE reads.id = claimed_job.read_id
           AND reads.vehicle_image_backfill_job_id = claimed_job.id
         RETURNING reads.*, claimed_job.id AS entry_history_job_id,
                   claimed_job.run_id AS entry_history_run_id,
                   claimed_job.profile_id AS entry_history_profile_id,
                   claimed_job.profile_key AS entry_history_profile_key,
                   claimed_job.profile_revision AS entry_history_profile_revision,
                   claimed_job.profile_kind AS entry_history_profile_kind,
                   claimed_job.source_kind AS entry_overview_source_kind,
                   claimed_job.overview_context AS overview_context,
                   claimed_job.source_camera_name AS overview_source_camera_name,
                   claimed_job.source_camera_short_name AS overview_source_camera_short_name,
                   claimed_job.anchor_at AS entry_overview_anchor_at,
                   claimed_job.expected_delta_ms AS overview_expected_delta_ms,
                   claimed_job.tolerance_ms AS overview_tolerance_ms,
                   claimed_job.algorithm_revision AS entry_history_algorithm_revision,
                   claimed_job.daylight_status AS entry_overview_daylight_status,
                   claimed_job.daylight_evidence AS entry_overview_daylight_evidence,
                   claimed_job.semantic_key AS entry_history_semantic_key,
                   claimed_job.prior_state_fingerprint AS entry_history_prior_state_fingerprint
       )
       SELECT *, NULL::text AS entry_history_direction_label
       FROM claimed_read`,
      [requireNoLiveWork === true, claimToken],
    );
    return result.rows?.[0] || null;
  }

  async setEntryOverviewBackfillRunState(runId, state) {
    const normalized = String(state || "").trim().toLowerCase();
    if (!["paused", "running"].includes(normalized)) {
      throw new Error("Entry history run state must be paused or running.");
    }
    const result = await this.pool.query(
      `UPDATE public.vehicle_entry_overview_backfill_runs
       SET status = $2,
           paused_at = CASE WHEN $2 = 'paused' THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND status IN ('previewed','running','paused')
       RETURNING *`,
      [runId, normalized],
    );
    return result.rows?.[0] || null;
  }

  async cancelEntryOverviewBackfillRun(runId) {
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_runs
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status IN ('previewed','running','paused')
         RETURNING id`,
        [runId],
      );
      if (!runResult.rows?.[0]) return null;
      const restored = await repository.pool.query(
        `WITH cancelled_jobs AS MATERIALIZED (
           SELECT * FROM public.vehicle_entry_overview_backfill_jobs
           WHERE run_id = $1
             AND status IN ('queued','processing','failed')
           FOR UPDATE
         ), restored_reads AS (
           UPDATE public.plate_reads reads
           SET vehicle_image_path = jobs.prior_image_path,
               vehicle_image_status = jobs.prior_image_status,
               vehicle_image_queue_kind = jobs.prior_queue_kind,
               vehicle_image_attempt_count = COALESCE(jobs.prior_attempt_count, 0),
               vehicle_image_retryable = COALESCE(jobs.prior_retryable, TRUE),
               vehicle_image_error_code = jobs.prior_error_code,
               vehicle_image_source_kind = jobs.prior_source_kind,
               vehicle_overview_candidate_id = jobs.prior_overview_candidate_id,
               vehicle_image_source_read_id = jobs.prior_source_read_id,
               vehicle_image_timestamp = jobs.prior_image_timestamp,
               vehicle_image_score = jobs.prior_image_score,
               vehicle_image_detection_confidence = jobs.prior_detection_confidence,
               vehicle_image_detection_box = jobs.prior_detection_box,
               vehicle_image_width = jobs.prior_image_width,
               vehicle_image_height = jobs.prior_image_height,
               vehicle_image_sampled_count = jobs.prior_sampled_count,
               vehicle_image_selection_metadata = jobs.prior_selection_metadata,
               vehicle_image_backfill_job_id = NULL,
               vehicle_image_claim_token = NULL,
               vehicle_image_next_attempt_at = NULL,
               vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           FROM cancelled_jobs jobs
           WHERE reads.id = jobs.read_id
             AND reads.vehicle_image_backfill_job_id = jobs.id
             AND reads.vehicle_image_queue_kind = 'overview_backfill'
             AND reads.vehicle_image_attempt_count = jobs.attempt_count
             AND reads.vehicle_image_retryable = TRUE
             AND reads.vehicle_image_error_code IS NOT DISTINCT FROM jobs.error_code
             AND (
               (jobs.status = 'queued' AND reads.vehicle_image_status = 'pending'
                 AND reads.vehicle_image_claim_token IS NULL)
               OR (jobs.status = 'failed' AND reads.vehicle_image_status = 'failed'
                 AND reads.vehicle_image_claim_token IS NULL)
               OR (jobs.status = 'processing' AND reads.vehicle_image_status = 'processing'
                 AND reads.vehicle_image_claim_token IS NOT DISTINCT FROM jobs.claim_token)
             )
             AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
             AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
             AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
             AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
             AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
             AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
             AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
             AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
             AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
             AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
             AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
             AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           RETURNING jobs.id
         )
         UPDATE public.vehicle_entry_overview_backfill_jobs jobs
         SET status = CASE WHEN restored_reads.id IS NULL THEN 'superseded' ELSE 'cancelled' END,
             retryable = FALSE, claim_token = NULL, heartbeat_at = NULL,
             processing_deadline_at = NULL, hard_deadline_at = NULL,
             next_attempt_at = NULL,
             error_code = CASE WHEN restored_reads.id IS NULL
               THEN 'ENTRY_HISTORY_SOURCE_CHANGED' ELSE 'ENTRY_HISTORY_CANCELLED' END,
             updated_at = CURRENT_TIMESTAMP
         FROM cancelled_jobs
         LEFT JOIN restored_reads ON restored_reads.id = cancelled_jobs.id
         WHERE jobs.id = cancelled_jobs.id
         RETURNING jobs.status`,
        [runId],
      );
      const previewed = await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_jobs
         SET status = 'cancelled', retryable = FALSE,
             error_code = 'ENTRY_HISTORY_CANCELLED', updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND status = 'previewed'
         RETURNING id`,
        [runId],
      );
      return {
        runId: Number(runId),
        cancelled: restored.rows.filter((row) => row.status === "cancelled").length
          + (previewed.rowCount || 0),
        superseded: restored.rows.filter((row) => row.status === "superseded").length,
      };
    });
  }

  async heartbeatEntryOverviewBackfillJob(jobId, claimToken, { extendSeconds = 180 } = {}) {
    const seconds = Math.min(300, Math.max(30, Number.parseInt(String(extendSeconds), 10) || 180));
    const result = await this.pool.query(
      `WITH active_job AS (
         UPDATE public.vehicle_entry_overview_backfill_jobs jobs
         SET heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = LEAST(
               CURRENT_TIMESTAMP + make_interval(secs => $3), hard_deadline_at
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE jobs.id = $1 AND jobs.status = 'processing'
           AND jobs.claim_token = $2::uuid
           AND jobs.hard_deadline_at > CURRENT_TIMESTAMP
         RETURNING jobs.*
       )
       UPDATE public.plate_reads reads
       SET vehicle_image_heartbeat_at = active_job.heartbeat_at,
           vehicle_image_processing_deadline_at = active_job.processing_deadline_at,
           vehicle_image_updated_at = CURRENT_TIMESTAMP
       FROM active_job
       WHERE reads.id = active_job.read_id
         AND reads.vehicle_image_backfill_job_id = active_job.id
         AND reads.vehicle_image_claim_token = $2::uuid
       RETURNING reads.id, active_job.hard_deadline_at`,
      [jobId, claimToken, seconds],
    );
    return result.rows?.[0] || null;
  }

  async recordEntryOverviewBackfillDaylight(jobId, claimToken, {
    status,
    evidence = {},
  } = {}) {
    const normalized = String(status || "").trim().toLowerCase();
    if (!["eligible", "nighttime", "unverified"].includes(normalized)) {
      throw new Error("Entry history preflight status must be eligible, nighttime, or unverified.");
    }
    const result = await this.pool.query(
      `UPDATE public.vehicle_entry_overview_backfill_jobs jobs
       SET daylight_status = $3,
           daylight_evidence = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE jobs.id = $1 AND jobs.status = 'processing'
         AND jobs.claim_token = $2::uuid
         AND jobs.hard_deadline_at > CURRENT_TIMESTAMP
       RETURNING jobs.id, jobs.read_id, jobs.daylight_status,
                 jobs.daylight_evidence, jobs.hard_deadline_at`,
      [jobId, claimToken, normalized, JSON.stringify(jsonObject(evidence))],
    );
    return result.rows?.[0] || null;
  }

  async markEntryOverviewBackfillReady(jobId, frame, {
    claimToken,
    exportToken,
  } = {}) {
    return this.withTransaction(async (repository) => {
      const updated = await repository.pool.query(
        `WITH eligible AS MATERIALIZED (
           SELECT jobs.*
           FROM public.vehicle_entry_overview_backfill_jobs jobs
           JOIN public.vehicle_entry_overview_backfill_runs runs ON runs.id = jobs.run_id
           JOIN public.blue_iris_timeline_exports exports
             ON exports.export_token = $12::uuid
            AND exports.read_id = jobs.read_id
            AND exports.claim_token = $11::uuid
            AND exports.status = 'downloaded'
            AND exports.profile_kind = jobs.profile_kind
            AND exports.profile_identity = jobs.profile_key
            AND exports.profile_revision = jobs.profile_revision
           WHERE jobs.id = $1 AND jobs.status = 'processing'
             AND jobs.claim_token = $11::uuid
             AND jobs.hard_deadline_at > CURRENT_TIMESTAMP
             AND runs.status IN ('running','paused')
           FOR SHARE OF jobs, runs, exports
         )
         UPDATE public.plate_reads reads
         SET vehicle_image_status = 'ready', vehicle_image_path = $2,
             vehicle_image_timestamp = $3::timestamptz,
             vehicle_image_score = $4, vehicle_image_detection_confidence = $5,
             vehicle_image_detection_box = $6::jsonb,
             vehicle_image_width = $7, vehicle_image_height = $8,
             vehicle_image_sampled_count = $9,
             vehicle_image_selection_metadata = $10::jsonb,
             vehicle_image_source_kind = 'entry_overview_history',
             vehicle_overview_candidate_id = NULL,
             vehicle_image_source_read_id = NULL,
             vehicle_image_retryable = FALSE, vehicle_image_error_code = NULL,
             vehicle_image_queue_kind = NULL,
             vehicle_image_backfill_job_id = NULL,
             vehicle_image_claim_token = NULL, vehicle_image_next_attempt_at = NULL,
             vehicle_image_heartbeat_at = NULL,
             vehicle_image_processing_deadline_at = NULL,
             vehicle_image_hard_deadline_at = NULL,
             vehicle_image_updated_at = CURRENT_TIMESTAMP
         FROM eligible jobs
         WHERE reads.id = jobs.read_id
           AND reads.vehicle_image_backfill_job_id = jobs.id
           AND reads.vehicle_image_status = 'processing'
           AND reads.vehicle_image_queue_kind = 'overview_backfill'
           AND reads.vehicle_image_attempt_count = jobs.attempt_count
           AND reads.vehicle_image_retryable = TRUE
           AND reads.vehicle_image_error_code IS NULL
           AND reads.vehicle_image_claim_token = $11::uuid
           AND reads.vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP
           AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
           AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
           AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
           AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
           AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
           AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
           AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
           AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
           AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
           AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
           AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
           AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
         RETURNING reads.id, jobs.run_id, jobs.prior_image_path`,
        [jobId, frame.framePath, frame.frameTimestamp, frame.frameScore,
          frame.detectionConfidence, JSON.stringify(frame.detectionBox || {}),
          frame.imageWidth, frame.imageHeight, frame.sampledCount,
          JSON.stringify(frame.selectionMetadata || {}), claimToken, exportToken],
      );
      const row = updated.rows?.[0] || null;
      if (!row) return null;
      await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_jobs
         SET status = 'ready', retryable = FALSE, claim_token = NULL,
             heartbeat_at = NULL, processing_deadline_at = NULL,
             hard_deadline_at = NULL, next_attempt_at = NULL,
             error_code = NULL, error_details = NULL,
             ready_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND claim_token = $2::uuid`,
        [jobId, claimToken],
      );
      await repository.completeEntryOverviewBackfillRunIfIdle(row.run_id);
      return {
        id: Number(row.id),
        runId: Number(row.run_id),
        priorImagePath: row.prior_image_path || null,
      };
    });
  }

  async markEntryOverviewBackfillFailed(jobId, {
    claimToken,
    errorCode,
    errorDetails = null,
    retryable = false,
    nextAttemptAt = null,
    unavailable = false,
  } = {}) {
    return this.withTransaction(async (repository) => {
      const jobResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_entry_overview_backfill_jobs
         WHERE id = $1 AND status = 'processing' AND claim_token = $2::uuid
         FOR UPDATE`,
        [jobId, claimToken],
      );
      const job = jobResult.rows?.[0] || null;
      if (!job) return null;
      const mayRetry = retryable === true && Number(job.attempt_count) < 2;
      const terminalStatus = unavailable === true ? "unavailable" : "failed";
      let readResult;
      if (mayRetry) {
        readResult = await repository.pool.query(
          `UPDATE public.plate_reads reads
           SET vehicle_image_status = 'failed', vehicle_image_retryable = TRUE,
               vehicle_image_error_code = $3,
               vehicle_image_next_attempt_at = COALESCE($4::timestamptz, CURRENT_TIMESTAMP + INTERVAL '30 seconds'),
               vehicle_image_claim_token = NULL, vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           FROM public.vehicle_entry_overview_backfill_jobs jobs
           WHERE reads.id = $1 AND jobs.id = $5
             AND reads.id = jobs.read_id
             AND reads.vehicle_image_backfill_job_id = jobs.id
             AND reads.vehicle_image_status = 'processing'
             AND reads.vehicle_image_queue_kind = 'overview_backfill'
             AND reads.vehicle_image_attempt_count = jobs.attempt_count
             AND reads.vehicle_image_retryable = TRUE
             AND reads.vehicle_image_error_code IS NULL
             AND reads.vehicle_image_claim_token = $2::uuid
             AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
             AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
             AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
             AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
             AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
             AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
             AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
             AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
             AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
             AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
             AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
             AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           RETURNING reads.id`,
          [job.read_id, claimToken, errorCode, nextAttemptAt, job.id],
        );
      } else {
        readResult = await repository.pool.query(
          `UPDATE public.plate_reads reads
           SET vehicle_image_path = jobs.prior_image_path,
               vehicle_image_status = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN $4
                 ELSE jobs.prior_image_status
               END,
               vehicle_image_queue_kind = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN NULL
                 ELSE jobs.prior_queue_kind
               END,
               vehicle_image_attempt_count = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN jobs.attempt_count
                 ELSE COALESCE(jobs.prior_attempt_count, 0)
               END,
               vehicle_image_retryable = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN FALSE
                 ELSE COALESCE(jobs.prior_retryable, TRUE)
               END,
               vehicle_image_error_code = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN $3
                 ELSE jobs.prior_error_code
               END,
               vehicle_image_source_kind = jobs.prior_source_kind,
               vehicle_overview_candidate_id = jobs.prior_overview_candidate_id,
               vehicle_image_source_read_id = jobs.prior_source_read_id,
               vehicle_image_timestamp = jobs.prior_image_timestamp,
               vehicle_image_score = jobs.prior_image_score,
               vehicle_image_detection_confidence = jobs.prior_detection_confidence,
               vehicle_image_detection_box = jobs.prior_detection_box,
               vehicle_image_width = jobs.prior_image_width,
               vehicle_image_height = jobs.prior_image_height,
               vehicle_image_sampled_count = jobs.prior_sampled_count,
               vehicle_image_selection_metadata = jobs.prior_selection_metadata,
               vehicle_image_backfill_job_id = NULL,
               vehicle_image_claim_token = NULL, vehicle_image_next_attempt_at = NULL,
               vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           FROM public.vehicle_entry_overview_backfill_jobs jobs
           WHERE jobs.id = $1 AND reads.id = jobs.read_id
             AND reads.vehicle_image_backfill_job_id = jobs.id
             AND reads.vehicle_image_status = 'processing'
             AND reads.vehicle_image_queue_kind = 'overview_backfill'
             AND reads.vehicle_image_attempt_count = jobs.attempt_count
             AND reads.vehicle_image_retryable = TRUE
             AND reads.vehicle_image_error_code IS NULL
             AND reads.vehicle_image_claim_token = $2::uuid
             AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
             AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
             AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
             AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
             AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
             AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
             AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
             AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
             AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
             AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
             AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
             AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           RETURNING reads.id`,
          [jobId, claimToken, String(errorCode || "ENTRY_HISTORY_FAILED").slice(0, 80),
            terminalStatus],
        );
      }
      if (!readResult.rows?.[0]) {
        await repository.pool.query(
          `UPDATE public.plate_reads
           SET vehicle_image_backfill_job_id = NULL,
               vehicle_image_claim_token = NULL,
               vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND vehicle_image_backfill_job_id = $2
             AND vehicle_image_claim_token = $3::uuid`,
          [job.read_id, job.id, claimToken],
        );
        await repository.pool.query(
          `UPDATE public.vehicle_entry_overview_backfill_jobs
           SET status = 'superseded', retryable = FALSE, claim_token = NULL,
               heartbeat_at = NULL, processing_deadline_at = NULL,
               hard_deadline_at = NULL, next_attempt_at = NULL,
               error_code = 'ENTRY_HISTORY_SOURCE_CHANGED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND claim_token = $2::uuid`,
          [jobId, claimToken],
        );
        await repository.completeEntryOverviewBackfillRunIfIdle(job.run_id);
        return { id: Number(job.read_id), status: "superseded", retryable: false };
      }
      await repository.pool.query(
        `UPDATE public.vehicle_entry_overview_backfill_jobs
         SET status = $3, retryable = $4, claim_token = NULL,
             heartbeat_at = NULL, processing_deadline_at = NULL,
             hard_deadline_at = NULL, next_attempt_at = CASE WHEN $4
               THEN COALESCE($5::timestamptz, CURRENT_TIMESTAMP + INTERVAL '30 seconds')
               ELSE NULL END,
             error_code = $6, error_details = $7::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND claim_token = $2::uuid`,
        [jobId, claimToken, mayRetry ? "failed" : terminalStatus, mayRetry,
          mayRetry ? nextAttemptAt : null, String(errorCode || "ENTRY_HISTORY_FAILED").slice(0, 80),
          errorDetails ? JSON.stringify(errorDetails) : null],
      );
      if (!mayRetry) await repository.completeEntryOverviewBackfillRunIfIdle(job.run_id);
      return { id: Number(job.read_id), status: mayRetry ? "failed" : terminalStatus, retryable: mayRetry };
    });
  }

  async completeEntryOverviewBackfillRunIfIdle(runId) {
    const result = await this.pool.query(
      `UPDATE public.vehicle_entry_overview_backfill_runs runs
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE runs.id = $1 AND runs.status IN ('running','paused')
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_entry_overview_backfill_jobs jobs
           WHERE jobs.run_id = runs.id
             AND jobs.status IN ('previewed','queued','processing')
             AND jobs.daylight_status IN ('eligible','needs_preflight')
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_entry_overview_backfill_jobs jobs
           WHERE jobs.run_id = runs.id AND jobs.status = 'failed' AND jobs.retryable = TRUE
         )
       RETURNING id`,
      [runId],
    );
    return result.rows?.[0] || null;
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
          overviewContext: deleted.overview_context,
          sourceCameraShortName: deleted.source_camera_short_name,
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
           AND COALESCE(NULLIF(LOWER(BTRIM(reads.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
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
           AND COALESCE(NULLIF(LOWER(BTRIM(reads.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
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
           AND COALESCE(NULLIF(LOWER(BTRIM(source.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
           AND target.vehicle_image_selection_metadata->>'profileId' = sharing.target_profile_id::text
           AND target.vehicle_image_selection_metadata->>'profileRevision' = sharing.target_profile_revision::text
           AND COALESCE(NULLIF(LOWER(BTRIM(target.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
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
           AND COALESCE(NULLIF(LOWER(BTRIM(source.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
           AND target.vehicle_image_selection_metadata->>'profileId' = sharing.target_profile_id::text
           AND target.vehicle_image_selection_metadata->>'profileRevision' = sharing.target_profile_revision::text
           AND COALESCE(NULLIF(LOWER(BTRIM(target.vehicle_image_selection_metadata->>'overviewContext')), ''), 'street') = 'street'
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
         COUNT(*) FILTER (WHERE vehicle_image_source_kind = 'overview_primary')::integer AS street_ready,
         COUNT(*) FILTER (WHERE vehicle_image_source_kind = 'entry_overview_primary')::integer AS entry_ready,
         MIN("timestamp") FILTER (WHERE vehicle_image_status IN ('pending','processing')) AS oldest_outstanding_at
       FROM public.plate_reads
       WHERE vehicle_image_queue_kind = 'overview'
          OR vehicle_image_source_kind IN ('overview_primary','entry_overview_primary')
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
                reads.vehicle_image_source_kind, reads.vehicle_image_selection_metadata,
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
            OR reads.vehicle_image_source_kind IN ('overview_primary','entry_overview_primary')
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
      byContext: {
        streetReady: Number(row.street_ready || 0),
        entryReady: Number(row.entry_ready || 0),
      },
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
      recentJobs: (recent.rows || []).map((item) => {
        const selectionMetadata = jsonObject(item.vehicle_image_selection_metadata);
        return {
          readId: Number(item.read_id),
          plateNumber: item.plate_number,
          cameraName: item.camera_name,
          readTimestamp: item.read_timestamp,
          readStatus: item.vehicle_image_status,
          attemptCount: Number(item.vehicle_image_attempt_count || 0),
          recoveryCount: Number(item.vehicle_image_recovery_count || 0),
          readErrorCode: item.vehicle_image_error_code,
          sourceKind: item.vehicle_image_source_kind,
          overviewContext: selectionMetadata.overviewContext
            || (item.vehicle_image_source_kind === "entry_overview_primary" ? "entry" : "street"),
          sourceCameraName: selectionMetadata.sourceCameraName || null,
          sourceCameraId: selectionMetadata.sourceCameraId || null,
          profileRevision: selectionMetadata.profileRevision == null
            ? null
            : Number(selectionMetadata.profileRevision),
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
        };
      }),
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
                profile.source_camera_short_name AS overview_source_camera_short_name,
                profile.expected_delta_ms AS overview_expected_delta_ms,
                 profile.tolerance_ms AS overview_tolerance_ms,
                  profile.priority AS overview_profile_priority,
                  profile.revision AS overview_profile_revision,
                  profile.overview_context AS overview_context,
                  profile.match_count AS overview_profile_match_count,
                  profile.updated_at AS overview_profile_updated_at
         FROM public.plate_reads reads
         LEFT JOIN LATERAL (
             SELECT id, source_camera_name, source_camera_short_name,
                    expected_delta_ms, tolerance_ms, priority, revision,
                    overview_context, COUNT(*) OVER()::integer AS match_count,
                    updated_at
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
                   candidate.overview_source_camera_short_name,
                   candidate.overview_expected_delta_ms, candidate.overview_tolerance_ms,
                   candidate.overview_profile_priority, candidate.overview_profile_revision,
                   candidate.overview_context, candidate.overview_profile_match_count,
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

  async terminalizeExpiredEntryOverviewBackfillJobs({ limit = 500 } = {}) {
    const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 500));
    return this.withTransaction(async (repository) => {
      const result = await repository.pool.query(
        `WITH expired_jobs AS MATERIALIZED (
           SELECT jobs.*
           FROM public.vehicle_entry_overview_backfill_jobs jobs
           JOIN public.vehicle_entry_overview_backfill_runs runs ON runs.id = jobs.run_id
           WHERE jobs.status = 'processing'
             AND jobs.attempt_count >= 2
             AND runs.status IN ('running','paused')
             AND COALESCE(
               jobs.hard_deadline_at, jobs.processing_deadline_at,
               jobs.updated_at + INTERVAL '5 minutes'
             ) <= CURRENT_TIMESTAMP
           ORDER BY jobs.read_timestamp, jobs.id
           FOR UPDATE OF jobs SKIP LOCKED
           LIMIT $1
         ), restored_reads AS (
           UPDATE public.plate_reads reads
           SET vehicle_image_path = jobs.prior_image_path,
               vehicle_image_status = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN 'failed'
                 ELSE jobs.prior_image_status
               END,
               vehicle_image_queue_kind = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN NULL
                 ELSE jobs.prior_queue_kind
               END,
               vehicle_image_attempt_count = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN jobs.attempt_count
                 ELSE COALESCE(jobs.prior_attempt_count, 0)
               END,
               vehicle_image_retryable = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN FALSE
                 ELSE COALESCE(jobs.prior_retryable, TRUE)
               END,
               vehicle_image_error_code = CASE
                 WHEN NULLIF(BTRIM(COALESCE(jobs.prior_image_path, '')), '') IS NULL
                   THEN 'ENTRY_HISTORY_PROCESSING_DEADLINE'
                 ELSE jobs.prior_error_code
               END,
               vehicle_image_source_kind = jobs.prior_source_kind,
               vehicle_overview_candidate_id = jobs.prior_overview_candidate_id,
               vehicle_image_source_read_id = jobs.prior_source_read_id,
               vehicle_image_timestamp = jobs.prior_image_timestamp,
               vehicle_image_score = jobs.prior_image_score,
               vehicle_image_detection_confidence = jobs.prior_detection_confidence,
               vehicle_image_detection_box = jobs.prior_detection_box,
               vehicle_image_width = jobs.prior_image_width,
               vehicle_image_height = jobs.prior_image_height,
               vehicle_image_sampled_count = jobs.prior_sampled_count,
               vehicle_image_selection_metadata = jobs.prior_selection_metadata,
               vehicle_image_backfill_job_id = NULL,
               vehicle_image_claim_token = NULL,
               vehicle_image_next_attempt_at = NULL,
               vehicle_image_heartbeat_at = NULL,
               vehicle_image_processing_deadline_at = NULL,
               vehicle_image_hard_deadline_at = NULL,
               vehicle_image_updated_at = CURRENT_TIMESTAMP
           FROM expired_jobs jobs
           WHERE reads.id = jobs.read_id
             AND reads.vehicle_image_backfill_job_id = jobs.id
             AND reads.vehicle_image_status = 'processing'
             AND reads.vehicle_image_queue_kind = 'overview_backfill'
             AND reads.vehicle_image_attempt_count = jobs.attempt_count
             AND reads.vehicle_image_retryable = TRUE
             AND reads.vehicle_image_error_code IS NULL
             AND reads.vehicle_image_claim_token IS NOT DISTINCT FROM jobs.claim_token
             AND COALESCE(
               reads.vehicle_image_hard_deadline_at,
               reads.vehicle_image_processing_deadline_at,
               reads.vehicle_image_updated_at + INTERVAL '5 minutes'
             ) <= CURRENT_TIMESTAMP
             AND reads.vehicle_image_path IS NOT DISTINCT FROM jobs.prior_image_path
             AND reads.vehicle_image_source_kind IS NOT DISTINCT FROM jobs.prior_source_kind
             AND reads.vehicle_overview_candidate_id IS NOT DISTINCT FROM jobs.prior_overview_candidate_id
             AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM jobs.prior_source_read_id
             AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM jobs.prior_image_timestamp
             AND reads.vehicle_image_score IS NOT DISTINCT FROM jobs.prior_image_score
             AND reads.vehicle_image_detection_confidence IS NOT DISTINCT FROM jobs.prior_detection_confidence
             AND reads.vehicle_image_detection_box IS NOT DISTINCT FROM jobs.prior_detection_box
             AND reads.vehicle_image_width IS NOT DISTINCT FROM jobs.prior_image_width
             AND reads.vehicle_image_height IS NOT DISTINCT FROM jobs.prior_image_height
             AND reads.vehicle_image_sampled_count IS NOT DISTINCT FROM jobs.prior_sampled_count
             AND reads.vehicle_image_selection_metadata IS NOT DISTINCT FROM jobs.prior_selection_metadata
           RETURNING jobs.id AS job_id
         )
         UPDATE public.vehicle_entry_overview_backfill_jobs jobs
         SET status = CASE WHEN restored_reads.job_id IS NULL THEN 'superseded' ELSE 'failed' END,
             retryable = FALSE, claim_token = NULL, heartbeat_at = NULL,
             processing_deadline_at = NULL, hard_deadline_at = NULL,
             next_attempt_at = NULL,
             error_code = CASE WHEN restored_reads.job_id IS NULL
               THEN 'ENTRY_HISTORY_SOURCE_CHANGED'
               ELSE 'ENTRY_HISTORY_PROCESSING_DEADLINE' END,
             error_details = jsonb_build_object('reason', 'retry_limit_exhausted'),
             updated_at = CURRENT_TIMESTAMP
         FROM expired_jobs
         LEFT JOIN restored_reads ON restored_reads.job_id = expired_jobs.id
         WHERE jobs.id = expired_jobs.id
         RETURNING jobs.run_id, jobs.status`,
        [boundedLimit],
      );
      const runIds = [...new Set((result.rows || []).map((row) => Number(row.run_id)))];
      for (const runId of runIds) {
        await repository.completeEntryOverviewBackfillRunIfIdle(runId);
      }
      return {
        terminalized: (result.rows || []).filter((row) => row.status === "failed").length,
        superseded: (result.rows || []).filter((row) => row.status === "superseded").length,
      };
    });
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
    if (isEntryHistoryPlateCamera(cameraName)) {
      throw new Error(
        "Entry LPR history must use the dedicated Entry Overview (Cam143) backfill."
      );
    }
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
          AND LOWER(BTRIM(camera_name)) NOT IN ('entry lpr 1','entry lpr 2')
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
               'OVERVIEW_PROFILE_CHANGED','OVERVIEW_PROFILE_NOT_CONFIGURED',
               'OVERVIEW_PROFILE_AMBIGUOUS','OVERVIEW_CAMERA_BINDING_INVALID',
               'OVERVIEW_CAMERA_BINDING_MISMATCH','CAMERA_NOT_MAPPED',
               'EXPORT_TIMEOUT','EXPORT_UNAVAILABLE',
               'EXPORT_FAILED','EXPORT_DURATION_TOO_SHORT','EXPORT_PROBE_INVALID',
               'EXPORT_FRAME_COUNT_INVALID','EXPORT_INVALID',
               'MEDIA_TOOL_TIMEOUT','MEDIA_TOOL_FAILED','HTTP_ERROR','CONNECTION_FAILED',
               'BLUE_IRIS_INITIALIZATION_FAILED'
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
    profileKind = null,
    profileIdentity = null,
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
           pair_profile_id = COALESCE(pair_profile_id, $7::bigint),
           profile_revision = COALESCE(profile_revision, $8::bigint),
           algorithm_revision = COALESCE(algorithm_revision, $9),
           profile_kind = COALESCE(profile_kind, $11),
           profile_identity = COALESCE(profile_identity, $12),
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
        profileKind,
        profileIdentity,
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
         pair_profile_id, profile_revision, algorithm_revision,
         profile_kind, profile_identity
       ) SELECT
         $1::uuid,$2,$3,$4::uuid,$5,$6::timestamptz,$7,'starting',
         COALESCE($8::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
         $9::bigint,$10::bigint,$11,$12,$13
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
        profileKind,
        profileIdentity,
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
           pair_profile_id = COALESCE(pair_profile_id, $5::bigint),
           profile_revision = COALESCE(profile_revision, $6::bigint),
           algorithm_revision = COALESCE(algorithm_revision, $7),
           profile_kind = COALESCE(profile_kind, $8),
           profile_identity = COALESCE(profile_identity, $9),
           hard_deadline_at = GREATEST(
             hard_deadline_at,
             COALESCE($3::timestamptz, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
           ),
           updated_at = CURRENT_TIMESTAMP
       FROM active_read
       WHERE exports.export_key = $1
       RETURNING exports.*`,
      [normalizedExportKey, claimToken, hardDeadlineAt, readId,
        pairProfileId, profileRevision, algorithmRevision, profileKind, profileIdentity]
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
