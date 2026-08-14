import crypto from "node:crypto";

import { OVERVIEW_ASSET_SOURCE_KINDS } from "./vehicle-image-asset-model.mjs";

const ACTIVE_RUN_STATUSES = Object.freeze(["previewing", "ready", "running", "paused"]);
const RETRY_LIMIT = 3;
const OPERATOR_RETRY_LIMIT = 1;
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
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function boundedBatch(value, fallback = 5) {
  const allowed = new Set([1, 5, 25, 250]);
  const number = Number.parseInt(String(value ?? fallback), 10);
  if (!allowed.has(number)) {
    throw new Error("Canonical Overview catalog batches must contain 1, 5, 25, or 250 reads.");
  }
  return number;
}

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

function safeErrorDetails(value) {
  const object = jsonObject(value);
  const safe = {};
  for (const key of ["message", "reason"]) {
    const text = String(object[key] || "").trim();
    if (text) safe[key] = text.slice(0, 500);
  }
  return safe;
}

function snapshotFromRead(row) {
  return {
    id: Number(row.id),
    camera_name: row.camera_name ?? null,
    timestamp: row.timestamp ?? null,
    vehicle_image_status: row.vehicle_image_status,
    vehicle_image_path: row.vehicle_image_path,
    vehicle_image_timestamp: row.vehicle_image_timestamp ?? null,
    vehicle_image_score: row.vehicle_image_score ?? null,
    vehicle_image_detection_confidence: row.vehicle_image_detection_confidence ?? null,
    vehicle_image_detection_box: row.vehicle_image_detection_box ?? null,
    vehicle_image_width: row.vehicle_image_width ?? null,
    vehicle_image_height: row.vehicle_image_height ?? null,
    vehicle_image_sampled_count: row.vehicle_image_sampled_count ?? null,
    vehicle_image_selection_metadata: row.vehicle_image_selection_metadata ?? null,
    vehicle_image_source_kind: row.vehicle_image_source_kind,
    vehicle_image_source_read_id: row.vehicle_image_source_read_id ?? null,
    vehicle_image_updated_at: row.vehicle_image_updated_at ?? null,
  };
}

function snapshotFromItem(row) {
  return {
    id: Number(row.read_id),
    camera_name: row.read_camera_name ?? null,
    timestamp: row.read_timestamp ?? null,
    vehicle_image_status: row.source_status,
    vehicle_image_path: row.source_path,
    vehicle_image_timestamp: row.captured_at ?? null,
    vehicle_image_score: row.source_score ?? null,
    vehicle_image_detection_confidence: row.detection_confidence ?? null,
    vehicle_image_detection_box: row.detection_box ?? null,
    vehicle_image_width: row.source_width ?? null,
    vehicle_image_height: row.source_height ?? null,
    vehicle_image_sampled_count: row.sampled_count ?? null,
    vehicle_image_selection_metadata: row.selection_metadata ?? null,
    vehicle_image_source_kind: row.source_kind,
    vehicle_image_source_read_id: row.source_read_id ?? null,
    vehicle_image_updated_at: row.source_updated_at ?? null,
  };
}

const READ_SELECTION = `
  reads.id,
  reads.camera_name,
  reads."timestamp"::text AS "timestamp",
  reads.vehicle_image_status,
  reads.vehicle_image_path,
  reads.vehicle_image_timestamp::text AS vehicle_image_timestamp,
  reads.vehicle_image_score,
  reads.vehicle_image_detection_confidence,
  reads.vehicle_image_detection_box,
  reads.vehicle_image_width,
  reads.vehicle_image_height,
  reads.vehicle_image_sampled_count,
  reads.vehicle_image_selection_metadata,
  reads.vehicle_image_source_kind,
  reads.vehicle_image_source_read_id,
  reads.vehicle_image_updated_at::text AS vehicle_image_updated_at,
  CASE WHEN links.read_id IS NULL THEN 'absent' ELSE 'stale' END AS prior_link_state`;

const CANDIDATE_PREDICATE = `
  reads.vehicle_image_status = 'ready'
  AND NULLIF(BTRIM(reads.vehicle_image_path), '') IS NOT NULL
  AND reads.vehicle_image_source_kind = ANY($1::text[])
  AND (
    links.read_id IS NULL
    OR reads.vehicle_image_path IS DISTINCT FROM links.source_path_snapshot
    OR reads.vehicle_image_source_kind IS DISTINCT FROM links.source_kind
    OR reads.vehicle_image_updated_at IS DISTINCT FROM links.source_updated_at
  )`;

const ITEM_SELECTION = `
  items.*,
  items.read_timestamp::text AS read_timestamp,
  items.source_updated_at::text AS source_updated_at,
  items.captured_at::text AS captured_at`;

export class VehicleImageAssetCatalogCampaignRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("Vehicle image asset catalog campaign requires a database pool");
    }
    this.pool = pool;
  }

  async withTransaction(operation) {
    const ownsClient = typeof this.pool.connect === "function";
    const client = ownsClient ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleImageAssetCatalogCampaignRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async recordAudit({ actorUserId, eventType, resourceId = null, outcome = "succeeded", metadata = {} }) {
    await this.pool.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata
       ) VALUES ($1, 'browser', $2, 'vehicle_image_asset_catalog', $3, $4, $5::jsonb)`,
      [actorUserId, eventType, resourceId == null ? null : String(resourceId),
        outcome, JSON.stringify(metadata)]
    );
  }

  async createPreview({ actorUserId }) {
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-asset-catalog-campaign'))"
      );
      const active = await repository.pool.query(
        `SELECT id FROM public.vehicle_image_asset_catalog_runs
         WHERE status = ANY($1::text[])
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ACTIVE_RUN_STATUSES]
      );
      if (active.rows?.[0]) return repository.getRun(active.rows[0].id);

      const scope = await repository.pool.query(
        `SELECT COALESCE(MAX(id), 0)::integer AS max_read_id FROM public.plate_reads`
      );
      const frozen = scope.rows?.[0] || { max_read_id: 0 };
      const inserted = await repository.pool.query(
        `INSERT INTO public.vehicle_image_asset_catalog_runs (
           phase, status, max_read_id, preview_cursor_read_id,
           candidate_reads, batch_size, actor_user_id
         ) VALUES ('preview','previewing',$1,0,0,5,$2)
         RETURNING id`,
        [Number(frozen.max_read_id || 0), actorId]
      );
      const runId = inserted.rows[0].id;
      const materialized = await repository.pool.query(
        `INSERT INTO public.vehicle_image_asset_catalog_items (
           run_id, read_id, snapshot_fingerprint, read_camera_name,
           read_timestamp, source_status, source_path, source_kind,
           source_read_id, source_updated_at, captured_at, source_score,
           detection_confidence, detection_box, source_width, source_height,
           sampled_count, selection_metadata, prior_link_state
         )
         SELECT $2, reads.id,
                md5(concat_ws('|', reads.id::text, reads.camera_name,
                  reads."timestamp"::text, reads.vehicle_image_status,
                  reads.vehicle_image_path, reads.vehicle_image_timestamp::text,
                  reads.vehicle_image_score::text,
                  reads.vehicle_image_detection_confidence::text,
                  reads.vehicle_image_detection_box::text,
                  reads.vehicle_image_width::text, reads.vehicle_image_height::text,
                  reads.vehicle_image_sampled_count::text,
                  reads.vehicle_image_selection_metadata::text,
                  reads.vehicle_image_source_kind,
                  reads.vehicle_image_source_read_id::text,
                  reads.vehicle_image_updated_at::text))
                || md5('vehicle-image-asset-snapshot-v1|' || concat_ws('|',
                  reads.id::text, reads.camera_name, reads."timestamp"::text,
                  reads.vehicle_image_status, reads.vehicle_image_path,
                  reads.vehicle_image_timestamp::text, reads.vehicle_image_score::text,
                  reads.vehicle_image_detection_confidence::text,
                  reads.vehicle_image_detection_box::text,
                  reads.vehicle_image_width::text, reads.vehicle_image_height::text,
                  reads.vehicle_image_sampled_count::text,
                  reads.vehicle_image_selection_metadata::text,
                  reads.vehicle_image_source_kind,
                  reads.vehicle_image_source_read_id::text,
                  reads.vehicle_image_updated_at::text)),
                reads.camera_name, reads."timestamp", reads.vehicle_image_status,
                reads.vehicle_image_path, reads.vehicle_image_source_kind,
                reads.vehicle_image_source_read_id, reads.vehicle_image_updated_at,
                reads.vehicle_image_timestamp, reads.vehicle_image_score,
                reads.vehicle_image_detection_confidence,
                reads.vehicle_image_detection_box, reads.vehicle_image_width,
                reads.vehicle_image_height, reads.vehicle_image_sampled_count,
                reads.vehicle_image_selection_metadata,
                CASE WHEN links.read_id IS NULL THEN 'absent' ELSE 'stale' END
         FROM public.plate_reads reads
         LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
         WHERE reads.id <= $3 AND ${CANDIDATE_PREDICATE}
         ORDER BY reads.id
         ON CONFLICT (run_id, read_id) DO NOTHING
         RETURNING id`,
        [OVERVIEW_ASSET_SOURCE_KINDS, runId, Number(frozen.max_read_id || 0)]
      );
      const candidateReads = Number(materialized.rowCount || 0);
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET candidate_reads = $2, preview_cursor_read_id = max_read_id,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, candidateReads]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_asset_catalog_preview_created",
        resourceId: runId,
        metadata: {
          maxReadId: Number(frozen.max_read_id || 0),
          candidateReads,
          externalProviderContacted: false,
        },
      });
      return repository.getRun(runId);
    });
  }

  async materializePreviewWindow({ runId, limit = 25 } = {}) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    const boundedLimit = Math.min(250, Math.max(1, Number.parseInt(String(limit), 10) || 25));
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs
         WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = runResult.rows?.[0] || null;
      if (!run || run.phase !== "preview" || run.status !== "previewing") {
        return { materialized: 0, finished: true };
      }
      const rows = await repository.pool.query(
        `SELECT ${READ_SELECTION}
         FROM public.plate_reads reads
         LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
         WHERE reads.id > $2 AND reads.id <= $3
           AND ${CANDIDATE_PREDICATE}
         ORDER BY reads.id
         LIMIT $4`,
        [OVERVIEW_ASSET_SOURCE_KINDS, Number(run.preview_cursor_read_id),
          Number(run.max_read_id), boundedLimit]
      );
      const selected = rows.rows || [];
      for (const read of selected) {
        const snapshot = snapshotFromRead(read);
        await repository.pool.query(
          `INSERT INTO public.vehicle_image_asset_catalog_items (
             run_id, read_id, snapshot_fingerprint, read_camera_name,
             read_timestamp, source_status, source_path, source_kind,
             source_read_id, source_updated_at, captured_at, source_score,
             detection_confidence, detection_box, source_width, source_height,
             sampled_count, selection_metadata, prior_link_state
           ) VALUES (
             $1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10::timestamptz,
             $11::timestamptz,$12::real,$13::real,$14::jsonb,$15,$16,$17,
             $18::jsonb,$19
           ) ON CONFLICT (run_id, read_id) DO NOTHING`,
          [normalizedRunId, snapshot.id, sha256(snapshot), snapshot.camera_name,
            snapshot.timestamp, snapshot.vehicle_image_status,
            snapshot.vehicle_image_path, snapshot.vehicle_image_source_kind,
            snapshot.vehicle_image_source_read_id, snapshot.vehicle_image_updated_at,
            snapshot.vehicle_image_timestamp, snapshot.vehicle_image_score,
            snapshot.vehicle_image_detection_confidence,
            JSON.stringify(snapshot.vehicle_image_detection_box),
            snapshot.vehicle_image_width, snapshot.vehicle_image_height,
            snapshot.vehicle_image_sampled_count,
            JSON.stringify(snapshot.vehicle_image_selection_metadata ?? null),
            read.prior_link_state]
        );
      }
      const cursor = selected.length
        ? Number(selected[selected.length - 1].id)
        : Number(run.max_read_id);
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET preview_cursor_read_id = GREATEST(preview_cursor_read_id, $2),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [normalizedRunId, cursor]
      );
      return {
        materialized: selected.length,
        cursor,
        finished: cursor >= Number(run.max_read_id),
      };
    });
  }

  async reclaimExpiredClaims() {
    const result = await this.pool.query(
      `UPDATE public.vehicle_image_asset_catalog_items items
       SET status = 'failed', failure_stage = CASE
             WHEN items.status = 'previewing' THEN 'preview' ELSE 'catalog' END,
           retryable = items.attempt_count < $1,
           error_code = 'CATALOG_CLAIM_EXPIRED',
           error_details = '{"message":"Worker claim expired before completion"}'::jsonb,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN items.attempt_count < $1
             THEN CURRENT_TIMESTAMP + INTERVAL '5 seconds' ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       FROM public.vehicle_image_asset_catalog_runs runs
       WHERE runs.id = items.run_id
         AND runs.status <> 'cancelled'
         AND items.status IN ('previewing','processing')
         AND items.processing_deadline_at < CURRENT_TIMESTAMP
       RETURNING items.id`,
      [RETRY_LIMIT]
    );
    return Number(result.rowCount || 0);
  }

  async claimPreviewItem() {
    return this.withTransaction(async (repository) => {
      const claimed = await repository.pool.query(
        `WITH candidate AS (
           SELECT items.id
           FROM public.vehicle_image_asset_catalog_items items
           JOIN public.vehicle_image_asset_catalog_runs runs ON runs.id = items.run_id
           WHERE runs.phase = 'preview' AND runs.status = 'previewing'
             AND (
               items.status = 'pending_preview'
               OR (items.status = 'failed' AND items.failure_stage = 'preview'
                 AND items.retryable = TRUE
                 AND items.attempt_count < $1
                 AND (items.next_attempt_at IS NULL OR items.next_attempt_at <= CURRENT_TIMESTAMP))
             )
           ORDER BY items.read_id, items.id
           FOR UPDATE OF items, runs SKIP LOCKED
           LIMIT 1
         )
         UPDATE public.vehicle_image_asset_catalog_items items
         SET status = 'previewing', attempt_count = attempt_count + 1,
             retryable = FALSE, failure_stage = NULL, error_code = NULL,
             error_details = NULL, claim_token = gen_random_uuid(),
             heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP + ($2 || ' seconds')::interval,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate WHERE items.id = candidate.id
         RETURNING ${ITEM_SELECTION}`,
        [RETRY_LIMIT, CLAIM_SECONDS]
      );
      const item = claimed.rows?.[0] || null;
      return item ? { ...item, readSnapshot: snapshotFromItem(item) } : null;
    });
  }

  async completePreviewItem(item, preview) {
    const result = await this.pool.query(
      `UPDATE public.vehicle_image_asset_catalog_items
       SET status = 'previewed', preview_sha256 = $3,
           preview_byte_size = $4, preview_width = $5,
           preview_height = $6, canonical_path = $7,
           retryable = FALSE, failure_stage = NULL, error_code = NULL,
           error_details = NULL, claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL, next_attempt_at = NULL,
           previewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'previewing'
       RETURNING id`,
      [item.id, item.claim_token, preview.contentSha256, preview.byteSize,
        preview.imageWidth, preview.imageHeight, preview.storagePath]
    );
    return result.rowCount === 1;
  }

  async failClaimedItem(item, {
    stage,
    status = "failed",
    errorCode,
    errorDetails = {},
    retryable = false,
  } = {}) {
    const expectedStatus = stage === "preview" ? "previewing" : "processing";
    const canRetry = status === "failed"
      && retryable === true
      && Number(item.attempt_count) < RETRY_LIMIT;
    const terminalStatus = status === "failed" && retryable && !canRetry
      ? "failed"
      : status;
    const result = await this.pool.query(
      `UPDATE public.vehicle_image_asset_catalog_items
       SET status = $4, failure_stage = $5,
           retryable = $6, error_code = $7, error_details = $8::jsonb,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN $6 THEN
             CURRENT_TIMESTAMP + (LEAST(30, POWER(2, attempt_count)) || ' seconds')::interval
             ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = $3
       RETURNING id`,
      [item.id, item.claim_token, expectedStatus, terminalStatus, stage,
        canRetry, String(errorCode || "VEHICLE_IMAGE_ASSET_CATALOG_FAILED").slice(0, 80),
        JSON.stringify(safeErrorDetails(errorDetails))]
    );
    return result.rowCount === 1;
  }

  async finalizePreview(runId) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs
         WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = runResult.rows?.[0] || null;
      if (!run || run.phase !== "preview" || run.status !== "previewing") return null;
      if (Number(run.preview_cursor_read_id) < Number(run.max_read_id)) return null;
      const active = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_catalog_items
           WHERE run_id = $1 AND (
             status IN ('pending_preview','previewing')
             OR (status = 'failed' AND failure_stage = 'preview' AND retryable = TRUE)
           )
         ) AS active`,
        [normalizedRunId]
      );
      if (active.rows?.[0]?.active === true) return null;
      const itemResult = await repository.pool.query(
        `SELECT read_id, snapshot_fingerprint, read_camera_name,
                read_timestamp::text AS read_timestamp, source_status,
                source_path, source_kind, source_read_id,
                source_updated_at::text AS source_updated_at,
                captured_at::text AS captured_at, source_score,
                detection_confidence, detection_box, source_width,
                source_height, sampled_count, selection_metadata,
                prior_link_state, status, preview_sha256,
                preview_byte_size, preview_width, preview_height, error_code
         FROM public.vehicle_image_asset_catalog_items
         WHERE run_id = $1 ORDER BY read_id, id`,
        [normalizedRunId]
      );
      const fingerprint = sha256({
        runId: Number(run.id),
        maxReadId: Number(run.max_read_id),
        candidateReads: Number(run.candidate_reads),
        items: itemResult.rows || [],
      });
      const noCatalogableItems = !(itemResult.rows || [])
        .some((item) => item.status === "previewed");
      const updated = await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET phase = CASE WHEN $3 THEN 'completed' ELSE 'catalog' END,
             status = CASE WHEN $3 THEN 'completed' ELSE 'ready' END,
             completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
             preview_fingerprint = $2,
             last_error_code = NULL, last_error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND phase = 'preview' AND status = 'previewing'
         RETURNING id`,
        [normalizedRunId, fingerprint, noCatalogableItems]
      );
      if (!updated.rows?.[0]) return null;
      await repository.recordAudit({
        actorUserId: run.actor_user_id,
        eventType: "maintenance.vehicle_image_asset_catalog_preview_completed",
        resourceId: normalizedRunId,
        metadata: {
          previewFingerprint: fingerprint,
          noCatalogableItems,
          externalProviderContacted: false,
        },
      });
      return repository.getRun(normalizedRunId);
    });
  }

  async confirmBatch({ runId, previewFingerprint, limit, actorUserId }) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    const fingerprint = String(previewFingerprint || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("The exact canonical Overview preview fingerprint is required.");
    }
    const batchSize = boundedBatch(limit);
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = runResult.rows?.[0] || null;
      if (!run) throw new Error("Canonical Overview catalog preview was not found.");
      if (String(run.preview_fingerprint || "").trim() !== fingerprint) {
        throw new Error("Canonical Overview catalog preview changed; preview again before confirming.");
      }
      if (!['ready','running'].includes(run.status) || run.phase !== 'catalog') {
        throw new Error(`Canonical Overview catalog cannot queue work while ${run.status}.`);
      }
      const active = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_catalog_items
           WHERE run_id = $1 AND (
             status IN ('queued','processing')
             OR (status = 'failed' AND failure_stage = 'catalog' AND retryable = TRUE)
           )
         ) AS active`,
        [normalizedRunId]
      );
      if (active.rows?.[0]?.active === true) {
        throw new Error("Wait for the current canonical Overview batch to finish.");
      }
      const queued = await repository.pool.query(
        `WITH selected AS (
           SELECT id FROM public.vehicle_image_asset_catalog_items
           WHERE run_id = $1 AND status = 'previewed'
           ORDER BY read_id, id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE public.vehicle_image_asset_catalog_items items
         SET status = 'queued', attempt_count = 0, retryable = TRUE,
             failure_stage = NULL, error_code = NULL, error_details = NULL,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM selected WHERE items.id = selected.id
         RETURNING items.id`,
        [normalizedRunId, batchSize]
      );
      const queuedCount = Number(queued.rowCount || 0);
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET status = CASE WHEN $2 > 0 THEN 'running' ELSE status END,
             batch_size = $3, confirmed_actor_user_id = $4,
             confirmed_at = CASE WHEN $2 > 0 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [normalizedRunId, queuedCount, batchSize, actorId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_asset_catalog_batch_confirmed",
        resourceId: normalizedRunId,
        metadata: { queued: queuedCount, batchSize, previewFingerprint: fingerprint },
      });
      return { queued: queuedCount, batchSize };
    });
  }

  async claimCatalogItem() {
    return this.withTransaction(async (repository) => {
      const claimed = await repository.pool.query(
        `WITH candidate AS (
           SELECT items.id
           FROM public.vehicle_image_asset_catalog_items items
           JOIN public.vehicle_image_asset_catalog_runs runs ON runs.id = items.run_id
           WHERE runs.phase = 'catalog' AND runs.status = 'running'
             AND (
               items.status = 'queued'
               OR (items.status = 'failed' AND items.failure_stage = 'catalog'
                 AND items.retryable = TRUE
                 AND items.attempt_count < $1
                 AND (items.next_attempt_at IS NULL OR items.next_attempt_at <= CURRENT_TIMESTAMP))
             )
           ORDER BY items.read_id, items.id
           FOR UPDATE OF items, runs SKIP LOCKED LIMIT 1
         )
         UPDATE public.vehicle_image_asset_catalog_items items
         SET status = 'processing', attempt_count = attempt_count + 1,
             retryable = FALSE, failure_stage = NULL, error_code = NULL,
             error_details = NULL, claim_token = gen_random_uuid(),
             heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP + ($2 || ' seconds')::interval,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM candidate WHERE items.id = candidate.id
         RETURNING ${ITEM_SELECTION}`,
        [RETRY_LIMIT, CLAIM_SECONDS]
      );
      const item = claimed.rows?.[0] || null;
      return item ? { ...item, readSnapshot: snapshotFromItem(item) } : null;
    });
  }

  async completeCatalogItem(item, result) {
    const status = result.assetCreated || result.linkCreated || result.linkUpdated
      ? "cataloged"
      : "already_current";
    const updated = await this.pool.query(
      `UPDATE public.vehicle_image_asset_catalog_items
       SET status = $3, retryable = FALSE, failure_stage = NULL,
           error_code = NULL, error_details = NULL, asset_id = $4,
           claim_token = NULL, heartbeat_at = NULL,
           processing_deadline_at = NULL, next_attempt_at = NULL,
           cataloged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_token = $2 AND status = 'processing'
       RETURNING id`,
      [item.id, item.claim_token, status, result.asset?.id ?? null]
    );
    return updated.rowCount === 1;
  }

  async settleCatalogRun(runId) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs
         WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = runResult.rows?.[0] || null;
      if (!run || run.phase !== "catalog" || run.status !== "running") return null;
      const state = await repository.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'previewed')::integer AS remaining,
           COUNT(*) FILTER (WHERE status IN ('queued','processing') OR
             (status = 'failed' AND failure_stage = 'catalog' AND retryable = TRUE))::integer AS active
         FROM public.vehicle_image_asset_catalog_items WHERE run_id = $1`,
        [normalizedRunId]
      );
      const counts = state.rows?.[0] || {};
      if (Number(counts.active || 0) > 0) return null;
      const completed = Number(counts.remaining || 0) === 0;
      const updated = await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET status = $2, phase = $3,
             completed_at = CASE WHEN $2 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'running'
         RETURNING id`,
        [normalizedRunId, completed ? "completed" : "ready", completed ? "completed" : "catalog"]
      );
      if (updated.rowCount === 1 && completed) {
        await repository.recordAudit({
          actorUserId: run.confirmed_actor_user_id || run.actor_user_id,
          eventType: "maintenance.vehicle_image_asset_catalog_completed",
          resourceId: normalizedRunId,
          metadata: { externalProviderContacted: false },
        });
      }
      return repository.getRun(normalizedRunId);
    });
  }

  async setPaused({ runId, paused, actorUserId }) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = runResult.rows?.[0] || null;
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) {
        throw new Error("Canonical Overview catalog run is no longer active.");
      }
      let status = "paused";
      if (!paused) {
        if (run.phase === "preview") status = "previewing";
        else {
          const active = await repository.pool.query(
            `SELECT EXISTS (SELECT 1 FROM public.vehicle_image_asset_catalog_items
             WHERE run_id = $1 AND (status IN ('queued','processing') OR
               (status = 'failed' AND failure_stage = 'catalog' AND retryable = TRUE))) AS active`,
            [normalizedRunId]
          );
          status = active.rows?.[0]?.active === true ? "running" : "ready";
        }
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET status = $2::varchar(16),
             paused_at = CASE WHEN $2::varchar(16) = 'paused'
               THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [normalizedRunId, status]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: paused
          ? "maintenance.vehicle_image_asset_catalog_paused"
          : "maintenance.vehicle_image_asset_catalog_resumed",
        resourceId: normalizedRunId,
        metadata: { phase: run.phase },
      });
      return repository.getRun(normalizedRunId);
    });
  }

  async cancel({ runId, actorUserId }) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      const runResult = await repository.pool.query(
        `SELECT * FROM public.vehicle_image_asset_catalog_runs
         WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const currentRun = runResult.rows?.[0] || null;
      if (!currentRun || !ACTIVE_RUN_STATUSES.includes(currentRun.status)) {
        throw new Error("Canonical Overview catalog run is no longer active.");
      }
      const claimed = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_catalog_items
           WHERE run_id = $1 AND status IN ('previewing','processing')
         ) AS active`,
        [normalizedRunId]
      );
      if (claimed.rows?.[0]?.active === true) {
        throw new Error("Wait for the current canonical Overview item to finish before cancelling.");
      }
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_runs
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [normalizedRunId]
      );
      const cancelled = await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_items
         SET status = 'cancelled', retryable = FALSE, claim_token = NULL,
             heartbeat_at = NULL, processing_deadline_at = NULL,
             next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND status IN ('pending_preview','previewed','queued','failed')
         RETURNING id`,
        [normalizedRunId]
      );
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_asset_catalog_cancelled",
        resourceId: normalizedRunId,
        metadata: { cancelledItems: Number(cancelled.rowCount || 0) },
      });
      return { cancelled: Number(cancelled.rowCount || 0) };
    });
  }

  async retryItem({ jobId, actorUserId }) {
    const itemId = positiveInteger(jobId, "Catalog job id");
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-image-asset-catalog-campaign'))"
      );
      const itemResult = await repository.pool.query(
        `SELECT items.*, runs.phase AS run_phase, runs.status AS run_status
         FROM public.vehicle_image_asset_catalog_items items
         JOIN public.vehicle_image_asset_catalog_runs runs ON runs.id = items.run_id
         WHERE items.id = $1 FOR UPDATE OF items, runs`,
        [itemId]
      );
      const item = itemResult.rows?.[0] || null;
      if (!item || !["failed", "unavailable"].includes(item.status)) {
        throw new Error("Only a terminal catalog failure can be retried.");
      }
      if (item.run_status === "cancelled") {
        throw new Error("A cancelled canonical Overview catalog run cannot be reopened.");
      }
      if (!["ready", "completed", "failed"].includes(item.run_status)) {
        throw new Error("Wait for active canonical Overview catalog work to finish before retrying an item.");
      }
      const active = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_catalog_items
           WHERE run_id = $1 AND id <> $2 AND (
             status IN ('pending_preview','previewing','queued','processing')
             OR (status = 'failed' AND retryable = TRUE)
           )
         ) AS active_items,
         EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_catalog_runs
           WHERE id <> $1 AND status = ANY($3::text[])
         ) AS other_active_run`,
        [item.run_id, itemId, ACTIVE_RUN_STATUSES]
      );
      if (
        active.rows?.[0]?.active_items === true
        || active.rows?.[0]?.other_active_run === true
      ) {
        throw new Error("Wait for active canonical Overview catalog work to finish before retrying an item.");
      }
      if (item.retryable === true || Number(item.operator_retry_count) >= OPERATOR_RETRY_LIMIT) {
        throw new Error("This catalog item is not eligible for another manual retry.");
      }
      const stage = item.failure_stage || (item.preview_sha256 ? "catalog" : "preview");
      const nextStatus = stage === "preview" ? "pending_preview" : "queued";
      await repository.pool.query(
        `UPDATE public.vehicle_image_asset_catalog_items
         SET status = $2, attempt_count = 0, operator_retry_count = operator_retry_count + 1,
             retryable = TRUE, failure_stage = NULL, error_code = NULL,
             error_details = NULL, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [itemId, nextStatus]
      );
      if (stage === "preview") {
        await repository.pool.query(
          `UPDATE public.vehicle_image_asset_catalog_runs
           SET phase = 'preview', status = 'previewing', preview_fingerprint = NULL,
               completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [item.run_id]
        );
      } else {
        await repository.pool.query(
          `UPDATE public.vehicle_image_asset_catalog_runs
           SET phase = 'catalog', status = 'running', completed_at = NULL,
               updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [item.run_id]
        );
      }
      await repository.recordAudit({
        actorUserId: actorId,
        eventType: "maintenance.vehicle_image_asset_catalog_item_retried",
        resourceId: item.run_id,
        metadata: { jobId: itemId, readId: Number(item.read_id), stage },
      });
      return { runId: Number(item.run_id), jobId: itemId, stage };
    });
  }

  async getRun(runId) {
    const normalizedRunId = positiveInteger(runId, "Catalog run id");
    const runResult = await this.pool.query(
      `SELECT * FROM public.vehicle_image_asset_catalog_runs WHERE id = $1`,
      [normalizedRunId]
    );
    const run = runResult.rows?.[0] || null;
    if (!run) return null;
    const countsResult = await this.pool.query(
      `WITH item_counts AS (
         SELECT
           COUNT(*)::integer AS total,
           COUNT(*) FILTER (WHERE status = 'pending_preview')::integer AS pending_preview,
           COUNT(*) FILTER (WHERE status = 'previewing')::integer AS previewing,
           COUNT(*) FILTER (WHERE status = 'previewed')::integer AS previewed,
           COUNT(*) FILTER (WHERE status = 'queued')::integer AS queued,
           COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
           COUNT(*) FILTER (WHERE status = 'cataloged')::integer AS cataloged,
           COUNT(*) FILTER (WHERE status = 'already_current')::integer AS already_current,
           COUNT(*) FILTER (WHERE status = 'superseded')::integer AS superseded,
           COUNT(*) FILTER (WHERE status = 'unavailable')::integer AS unavailable,
           COUNT(*) FILTER (WHERE status = 'invalid')::integer AS invalid,
           COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
           COUNT(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled,
           COUNT(*) FILTER (WHERE retryable = TRUE)::integer AS retryable,
           COUNT(*) FILTER (WHERE source_kind <> 'entry_overview_route_fallback')::integer
             AS identity_eligible,
           COUNT(*) FILTER (WHERE source_kind = 'entry_overview_route_fallback')::integer
             AS display_only,
           COUNT(*) FILTER (WHERE prior_link_state = 'stale')::integer AS stale_links,
           COUNT(*) FILTER (WHERE prior_link_state = 'absent')::integer AS missing_links,
           COALESCE(SUM(preview_byte_size), 0)::bigint AS logical_source_bytes
         FROM public.vehicle_image_asset_catalog_items WHERE run_id = $1
       ), unique_preview AS (
         SELECT preview_sha256, MAX(preview_byte_size)::bigint AS byte_size
         FROM public.vehicle_image_asset_catalog_items
         WHERE run_id = $1 AND preview_sha256 IS NOT NULL
         GROUP BY preview_sha256
       ), preview_bytes AS (
         SELECT COUNT(*)::integer AS unique_hashes,
                COALESCE(SUM(unique_preview.byte_size), 0)::bigint AS unique_bytes,
                COALESCE(SUM(unique_preview.byte_size)
                  FILTER (WHERE assets.id IS NOT NULL), 0)::bigint AS existing_asset_bytes,
                COALESCE(SUM(unique_preview.byte_size)
                  FILTER (WHERE assets.id IS NULL), 0)::bigint AS projected_new_bytes
         FROM unique_preview
         LEFT JOIN public.vehicle_image_assets assets
           ON assets.content_sha256 = unique_preview.preview_sha256
       )
       SELECT item_counts.*, preview_bytes.*,
              GREATEST(0, item_counts.logical_source_bytes
                - preview_bytes.projected_new_bytes)::bigint AS duplicate_bytes_avoided
       FROM item_counts CROSS JOIN preview_bytes`,
      [normalizedRunId]
    );
    return { ...run, counts: countsResult.rows?.[0] || {} };
  }

  async getLatestRun() {
    const result = await this.pool.query(
      `SELECT id FROM public.vehicle_image_asset_catalog_runs
       ORDER BY CASE WHEN status = ANY($1::text[]) THEN 0 ELSE 1 END,
                created_at DESC, id DESC LIMIT 1`,
      [ACTIVE_RUN_STATUSES]
    );
    return result.rows?.[0] ? this.getRun(result.rows[0].id) : null;
  }

  async getOverview() {
    const [latestRun, catalogResult] = await Promise.all([
      this.getLatestRun(),
      this.pool.query(
        `WITH eligible AS (
           SELECT reads.id, links.asset_id, links.identity_eligible,
                  CASE WHEN links.read_id IS NOT NULL
                    AND reads.vehicle_image_path = links.source_path_snapshot
                    AND reads.vehicle_image_source_kind = links.source_kind
                    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
                    THEN TRUE ELSE FALSE END AS current_link
           FROM public.plate_reads reads
           LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
           WHERE reads.vehicle_image_status = 'ready'
             AND NULLIF(BTRIM(reads.vehicle_image_path), '') IS NOT NULL
             AND reads.vehicle_image_source_kind = ANY($1::text[])
         ), asset_totals AS (
           SELECT COUNT(*)::bigint AS asset_count,
                  COALESCE(SUM(byte_size), 0)::bigint AS asset_bytes
           FROM public.vehicle_image_assets
         ), link_totals AS (
           SELECT COUNT(*)::bigint AS read_links,
                  COUNT(*) FILTER (WHERE reads.vehicle_image_status = 'ready'
                    AND reads.vehicle_image_path = links.source_path_snapshot
                    AND reads.vehicle_image_source_kind = links.source_kind
                    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
                  )::bigint AS current_links,
                  COUNT(*) FILTER (WHERE (
                    reads.vehicle_image_status = 'ready'
                    AND reads.vehicle_image_path = links.source_path_snapshot
                    AND reads.vehicle_image_source_kind = links.source_kind
                    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
                  ) IS NOT TRUE)::bigint AS stale_links,
                  COUNT(*) FILTER (WHERE links.identity_eligible = TRUE
                    AND reads.vehicle_image_status = 'ready'
                    AND reads.vehicle_image_path = links.source_path_snapshot
                    AND reads.vehicle_image_source_kind = links.source_kind
                    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
                  )::bigint AS identity_eligible_links,
                  COUNT(*) FILTER (WHERE links.identity_eligible = FALSE
                    AND reads.vehicle_image_status = 'ready'
                    AND reads.vehicle_image_path = links.source_path_snapshot
                    AND reads.vehicle_image_source_kind = links.source_kind
                    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
                  )::bigint AS display_only_links
           FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
         ), zero_links AS (
           SELECT COUNT(*)::bigint AS zero_link_asset_count,
                  COALESCE(SUM(assets.byte_size), 0)::bigint AS zero_link_asset_bytes
           FROM public.vehicle_image_assets assets
           WHERE NOT EXISTS (SELECT 1 FROM public.vehicle_image_asset_reads links
             WHERE links.asset_id = assets.id)
         ), eligible_totals AS (
           SELECT COUNT(eligible.id)::bigint AS eligible_reads
           FROM eligible
         )
         SELECT eligible_totals.*, asset_totals.*, link_totals.*, zero_links.*
         FROM eligible_totals CROSS JOIN asset_totals
         CROSS JOIN link_totals CROSS JOIN zero_links`,
        [OVERVIEW_ASSET_SOURCE_KINDS]
      ),
    ]);
    const retryResult = latestRun
      ? await this.pool.query(
        `SELECT items.id, items.read_id, items.error_code,
                items.failure_stage, items.operator_retry_count
         FROM public.vehicle_image_asset_catalog_items items
         JOIN public.vehicle_image_asset_catalog_runs runs ON runs.id = items.run_id
         WHERE items.run_id = $2
           AND items.status IN ('failed','unavailable')
           AND items.retryable = FALSE
           AND items.operator_retry_count < $1
           AND runs.status <> 'cancelled'
         ORDER BY items.updated_at DESC, items.id DESC LIMIT 25`,
        [OPERATOR_RETRY_LIMIT, latestRun.id]
      )
      : { rows: [] };
    return {
      latestRun,
      catalog: catalogResult.rows?.[0] || {},
      retryCandidates: retryResult.rows || [],
      retention: {
        policy: "archival",
        zeroLinkAssetCount: Number(catalogResult.rows?.[0]?.zero_link_asset_count || 0),
        zeroLinkAssetBytes: Number(catalogResult.rows?.[0]?.zero_link_asset_bytes || 0),
      },
    };
  }
}

export const vehicleImageAssetCatalogCampaignRepositoryInternals = Object.freeze({
  ACTIVE_RUN_STATUSES,
  RETRY_LIMIT,
  OPERATOR_RETRY_LIMIT,
  READ_SELECTION,
  CANDIDATE_PREDICATE,
  canonicalJson,
  sha256,
  snapshotFromRead,
  snapshotFromItem,
});
