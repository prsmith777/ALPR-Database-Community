import {
  processCleanupCandidateTransaction,
  STORAGE_CLEANUP_JOB,
  STORAGE_CLEANUP_LOCK_NAME,
  validateAndDeleteCleanupCandidate,
} from "./storage-cleanup.mjs";
import { unlockAndReleaseStorageCleanupClient } from "./storage-maintenance-lock.mjs";
import { AUTOMATIC_CLEANUP_LIMITS } from "./storage-maintenance-policy.mjs";

export const AUTOMATIC_CLEANUP_CATEGORY = "derived-orphans";
export const AUTOMATIC_CLEANUP_CONFIRMATION = "ENABLE AUTOMATIC DERIVED CLEANUP";
export const AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT = "ACKNOWLEDGE AUTOMATIC CLEANUP FAILURE";
const AUTOMATIC_CLEANUP_APPROVAL_LOCK = "alpr_automatic_cleanup_approval";

async function defaultPool() {
  return (await import("./db.js")).getPool();
}

function actorId(actor) {
  const id = Number(actor?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Automatic cleanup approval requires an authenticated Administrator");
  return id;
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeError(error) {
  return String(error?.message || error || "Automatic cleanup failed").slice(0, 2000);
}

function approvalFromRow(row) {
  if (!row) return null;
  return {
    category: row.category,
    revision: Number(row.revision),
    enabled: row.enabled === true,
    intervalSeconds: Number(row.interval_seconds),
    graceSeconds: Number(row.grace_seconds),
    actorUserId: Number(row.actor_user_id),
    createdAt: row.created_at,
  };
}

function stateFromRow(row) {
  if (!row) return null;
  return {
    category: row.category,
    nextRunAt: row.next_run_at,
    lastRunId: row.last_run_id == null ? null : Number(row.last_run_id),
    sourceReconciliationRunId: row.source_reconciliation_run_id == null ? null : Number(row.source_reconciliation_run_id),
    circuitBreakerOpen: row.circuit_breaker_open === true,
    circuitBreakerOpenedAt: row.circuit_breaker_opened_at,
    circuitBreakerReason: row.circuit_breaker_reason,
    circuitBreakerRunId: row.circuit_breaker_run_id == null ? null : Number(row.circuit_breaker_run_id),
    acknowledgedAt: row.acknowledged_at,
    acknowledgedByUserId: row.acknowledged_by_user_id == null ? null : Number(row.acknowledged_by_user_id),
    acknowledgedRunId: row.acknowledged_run_id == null ? null : Number(row.acknowledged_run_id),
    acknowledgementReconciliationRunId: row.acknowledgement_reconciliation_run_id == null ? null : Number(row.acknowledgement_reconciliation_run_id),
    updatedAt: row.updated_at,
  };
}

export async function getAutomaticCleanupApproval({ executor } = {}) {
  const database = executor || await defaultPool();
  const [approvalResult, stateResult] = await Promise.all([
    database.query(
      `SELECT * FROM public.storage_cleanup_automatic_approvals
       WHERE category = $1 ORDER BY revision DESC LIMIT 1`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    ),
    database.query(
      "SELECT * FROM public.storage_cleanup_automatic_state WHERE category = $1",
      [AUTOMATIC_CLEANUP_CATEGORY]
    ),
  ]);
  return {
    approval: approvalFromRow(approvalResult.rows?.[0]),
    state: stateFromRow(stateResult.rows?.[0]),
    limits: { ...AUTOMATIC_CLEANUP_LIMITS },
    activationConfirmation: AUTOMATIC_CLEANUP_CONFIRMATION,
    acknowledgementConfirmation: AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT,
  };
}

export async function setAutomaticCleanupApproval({
  executor,
  actor,
  enabled,
  confirmation = "",
  intervalSeconds = AUTOMATIC_CLEANUP_LIMITS.minimumIntervalSeconds,
  graceSeconds = AUTOMATIC_CLEANUP_LIMITS.minimumGraceSeconds,
  now = new Date(),
} = {}) {
  const database = executor || await defaultPool();
  const id = actorId(actor);
  if (enabled === true && confirmation !== AUTOMATIC_CLEANUP_CONFIRMATION) {
    throw new Error(`Type ${AUTOMATIC_CLEANUP_CONFIRMATION} to activate automatic cleanup`);
  }
  const interval = bounded(intervalSeconds, 86_400, AUTOMATIC_CLEANUP_LIMITS.minimumIntervalSeconds, 604_800);
  const grace = bounded(graceSeconds, 604_800, AUTOMATIC_CLEANUP_LIMITS.minimumGraceSeconds, 31_536_000);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [AUTOMATIC_CLEANUP_APPROVAL_LOCK]);
    const current = await client.query(
      `SELECT revision FROM public.storage_cleanup_automatic_approvals
       WHERE category = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    );
    const revision = Number(current.rows?.[0]?.revision || 0) + 1;
    const approval = await client.query(
      `INSERT INTO public.storage_cleanup_automatic_approvals (
         category, revision, enabled, interval_seconds, grace_seconds, actor_user_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [AUTOMATIC_CLEANUP_CATEGORY, revision, enabled === true, interval, grace, id, now]
    );
    await client.query(
      `INSERT INTO public.storage_cleanup_automatic_state (category, next_run_at, updated_at)
       VALUES ($1, CASE WHEN $2 THEN $3::timestamptz + make_interval(secs => $4) ELSE NULL END, $3)
       ON CONFLICT (category) DO UPDATE SET
         next_run_at = CASE
           WHEN $2 AND NOT storage_cleanup_automatic_state.circuit_breaker_open
             THEN $3::timestamptz + make_interval(secs => $4)
           ELSE NULL
         END,
         updated_at = $3`,
      [AUTOMATIC_CLEANUP_CATEGORY, enabled === true, now, interval]
    );
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1, 'browser', $2, 'storage-cleanup-approval', $3, 'succeeded', $4::jsonb)`,
      [
        id,
        enabled === true ? "maintenance.automatic_cleanup_approved" : "maintenance.automatic_cleanup_disabled",
        `${AUTOMATIC_CLEANUP_CATEGORY}:${revision}`,
        JSON.stringify({ category: AUTOMATIC_CLEANUP_CATEGORY, revision, enabled: enabled === true, intervalSeconds: interval, graceSeconds: grace }),
      ]
    );
    await client.query("COMMIT");
    return approvalFromRow(approval.rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeAutomaticCleanupFailure({ executor, actor, confirmation = "", now = new Date() } = {}) {
  if (confirmation !== AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT) {
    throw new Error(`Type ${AUTOMATIC_CLEANUP_ACKNOWLEDGEMENT} to acknowledge the automatic cleanup failure`);
  }
  const database = executor || await defaultPool();
  const id = actorId(actor);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const stateResult = await client.query(
      `SELECT * FROM public.storage_cleanup_automatic_state
       WHERE category = $1 FOR UPDATE`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    );
    const state = stateResult.rows?.[0];
    if (!state?.circuit_breaker_open) throw new Error("Automatic cleanup is not suspended");
    if (state.circuit_breaker_run_id == null) {
      throw new Error("Automatic cleanup suspension is missing its failed-run provenance");
    }
    const reconciliation = await client.query(
      `SELECT id, scan_started_at, completed_at, error_count
       FROM public.storage_reconciliation_runs
       WHERE status = 'completed' AND error_count = 0
         AND scan_started_at > $1::timestamptz
         AND completed_at >= $2::timestamptz - make_interval(secs => $3)
       ORDER BY id DESC LIMIT 1`,
      [state.circuit_breaker_opened_at, now, AUTOMATIC_CLEANUP_LIMITS.reconciliationFreshnessSeconds]
    );
    if (!reconciliation.rowCount) {
      throw new Error("Run a fresh, successful storage reconciliation before acknowledging this failure");
    }
    const approval = await client.query(
      `SELECT * FROM public.storage_cleanup_automatic_approvals
       WHERE category = $1 ORDER BY revision DESC LIMIT 1`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    );
    const current = approval.rows?.[0];
    await client.query(
      `UPDATE public.storage_cleanup_automatic_state SET
         circuit_breaker_open = FALSE, circuit_breaker_opened_at = NULL,
         circuit_breaker_reason = NULL, circuit_breaker_run_id = NULL,
         acknowledged_at = $2, acknowledged_by_user_id = $3,
         next_run_at = CASE WHEN $4 THEN $2::timestamptz + make_interval(secs => $5) ELSE NULL END,
         source_reconciliation_run_id = $6,
         acknowledged_run_id = $7,
         acknowledgement_reconciliation_run_id = $6,
         updated_at = $2
       WHERE category = $1`,
      [AUTOMATIC_CLEANUP_CATEGORY, now, id, current?.enabled === true, Number(current?.interval_seconds || 86_400), reconciliation.rows[0].id, state.circuit_breaker_run_id]
    );
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1, 'browser', 'maintenance.automatic_cleanup_failure_acknowledged',
         'storage-cleanup-approval', $2, 'succeeded', $3::jsonb)`,
      [id, AUTOMATIC_CLEANUP_CATEGORY, JSON.stringify({
        acknowledgedRunId: Number(state.circuit_breaker_run_id),
        reconciliationRunId: Number(reconciliation.rows[0].id),
      })]
    );
    await client.query("COMMIT");
    return {
      acknowledged: true,
      acknowledgedRunId: Number(state.circuit_breaker_run_id),
      reconciliationRunId: Number(reconciliation.rows[0].id),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function openCircuitBreaker(client, { runId, reconciliationRunId, error, now }) {
  const message = safeError(error);
  await client.query("BEGIN");
  await client.query(
    `UPDATE public.maintenance_cleanup_items SET
       status = 'failed', error = $2, completed_at = $3
     WHERE run_id = $1 AND status = 'candidate'`,
    [runId, message, now]
  );
  await client.query(
    `UPDATE public.maintenance_job_state SET next_run_at = CURRENT_TIMESTAMP,
       status = 'idle', updated_at = CURRENT_TIMESTAMP
     WHERE job_name = 'storage-reconciliation' AND mode = 'dry-run'`
  );
  await client.query(
    `UPDATE public.maintenance_runs SET status = 'failed', completed_at = $2,
       failure_count = GREATEST(failure_count, 1), last_error = $3,
       reclaimed_bytes = COALESCE((SELECT SUM(reclaimed_bytes)
         FROM public.maintenance_cleanup_items WHERE run_id = $1), 0),
       result = result || '{"reconciliationRequired":true,"circuitBreakerOpen":true}'::jsonb,
       updated_at = $2 WHERE id = $1`,
    [runId, now, message]
  );
  await client.query(
    `UPDATE public.storage_cleanup_automatic_state SET
       next_run_at = NULL, last_run_id = $2, source_reconciliation_run_id = $3,
       circuit_breaker_open = TRUE, circuit_breaker_opened_at = $4,
       circuit_breaker_reason = $5, circuit_breaker_run_id = $2,
       acknowledged_at = NULL, acknowledged_by_user_id = NULL,
       acknowledged_run_id = NULL, acknowledgement_reconciliation_run_id = NULL,
       updated_at = $4
     WHERE category = $1`,
    [AUTOMATIC_CLEANUP_CATEGORY, runId, reconciliationRunId, now, message]
  );
  await client.query(
    `INSERT INTO public.audit_events (
       source, event_type, resource_type, resource_id, outcome, reason, metadata
     ) VALUES ('system', 'maintenance.automatic_cleanup_suspended',
       'maintenance-run', $1, 'failed', $2,
       jsonb_build_object('category', $3::text, 'sourceReconciliationRunId', $4::bigint))`,
    [String(runId), message, AUTOMATIC_CLEANUP_CATEGORY, reconciliationRunId]
  );
  await client.query("COMMIT");
}

async function claimAutomaticRun(client, now) {
  await client.query("BEGIN");
  try {
    const approvalResult = await client.query(
      `SELECT * FROM public.storage_cleanup_automatic_approvals
       WHERE category = $1 ORDER BY revision DESC LIMIT 1`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    );
    const approval = approvalResult.rows?.[0];
    if (!approval?.enabled) { await client.query("COMMIT"); return { status: "disabled" }; }
    const stateResult = await client.query(
      `SELECT * FROM public.storage_cleanup_automatic_state
       WHERE category = $1 FOR UPDATE`,
      [AUTOMATIC_CLEANUP_CATEGORY]
    );
    const state = stateResult.rows?.[0];
    if (!state || state.circuit_breaker_open) { await client.query("COMMIT"); return { status: "suspended" }; }
    const unsafeRunResult = await client.query(
      `SELECT run.id, run.status, run.started_at, run.completed_at,
              COALESCE((run.result->>'reconciliationRequired')::boolean, FALSE) AS reconciliation_required,
              EXISTS (
                SELECT 1 FROM public.storage_reconciliation_runs reconciliation
                WHERE run.id = $2::bigint
                  AND reconciliation.id = $3::bigint
                  AND reconciliation.status = 'completed' AND reconciliation.error_count = 0
                  AND reconciliation.scan_started_at > COALESCE(run.completed_at, run.started_at)
                  AND reconciliation.completed_at <= $4::timestamptz
              ) AS acknowledged_after_fresh_reconciliation
       FROM public.maintenance_runs run
       WHERE run.job_name = $1
         AND (run.trigger_type = 'scheduled' OR run.configuration @> '{"automatic":true}'::jsonb)
         AND (run.status IN ('running', 'failed')
           OR COALESCE((run.result->>'reconciliationRequired')::boolean, FALSE))
       ORDER BY run.id DESC LIMIT 1`,
      [STORAGE_CLEANUP_JOB, state.acknowledged_run_id, state.acknowledgement_reconciliation_run_id, state.acknowledged_at]
    );
    const unsafeRun = unsafeRunResult.rows?.[0];
    if (unsafeRun && (
      unsafeRun.status === "running" ||
      state.acknowledged_at == null ||
      unsafeRun.acknowledged_after_fresh_reconciliation !== true
    )) {
      await client.query("COMMIT");
      return { status: "suspended-invariant", runId: Number(unsafeRun.id) };
    }
    if (!state.next_run_at || new Date(state.next_run_at) > now) { await client.query("COMMIT"); return { status: "not-due" }; }
    const reconciliationResult = await client.query(
      `SELECT id, scan_started_at, completed_at, error_count, status
       FROM public.storage_reconciliation_runs ORDER BY id DESC LIMIT 1`
    );
    const reconciliation = reconciliationResult.rows?.[0];
    const freshAfter = new Date(now.getTime() - AUTOMATIC_CLEANUP_LIMITS.reconciliationFreshnessSeconds * 1000);
    if (!reconciliation || reconciliation.status !== "completed" || Number(reconciliation.error_count) !== 0 ||
        !reconciliation.completed_at || new Date(reconciliation.completed_at) < freshAfter) {
      await client.query(
        `UPDATE public.storage_cleanup_automatic_state SET
           next_run_at = $2::timestamptz + make_interval(secs => $3), updated_at = $2
         WHERE category = $1`,
        [AUTOMATIC_CLEANUP_CATEGORY, now, Number(approval.interval_seconds)]
      );
      await client.query(
        `UPDATE public.maintenance_job_state SET next_run_at = CURRENT_TIMESTAMP,
           status = 'idle', updated_at = CURRENT_TIMESTAMP
         WHERE job_name = 'storage-reconciliation' AND mode = 'dry-run'`
      );
      await client.query("COMMIT");
      return { status: "reconciliation-required" };
    }
    const grace = bounded(approval.grace_seconds, 604_800, AUTOMATIC_CLEANUP_LIMITS.minimumGraceSeconds, 31_536_000);
    const candidates = await client.query(
      `WITH eligible AS (
         SELECT item.id, item.relative_path, item.size_bytes, item.modified_at,
                SUM(item.size_bytes) OVER (ORDER BY item.modified_at ASC, item.id ASC) AS cumulative_bytes
         FROM public.storage_reconciliation_items item
         WHERE item.run_id = $1 AND item.finding_type = 'orphan-file'
           AND item.relative_path LIKE 'derived/%'
           AND item.modified_at < $2::timestamptz
           AND item.modified_at <= $3::timestamptz - make_interval(secs => $4)
       )
       SELECT relative_path, size_bytes, modified_at FROM eligible
       WHERE cumulative_bytes <= $5 ORDER BY modified_at ASC, id ASC LIMIT $6`,
      [reconciliation.id, reconciliation.scan_started_at, now, grace, AUTOMATIC_CLEANUP_LIMITS.maximumBytes, AUTOMATIC_CLEANUP_LIMITS.maximumFiles]
    );
    const bytes = (candidates.rows || []).reduce((total, item) => total + Number(item.size_bytes || 0), 0);
    const runResult = await client.query(
      `INSERT INTO public.maintenance_runs (
         job_name, trigger_type, mode, status, started_at, source_reconciliation_run_id, candidate_count,
         candidate_bytes, configuration, result
       ) VALUES ($1, 'scheduled', 'execute', 'running', $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING id`,
      [STORAGE_CLEANUP_JOB, now, reconciliation.id, candidates.rowCount || 0, bytes, JSON.stringify({
        automatic: true,
        category: AUTOMATIC_CLEANUP_CATEGORY,
        approvalRevision: Number(approval.revision),
        sourceReconciliationRunId: Number(reconciliation.id),
        sourceReconciliationStartedAt: reconciliation.scan_started_at,
        graceSeconds: grace,
        maximumFiles: AUTOMATIC_CLEANUP_LIMITS.maximumFiles,
        maximumBytes: AUTOMATIC_CLEANUP_LIMITS.maximumBytes,
        maximumDurationMs: AUTOMATIC_CLEANUP_LIMITS.maximumDurationMs,
      }), JSON.stringify({ reconciliationRequired: false })]
    );
    const runId = Number(runResult.rows[0].id);
    if (candidates.rowCount) {
      await client.query(
        `INSERT INTO public.maintenance_cleanup_items (
           run_id, relative_path, category, observed_size_bytes, observed_modified_at
         ) SELECT $1, path, 'derived', bytes, modified_at
           FROM unnest($2::text[], $3::bigint[], $4::timestamptz[])
           AS candidate(path, bytes, modified_at)`,
        [runId, candidates.rows.map((item) => item.relative_path), candidates.rows.map((item) => item.size_bytes), candidates.rows.map((item) => item.modified_at)]
      );
    }
    const items = await client.query(
      "SELECT * FROM public.maintenance_cleanup_items WHERE run_id = $1 ORDER BY observed_modified_at ASC, id ASC",
      [runId]
    );
    await client.query(
      `UPDATE public.storage_cleanup_automatic_state SET
         next_run_at = $2::timestamptz + make_interval(secs => $3),
         last_run_id = $4, source_reconciliation_run_id = $5, updated_at = $2
       WHERE category = $1`,
      [AUTOMATIC_CLEANUP_CATEGORY, now, Number(approval.interval_seconds), runId, reconciliation.id]
    );
    await client.query(
      `INSERT INTO public.audit_events (
         source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ('system', 'maintenance.automatic_cleanup_started',
         'maintenance-run', $1, 'succeeded', $2::jsonb)`,
      [String(runId), JSON.stringify({ category: AUTOMATIC_CLEANUP_CATEGORY, approvalRevision: Number(approval.revision), sourceReconciliationRunId: Number(reconciliation.id), candidateCount: candidates.rowCount || 0, candidateBytes: bytes })]
    );
    await client.query("COMMIT");
    return { status: "running", runId, reconciliationRunId: Number(reconciliation.id), approvalRevision: Number(approval.revision), items: items.rows || [], startedAt: now };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  }
}

export async function runScheduledStorageCleanup({
  pool,
  storagePath,
  now = () => new Date(),
  processCandidate = processCleanupCandidateTransaction,
  deleteCandidate = validateAndDeleteCleanupCandidate,
} = {}) {
  if (!storagePath) throw new Error("Automatic storage cleanup requires a storage path");
  const database = pool || await defaultPool();
  const client = await database.connect();
  let locked = false;
  let claim = null;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [STORAGE_CLEANUP_LOCK_NAME]);
    locked = Boolean(lock.rows?.[0]?.locked);
    if (!locked) return { status: "busy", automatic: true };
    const startedAt = now();
    claim = await claimAutomaticRun(client, startedAt);
    if (claim.status !== "running") return { ...claim, automatic: true };
    let reclaimedBytes = 0;
    const counts = {};
    let boundedStop = false;
    for (const item of claim.items) {
      const elapsedMs = now().getTime() - startedAt.getTime();
      if (elapsedMs >= AUTOMATIC_CLEANUP_LIMITS.maximumDurationMs) {
        boundedStop = true;
        break;
      }
      const remainingBudgetMs = Math.max(
        1,
        AUTOMATIC_CLEANUP_LIMITS.maximumDurationMs - elapsedMs
      );
      const guardedDeleteCandidate = async (options) => {
        await options.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [AUTOMATIC_CLEANUP_APPROVAL_LOCK]);
        const approvalCheck = await options.query(
          `SELECT enabled, revision FROM public.storage_cleanup_automatic_approvals
           WHERE category = $1 ORDER BY revision DESC LIMIT 1`,
          [AUTOMATIC_CLEANUP_CATEGORY]
        );
        const currentApproval = approvalCheck.rows?.[0];
        if (!currentApproval?.enabled || Number(currentApproval.revision) !== claim.approvalRevision) {
          throw new Error("Automatic cleanup approval changed while the run was active");
        }
        return deleteCandidate(options);
      };
      const outcome = await processCandidate({
        client,
        runId: claim.runId,
        item,
        storagePath,
        completedAt: now,
        deleteCandidate: guardedDeleteCandidate,
        lockTimeoutMs: Math.min(5_000, remainingBudgetMs),
        statementTimeoutMs: remainingBudgetMs,
      });
      counts[outcome.status] = (counts[outcome.status] || 0) + 1;
      reclaimedBytes += Number(outcome.reclaimedBytes || 0);
      if (outcome.status === "failed" || outcome.reconciliationRequired) {
        throw new Error(outcome.error || "Automatic cleanup stopped after the first candidate failure");
      }
    }
    const completedAt = now();
    await client.query("BEGIN");
    if (boundedStop) {
      await client.query(
        `UPDATE public.maintenance_cleanup_items SET status = 'skipped-limit',
           error = 'Automatic cleanup stopped at the five-minute safety limit', completed_at = $2
         WHERE run_id = $1 AND status = 'candidate'`,
        [claim.runId, completedAt]
      );
      counts["skipped-limit"] = claim.items.length - Object.values(counts).reduce((total, value) => total + value, 0);
    }
    await client.query(
      `UPDATE public.maintenance_runs SET status = 'completed', completed_at = $2,
         duration_ms = $3, reclaimed_bytes = $4, result = $5::jsonb, updated_at = $2
       WHERE id = $1`,
      [claim.runId, completedAt, Math.max(0, completedAt.getTime() - startedAt.getTime()), reclaimedBytes, JSON.stringify({ counts, reconciliationRequired: false, sourceReconciliationRunId: claim.reconciliationRunId, boundedStop, stopReason: boundedStop ? "maximum-duration" : null })]
    );
    await client.query(
      `UPDATE public.maintenance_job_state SET next_run_at = CURRENT_TIMESTAMP,
         status = 'idle', updated_at = CURRENT_TIMESTAMP
       WHERE job_name = 'storage-reconciliation' AND mode = 'dry-run'`,
    );
    await client.query(
      `INSERT INTO public.audit_events (
         source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ('system', 'maintenance.automatic_cleanup_completed',
         'maintenance-run', $1, 'succeeded', $2::jsonb)`,
      [String(claim.runId), JSON.stringify({ category: AUTOMATIC_CLEANUP_CATEGORY, sourceReconciliationRunId: claim.reconciliationRunId, reclaimedBytes, counts, reconciliationScheduled: true })]
    );
    await client.query("COMMIT");
    return { status: "completed", automatic: true, runId: claim.runId, reclaimedBytes, counts, boundedStop };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (claim?.runId) {
      try {
        await openCircuitBreaker(client, { runId: claim.runId, reconciliationRunId: claim.reconciliationRunId, error, now: now() });
      } catch (breakerError) {
        try { await client.query("ROLLBACK"); } catch {}
        const combined = new Error(
          `${safeError(error)}; circuit breaker persistence failed: ${safeError(breakerError)}. ` +
          "Further automatic runs are blocked by the failed/running-run invariant."
        );
        combined.cause = new AggregateError([error, breakerError], "Automatic cleanup and breaker persistence both failed");
        throw combined;
      }
    }
    throw error;
  } finally {
    if (locked) {
      const unlockError = await unlockAndReleaseStorageCleanupClient(client);
      if (unlockError) throw unlockError;
    } else {
      client.release();
    }
  }
}

export const automaticStorageCleanupInternals = Object.freeze({
  AUTOMATIC_CLEANUP_APPROVAL_LOCK,
  actorId,
  approvalFromRow,
  claimAutomaticRun,
  openCircuitBreaker,
  safeError,
  stateFromRow,
});
