import crypto from "node:crypto";

import { withStorageCleanupWriterLock } from "./storage-maintenance-lock.mjs";
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
    throw new Error("Vehicle crop batches must contain 1, 5, 25, or 250 assets.");
  }
  return number;
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function jobSelection(alias = "jobs") {
  return `${alias}.*, ${alias}.evidence_source_updated_at::text AS evidence_source_updated_at`;
}

function currentLinkPredicate(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

export class VehicleImageCropRepository {
  constructor({ pool, executor = null, storageWriterLockHeld = false } = {}) {
    if (!pool && !executor) throw new Error("Vehicle crop repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
    this.storageWriterLockHeld = storageWriterLockHeld === true;
  }

  async query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async withTransaction(operation) {
    const ownsClient = !this.executor && typeof this.pool?.connect === "function";
    const client = ownsClient ? await this.pool.connect() : (this.executor || this.pool);
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleImageCropRepository({
        executor: client,
        storageWriterLockHeld: this.storageWriterLockHeld,
      }));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async withStorageWriter(operation) {
    if (this.executor) {
      if (!this.storageWriterLockHeld) {
        throw new Error("Vehicle crop writes require the shared storage cleanup lock");
      }
      return operation(this);
    }
    return withStorageCleanupWriterLock(this.pool, (client) => operation(
      new VehicleImageCropRepository({ executor: client, storageWriterLockHeld: true })
    ));
  }

  async recordAudit({ actorUserId, eventType, runId = null, metadata = {} }) {
    await this.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata
       ) VALUES ($1, 'browser', $2, 'vehicle_image_crop', $3, 'succeeded', $4::jsonb)`,
      [actorUserId, eventType, runId == null ? null : String(runId), JSON.stringify(metadata)]
    );
  }

  async createPreview({ actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      await repository.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-crop-campaign'))"
      );
      const active = await repository.query(
        `SELECT id FROM public.vehicle_image_crop_runs
         WHERE status = ANY($1::text[])
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ACTIVE_RUN_STATUSES]
      );
      if (active.rows?.[0]) return repository.getRun(active.rows[0].id);
      const scope = await repository.query(
        "SELECT COALESCE(MAX(id), 0)::bigint AS max_asset_id FROM public.vehicle_image_assets"
      );
      const maxAssetId = Number(scope.rows?.[0]?.max_asset_id || 0);
      const inserted = await repository.query(
        `INSERT INTO public.vehicle_image_crop_runs (
           status, max_asset_id, actor_user_id
         ) VALUES ('previewing', $1, $2) RETURNING id`,
        [maxAssetId, actorId]
      );
      const runId = inserted.rows[0].id;
      await repository.query(
        `INSERT INTO public.vehicle_image_crop_jobs (
           run_id, asset_id, source_sha256, source_path, source_width,
           source_height, evidence_read_id, evidence_source_kind,
           evidence_source_path, evidence_source_updated_at,
           detection_box, detection_confidence
         )
         SELECT $1, assets.id, assets.content_sha256, assets.storage_path,
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
         WHERE assets.id <= $2
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_image_derivatives derivatives
             WHERE derivatives.asset_id = assets.id
               AND derivatives.derivative_kind = $3
               AND derivatives.algorithm_version = $4
           )
         ORDER BY assets.id`,
        [runId, maxAssetId, VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_crop_preview_created",
        runId,
        metadata: { maxAssetId },
      });
      return repository.getRun(runId);
    });
  }

  async getRun(runId) {
    const result = await this.query(
      "SELECT * FROM public.vehicle_image_crop_runs WHERE id = $1",
      [positiveInteger(runId, "Crop run id")]
    );
    return result.rows?.[0] || null;
  }

  async getLatestRun() {
    const result = await this.query(
      "SELECT * FROM public.vehicle_image_crop_runs ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    return result.rows?.[0] || null;
  }

  async getOverview() {
    const latestRun = await this.getLatestRun();
    const [catalog, runCounts, retry, samples] = await Promise.all([
      this.query(
        `WITH physical AS (
           SELECT storage_path, MAX(byte_size)::bigint AS byte_size
           FROM public.vehicle_image_derivatives
           WHERE derivative_kind = $1 AND algorithm_version = $2
           GROUP BY storage_path
         ), eligible AS (
           SELECT DISTINCT links.asset_id
           FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE ${currentLinkPredicate()}
         )
         SELECT
           (SELECT COUNT(*) FROM eligible)::bigint AS eligible_assets,
           COUNT(*) FILTER (WHERE derivatives.derivative_kind = $1
             AND derivatives.algorithm_version = $2)::bigint AS crop_count,
           COALESCE((SELECT COUNT(*) FROM physical), 0)::bigint AS physical_files,
           COALESCE((SELECT SUM(byte_size) FROM physical), 0)::bigint AS crop_bytes
         FROM public.vehicle_image_derivatives derivatives`,
        [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      ),
      latestRun ? this.query(
        `WITH run_jobs AS (
           SELECT * FROM public.vehicle_image_crop_jobs WHERE run_id = $1
         ), unique_preview_files AS (
           SELECT preview_sha256, MAX(preview_byte_size)::bigint AS byte_size
           FROM run_jobs
           WHERE preview_sha256 IS NOT NULL AND preview_byte_size IS NOT NULL
           GROUP BY preview_sha256
         )
         SELECT
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
           COUNT(*) FILTER (WHERE status = 'failed' AND retryable = TRUE)::bigint AS retryable,
           COUNT(DISTINCT preview_sha256) FILTER (WHERE preview_sha256 IS NOT NULL)::bigint
             AS unique_crops,
           COALESCE((SELECT SUM(byte_size) FROM unique_preview_files), 0)::bigint
             AS projected_bytes,
           COALESCE(SUM(source_width::bigint * source_height::bigint)
             FILTER (WHERE preview_width IS NOT NULL), 0)::bigint
             AS source_pixels,
           COALESCE(SUM(preview_width::bigint * preview_height::bigint)
             FILTER (WHERE preview_width IS NOT NULL), 0)::bigint AS crop_pixels
         FROM run_jobs`,
        [latestRun.id]
      ) : Promise.resolve({ rows: [{}] }),
      latestRun ? this.query(
        `SELECT id, asset_id, failure_stage, error_code,
                error_details, operator_retry_count
         FROM public.vehicle_image_crop_jobs
         WHERE run_id = $1 AND status = 'failed'
         ORDER BY updated_at DESC, id DESC LIMIT 25`,
        [latestRun.id]
      ) : Promise.resolve({ rows: [] }),
      this.query(
        `SELECT asset_id, storage_path, image_width, image_height, created_at
         FROM public.vehicle_image_derivatives
         WHERE derivative_kind = $1 AND algorithm_version = $2
         ORDER BY created_at DESC, id DESC LIMIT 8`,
        [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      ),
    ]);
    return {
      catalog: catalog.rows?.[0] || {},
      latestRun,
      counts: runCounts.rows?.[0] || {},
      retryCandidates: retry.rows || [],
      samples: samples.rows || [],
      algorithmVersion: VEHICLE_IMAGE_CROP_ALGORITHM,
    };
  }

  async reclaimExpiredClaims() {
    const result = await this.query(
      `UPDATE public.vehicle_image_crop_jobs jobs
       SET status = CASE WHEN failure_stage = 'catalog' THEN 'queued' ELSE 'pending_preview' END,
           claim_token = NULL, processing_deadline_at = NULL,
           next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       FROM public.vehicle_image_crop_runs runs
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
        `SELECT ${jobSelection("jobs")}
         FROM public.vehicle_image_crop_jobs jobs
         JOIN public.vehicle_image_crop_runs runs ON runs.id = jobs.run_id
         WHERE runs.status = $1
           AND (
             jobs.status = $2
             OR (jobs.status = 'failed' AND jobs.failure_stage = $3
               AND jobs.retryable = TRUE AND jobs.attempt_count < 3
               AND jobs.next_attempt_at <= CURRENT_TIMESTAMP)
           )
         ORDER BY jobs.asset_id, jobs.id
         FOR UPDATE OF jobs SKIP LOCKED LIMIT 1`,
        [preview ? "previewing" : "running", preview ? "pending_preview" : "queued", stage]
      );
      const job = claimed.rows?.[0];
      if (!job) return null;
      const token = crypto.randomUUID();
      const updated = await repository.query(
        `UPDATE public.vehicle_image_crop_jobs
         SET status = $2, failure_stage = $3, attempt_count = attempt_count + 1,
             retryable = FALSE, claim_token = $4::uuid,
             processing_deadline_at = CURRENT_TIMESTAMP + make_interval(secs => $5),
             next_attempt_at = NULL, error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING ${jobSelection("vehicle_image_crop_jobs")}`,
        [job.id, preview ? "previewing" : "processing", stage, token, CLAIM_SECONDS]
      );
      return updated.rows?.[0] || null;
    });
  }

  claimPreviewJob() { return this.claim("preview"); }
  claimCatalogJob() { return this.claim("catalog"); }

  async completePreviewJob(job, preview) {
    const result = await this.query(
      `UPDATE public.vehicle_image_crop_jobs
       SET status = 'previewed', claim_token = NULL, processing_deadline_at = NULL,
           preview_sha256 = $3, preview_path = $4, preview_byte_size = $5,
           preview_width = $6, preview_height = $7, preview_crop_box = $8::jsonb,
           previewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'previewing' AND claim_token = $2::uuid
       RETURNING id`,
      [job.id, job.claim_token, preview.contentSha256, preview.storagePath,
        preview.byteSize, preview.imageWidth, preview.imageHeight, json(preview.cropBox)]
    );
    return Boolean(result.rows?.[0]);
  }

  async failJob(job, { stage, status, errorCode, message, retryable }) {
    const mayRetry = retryable === true && Number(job.attempt_count || 0) < 3;
    const finalStatus = mayRetry ? "failed" : status;
    await this.query(
      `UPDATE public.vehicle_image_crop_jobs
       SET status = $3, failure_stage = $4, retryable = $5,
           claim_token = NULL, processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN $5 THEN CURRENT_TIMESTAMP
             + make_interval(secs => GREATEST(5, attempt_count * 5)) ELSE NULL END,
           error_code = $6, error_details = $7::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2::uuid`,
      [job.id, job.claim_token, finalStatus, stage, mayRetry,
        String(errorCode || "VEHICLE_IMAGE_CROP_FAILED").slice(0, 80),
        JSON.stringify({ message: String(message || "Vehicle crop failed").slice(0, 500) })]
    );
  }

  async finalizePreview(runId) {
    return this.withTransaction(async (repository) => {
      const runResult = await repository.query(
        "SELECT * FROM public.vehicle_image_crop_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Crop run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || run.status !== "previewing") return run || null;
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_image_crop_jobs
         WHERE run_id = $1 AND (
           status IN ('pending_preview','previewing')
           OR (status = 'failed' AND failure_stage = 'preview'
             AND retryable = TRUE AND attempt_count < 3)
         )`,
        [run.id]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) return run;
      const evidence = await repository.query(
        `SELECT asset_id, source_sha256, source_path, evidence_read_id,
                evidence_source_kind, evidence_source_path,
                evidence_source_updated_at::text AS evidence_source_updated_at,
                detection_box, detection_confidence, status,
                preview_sha256, preview_byte_size, preview_width,
                preview_height, preview_crop_box
         FROM public.vehicle_image_crop_jobs WHERE run_id = $1
         ORDER BY asset_id, id`,
        [run.id]
      );
      const fingerprint = sha256({
        algorithm: VEHICLE_IMAGE_CROP_ALGORITHM,
        maxAssetId: Number(run.max_asset_id),
        jobs: evidence.rows || [],
      });
      const catalogable = (evidence.rows || []).filter((row) => row.status === "previewed").length;
      const updated = await repository.query(
        `UPDATE public.vehicle_image_crop_runs
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
        "SELECT * FROM public.vehicle_image_crop_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Crop run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || !["ready", "running"].includes(run.status)) {
        throw new Error("Vehicle crop preview is not ready for a batch.");
      }
      if (!run.preview_fingerprint || run.preview_fingerprint !== String(previewFingerprint || "")) {
        throw new Error("Vehicle crop preview changed; refresh before confirming.");
      }
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_image_crop_jobs
         WHERE run_id = $1 AND (
           status IN ('queued','processing')
           OR (status = 'failed' AND failure_stage = 'catalog' AND retryable = TRUE)
         )`,
        [run.id]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) {
        throw new Error("Wait for the current vehicle crop batch to finish.");
      }
      const queued = await repository.query(
        `UPDATE public.vehicle_image_crop_jobs SET status = 'queued',
             failure_stage = 'catalog', attempt_count = 0, retryable = FALSE,
             next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM public.vehicle_image_crop_jobs
           WHERE run_id = $1 AND status = 'previewed'
           ORDER BY asset_id, id LIMIT $2
         ) RETURNING id`,
        [run.id, batchSize]
      );
      const queuedCount = Number(queued.rowCount || 0);
      await repository.query(
        `UPDATE public.vehicle_image_crop_runs
         SET status = CASE WHEN $2 > 0 THEN 'running' ELSE status END,
             batch_size = $3, confirmed_actor_user_id = $4,
             confirmed_at = CASE WHEN $2 > 0 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [run.id, queuedCount, batchSize, actorId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_crop_batch_confirmed",
        runId: run.id,
        metadata: { batchSize, queued: queuedCount, previewFingerprint: run.preview_fingerprint },
      });
      return { queued: queuedCount, runId: Number(run.id) };
    });
  }

  async registerDerivative(job, derivative) {
    if (!this.executor || !this.storageWriterLockHeld) {
      throw new Error("Vehicle crop registration requires the shared storage cleanup lock");
    }
    return this.withTransaction(async (repository) => {
      const evidence = await repository.query(
        `SELECT assets.id
         FROM public.vehicle_image_assets assets
         JOIN public.vehicle_image_asset_reads links ON links.asset_id = assets.id
         JOIN public.plate_reads reads ON reads.id = links.read_id
         WHERE assets.id = $1 AND assets.content_sha256 = $2
           AND assets.storage_path = $3 AND assets.image_width = $4
           AND assets.image_height = $5 AND links.read_id = $6
           AND links.source_kind = $7 AND links.source_path_snapshot = $8
           AND links.source_updated_at IS NOT DISTINCT FROM $9::timestamptz
           AND links.detection_box IS NOT DISTINCT FROM $10::jsonb
           AND links.detection_confidence IS NOT DISTINCT FROM $11::real
           AND ${currentLinkPredicate()}
         FOR SHARE OF assets, links, reads`,
        [job.asset_id, job.source_sha256, job.source_path, job.source_width,
          job.source_height, job.evidence_read_id, job.evidence_source_kind,
          job.evidence_source_path, job.evidence_source_updated_at,
          json(job.detection_box), job.detection_confidence]
      );
      if (!evidence.rows?.[0]) {
        const error = new Error("Canonical Overview crop evidence changed after preview.");
        error.code = "VEHICLE_IMAGE_CROP_SOURCE_CHANGED";
        throw error;
      }
      const existing = await repository.query(
        `SELECT * FROM public.vehicle_image_derivatives
         WHERE asset_id = $1 AND derivative_kind = $2 AND algorithm_version = $3
         FOR SHARE`,
        [job.asset_id, VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
      );
      let row = existing.rows?.[0] || null;
      let created = false;
      if (!row) {
        const inserted = await repository.query(
          `INSERT INTO public.vehicle_image_derivatives (
             asset_id, derivative_kind, algorithm_version, source_sha256,
             content_sha256, storage_path, media_type, byte_size,
             image_width, image_height, crop_box, detector_model,
             detection_confidence, evidence_read_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'image/jpeg',$7,$8,$9,$10::jsonb,$11,$12,$13)
           ON CONFLICT (asset_id, derivative_kind, algorithm_version) DO NOTHING
           RETURNING *`,
          [job.asset_id, VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM,
            job.source_sha256, derivative.contentSha256, derivative.storagePath,
            derivative.byteSize, derivative.imageWidth, derivative.imageHeight,
            json(derivative.cropBox), derivative.detectorModel,
            derivative.detectionConfidence, job.evidence_read_id]
        );
        row = inserted.rows?.[0] || null;
        created = Boolean(row);
        if (!row) {
          const raced = await repository.query(
            `SELECT * FROM public.vehicle_image_derivatives
             WHERE asset_id = $1 AND derivative_kind = $2 AND algorithm_version = $3
             FOR SHARE`,
            [job.asset_id, VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
          );
          row = raced.rows?.[0] || null;
        }
      }
      if (!row
        || row.source_sha256 !== job.source_sha256
        || row.content_sha256 !== derivative.contentSha256
        || row.storage_path !== derivative.storagePath
        || Number(row.byte_size) !== Number(derivative.byteSize)
        || Number(row.image_width) !== Number(derivative.imageWidth)
        || Number(row.image_height) !== Number(derivative.imageHeight)) {
        const error = new Error("Existing canonical vehicle crop does not match this preview.");
        error.code = "VEHICLE_IMAGE_CROP_CONFLICT";
        throw error;
      }
      return { derivative: row, derivativeCreated: created };
    });
  }

  async completeCatalogJob(job, result) {
    const resultStatus = result.derivativeCreated ? "ready" : "already_current";
    const updated = await this.query(
      `UPDATE public.vehicle_image_crop_jobs
       SET status = $3, derivative_id = $4, completed_at = CURRENT_TIMESTAMP,
           claim_token = NULL, processing_deadline_at = NULL,
           retryable = FALSE, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing' AND claim_token = $2::uuid
       RETURNING id`,
      [job.id, job.claim_token, resultStatus, result.derivative.id]
    );
    return Boolean(updated.rows?.[0]);
  }

  async settleRun(runId) {
    return this.withTransaction(async (repository) => {
      const runResult = await repository.query(
        "SELECT * FROM public.vehicle_image_crop_runs WHERE id = $1 FOR UPDATE",
        [positiveInteger(runId, "Crop run id")]
      );
      const run = runResult.rows?.[0];
      if (!run || run.status !== "running") return run || null;
      const counts = await repository.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'previewed')::integer AS remaining,
           COUNT(*) FILTER (WHERE status IN ('queued','processing')
             OR (status = 'failed' AND failure_stage = 'catalog' AND retryable = TRUE))::integer
             AS active
         FROM public.vehicle_image_crop_jobs WHERE run_id = $1`,
        [run.id]
      );
      if (Number(counts.rows[0].active || 0) > 0) return run;
      const completed = Number(counts.rows[0].remaining || 0) === 0;
      const updated = await repository.query(
        `UPDATE public.vehicle_image_crop_runs
         SET status = $2::varchar(16), completed_at = CASE
             WHEN $2::varchar(16) = 'completed'
             THEN CURRENT_TIMESTAMP ELSE NULL END,
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
        `UPDATE public.vehicle_image_crop_runs
         SET status = CASE WHEN $2 THEN 'paused'
             WHEN EXISTS (SELECT 1 FROM public.vehicle_image_crop_jobs jobs
               WHERE jobs.run_id = vehicle_image_crop_runs.id
                 AND jobs.status IN ('queued','processing')) THEN 'running'
             ELSE 'ready' END,
             paused_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
        [positiveInteger(runId, "Crop run id"), paused === true,
          paused === true ? ["ready", "running"] : ["paused"]]
      );
      if (!result.rows?.[0]) throw new Error("Vehicle crop campaign cannot change pause state.");
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: paused
          ? "maintenance.vehicle_image_crop_paused"
          : "maintenance.vehicle_image_crop_resumed",
        runId,
      });
      return result.rows[0];
    });
  }

  async cancel({ runId, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const active = await repository.query(
        `SELECT COUNT(*)::integer AS count FROM public.vehicle_image_crop_jobs
         WHERE run_id = $1 AND status IN ('previewing','processing')`,
        [positiveInteger(runId, "Crop run id")]
      );
      if (Number(active.rows?.[0]?.count || 0) > 0) {
        throw new Error("Wait for the current vehicle crop item to finish before cancelling.");
      }
      const result = await repository.query(
        `UPDATE public.vehicle_image_crop_runs
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
        [runId, ACTIVE_RUN_STATUSES]
      );
      if (!result.rows?.[0]) throw new Error("Vehicle crop campaign is already terminal.");
      await repository.query(
        `UPDATE public.vehicle_image_crop_jobs SET status = 'cancelled',
             retryable = FALSE, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND status IN (
           'pending_preview','previewed','queued','failed'
         )`,
        [runId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_crop_cancelled",
        runId,
      });
      return result.rows[0];
    });
  }

  async retryJob({ jobId, actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const result = await repository.query(
        `UPDATE public.vehicle_image_crop_jobs jobs
         SET status = CASE WHEN failure_stage = 'catalog' THEN 'queued' ELSE 'pending_preview' END,
             operator_retry_count = operator_retry_count + 1,
             attempt_count = 0, retryable = FALSE, next_attempt_at = CURRENT_TIMESTAMP,
             error_code = NULL, error_details = NULL, updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_image_crop_runs runs
         WHERE jobs.id = $1 AND runs.id = jobs.run_id
           AND jobs.status = 'failed' AND jobs.operator_retry_count < 1
           AND runs.status IN ('ready','completed','failed')
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_image_crop_runs active
             WHERE active.id <> runs.id AND active.status = ANY($2::text[])
           )
         RETURNING jobs.id, jobs.run_id, jobs.failure_stage`,
        [positiveInteger(jobId, "Crop job id"), ACTIVE_RUN_STATUSES]
      );
      const job = result.rows?.[0];
      if (!job) throw new Error("Vehicle crop failure is not eligible for another retry.");
      await repository.query(
        `UPDATE public.vehicle_image_crop_runs
         SET status = CASE WHEN $2 = 'catalog' THEN 'running' ELSE 'previewing' END,
             preview_fingerprint = CASE WHEN $2 = 'catalog'
               THEN preview_fingerprint ELSE NULL END,
             completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [job.run_id, job.failure_stage]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_crop_retried",
        runId: job.run_id,
        metadata: { jobId: Number(job.id) },
      });
      return job;
    });
  }
}

export const vehicleImageCropRepositoryInternals = Object.freeze({
  ACTIVE_RUN_STATUSES,
  CLAIM_SECONDS,
  boundedBatch,
  canonicalJson,
  currentLinkPredicate,
  sha256,
});
