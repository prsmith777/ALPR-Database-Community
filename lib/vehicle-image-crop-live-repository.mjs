import {
  VEHICLE_IMAGE_CROP_ALGORITHM,
  VEHICLE_IMAGE_CROP_KIND,
} from "./vehicle-image-crop.mjs";

const ACTIVE_CAMPAIGN_STATUSES = Object.freeze(["previewing", "ready", "running", "paused"]);
const RETRY_LIMIT = 5;
const OPERATOR_RETRY_LIMIT = 1;
const CLAIM_SECONDS = 120;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function safeErrorDetails(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const details = {};
  for (const key of ["message", "reason"]) {
    const text = String(source[key] || "").trim();
    if (text) details[key] = text.slice(0, 500);
  }
  return details;
}

function activationState({ enabled, completed_campaign: completed, active_campaign: active } = {}) {
  if (enabled !== true) return "disabled";
  if (completed !== true) return "waiting_for_initial_campaign";
  if (active === true) return "paused_for_operator_campaign";
  return "active";
}

function currentLinkPredicate(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

const ACTIVATION_SQL = `
  SELECT
    COALESCE((SELECT enabled
      FROM public.vehicle_image_crop_live_control
      WHERE singleton = TRUE), FALSE) AS enabled,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_crop_runs
      WHERE status = 'completed'
    ) AS completed_campaign,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_crop_runs
      WHERE status = ANY($1::text[])
    ) AS active_campaign`;

export class VehicleImageCropLiveRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("Automatic vehicle crops require a database pool");
    }
    this.pool = pool;
  }

  async withTransaction(operation) {
    const ownsClient = typeof this.pool.connect === "function";
    const client = ownsClient ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleImageCropLiveRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async recordAudit({ actorUserId, eventType, resourceId = "singleton", metadata = {} }) {
    await this.pool.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata
       ) VALUES ($1, 'browser', $2, 'vehicle_image_crop_live', $3,
         'succeeded', $4::jsonb)`,
      [positiveInteger(actorUserId, "Actor user id"), eventType, String(resourceId),
        JSON.stringify(metadata)]
    );
  }

  async getActivation() {
    const result = await this.pool.query(ACTIVATION_SQL, [ACTIVE_CAMPAIGN_STATUSES]);
    const row = result.rows?.[0] || {};
    return {
      enabled: row.enabled === true,
      completedCampaign: row.completed_campaign === true,
      activeCampaign: row.active_campaign === true,
      state: activationState(row),
    };
  }

  async setEnabled({ enabled, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    const requested = enabled === true;
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-crop-mode-control'))"
      );
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-crop-live-control'))"
      );
      if (requested) {
        const gate = await repository.pool.query(
          `SELECT
             EXISTS (SELECT 1 FROM public.vehicle_image_crop_runs
               WHERE status = 'completed') AS completed,
             EXISTS (SELECT 1 FROM public.vehicle_image_crop_runs
               WHERE status = ANY($1::text[])) AS active`,
          [ACTIVE_CAMPAIGN_STATUSES]
        );
        if (gate.rows?.[0]?.completed !== true) {
          throw new Error(
            "Complete the initial vehicle crop campaign before enabling automatic cropping."
          );
        }
        if (gate.rows?.[0]?.active === true) {
          throw new Error(
            "Wait for the active vehicle crop campaign to finish before enabling automatic cropping."
          );
        }
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_crop_live_control
         SET enabled = $1, enabled_by_user_id = $2,
             enabled_at = CASE WHEN $1 THEN CURRENT_TIMESTAMP ELSE enabled_at END,
             disabled_at = CASE WHEN $1 THEN NULL ELSE CURRENT_TIMESTAMP END,
             updated_at = CURRENT_TIMESTAMP
         WHERE singleton = TRUE`,
        [requested, actorId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: requested
          ? "maintenance.vehicle_image_crop_live_enabled"
          : "maintenance.vehicle_image_crop_live_disabled",
        metadata: {
          enabled: requested,
          reidChanged: false,
          externalProviderContacted: false,
        },
      });
      return repository.getActivation();
    });
  }

  async materializeCandidates({ limit = 25 } = {}) {
    const bounded = Math.min(250, Math.max(1, Number.parseInt(String(limit), 10) || 25));
    const result = await this.pool.query(
      `WITH activation AS (
         ${ACTIVATION_SQL}
       ), candidates AS (
         SELECT assets.id AS asset_id, assets.content_sha256, assets.storage_path,
                assets.image_width, assets.image_height,
                evidence.read_id, evidence.source_kind,
                evidence.source_path_snapshot, evidence.source_updated_at,
                evidence.detection_box, evidence.detection_confidence
         FROM public.vehicle_image_assets assets
         JOIN LATERAL (
           SELECT links.read_id, links.source_kind, links.source_path_snapshot,
                  links.source_updated_at, links.detection_box,
                  links.detection_confidence
           FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE links.asset_id = assets.id
             AND ${currentLinkPredicate()}
           ORDER BY links.detection_confidence DESC NULLS LAST, links.read_id ASC
           LIMIT 1
         ) evidence ON TRUE
         LEFT JOIN public.vehicle_image_derivatives derivatives
           ON derivatives.asset_id = assets.id
          AND derivatives.derivative_kind = $2
          AND derivatives.algorithm_version = $3
         LEFT JOIN public.vehicle_image_crop_live_jobs jobs
           ON jobs.asset_id = assets.id
         CROSS JOIN activation
         WHERE activation.enabled = TRUE
           AND activation.completed_campaign = TRUE
           AND activation.active_campaign = FALSE
           AND derivatives.id IS NULL
           AND (
             jobs.id IS NULL
             OR (jobs.status <> 'processing' AND (
               jobs.source_sha256 IS DISTINCT FROM assets.content_sha256
               OR jobs.source_path IS DISTINCT FROM assets.storage_path
               OR jobs.source_width IS DISTINCT FROM assets.image_width
               OR jobs.source_height IS DISTINCT FROM assets.image_height
               OR jobs.evidence_read_id IS DISTINCT FROM evidence.read_id
               OR jobs.evidence_source_kind IS DISTINCT FROM evidence.source_kind
               OR jobs.evidence_source_path IS DISTINCT FROM evidence.source_path_snapshot
               OR jobs.evidence_source_updated_at IS DISTINCT FROM evidence.source_updated_at
               OR jobs.detection_box IS DISTINCT FROM evidence.detection_box
               OR jobs.detection_confidence IS DISTINCT FROM evidence.detection_confidence
               OR jobs.status IN ('ready','already_current')
             ))
           )
         ORDER BY assets.id
         LIMIT $4
       )
       INSERT INTO public.vehicle_image_crop_live_jobs (
         asset_id, source_sha256, source_path, source_width, source_height,
         evidence_read_id, evidence_source_kind, evidence_source_path,
         evidence_source_updated_at, detection_box, detection_confidence,
         status, attempt_count, operator_retry_count, retryable
       )
       SELECT asset_id, content_sha256, storage_path, image_width, image_height,
              read_id, source_kind, source_path_snapshot, source_updated_at,
              detection_box, detection_confidence, 'queued', 0, 0, TRUE
       FROM candidates
       ON CONFLICT (asset_id) DO UPDATE
       SET source_sha256 = EXCLUDED.source_sha256,
           source_path = EXCLUDED.source_path,
           source_width = EXCLUDED.source_width,
           source_height = EXCLUDED.source_height,
           evidence_read_id = EXCLUDED.evidence_read_id,
           evidence_source_kind = EXCLUDED.evidence_source_kind,
           evidence_source_path = EXCLUDED.evidence_source_path,
           evidence_source_updated_at = EXCLUDED.evidence_source_updated_at,
           detection_box = EXCLUDED.detection_box,
           detection_confidence = EXCLUDED.detection_confidence,
           status = 'queued', attempt_count = 0, operator_retry_count = 0,
           retryable = TRUE, claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL, next_attempt_at = NULL,
           error_code = NULL, error_details = NULL, derivative_id = NULL,
           completed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_crop_live_jobs.status <> 'processing'
         AND (
           vehicle_image_crop_live_jobs.source_sha256
               IS DISTINCT FROM EXCLUDED.source_sha256
          OR vehicle_image_crop_live_jobs.source_path
               IS DISTINCT FROM EXCLUDED.source_path
          OR vehicle_image_crop_live_jobs.source_width
               IS DISTINCT FROM EXCLUDED.source_width
          OR vehicle_image_crop_live_jobs.source_height
               IS DISTINCT FROM EXCLUDED.source_height
          OR vehicle_image_crop_live_jobs.evidence_read_id
               IS DISTINCT FROM EXCLUDED.evidence_read_id
          OR vehicle_image_crop_live_jobs.evidence_source_kind
               IS DISTINCT FROM EXCLUDED.evidence_source_kind
          OR vehicle_image_crop_live_jobs.evidence_source_path
               IS DISTINCT FROM EXCLUDED.evidence_source_path
          OR vehicle_image_crop_live_jobs.evidence_source_updated_at
               IS DISTINCT FROM EXCLUDED.evidence_source_updated_at
          OR vehicle_image_crop_live_jobs.detection_box
               IS DISTINCT FROM EXCLUDED.detection_box
          OR vehicle_image_crop_live_jobs.detection_confidence
               IS DISTINCT FROM EXCLUDED.detection_confidence
          OR vehicle_image_crop_live_jobs.status IN ('ready','already_current')
         )
       RETURNING id`,
      [ACTIVE_CAMPAIGN_STATUSES, VEHICLE_IMAGE_CROP_KIND,
        VEHICLE_IMAGE_CROP_ALGORITHM, bounded]
    );
    return Number(result.rowCount || 0);
  }

  async reclaimExpiredClaims() {
    const result = await this.pool.query(
      `UPDATE public.vehicle_image_crop_live_jobs
       SET status = 'failed', retryable = attempt_count < $1,
           error_code = 'VEHICLE_IMAGE_CROP_LIVE_CLAIM_EXPIRED',
           error_details = '{"message":"Automatic crop claim expired before completion"}'::jsonb,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN attempt_count < $1
             THEN CURRENT_TIMESTAMP + INTERVAL '5 seconds' ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'processing'
         AND processing_deadline_at < CURRENT_TIMESTAMP
       RETURNING id`,
      [RETRY_LIMIT]
    );
    return Number(result.rowCount || 0);
  }

  async claimNext() {
    return this.withTransaction(async (repository) => {
      const result = await repository.pool.query(
        `WITH activation AS (
           ${ACTIVATION_SQL}
         ), candidate AS (
           SELECT jobs.id
           FROM public.vehicle_image_crop_live_jobs jobs
           CROSS JOIN activation
           WHERE activation.enabled = TRUE
             AND activation.completed_campaign = TRUE
             AND activation.active_campaign = FALSE
             AND (
               jobs.status = 'queued'
               OR (jobs.status = 'failed' AND jobs.retryable = TRUE
                 AND jobs.attempt_count < $2
                 AND (jobs.next_attempt_at IS NULL
                   OR jobs.next_attempt_at <= CURRENT_TIMESTAMP))
             )
           ORDER BY jobs.asset_id, jobs.id
           FOR UPDATE OF jobs SKIP LOCKED
           LIMIT 1
         )
         UPDATE public.vehicle_image_crop_live_jobs jobs
         SET status = 'processing', attempt_count = attempt_count + 1,
             retryable = FALSE, error_code = NULL, error_details = NULL,
             claim_token = gen_random_uuid(), heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP
               + ($3 || ' seconds')::interval,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate WHERE jobs.id = candidate.id
         RETURNING jobs.*,
           jobs.evidence_source_updated_at::text AS evidence_source_updated_at_exact`,
        [ACTIVE_CAMPAIGN_STATUSES, RETRY_LIMIT, CLAIM_SECONDS]
      );
      return result.rows?.[0] || null;
    });
  }

  async completeJob(job, result) {
    const status = result.derivativeCreated ? "ready" : "already_current";
    const updated = await this.pool.query(
      `UPDATE public.vehicle_image_crop_live_jobs
       SET status = $3, retryable = FALSE, claim_token = NULL,
           heartbeat_at = NULL, processing_deadline_at = NULL,
           next_attempt_at = NULL, error_code = NULL, error_details = NULL,
           derivative_id = $4, completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2::uuid AND status = 'processing'
       RETURNING id`,
      [job.id, job.claim_token, status, result.derivative.id]
    );
    return updated.rowCount === 1;
  }

  async failClaimedJob(job, {
    status = "failed",
    errorCode,
    errorDetails = {},
    retryable = false,
  } = {}) {
    const canRetry = status === "failed"
      && retryable === true
      && Number(job.attempt_count) < RETRY_LIMIT;
    const updated = await this.pool.query(
      `UPDATE public.vehicle_image_crop_live_jobs
       SET status = $3, retryable = $4, error_code = $5,
           error_details = $6::jsonb, claim_token = NULL,
           heartbeat_at = NULL, processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP
             + (LEAST(60, POWER(2, attempt_count)) || ' seconds')::interval
             ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2::uuid AND status = 'processing'
       RETURNING id`,
      [job.id, job.claim_token, status, canRetry,
        String(errorCode || "VEHICLE_IMAGE_CROP_LIVE_FAILED").slice(0, 80),
        JSON.stringify(safeErrorDetails(errorDetails))]
    );
    return updated.rowCount === 1;
  }

  async retryJob({ jobId, actorUserId }) {
    const id = positiveInteger(jobId, "Automatic crop job id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const selected = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_crop_live_jobs
         WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const job = selected.rows?.[0] || null;
      if (!job || !["failed", "unavailable"].includes(job.status)
        || job.retryable === true) {
        throw new Error("Only a terminal automatic vehicle crop failure can be retried.");
      }
      if (Number(job.operator_retry_count) >= OPERATOR_RETRY_LIMIT) {
        throw new Error("This automatic vehicle crop is not eligible for another manual retry.");
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_crop_live_jobs
         SET status = 'queued', attempt_count = 0,
             operator_retry_count = operator_retry_count + 1,
             retryable = TRUE, claim_token = NULL, heartbeat_at = NULL,
             processing_deadline_at = NULL, next_attempt_at = NULL,
             error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_crop_live_item_retried",
        resourceId: id,
        metadata: {
          assetId: Number(job.asset_id),
          externalProviderContacted: false,
        },
      });
      return { jobId: id, assetId: Number(job.asset_id) };
    });
  }

  async getOverview() {
    const [activation, counts, retry] = await Promise.all([
      this.getActivation(),
      this.pool.query(
        `WITH eligible AS (
           SELECT DISTINCT links.asset_id
           FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE ${currentLinkPredicate()}
         ), pending AS (
           SELECT eligible.asset_id FROM eligible
           WHERE NOT EXISTS (
             SELECT 1 FROM public.vehicle_image_derivatives derivatives
             WHERE derivatives.asset_id = eligible.asset_id
               AND derivatives.derivative_kind = $1
               AND derivatives.algorithm_version = $2
           )
         )
         SELECT
           COUNT(*)::bigint AS total_jobs,
           COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
           COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
           COUNT(*) FILTER (WHERE status = 'ready')::bigint AS ready,
           COUNT(*) FILTER (WHERE status = 'already_current')::bigint AS already_current,
           COUNT(*) FILTER (WHERE status = 'source_changed')::bigint AS source_changed,
           COUNT(*) FILTER (WHERE status = 'unavailable')::bigint AS unavailable,
           COUNT(*) FILTER (WHERE status = 'invalid')::bigint AS invalid,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           COUNT(*) FILTER (WHERE retryable = TRUE)::bigint AS retryable,
           MAX(completed_at) AS last_completed_at,
           (SELECT COUNT(*)::bigint FROM pending) AS pending_eligible
         FROM public.vehicle_image_crop_live_jobs`,
        [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      ),
      this.pool.query(
        `SELECT id, asset_id, error_code, operator_retry_count
         FROM public.vehicle_image_crop_live_jobs
         WHERE status IN ('failed','unavailable')
           AND retryable = FALSE
           AND operator_retry_count < $1
         ORDER BY updated_at DESC, id DESC LIMIT 25`,
        [OPERATOR_RETRY_LIMIT]
      ),
    ]);
    return {
      ...activation,
      counts: counts.rows?.[0] || {},
      retryCandidates: retry.rows || [],
    };
  }
}

export const vehicleImageCropLiveRepositoryInternals = Object.freeze({
  ACTIVE_CAMPAIGN_STATUSES,
  RETRY_LIMIT,
  OPERATOR_RETRY_LIMIT,
  CLAIM_SECONDS,
  ACTIVATION_SQL,
  activationState,
  currentLinkPredicate,
});
