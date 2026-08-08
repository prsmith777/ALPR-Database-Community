import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { isPathInside, resolveStoragePath } from "./storage-path.mjs";
import { normalizeStorageRelativePath } from "./storage-reconciliation.mjs";
import {
  STORAGE_CLEANUP_LOCK_NAME,
  unlockAndReleaseStorageCleanupClient,
} from "./storage-maintenance-lock.mjs";

export const STORAGE_CLEANUP_CONFIRMATION = "DELETE DERIVED ORPHANS";
export const STORAGE_CLEANUP_TOKEN_TTL_SECONDS = 900;
export const STORAGE_CLEANUP_JOB = "storage-cleanup";
export { STORAGE_CLEANUP_LOCK_NAME };

const REFERENCE_CHECK_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM public.plate_reads WHERE REPLACE(image_path, E'\\\\', '/') = $1
    UNION ALL
    SELECT 1 FROM public.plate_reads WHERE REPLACE(thumbnail_path, E'\\\\', '/') = $1
    UNION ALL
    SELECT 1 FROM public.plate_reads WHERE REPLACE(vehicle_image_path, E'\\\\', '/') = $1
    UNION ALL
    SELECT 1 FROM public.vehicle_overview_candidates WHERE REPLACE(frame_path, E'\\\\', '/') = $1
    UNION ALL
    SELECT 1 FROM public.capture_assets WHERE REPLACE(source_image_path, E'\\\\', '/') = $1
    UNION ALL
    SELECT 1 FROM public.capture_assets WHERE REPLACE(derived_path, E'\\\\', '/') = $1
  ) AS referenced`;

async function getDefaultPool() {
  return (await import("./db.js")).getPool();
}

function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function actorId(actor) {
  const value = Number(actor?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeError(error) {
  return String(error?.message || error || "Storage cleanup failed").slice(0, 2000);
}

async function acquireTransactionCleanupLock(client) {
  const result = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
    [STORAGE_CLEANUP_LOCK_NAME]
  );
  if (!result.rows?.[0]?.locked) throw new Error("Another storage cleanup operation is already running");
}

function normalizeDerivedCandidate(item = {}) {
  const relativePath = normalizeStorageRelativePath(item.relative_path ?? item.relativePath);
  if (!relativePath.startsWith("derived/")) throw new Error("Only derived-file orphans can be cleaned up manually");
  const sizeBytes = Number(item.size_bytes ?? item.observed_size_bytes ?? item.observedSizeBytes);
  const modifiedAt = new Date(item.modified_at ?? item.observed_modified_at ?? item.observedModifiedAt);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || Number.isNaN(modifiedAt.getTime())) {
    throw new Error("Cleanup candidate metadata is invalid");
  }
  return { relativePath, sizeBytes, modifiedAt: modifiedAt.toISOString() };
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function createStorageCleanupPreview({
  pool,
  actor = null,
  now = new Date(),
  graceSeconds = 604_800,
  tokenFactory = () => randomBytes(32).toString("hex"),
} = {}) {
  const database = pool || await getDefaultPool();
  const current = new Date(now);
  const graceCutoff = new Date(current.getTime() - Math.max(86_400, Number(graceSeconds) || 604_800) * 1000);
  return withTransaction(database, async (client) => {
    await acquireTransactionCleanupLock(client);
    const findings = await client.query(
      `SELECT item.relative_path, item.size_bytes, item.modified_at
       FROM public.storage_reconciliation_items item
       JOIN public.storage_reconciliation_runs reconciliation ON reconciliation.id = item.run_id
       WHERE reconciliation.id = (
         SELECT id FROM public.storage_reconciliation_runs
         WHERE status = 'completed' ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1
       )
         AND item.finding_type = 'orphan-file'
         AND item.relative_path LIKE 'derived/%'
         AND item.modified_at <= $1
       ORDER BY item.relative_path`,
      [graceCutoff]
    );
    const candidates = (findings.rows || []).map(normalizeDerivedCandidate);
    const candidateBytes = candidates.reduce((total, item) => total + item.sizeBytes, 0);
    const run = await client.query(
      `INSERT INTO public.maintenance_runs (
         job_name, trigger_type, mode, status, actor_user_id,
         candidate_count, candidate_bytes, configuration, result
       ) VALUES ($1, 'manual', 'preview', 'previewed', $2::bigint, $3, $4,
         $5::jsonb, $6::jsonb) RETURNING id, created_at`,
      [
        STORAGE_CLEANUP_JOB,
        actorId(actor),
        candidates.length,
        candidateBytes,
        JSON.stringify({ categories: ["derived"], graceSeconds: Math.max(86_400, Number(graceSeconds) || 604_800) }),
        JSON.stringify({ destructive: false, sourceReconciliationRequired: true }),
      ]
    );
    const runId = Number(run.rows[0].id);
    if (candidates.length) {
      await client.query(
        `INSERT INTO public.maintenance_cleanup_items (
           run_id, relative_path, category, observed_size_bytes, observed_modified_at
         )
         SELECT $1, path, 'derived', size_bytes, modified_at
         FROM unnest($2::text[], $3::bigint[], $4::timestamptz[])
           AS candidate(path, size_bytes, modified_at)`,
        [
          runId,
          candidates.map((item) => item.relativePath),
          candidates.map((item) => item.sizeBytes),
          candidates.map((item) => item.modifiedAt),
        ]
      );
    }
    const previewToken = tokenFactory();
    const expiresAt = new Date(current.getTime() + STORAGE_CLEANUP_TOKEN_TTL_SECONDS * 1000);
    await client.query(
      `INSERT INTO public.maintenance_cleanup_tokens (
         token_hash, preview_run_id, confirmation_phrase, expires_at
       ) VALUES ($1, $2, $3, $4)`,
      [tokenHash(previewToken), runId, STORAGE_CLEANUP_CONFIRMATION, expiresAt]
    );
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1::bigint, 'browser', 'maintenance.storage_cleanup_previewed',
         'maintenance-run', $2, 'succeeded', $3::jsonb)`,
      [actorId(actor), String(runId), JSON.stringify({ candidateCount: candidates.length, candidateBytes, categories: ["derived"] })]
    );
    return {
      runId,
      previewToken,
      confirmationPhrase: STORAGE_CLEANUP_CONFIRMATION,
      expiresAt: expiresAt.toISOString(),
      candidateCount: candidates.length,
      candidateBytes,
      categories: ["derived"],
      destructive: false,
    };
  });
}

