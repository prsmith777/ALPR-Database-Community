import crypto from "node:crypto";

import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "./vehicle-asset-embedding-contract.mjs";
import {
  VEHICLE_IMAGE_CROP_ALGORITHM,
  VEHICLE_IMAGE_CROP_KIND,
} from "./vehicle-image-crop.mjs";

const ACTIVE_RUN_STATUSES = Object.freeze(["previewing", "ready", "running", "paused"]);
const CLAIM_SECONDS = 120;

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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function boundedBatch(value) {
  const number = Number.parseInt(String(value ?? 5), 10);
  if (![1, 5, 25, 250].includes(number)) {
    throw new Error("Embedding batches must contain 1, 5, 25, or 250 crops.");
  }
  return number;
}

function currentLinkPredicate(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

function jobSelection() {
  return `jobs.*, jobs.evidence_source_updated_at::text AS evidence_source_updated_at,
    runs.model_name, runs.algorithm_version`;
}

export class VehicleAssetEmbeddingRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("Vehicle asset embedding repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }

  query(text, values = []) { return (this.executor || this.pool).query(text, values); }

  async withTransaction(operation) {
    const ownsClient = !this.executor && typeof this.pool?.connect === "function";
    const client = ownsClient ? await this.pool.connect() : (this.executor || this.pool);
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleAssetEmbeddingRepository({ executor: client }));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async recordAudit({ actorUserId, eventType, runId = null, metadata = {} }) {
    await this.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata
       ) VALUES ($1, 'browser', $2, 'vehicle_asset_embedding', $3, 'succeeded', $4::jsonb)`,
      [actorUserId, eventType, runId == null ? null : String(runId), JSON.stringify(metadata)]
    );
  }

  async createPreview({ actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      await repository.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-asset-embedding-campaign'))"
      );
      const active = await repository.query(
        `SELECT id FROM public.vehicle_asset_embedding_runs
         WHERE status = ANY($1::text[])
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ACTIVE_RUN_STATUSES]
      );
      if (active.rows?.[0]) return repository.getRun(active.rows[0].id);
      const scope = await repository.query(
        `SELECT COALESCE(MAX(id), 0)::bigint AS max_derivative_id
         FROM public.vehicle_image_derivatives
         WHERE derivative_kind = $1 AND algorithm_version = $2`,
        [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      );
      const maxDerivativeId = Number(scope.rows?.[0]?.max_derivative_id || 0);
      const inserted = await repository.query(
        `INSERT INTO public.vehicle_asset_embedding_runs (
           status, max_derivative_id, model_name, algorithm_version, actor_user_id
         ) VALUES ('previewing',$1,$2,$3,$4) RETURNING id`,
        [maxDerivativeId, VEHICLE_ASSET_EMBEDDING_MODEL,
          VEHICLE_ASSET_EMBEDDING_ALGORITHM, actorId]
      );
      const runId = inserted.rows[0].id;
      await repository.query(
        `INSERT INTO public.vehicle_asset_embedding_jobs (
           run_id, derivative_id, asset_id, source_sha256, source_path,
           source_width, source_height, source_algorithm_version,
           evidence_read_id, evidence_source_kind, evidence_source_path,
           evidence_source_updated_at
         )
         SELECT $1, derivatives.id, derivatives.asset_id,
                derivatives.content_sha256, derivatives.storage_path,
                derivatives.image_width, derivatives.image_height,
                derivatives.algorithm_version, evidence.read_id,
                evidence.source_kind, evidence.source_path_snapshot,
                evidence.source_updated_at
         FROM public.vehicle_image_derivatives derivatives
         JOIN LATERAL (
           SELECT links.read_id, links.source_kind, links.source_path_snapshot,
                  links.source_updated_at
           FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE links.asset_id = derivatives.asset_id
             AND ${currentLinkPredicate()}
           ORDER BY links.read_id ASC LIMIT 1
         ) evidence ON TRUE
         WHERE derivatives.id <= $2
           AND derivatives.derivative_kind = $3
           AND derivatives.algorithm_version = $4
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_asset_embeddings embeddings
             WHERE embeddings.derivative_id = derivatives.id
               AND embeddings.model_name = $5
               AND embeddings.algorithm_version = $6
           )
         ORDER BY derivatives.id`,
        [runId, maxDerivativeId, VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM,
          VEHICLE_ASSET_EMBEDDING_MODEL, VEHICLE_ASSET_EMBEDDING_ALGORITHM]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_asset_embedding_preview_created",
        runId,
        metadata: {
          maxDerivativeId,
          modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
          algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
        },
      });
      return repository.getRun(runId);
    });
  }

  async getRun(runId) {
    const result = await this.query(
      "SELECT * FROM public.vehicle_asset_embedding_runs WHERE id = $1",
      [positiveInteger(runId, "Embedding run id")]
    );
    return result.rows?.[0] || null;
  }

  async getLatestRun() {
    const result = await this.query(
      "SELECT * FROM public.vehicle_asset_embedding_runs ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    return result.rows?.[0] || null;
  }

  async getOverview() {
    const latestRun = await this.getLatestRun();
    const [catalog, runCounts, retry] = await Promise.all([
      this.query(
        `WITH eligible AS (
           SELECT DISTINCT derivatives.id
           FROM public.vehicle_image_derivatives derivatives
           JOIN public.vehicle_image_asset_reads links
             ON links.asset_id = derivatives.asset_id
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE derivatives.derivative_kind = $1
             AND derivatives.algorithm_version = $2
             AND ${currentLinkPredicate()}
         )
         SELECT
           (SELECT COUNT(*) FROM eligible)::bigint AS eligible_crops,
           COUNT(*) FILTER (WHERE embeddings.model_name = $3
             AND embeddings.algorithm_version = $4)::bigint AS embedding_count,
           COALESCE(SUM(OCTET_LENGTH(embeddings.embedding)) FILTER (
             WHERE embeddings.model_name = $3 AND embeddings.algorithm_version = $4
           ), 0)::bigint AS embedding_bytes
         FROM public.vehicle_asset_embeddings embeddings`,
        [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM,
          VEHICLE_ASSET_EMBEDDING_MODEL, VEHICLE_ASSET_EMBEDDING_ALGORITHM]
      ),
      latestRun ? this.query(
        `SELECT
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE status = 'pending_preview')::bigint AS pending_preview,
           COUNT(*) FILTER (WHERE status = 'previewing')::bigint AS previewing,
           COUNT(*) FILTER (WHERE status = 'previewed')::bigint AS previewed,
           COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
           COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
           COUNT(*) FILTER (WHERE status = 'ready')::bigint AS ready,
           COUNT(*) FILTER (WHERE status = 'already_current')::bigint AS already_current,
           COUNT(*) FILTER (WHERE status = 'source_changed')::bigint AS source_changed,
           COUNT(*) FILTER (WHERE status = 'invalid')::bigint AS invalid,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           COUNT(*) FILTER (WHERE status = 'failed' AND retryable = TRUE)::bigint AS retryable
         FROM public.vehicle_asset_embedding_jobs WHERE run_id = $1`,
        [latestRun.id]
      ) : Promise.resolve({ rows: [{}] }),
      latestRun ? this.query(
        `SELECT id, derivative_id, asset_id, failure_stage, error_code,
                error_details, operator_retry_count
         FROM public.vehicle_asset_embedding_jobs
         WHERE run_id = $1 AND status = 'failed'
         ORDER BY updated_at DESC, id DESC LIMIT 25`,
        [latestRun.id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    return {
      catalog: catalog.rows?.[0] || {},
      latestRun,
      counts: runCounts.rows?.[0] || {},
      retryCandidates: retry.rows || [],
      modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
      algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
    };
  }

  async reclaimExpiredClaims() {
    const result = await this.query(
      `UPDATE public.vehicle_asset_embedding_jobs jobs
       SET status = CASE
             WHEN attempt_count >= 3 THEN 'failed'
             WHEN failure_stage = 'embed' THEN 'queued'
             ELSE 'pending_preview' END,
           claim_token = NULL, processing_deadline_at = NULL,
           retryable = attempt_count < 3,
           next_attempt_at = CASE WHEN attempt_count < 3
             THEN CURRENT_TIMESTAMP ELSE NULL END,
           error_code = CASE WHEN attempt_count >= 3
             THEN 'VEHICLE_ASSET_EMBEDDING_CLAIM_EXPIRED' ELSE NULL END,
           error_details = CASE WHEN attempt_count >= 3
             THEN jsonb_build_object('message', 'Crop embedding claim expired after its final automatic attempt.')
             ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       FROM public.vehicle_asset_embedding_runs runs
       WHERE runs.id = jobs.run_id
         AND runs.status IN ('previewing','running')
         AND jobs.status IN ('previewing','processing')
         AND jobs.processing_deadline_at < CURRENT_TIMESTAMP
       RETURNING jobs.id`
    );
    return Number(result.rowCount || 0);
  }

  async claim(stage) {
    const preview = stage === "preview";
    return this.withTransaction(async (repository) => {
      const claimed = await repository.query(
        `SELECT ${jobSelection()}
         FROM public.vehicle_asset_embedding_jobs jobs
         JOIN public.vehicle_asset_embedding_runs runs ON runs.id = jobs.run_id
         WHERE runs.status = $1
           AND (
             jobs.status = $2
             OR (jobs.status = 'failed' AND jobs.failure_stage = $3
               AND jobs.retryable = TRUE AND jobs.attempt_count < 3
               AND jobs.next_attempt_at <= CURRENT_TIMESTAMP)
           )
         ORDER BY jobs.derivative_id, jobs.id
         FOR UPDATE OF jobs SKIP LOCKED LIMIT 1`,
        [preview ? "previewing" : "running", preview ? "pending_preview" : "queued", stage]
      );
      const job = claimed.rows?.[0];
      if (!job) return null;
      const token = crypto.randomUUID();
      const updated = await repository.query(
        `UPDATE public.vehicle_asset_embedding_jobs
         SET status = $2, failure_stage = $3, attempt_count = attempt_count + 1,
             retryable = FALSE, claim_token = $4::uuid,
             processing_deadline_at = CURRENT_TIMESTAMP + make_interval(secs => $5),
             next_attempt_at = NULL, error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING id`,
        [job.id, preview ? "previewing" : "processing", stage, token, CLAIM_SECONDS]
      );
      return updated.rows?.[0] ? { ...job, status: preview ? "previewing" : "processing",
        failure_stage: stage, attempt_count: Number(job.attempt_count || 0) + 1,
        claim_token: token } : null;
    });
  }

  claimPreviewJob() { return this.claim("preview"); }
  claimEmbeddingJob() { return this.claim("embed"); }

  async completePreviewJob(job, preview) {
    const result = await this.query(
      `UPDATE public.vehicle_asset_embedding_jobs
       SET status = 'previewed', claim_token = NULL, processing_deadline_at = NULL,
           preview_embedding_sha256 = $3,
           preview_embedding_dimensions = $4, preview_embedding_bytes = $5,
           previewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'previewing' AND claim_token = $2::uuid
       RETURNING id`,
      [job.id, job.claim_token, preview.embeddingSha256,
        preview.embeddingDimensions, preview.embeddingBytes]
    );
    return Boolean(result.rows?.[0]);
  }

  async failJob(job, { stage, status, errorCode, message, retryable }) {
    const mayRetry = retryable === true && Number(job.attempt_count || 0) < 3;
    const finalStatus = mayRetry ? "failed" : status;
    await this.query(
      `UPDATE public.vehicle_asset_embedding_jobs
       SET status = $3, failure_stage = $4, retryable = $5,
           claim_token = NULL, processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN $5 THEN CURRENT_TIMESTAMP
             + make_interval(secs => GREATEST(5, attempt_count * 5)) ELSE NULL END,
           error_code = $6, error_details = $7::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2::uuid`,
      [job.id, job.claim_token, finalStatus, stage, mayRetry,
        String(errorCode || "VEHICLE_ASSET_EMBEDDING_FAILED").slice(0, 80),
        JSON.stringify({ message: String(message || "Crop embedding failed").slice(0, 500) })]
    );
  }

  async finalizePreview(runId) {
    return this.withTransaction(async (repository) => {
      const runResult = await repository.query(
        "SELECT * FROM public.vehicle_asset_embedding_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Embedding run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || run.status !== "previewing") return run || null;
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_asset_embedding_jobs
         WHERE run_id = $1 AND (
           status IN ('pending_preview','previewing')
           OR (status = 'failed' AND failure_stage = 'preview'
             AND retryable = TRUE AND attempt_count < 3)
         )`,
        [run.id]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) return run;
      const evidence = await repository.query(
        `SELECT derivative_id, asset_id, source_sha256, source_path,
                source_width, source_height, source_algorithm_version,
                evidence_read_id, evidence_source_kind, evidence_source_path,
                evidence_source_updated_at::text AS evidence_source_updated_at,
                status, preview_embedding_sha256,
                preview_embedding_dimensions, preview_embedding_bytes
         FROM public.vehicle_asset_embedding_jobs WHERE run_id = $1
         ORDER BY derivative_id, id`,
        [run.id]
      );
      const fingerprint = sha256({
        modelName: run.model_name,
        algorithmVersion: run.algorithm_version,
        maxDerivativeId: Number(run.max_derivative_id),
        jobs: evidence.rows || [],
      });
      const catalogable = (evidence.rows || []).filter((row) => row.status === "previewed").length;
      const updated = await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = $2::varchar(16), preview_fingerprint = $3,
             completed_at = CASE WHEN $2::varchar(16) = 'completed'
               THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [run.id, catalogable > 0 ? "ready" : "completed", fingerprint]
      );
      return updated.rows?.[0] || null;
    });
  }

  async confirmBatch({ runId, previewFingerprint, limit, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    const batchSize = boundedBatch(limit);
    return this.withTransaction(async (repository) => {
      const runResult = await repository.query(
        "SELECT * FROM public.vehicle_asset_embedding_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Embedding run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || !["ready", "running"].includes(run.status)) {
        throw new Error("Crop embedding preview is not ready for a batch.");
      }
      if (!run.preview_fingerprint || run.preview_fingerprint !== String(previewFingerprint || "")) {
        throw new Error("Crop embedding preview changed; refresh before confirming.");
      }
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_asset_embedding_jobs
         WHERE run_id = $1 AND (
           status IN ('queued','processing')
           OR (status = 'failed' AND failure_stage = 'embed' AND retryable = TRUE)
         )`,
        [run.id]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) {
        throw new Error("Wait for the current crop embedding batch to finish.");
      }
      const queued = await repository.query(
        `UPDATE public.vehicle_asset_embedding_jobs SET status = 'queued',
             failure_stage = 'embed', attempt_count = 0, retryable = FALSE,
             next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM public.vehicle_asset_embedding_jobs
           WHERE run_id = $1 AND status = 'previewed'
           ORDER BY derivative_id, id LIMIT $2
         ) RETURNING id`,
        [run.id, batchSize]
      );
      const queuedCount = Number(queued.rowCount || 0);
      await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = CASE WHEN $2 > 0 THEN 'running' ELSE status END,
             batch_size = $3, confirmed_actor_user_id = $4,
             confirmed_at = CASE WHEN $2 > 0 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [run.id, queuedCount, batchSize, actorId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_asset_embedding_batch_confirmed",
        runId: run.id,
        metadata: { batchSize, queued: queuedCount, previewFingerprint: run.preview_fingerprint },
      });
      return { queued: queuedCount, runId: Number(run.id) };
    });
  }

  async registerEmbedding(job, rendered) {
    const bytes = Buffer.isBuffer(rendered?.embedding)
      ? rendered.embedding
      : rendered?.embedding instanceof Uint8Array
        ? Buffer.from(rendered.embedding.buffer, rendered.embedding.byteOffset,
          rendered.embedding.byteLength)
        : null;
    const actualSha256 = bytes
      ? crypto.createHash("sha256").update(bytes).digest("hex")
      : null;
    if (
      rendered?.modelName !== job.model_name
      || rendered?.algorithmVersion !== job.algorithm_version
      || Number(rendered?.embeddingDimensions) !== 512
      || bytes?.length !== 2048
      || actualSha256 !== rendered?.embeddingSha256
    ) {
      const error = new Error("Rendered canonical crop embedding conflicts with its frozen contract.");
      error.code = "VEHICLE_ASSET_EMBEDDING_CONFLICT";
      throw error;
    }
    return this.withTransaction(async (repository) => {
      const evidence = await repository.query(
        `SELECT derivatives.id
         FROM public.vehicle_image_derivatives derivatives
         JOIN public.vehicle_image_asset_reads links ON links.asset_id = derivatives.asset_id
         JOIN public.plate_reads reads ON reads.id = links.read_id
         WHERE derivatives.id = $1 AND derivatives.asset_id = $2
           AND derivatives.derivative_kind = $3
           AND derivatives.algorithm_version = $4
           AND derivatives.content_sha256 = $5 AND derivatives.storage_path = $6
           AND derivatives.image_width = $7 AND derivatives.image_height = $8
           AND links.read_id = $9 AND links.source_kind = $10
           AND links.source_path_snapshot = $11
           AND links.source_updated_at IS NOT DISTINCT FROM $12::timestamptz
           AND ${currentLinkPredicate()}
         FOR SHARE OF derivatives, links, reads`,
        [job.derivative_id, job.asset_id, VEHICLE_IMAGE_CROP_KIND,
          job.source_algorithm_version, job.source_sha256, job.source_path,
          job.source_width, job.source_height, job.evidence_read_id,
          job.evidence_source_kind, job.evidence_source_path,
          job.evidence_source_updated_at]
      );
      if (!evidence.rows?.[0]) {
        const error = new Error("Canonical crop or current evidence link changed after preview.");
        error.code = "VEHICLE_ASSET_EMBEDDING_SOURCE_CHANGED";
        throw error;
      }
      const existing = await repository.query(
        `SELECT * FROM public.vehicle_asset_embeddings
         WHERE derivative_id = $1 AND model_name = $2 AND algorithm_version = $3
         FOR SHARE`,
        [job.derivative_id, job.model_name, job.algorithm_version]
      );
      let row = existing.rows?.[0] || null;
      let created = false;
      if (!row) {
        const inserted = await repository.query(
          `INSERT INTO public.vehicle_asset_embeddings (
             derivative_id, model_name, algorithm_version, source_sha256,
             embedding_sha256, embedding_dimensions, embedding
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (derivative_id, model_name, algorithm_version) DO NOTHING
           RETURNING *`,
          [job.derivative_id, rendered.modelName, rendered.algorithmVersion,
            job.source_sha256, rendered.embeddingSha256,
            rendered.embeddingDimensions, bytes]
        );
        row = inserted.rows?.[0] || null;
        created = Boolean(row);
        if (!row) {
          const raced = await repository.query(
            `SELECT * FROM public.vehicle_asset_embeddings
             WHERE derivative_id = $1 AND model_name = $2 AND algorithm_version = $3
             FOR SHARE`,
            [job.derivative_id, job.model_name, job.algorithm_version]
          );
          row = raced.rows?.[0] || null;
        }
      }
      if (!row
        || row.source_sha256 !== job.source_sha256
        || row.embedding_sha256 !== rendered.embeddingSha256
        || Number(row.embedding_dimensions) !== Number(rendered.embeddingDimensions)
        || !Buffer.isBuffer(row.embedding)
        || !row.embedding.equals(bytes)) {
        const error = new Error("Existing canonical crop embedding conflicts with this preview.");
        error.code = "VEHICLE_ASSET_EMBEDDING_CONFLICT";
        throw error;
      }
      return { embedding: row, embeddingCreated: created };
    });
  }

  async completeEmbeddingJob(job, result) {
    const resultStatus = result.embeddingCreated ? "ready" : "already_current";
    const updated = await this.query(
      `UPDATE public.vehicle_asset_embedding_jobs
       SET status = $3, embedding_id = $4, completed_at = CURRENT_TIMESTAMP,
           claim_token = NULL, processing_deadline_at = NULL,
           retryable = FALSE, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing' AND claim_token = $2::uuid
       RETURNING id`,
      [job.id, job.claim_token, resultStatus, result.embedding.id]
    );
    return Boolean(updated.rows?.[0]);
  }

  async settleRun(runId) {
    return this.withTransaction(async (repository) => {
      const runResult = await repository.query(
        "SELECT * FROM public.vehicle_asset_embedding_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Embedding run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || run.status !== "running") return run || null;
      const counts = await repository.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'previewed')::integer AS remaining,
           COUNT(*) FILTER (WHERE status IN ('queued','processing')
             OR (status = 'failed' AND failure_stage = 'embed' AND retryable = TRUE))::integer
             AS active
         FROM public.vehicle_asset_embedding_jobs WHERE run_id = $1`,
        [run.id]
      );
      if (Number(counts.rows[0].active || 0) > 0) return run;
      const completed = Number(counts.rows[0].remaining || 0) === 0;
      const updated = await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = $2::varchar(16), completed_at = CASE
             WHEN $2::varchar(16) = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [run.id, completed ? "completed" : "ready"]
      );
      return updated.rows?.[0] || null;
    });
  }

  async setPaused({ runId, paused, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const result = await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = CASE WHEN $2 THEN 'paused'
             WHEN EXISTS (SELECT 1 FROM public.vehicle_asset_embedding_jobs jobs
               WHERE jobs.run_id = vehicle_asset_embedding_runs.id
                 AND jobs.status IN ('queued','processing')) THEN 'running'
             ELSE 'ready' END,
             paused_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
        [positiveInteger(runId, "Embedding run id"), paused === true,
          paused === true ? ["ready", "running"] : ["paused"]]
      );
      if (!result.rows?.[0]) throw new Error("Crop embedding campaign cannot change pause state.");
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: paused
          ? "maintenance.vehicle_asset_embedding_paused"
          : "maintenance.vehicle_asset_embedding_resumed",
        runId,
      });
      return result.rows[0];
    });
  }

  async cancel({ runId, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_asset_embedding_jobs
         WHERE run_id = $1 AND status IN ('previewing','processing')`,
        [positiveInteger(runId, "Embedding run id")]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) {
        throw new Error("Wait for the current crop embedding item to finish before cancelling.");
      }
      const result = await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
        [runId, ACTIVE_RUN_STATUSES]
      );
      if (!result.rows?.[0]) throw new Error("Crop embedding campaign is already terminal.");
      await repository.query(
        `UPDATE public.vehicle_asset_embedding_jobs SET status = 'cancelled',
             retryable = FALSE, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND status IN ('pending_preview','previewed','queued','failed')`,
        [runId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_asset_embedding_cancelled",
        runId,
      });
      return result.rows[0];
    });
  }

  async retryJob({ jobId, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const result = await repository.query(
        `UPDATE public.vehicle_asset_embedding_jobs jobs
         SET status = CASE WHEN failure_stage = 'embed' THEN 'queued' ELSE 'pending_preview' END,
             operator_retry_count = operator_retry_count + 1,
             attempt_count = 0, retryable = FALSE, next_attempt_at = CURRENT_TIMESTAMP,
             error_code = NULL, error_details = NULL, updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_asset_embedding_runs runs
         WHERE jobs.id = $1 AND runs.id = jobs.run_id
           AND jobs.status = 'failed' AND jobs.operator_retry_count < 1
           AND runs.status IN ('ready','completed','failed')
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_asset_embedding_runs active
             WHERE active.id <> runs.id AND active.status = ANY($2::text[])
           )
         RETURNING jobs.id, jobs.run_id, jobs.failure_stage`,
        [positiveInteger(jobId, "Embedding job id"), ACTIVE_RUN_STATUSES]
      );
      const job = result.rows?.[0];
      if (!job) throw new Error("Crop embedding failure is not eligible for another retry.");
      await repository.query(
        `UPDATE public.vehicle_asset_embedding_runs
         SET status = CASE WHEN $2 = 'embed' THEN 'running' ELSE 'previewing' END,
             preview_fingerprint = CASE WHEN $2 = 'embed'
               THEN preview_fingerprint ELSE NULL END,
             completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [job.run_id, job.failure_stage]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_asset_embedding_retried",
        runId: job.run_id,
        metadata: { jobId: Number(job.id) },
      });
      return job;
    });
  }
}

export const vehicleAssetEmbeddingRepositoryInternals = Object.freeze({
  ACTIVE_RUN_STATUSES,
  CLAIM_SECONDS,
  boundedBatch,
  canonicalJson,
  currentLinkPredicate,
  sha256,
});
