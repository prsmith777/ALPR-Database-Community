import { OVERVIEW_ASSET_SOURCE_KINDS } from "./vehicle-image-asset-model.mjs";

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
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const safe = {};
  for (const key of ["message", "reason"]) {
    const text = String(object[key] || "").trim();
    if (text) safe[key] = text.slice(0, 500);
  }
  return safe;
}

function activationState({ enabled, completed_campaign: completedCampaign, active_campaign: activeCampaign } = {}) {
  if (enabled !== true) return "disabled";
  if (completedCampaign !== true) return "waiting_for_initial_campaign";
  if (activeCampaign === true) return "paused_for_operator_campaign";
  return "active";
}

const ACTIVATION_SQL = `
  SELECT
    COALESCE((SELECT enabled
      FROM public.vehicle_image_asset_live_catalog_control
      WHERE singleton = TRUE), FALSE) AS enabled,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_asset_catalog_runs
      WHERE status = 'completed' AND phase = 'completed'
    ) AS completed_campaign,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_asset_catalog_runs
      WHERE status = ANY($1::text[])
    ) AS active_campaign`;

function activationSql(statusParameter = "$1") {
  return ACTIVATION_SQL.replace("$1::text[]", `${statusParameter}::text[]`);
}

const CURRENT_CANDIDATE_PREDICATE = `
  reads.vehicle_image_status = 'ready'
  AND NULLIF(BTRIM(reads.vehicle_image_path), '') IS NOT NULL
  AND reads.vehicle_image_source_kind = ANY($1::text[])
  AND (
    links.read_id IS NULL
    OR reads.vehicle_image_path IS DISTINCT FROM links.source_path_snapshot
    OR reads.vehicle_image_source_kind IS DISTINCT FROM links.source_kind
    OR reads.vehicle_image_updated_at IS DISTINCT FROM links.source_updated_at
  )`;

export class VehicleImageAssetLiveCatalogRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("Automatic canonical Overview catalog requires a database pool");
    }
    this.pool = pool;
  }

  async withTransaction(operation) {
    const ownsClient = typeof this.pool.connect === "function";
    const client = ownsClient ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleImageAssetLiveCatalogRepository(client));
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
       ) VALUES ($1, 'browser', $2, 'vehicle_image_asset_live_catalog', $3,
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
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-asset-live-catalog-control'))"
      );
      if (requested) {
        const completed = await repository.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM public.vehicle_image_asset_catalog_runs
             WHERE status = 'completed' AND phase = 'completed'
           ) AS completed`
        );
        if (completed.rows?.[0]?.completed !== true) {
          throw new Error(
            "Complete the initial canonical Overview campaign before enabling automatic cataloging."
          );
        }
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_live_catalog_control
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
          ? "maintenance.vehicle_image_asset_live_catalog_enabled"
          : "maintenance.vehicle_image_asset_live_catalog_disabled",
        metadata: { enabled: requested, externalProviderContacted: false },
      });
      return repository.getActivation();
    });
  }

  async materializeCandidates({ limit = 100 } = {}) {
    const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 100));
    const result = await this.pool.query(
      `WITH activation AS (
         ${activationSql("$2")}
       ), candidates AS (
         SELECT reads.id, reads.vehicle_image_path,
                reads.vehicle_image_source_kind, reads.vehicle_image_updated_at
         FROM public.plate_reads reads
         LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
         LEFT JOIN public.vehicle_image_asset_live_catalog_jobs jobs
           ON jobs.read_id = reads.id
         CROSS JOIN activation
         WHERE activation.enabled = TRUE
           AND activation.completed_campaign = TRUE
           AND activation.active_campaign = FALSE
           AND ${CURRENT_CANDIDATE_PREDICATE}
           AND (
             jobs.id IS NULL
             OR jobs.source_path_snapshot IS DISTINCT FROM reads.vehicle_image_path
             OR jobs.source_kind_snapshot IS DISTINCT FROM reads.vehicle_image_source_kind
             OR jobs.source_updated_at_snapshot IS DISTINCT FROM reads.vehicle_image_updated_at
             OR jobs.status = 'cataloged'
           )
         ORDER BY reads.id
         LIMIT $3
       )
       INSERT INTO public.vehicle_image_asset_live_catalog_jobs (
         read_id, source_path_snapshot, source_kind_snapshot,
         source_updated_at_snapshot, status, attempt_count,
         operator_retry_count, retryable
       )
       SELECT id, vehicle_image_path, vehicle_image_source_kind,
              vehicle_image_updated_at, 'queued', 0, 0, TRUE
       FROM candidates
       ON CONFLICT (read_id) DO UPDATE
       SET source_path_snapshot = EXCLUDED.source_path_snapshot,
           source_kind_snapshot = EXCLUDED.source_kind_snapshot,
           source_updated_at_snapshot = EXCLUDED.source_updated_at_snapshot,
           status = 'queued', attempt_count = 0, operator_retry_count = 0,
           retryable = TRUE, claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL, next_attempt_at = NULL,
           error_code = NULL, error_details = NULL, asset_id = NULL,
           cataloged_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE vehicle_image_asset_live_catalog_jobs.source_path_snapshot
               IS DISTINCT FROM EXCLUDED.source_path_snapshot
          OR vehicle_image_asset_live_catalog_jobs.source_kind_snapshot
               IS DISTINCT FROM EXCLUDED.source_kind_snapshot
          OR vehicle_image_asset_live_catalog_jobs.source_updated_at_snapshot
               IS DISTINCT FROM EXCLUDED.source_updated_at_snapshot
          OR vehicle_image_asset_live_catalog_jobs.status = 'cataloged'
       RETURNING id`,
      [OVERVIEW_ASSET_SOURCE_KINDS, ACTIVE_CAMPAIGN_STATUSES, boundedLimit]
    );
    return Number(result.rowCount || 0);
  }

  async reclaimExpiredClaims() {
    const result = await this.pool.query(
      `UPDATE public.vehicle_image_asset_live_catalog_jobs
       SET status = 'failed', retryable = attempt_count < $1,
           error_code = 'LIVE_CATALOG_CLAIM_EXPIRED',
           error_details = '{"message":"Automatic catalog claim expired before completion"}'::jsonb,
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
      const claimed = await repository.pool.query(
        `WITH activation AS (
           ${ACTIVATION_SQL}
         ), candidate AS (
           SELECT jobs.id
           FROM public.vehicle_image_asset_live_catalog_jobs jobs
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
           ORDER BY jobs.read_id, jobs.id
           FOR UPDATE OF jobs SKIP LOCKED
           LIMIT 1
         )
         UPDATE public.vehicle_image_asset_live_catalog_jobs jobs
         SET status = 'processing', attempt_count = attempt_count + 1,
             retryable = FALSE, error_code = NULL, error_details = NULL,
             claim_token = gen_random_uuid(), heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP
               + ($3 || ' seconds')::interval,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate WHERE jobs.id = candidate.id
         RETURNING jobs.*,
           jobs.source_updated_at_snapshot::text AS source_updated_at_snapshot_exact`,
        [ACTIVE_CAMPAIGN_STATUSES, RETRY_LIMIT, CLAIM_SECONDS]
      );
      return claimed.rows?.[0] || null;
    });
  }

  async completeJob(job, result) {
    const updated = await this.pool.query(
      `UPDATE public.vehicle_image_asset_live_catalog_jobs
       SET status = 'cataloged', retryable = FALSE,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL, next_attempt_at = NULL,
           error_code = NULL, error_details = NULL, asset_id = $3,
           cataloged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'processing'
       RETURNING id`,
      [job.id, job.claim_token, result.asset?.id ?? null]
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
    const terminalStatus = status === "failed" ? "failed" : status;
    const updated = await this.pool.query(
      `UPDATE public.vehicle_image_asset_live_catalog_jobs
       SET status = $3, retryable = $4,
           error_code = $5, error_details = $6::jsonb,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP
             + (LEAST(60, POWER(2, attempt_count)) || ' seconds')::interval
             ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'processing'
       RETURNING id`,
      [job.id, job.claim_token, terminalStatus, canRetry,
        String(errorCode || "VEHICLE_IMAGE_ASSET_LIVE_CATALOG_FAILED").slice(0, 80),
        JSON.stringify(safeErrorDetails(errorDetails))]
    );
    return updated.rowCount === 1;
  }

  async retryJob({ jobId, actorUserId }) {
    const id = positiveInteger(jobId, "Automatic catalog job id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const selected = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_live_catalog_jobs
         WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const job = selected.rows?.[0] || null;
      if (!job || !["failed", "unavailable"].includes(job.status)
        || job.retryable === true) {
        throw new Error("Only a terminal automatic catalog failure can be retried.");
      }
      if (Number(job.operator_retry_count) >= OPERATOR_RETRY_LIMIT) {
        throw new Error("This automatic catalog item is not eligible for another manual retry.");
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_live_catalog_jobs
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
        eventType: "maintenance.vehicle_image_asset_live_catalog_item_retried",
        resourceId: id,
        metadata: { readId: Number(job.read_id), externalProviderContacted: false },
      });
      return { jobId: id, readId: Number(job.read_id) };
    });
  }

  async getOverview() {
    const [activation, countsResult, retryResult] = await Promise.all([
      this.getActivation(),
      this.pool.query(
        `WITH current_candidates AS (
           SELECT reads.id
           FROM public.plate_reads reads
           LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
           WHERE ${CURRENT_CANDIDATE_PREDICATE}
         )
         SELECT
           COUNT(*)::bigint AS total_jobs,
           COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
           COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
           COUNT(*) FILTER (WHERE status = 'cataloged')::bigint AS cataloged,
           COUNT(*) FILTER (WHERE status = 'superseded')::bigint AS superseded,
           COUNT(*) FILTER (WHERE status = 'unavailable')::bigint AS unavailable,
           COUNT(*) FILTER (WHERE status = 'invalid')::bigint AS invalid,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           COUNT(*) FILTER (WHERE retryable = TRUE)::bigint AS retryable,
           MAX(cataloged_at) AS last_cataloged_at,
           (SELECT COUNT(*)::bigint FROM current_candidates) AS pending_eligible
         FROM public.vehicle_image_asset_live_catalog_jobs`,
        [OVERVIEW_ASSET_SOURCE_KINDS]
      ),
      this.pool.query(
        `SELECT id, read_id, error_code, operator_retry_count
         FROM public.vehicle_image_asset_live_catalog_jobs
         WHERE status IN ('failed','unavailable')
           AND retryable = FALSE
           AND operator_retry_count < $1
         ORDER BY updated_at DESC, id DESC LIMIT 25`,
        [OPERATOR_RETRY_LIMIT]
      ),
    ]);
    return {
      ...activation,
      counts: countsResult.rows?.[0] || {},
      retryCandidates: retryResult.rows || [],
    };
  }
}

export const vehicleImageAssetLiveCatalogRepositoryInternals = Object.freeze({
  ACTIVE_CAMPAIGN_STATUSES,
  RETRY_LIMIT,
  OPERATOR_RETRY_LIMIT,
  CLAIM_SECONDS,
  ACTIVATION_SQL,
  activationSql,
  CURRENT_CANDIDATE_PREDICATE,
  activationState,
});