async function claimCleanupExecution({ pool, previewToken, confirmation, actor, now }) {
  if (String(confirmation || "") !== STORAGE_CLEANUP_CONFIRMATION) {
    throw new Error(`Type ${STORAGE_CLEANUP_CONFIRMATION} to confirm cleanup`);
  }
  return withTransaction(pool, async (client) => {
    const claimed = await client.query(
      `SELECT token.preview_run_id, token.confirmation_phrase, token.expires_at,
              preview.candidate_count, preview.candidate_bytes
       FROM public.maintenance_cleanup_tokens token
       JOIN public.maintenance_runs preview ON preview.id = token.preview_run_id
       WHERE token.token_hash = $1 AND token.consumed_at IS NULL
         AND preview.actor_user_id IS NOT DISTINCT FROM $2::bigint
       FOR UPDATE OF token`,
      [tokenHash(previewToken), actorId(actor)]
    );
    const token = claimed.rows?.[0];
    if (!token) throw new Error("Cleanup preview token is invalid or has already been used");
    if (new Date(token.expires_at) <= new Date(now)) throw new Error("Cleanup preview token has expired");
    if (token.confirmation_phrase !== STORAGE_CLEANUP_CONFIRMATION) throw new Error("Cleanup confirmation does not match this preview");
    const execution = await client.query(
      `INSERT INTO public.maintenance_runs (
         job_name, trigger_type, mode, status, actor_user_id, preview_run_id,
         started_at, candidate_count, candidate_bytes, configuration
       ) VALUES ($1, 'manual', 'execute', 'running', $2::bigint, $3, $4, $5, $6,
         '{"categories":["derived"],"automatic":false}'::jsonb)
       RETURNING id`,
      [STORAGE_CLEANUP_JOB, actorId(actor), token.preview_run_id, now, token.candidate_count, token.candidate_bytes]
    );
    const executionRunId = Number(execution.rows[0].id);
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1::bigint, 'browser', 'maintenance.storage_cleanup_started',
         'maintenance-run', $2, 'succeeded', $3::jsonb)`,
      [
        actorId(actor),
        String(executionRunId),
        JSON.stringify({
          previewRunId: Number(token.preview_run_id),
          candidateCount: Number(token.candidate_count),
          candidateBytes: Number(token.candidate_bytes),
          categories: ["derived"],
          automatic: false,
        }),
      ]
    );
    await client.query(
      `INSERT INTO public.maintenance_cleanup_items (
         run_id, relative_path, category, observed_size_bytes, observed_modified_at
       ) SELECT $1, relative_path, category, observed_size_bytes, observed_modified_at
         FROM public.maintenance_cleanup_items WHERE run_id = $2`,
      [executionRunId, token.preview_run_id]
    );
    await client.query(
      "UPDATE public.maintenance_cleanup_tokens SET consumed_at = $2 WHERE token_hash = $1",
      [tokenHash(previewToken), now]
    );
    const items = await client.query(
      "SELECT * FROM public.maintenance_cleanup_items WHERE run_id = $1 ORDER BY id",
      [executionRunId]
    );
    return { executionRunId, previewRunId: Number(token.preview_run_id), items: items.rows || [] };
  });
}

async function assertNoSymlinkComponents({ storagePath, relativePath, fileLstat }) {
  const root = path.resolve(storagePath);
  const rootInfo = await fileLstat(root);
  if (rootInfo?.isSymbolicLink?.()) throw new Error("Storage root cannot be a symbolic link");
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const info = await fileLstat(current);
    if (info?.isSymbolicLink?.()) throw new Error("Cleanup paths cannot contain symbolic links");
  }
}

export async function validateAndDeleteCleanupCandidate({
  query,
  storagePath,
  item,
  fileLstat = lstat,
  resolveRealPath = realpath,
  removeFile = unlink,
} = {}) {
  const candidate = normalizeDerivedCandidate(item);
  const fullPath = resolveStoragePath(storagePath, candidate.relativePath, ["derived"]);
  const derivedRoot = path.join(storagePath, "derived");
  let before;
  try {
    await assertNoSymlinkComponents({ storagePath, relativePath: candidate.relativePath, fileLstat });
    before = await fileLstat(fullPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "skipped-missing", reclaimedBytes: 0 };
    throw error;
  }
  if (!before?.isFile?.() || before?.isSymbolicLink?.()) return { status: "skipped-unsafe", reclaimedBytes: 0 };
  if (Number(before.nlink || 1) !== 1) return { status: "skipped-unsafe", reclaimedBytes: 0 };
  if (Number(before.size) !== candidate.sizeBytes || new Date(before.mtime).getTime() !== new Date(candidate.modifiedAt).getTime()) {
    return { status: "skipped-changed", reclaimedBytes: 0 };
  }
  const [realRoot, realCandidate] = await Promise.all([resolveRealPath(derivedRoot), resolveRealPath(fullPath)]);
  if (!isPathInside(realRoot, realCandidate)) return { status: "skipped-unsafe", reclaimedBytes: 0 };
  const reference = await query(REFERENCE_CHECK_SQL, [candidate.relativePath]);
  if (Boolean(reference.rows?.[0]?.referenced)) return { status: "skipped-referenced", reclaimedBytes: 0 };
  const finalCheck = await fileLstat(fullPath);
  if (
    !finalCheck?.isFile?.() || finalCheck?.isSymbolicLink?.() ||
    Number(finalCheck.nlink || 1) !== 1 ||
    Number(finalCheck.size) !== candidate.sizeBytes ||
    new Date(finalCheck.mtime).getTime() !== new Date(candidate.modifiedAt).getTime() ||
    (before.dev != null && finalCheck.dev != null && before.dev !== finalCheck.dev) ||
    (before.ino != null && finalCheck.ino != null && before.ino !== finalCheck.ino)
  ) {
    return { status: "skipped-changed", reclaimedBytes: 0 };
  }
  await removeFile(fullPath);
  return { status: "deleted", reclaimedBytes: candidate.sizeBytes };
}

export async function processCleanupCandidateTransaction({
  client,
  runId,
  item,
  storagePath,
  completedAt = () => new Date(),
  deleteCandidate = validateAndDeleteCleanupCandidate,
  lockTimeoutMs = null,
  statementTimeoutMs = null,
} = {}) {
  if (!client || typeof client.query !== "function") throw new Error("Cleanup candidate processing requires a database client");
  const applyTimeouts = async () => {
    if (!Number.isFinite(lockTimeoutMs) && !Number.isFinite(statementTimeoutMs)) return;
    const lockBudget = Math.max(1, Math.floor(Number(lockTimeoutMs) || 1));
    const statementBudget = Math.max(lockBudget, Math.floor(Number(statementTimeoutMs) || lockBudget));
    await client.query(
      "SELECT set_config('lock_timeout', $1, TRUE), set_config('statement_timeout', $2, TRUE)",
      [`${lockBudget}ms`, `${statementBudget}ms`]
    );
  };
  let outcome = null;
  try {
    await client.query("BEGIN");
    await applyTimeouts();
    await client.query("LOCK TABLE public.plate_reads, public.capture_assets IN SHARE MODE");
    outcome = await deleteCandidate({
      query: (text, values) => client.query(text, values),
      storagePath,
      item,
    });
    await client.query(
      `UPDATE public.maintenance_cleanup_items SET
         status = $3, reclaimed_bytes = $4, error = $5, completed_at = $6
       WHERE run_id = $1 AND id = $2`,
      [runId, item.id, outcome.status, outcome.reclaimedBytes || 0, outcome.error || null, completedAt()]
    );
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    const reconciliationRequired = outcome?.status === "deleted";
    const message = reconciliationRequired
      ? `Post-unlink bookkeeping failed; reconciliation is required: ${safeError(error)}`
      : safeError(error);
    try {
      await client.query("BEGIN");
      await applyTimeouts();
      await client.query(
        `UPDATE public.maintenance_cleanup_items SET
           status = 'failed', reclaimed_bytes = $3, error = $4, completed_at = $5
         WHERE run_id = $1 AND id = $2`,
        [runId, item.id, reconciliationRequired ? Number(item.observed_size_bytes || 0) : 0, message, completedAt()]
      );
      await client.query("COMMIT");
    } catch (bookkeepingError) {
      try { await client.query("ROLLBACK"); } catch {}
      const combined = new Error(`${message}; failure status could not be persisted: ${safeError(bookkeepingError)}`);
      combined.cause = error;
      throw combined;
    }
    return {
      status: "failed",
      reclaimedBytes: reconciliationRequired ? Number(item.observed_size_bytes || 0) : 0,
      error: message,
      reconciliationRequired,
    };
  }
}

export async function executeStorageCleanupPreview({
  pool,
  storagePath,
  previewToken,
  confirmation,
  actor = null,
  now = () => new Date(),
  deleteCandidate = validateAndDeleteCleanupCandidate,
  processCandidate = processCleanupCandidateTransaction,
} = {}) {
  if (!storagePath) throw new Error("Storage cleanup requires a storage path");
  const database = pool || await getDefaultPool();
  const lockClient = await database.connect();
  let locked = false;
  let executionError = null;
  const startedAt = now();
  let claim = null;
  try {
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [STORAGE_CLEANUP_LOCK_NAME]
    );
    locked = Boolean(lock.rows?.[0]?.locked);
    if (!locked) throw new Error("Another storage cleanup operation is already running");
    claim = await claimCleanupExecution({
      pool: database,
      previewToken,
      confirmation,
      actor,
      now: startedAt,
    });
    let reclaimedBytes = 0;
    let failureCount = 0;
    let reconciliationRequired = false;
    const counts = {};
    for (const item of claim.items) {
      const outcome = await processCandidate({
        client: lockClient,
        runId: claim.executionRunId,
        storagePath,
        item,
        completedAt: now,
        deleteCandidate,
      });
      reclaimedBytes += Number(outcome.reclaimedBytes) || 0;
      if (outcome.status === "failed") failureCount += 1;
      if (outcome.reconciliationRequired) reconciliationRequired = true;
      counts[outcome.status] = (counts[outcome.status] || 0) + 1;
    }
    const completedAt = now();
    const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
    const status = failureCount ? "failed" : "completed";
    const lastError = failureCount ? `${failureCount} cleanup item(s) failed` : null;
    await lockClient.query("BEGIN");
    await lockClient.query(
    `UPDATE public.maintenance_runs SET
       status = $2, completed_at = $3, duration_ms = $4,
       reclaimed_bytes = $5, failure_count = $6, last_error = $7,
       result = $8::jsonb, updated_at = $3
     WHERE id = $1`,
    [claim.executionRunId, status, completedAt, durationMs, reclaimedBytes, failureCount, lastError, JSON.stringify({ counts, reconciliationRequired })]
  );
    await lockClient.query(
    `INSERT INTO public.audit_events (
       actor_user_id, source, event_type, resource_type, resource_id, outcome, reason, metadata
     ) VALUES ($1::bigint, 'browser', 'maintenance.storage_cleanup_executed',
       'maintenance-run', $2, $3, $4, $5::jsonb)`,
    [
      actorId(actor),
      String(claim.executionRunId),
      failureCount ? "failed" : "succeeded",
      lastError,
      JSON.stringify({ previewRunId: claim.previewRunId, reclaimedBytes, failureCount, counts, reconciliationRequired, categories: ["derived"] }),
    ]
  );
    await lockClient.query("COMMIT");
    return {
      runId: claim.executionRunId,
      previewRunId: claim.previewRunId,
      status,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs,
      reclaimedBytes,
      failureCount,
      counts,
    };
  } catch (error) {
    executionError = error;
    try { await lockClient.query("ROLLBACK"); } catch {}
    if (claim?.executionRunId) {
      const failedAt = now();
      const message = `Cleanup interrupted; filesystem reconciliation is required: ${safeError(error)}`;
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `UPDATE public.maintenance_cleanup_items SET
             status = 'failed', error = $2, completed_at = $3
           WHERE run_id = $1 AND status = 'candidate'`,
          [claim.executionRunId, message, failedAt]
        );
        await lockClient.query(
          `UPDATE public.maintenance_runs SET
             status = 'failed', completed_at = $2,
             duration_ms = $3, last_error = $4,
             failure_count = GREATEST(failure_count, 1),
             result = result || '{"reconciliationRequired":true}'::jsonb,
             updated_at = $2 WHERE id = $1`,
          [
            claim.executionRunId,
            failedAt,
            Math.max(0, new Date(failedAt).getTime() - new Date(startedAt).getTime()),
            message,
          ]
        );
        await lockClient.query(
          `INSERT INTO public.audit_events (
             actor_user_id, source, event_type, resource_type, resource_id,
             outcome, reason, metadata
           ) VALUES ($1::bigint, 'system', 'maintenance.storage_cleanup_interrupted',
             'maintenance-run', $2, 'failed', $3,
             jsonb_build_object('reconciliationRequired', true))`,
          [actorId(actor), String(claim.executionRunId), message]
        );
        await lockClient.query("COMMIT");
      } catch {
        try { await lockClient.query("ROLLBACK"); } catch {}
        // The durable running record and consumed token make an interrupted
        // run visible even if the database is unavailable during recovery.
      }
    }
    throw error;
  } finally {
    if (locked) {
      const unlockError = await unlockAndReleaseStorageCleanupClient(lockClient);
      if (unlockError && !executionError) throw unlockError;
    } else {
      lockClient.release();
    }
  }
}

export async function getStorageCleanupOverview({ executor } = {}) {
  const database = executor || await getDefaultPool();
  const result = await database.query(
    `SELECT id, trigger_type, mode, status, actor_user_id, preview_run_id,
            source_reconciliation_run_id,
            started_at, completed_at, duration_ms, candidate_count, candidate_bytes,
            reclaimed_bytes, failure_count, last_error, configuration, result, created_at
     FROM public.maintenance_runs WHERE job_name = $1
     ORDER BY created_at DESC, id DESC LIMIT 20`,
    [STORAGE_CLEANUP_JOB]
  );
  return (result.rows || []).map((row) => ({
    id: Number(row.id), triggerType: row.trigger_type, mode: row.mode, status: row.status,
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    previewRunId: row.preview_run_id == null ? null : Number(row.preview_run_id),
    sourceReconciliationRunId: row.source_reconciliation_run_id == null ? null : Number(row.source_reconciliation_run_id),
    startedAt: row.started_at, completedAt: row.completed_at,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    candidateCount: Number(row.candidate_count), candidateBytes: Number(row.candidate_bytes),
    reclaimedBytes: Number(row.reclaimed_bytes), failureCount: Number(row.failure_count),
    lastError: row.last_error, configuration: row.configuration || {}, result: row.result || {},
    createdAt: row.created_at,
  }));
}

export async function recoverInterruptedStorageCleanupRuns({ executor, now = new Date(), staleMinutes = 30 } = {}) {
  const database = executor || await getDefaultPool();
  if (typeof database.connect !== "function") throw new Error("Interrupted cleanup recovery requires a database pool");
  const client = await database.connect();
  let locked = false;
  const message = "Cleanup execution stopped before completion; run storage reconciliation before another cleanup.";
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [STORAGE_CLEANUP_LOCK_NAME]
    );
    locked = Boolean(lock.rows?.[0]?.locked);
    if (!locked) return [];
    const result = await client.query(
    `WITH interrupted AS (
       UPDATE public.maintenance_runs SET
         status = 'failed', completed_at = $1::timestamptz,
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - started_at)) * 1000)::bigint,
         failure_count = GREATEST(failure_count, 1), last_error = $3,
         result = result || '{"reconciliationRequired":true}'::jsonb,
         updated_at = $1::timestamptz
       WHERE job_name = $2 AND mode = 'execute' AND status = 'running'
         AND started_at < $1::timestamptz - make_interval(mins => $4::integer)
       RETURNING id, actor_user_id, trigger_type, configuration,
                 source_reconciliation_run_id, started_at
     ), automatic_interrupted AS (
       SELECT * FROM interrupted
       WHERE trigger_type = 'scheduled'
          OR configuration @> '{"automatic":true}'::jsonb
     ), marked_items AS (
       UPDATE public.maintenance_cleanup_items item SET
         status = 'failed', error = $3, completed_at = $1::timestamptz
       FROM interrupted WHERE item.run_id = interrupted.id AND item.status = 'candidate'
       RETURNING item.run_id
     ), automatic_breaker AS (
       UPDATE public.storage_cleanup_automatic_state state SET
         next_run_at = NULL,
         last_run_id = automatic.id,
         source_reconciliation_run_id = automatic.source_reconciliation_run_id,
         circuit_breaker_open = TRUE,
         circuit_breaker_opened_at = $1::timestamptz,
         circuit_breaker_reason = $3,
         circuit_breaker_run_id = automatic.id,
         acknowledged_at = NULL,
         acknowledged_by_user_id = NULL,
         acknowledged_run_id = NULL,
         acknowledgement_reconciliation_run_id = NULL,
         updated_at = $1::timestamptz
       FROM (
         SELECT * FROM automatic_interrupted ORDER BY id DESC LIMIT 1
       ) automatic
       WHERE state.category = 'derived-orphans'
       RETURNING state.category
     ), reconciliation_due AS (
       UPDATE public.maintenance_job_state SET
         next_run_at = CURRENT_TIMESTAMP, status = 'idle', updated_at = CURRENT_TIMESTAMP
       WHERE job_name = 'storage-reconciliation' AND mode = 'dry-run'
         AND EXISTS (SELECT 1 FROM automatic_interrupted)
       RETURNING job_name
     ), interruption_audit AS (
       INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, reason, metadata
       )
       SELECT interrupted.actor_user_id, 'system',
         'maintenance.storage_cleanup_interrupted', 'maintenance-run',
         interrupted.id::text, 'failed', $3,
         jsonb_build_object('reconciliationRequired', true)
       FROM interrupted
       RETURNING resource_id
     ), automatic_suspension_audit AS (
       INSERT INTO public.audit_events (
         source, event_type, resource_type, resource_id, outcome, reason, metadata
       )
       SELECT 'system', 'maintenance.automatic_cleanup_suspended',
         'maintenance-run', automatic.id::text, 'failed', $3,
         jsonb_build_object(
           'reconciliationRequired', true,
           'sourceReconciliationRunId', automatic.source_reconciliation_run_id,
           'recoveredAfterInterruption', true
         )
       FROM automatic_interrupted automatic
       RETURNING resource_id
     )
     SELECT id FROM interrupted`,
    [now, STORAGE_CLEANUP_JOB, message, Math.max(5, Math.min(1440, Number(staleMinutes) || 30))]
    );
    return (result.rows || []).map((row) => Number(row.id));
  } finally {
    if (locked) {
      const unlockError = await unlockAndReleaseStorageCleanupClient(client);
      if (unlockError) throw unlockError;
    } else {
      client.release();
    }
  }
}

export const storageCleanupInternals = Object.freeze({
  REFERENCE_CHECK_SQL,
  assertNoSymlinkComponents,
  actorId,
  claimCleanupExecution,
  normalizeDerivedCandidate,
  processCleanupCandidateTransaction,
  safeError,
  tokenHash,
});
