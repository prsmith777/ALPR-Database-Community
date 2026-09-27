import crypto from "node:crypto";
import { VEHICLE_ASSET_EMBEDDING_ALGORITHM, VEHICLE_ASSET_EMBEDDING_MODEL } from "./vehicle-asset-embedding-contract.mjs";
import { VEHICLE_ASSET_ATTRIBUTE_ALGORITHM } from "./vehicle-asset-attribute-contract.mjs";
import { VEHICLE_IMAGE_CROP_ALGORITHM, VEHICLE_IMAGE_CROP_KIND } from "./vehicle-image-crop.mjs";

// A background job has a bounded lease and retry budget. It never runs in a
// page request; canonical repositories revalidate the exact source before writing.
export class VehicleAssetAnalysisRepository {
  constructor(pool) { this.pool = pool; }
  async isEnabled() {
    const result = await this.pool.query("SELECT processing_enabled FROM public.vehicle_reid_control WHERE singleton");
    return result.rows[0]?.processing_enabled === true;
  }
  async getStatus() {
    const result = await this.pool.query(`SELECT control.processing_enabled AS enabled,
      (SELECT COUNT(*)::integer FROM public.vehicle_asset_analysis_jobs WHERE status = 'pending') AS pending,
      (SELECT COUNT(*)::integer FROM public.vehicle_asset_analysis_jobs WHERE status = 'processing') AS processing,
      (SELECT COUNT(*)::integer FROM public.vehicle_asset_analysis_jobs WHERE status = 'ready') AS ready,
      (SELECT COUNT(*)::integer FROM public.vehicle_asset_analysis_jobs WHERE status = 'failed') AS failed
      FROM public.vehicle_reid_control control WHERE singleton`);
    if (!result.rows[0]) throw new Error("Vehicle processing is not initialized.");
    return result.rows[0];
  }
  async operate(operation, actorId) {
    if (!["pause", "resume", "retry"].includes(operation)) throw new Error("Unknown processing operation.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let changed = 0;
      if (operation === "retry") {
        const result = await client.query(`WITH candidates AS (
          SELECT derivative_id FROM public.vehicle_asset_analysis_jobs
          WHERE status = 'failed' ORDER BY derivative_id FOR UPDATE SKIP LOCKED LIMIT 100
        ) UPDATE public.vehicle_asset_analysis_jobs jobs
          SET status = 'pending', attempt_count = 0, next_attempt_at = CURRENT_TIMESTAMP,
              error_code = NULL, claim_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
          FROM candidates WHERE jobs.derivative_id = candidates.derivative_id`);
        changed = result.rowCount;
      } else {
        await client.query(`UPDATE public.vehicle_reid_control
          SET processing_enabled = $1, revision = revision + 1 WHERE singleton`, [operation === "resume"]);
      }
      await client.query(`INSERT INTO public.audit_events
        (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata)
        VALUES ($1, 'browser', 'vehicle.processing', 'vehicle_analysis', 'native', 'succeeded', $2::jsonb)`,
        [actorId, JSON.stringify({ operation, changed })]);
      await client.query("COMMIT");
      return { changed };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async reclaimExpired() {
    await this.pool.query(`UPDATE public.vehicle_asset_analysis_jobs
      SET status = 'failed', error_code = 'VEHICLE_ANALYSIS_LEASE_EXHAUSTED',
          claim_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing' AND lease_until < CURRENT_TIMESTAMP AND attempt_count >= 3`);
  }
  async discover() {
    await this.pool.query(
      `INSERT INTO public.vehicle_asset_analysis_jobs(derivative_id)
       SELECT derivatives.id FROM public.vehicle_image_derivatives derivatives
       WHERE derivatives.derivative_kind = $1 AND derivatives.algorithm_version = $2
         AND EXISTS (SELECT 1 FROM public.vehicle_reid_control WHERE processing_enabled)
         AND NOT EXISTS (SELECT 1 FROM public.vehicle_asset_analysis_jobs jobs
           WHERE jobs.derivative_id = derivatives.id)
         AND EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE links.asset_id = derivatives.asset_id AND links.identity_eligible
             AND links.relationship <> 'display_fallback'
             AND reads.vehicle_image_status = 'ready'
             AND reads.vehicle_image_path = links.source_path_snapshot
             AND reads.vehicle_image_source_kind = links.source_kind
             AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at)
       ORDER BY derivatives.id LIMIT 25 ON CONFLICT DO NOTHING`,
      [VEHICLE_IMAGE_CROP_KIND, VEHICLE_IMAGE_CROP_ALGORITHM]
    );
  }
  async claim() {
    const token = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT derivative_id FROM public.vehicle_asset_analysis_jobs
         WHERE attempt_count < 3 AND (
           (status IN ('pending','failed') AND next_attempt_at <= CURRENT_TIMESTAMP)
           OR (status = 'processing' AND lease_until < CURRENT_TIMESTAMP))
           AND EXISTS (SELECT 1 FROM public.vehicle_reid_control WHERE processing_enabled)
         ORDER BY next_attempt_at, derivative_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE public.vehicle_asset_analysis_jobs jobs
       SET status = 'processing', attempt_count = attempt_count + 1,
           claim_token = $1::uuid, lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
           updated_at = CURRENT_TIMESTAMP
       FROM candidate WHERE jobs.derivative_id = candidate.derivative_id
       RETURNING jobs.*`, [token]
    );
    return result.rows[0] || null;
  }
  async source(derivativeId) {
    const result = await this.pool.query(
      `SELECT derivatives.id AS derivative_id, derivatives.asset_id,
              derivatives.storage_path AS source_path, derivatives.content_sha256 AS source_sha256,
              derivatives.image_width AS source_width, derivatives.image_height AS source_height,
              derivatives.algorithm_version AS source_algorithm_version,
              evidence.read_id AS evidence_read_id, evidence.source_kind AS evidence_source_kind,
              evidence.source_path_snapshot AS evidence_source_path,
              evidence.source_updated_at::text AS evidence_source_updated_at,
              EXISTS (SELECT 1 FROM public.vehicle_asset_embeddings embeddings
                WHERE embeddings.derivative_id = derivatives.id AND embeddings.model_name = $2
                  AND embeddings.algorithm_version = $3
                  AND embeddings.source_sha256 = derivatives.content_sha256) AS has_embedding,
              (SELECT COUNT(DISTINCT observations.attribute_key)
               FROM public.vehicle_asset_attribute_observations observations
               WHERE observations.derivative_id = derivatives.id AND observations.algorithm_version = $4
                 AND observations.source_sha256 = derivatives.content_sha256) = 2 AS has_attributes
       FROM public.vehicle_image_derivatives derivatives
       JOIN public.vehicle_image_assets assets ON assets.id = derivatives.asset_id
         AND derivatives.source_sha256 = assets.content_sha256
       JOIN LATERAL (
         SELECT links.* FROM public.vehicle_image_asset_reads links
         JOIN public.plate_reads reads ON reads.id = links.read_id
         WHERE links.asset_id = derivatives.asset_id AND links.identity_eligible
           AND links.relationship <> 'display_fallback' AND reads.vehicle_image_status = 'ready'
           AND reads.vehicle_image_path = links.source_path_snapshot
           AND reads.vehicle_image_source_kind = links.source_kind
           AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
         ORDER BY links.read_id LIMIT 1
       ) evidence ON TRUE
       WHERE derivatives.id = $1`,
      [derivativeId, VEHICLE_ASSET_EMBEDDING_MODEL, VEHICLE_ASSET_EMBEDDING_ALGORITHM, VEHICLE_ASSET_ATTRIBUTE_ALGORITHM]
    );
    return result.rows[0] || null;
  }
  async finish(job, error = null) {
    await this.pool.query(
      `UPDATE public.vehicle_asset_analysis_jobs
       SET status = $3, error_code = $4, claim_token = NULL, lease_until = NULL,
           next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds', updated_at = CURRENT_TIMESTAMP
       WHERE derivative_id = $1 AND claim_token = $2::uuid`,
      [job.derivative_id, job.claim_token, error ? "failed" : "ready",
        error ? String(error.code || "VEHICLE_ANALYSIS_FAILED").slice(0, 100) : null]
    );
  }
}

export class VehicleAssetAnalysisService {
  constructor({ repository, embeddingService, attributeService, directionService, wakeIdentity = () => {}, logger = console }) {
    this.repository = repository;
    this.embeddingService = embeddingService;
    this.attributeService = attributeService;
    this.directionService = directionService;
    this.wakeIdentity = wakeIdentity;
    this.logger = logger;
    this.processing = false;
  }
  async processBatch() {
    if (this.processing) return { status: "idle", processed: 0 };
    this.processing = true;
    try {
      if (!await this.repository.isEnabled()) return { status: "paused", processed: 0 };
      await this.repository.reclaimExpired();
      await this.repository.discover();
      const job = await this.repository.claim();
      if (!job) {
        // Direction can become actionable when an operator labels a camera,
        // even though no new embedding is needed.
        await this.directionService.backfillDirectionBatch({ limit: 5, includeStatus: false });
        return { status: "idle", processed: 0 };
      }
      try {
        const source = await this.repository.source(job.derivative_id);
        if (!source) {
          const error = new Error("No current identity-eligible image source.");
          error.code = "VEHICLE_ANALYSIS_SOURCE_UNAVAILABLE";
          throw error;
        }
        if (!source.has_embedding) {
          const contract = { ...source, model_name: VEHICLE_ASSET_EMBEDDING_MODEL, algorithm_version: VEHICLE_ASSET_EMBEDDING_ALGORITHM };
          const rendered = await this.embeddingService.render(contract);
          await this.embeddingService.repository.registerEmbedding(contract, rendered);
        }
        // Attribute failure must not prevent an already-valid embedding from
        // becoming useful for identity; retries skip completed stages.
        this.wakeIdentity();
        if (!source.has_attributes) {
          const contract = { ...source, algorithm_version: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM };
          const rendered = await this.attributeService.render(contract);
          await this.attributeService.repository.registerObservations(contract, rendered);
        }
        await this.directionService.backfillDirectionBatch({ limit: 5, includeStatus: false });
        await this.repository.finish(job);
        return { status: "working", phase: "automatic", processed: 1, succeeded: 1, failed: 0 };
      } catch (error) {
        await this.repository.finish(job, error);
        this.logger?.warn?.("Canonical vehicle analysis failed", { derivativeId: job.derivative_id, code: error.code || "VEHICLE_ANALYSIS_FAILED" });
        return { status: "working", phase: "automatic", processed: 1, succeeded: 0, failed: 1 };
      }
    } finally { this.processing = false; }
  }
}
