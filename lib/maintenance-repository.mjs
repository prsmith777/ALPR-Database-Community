import {
  calculateRetentionPreview,
  RETENTION_MAINTENANCE_JOB,
} from "./maintenance-plan.mjs";

const LOCK_NAME = "alpr_retention_maintenance_preview";

async function getDefaultPool() {
  const database = await import("./db.js");
  return database.getPool();
}

function safeError(error) {
  return String(error?.message || error || "Unknown maintenance error")
    .trim()
    .slice(0, 2000);
}

export async function ensureMaintenanceJobState({
  query,
  enabled,
  intervalSeconds,
  initialDelaySeconds,
} = {}) {
  if (typeof query !== "function") throw new Error("Maintenance state query must be a function");
  await query(
    `INSERT INTO public.maintenance_job_state (
       job_name, enabled, mode, status, interval_seconds, next_run_at
     ) VALUES ($1, $2, 'dry-run', 'idle', $3,
       CASE WHEN $2 THEN CURRENT_TIMESTAMP + make_interval(secs => $4::integer) ELSE NULL END
     )
     ON CONFLICT (job_name) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       mode = 'dry-run',
       interval_seconds = EXCLUDED.interval_seconds,
       next_run_at = CASE
         WHEN NOT EXCLUDED.enabled THEN NULL
         WHEN NOT maintenance_job_state.enabled OR maintenance_job_state.next_run_at IS NULL
           THEN CURRENT_TIMESTAMP + make_interval(secs => $4::integer)
         ELSE maintenance_job_state.next_run_at
       END,
       updated_at = CURRENT_TIMESTAMP`,
    [RETENTION_MAINTENANCE_JOB, Boolean(enabled), intervalSeconds, initialDelaySeconds]
  );
}

export async function getMaintenanceJobStatus({ query } = {}) {
  const databaseQuery = query || (async (text, values) => {
    const pool = await getDefaultPool();
    return pool.query(text, values);
  });
  const result = await databaseQuery(
    `SELECT job_name, enabled, mode, status, interval_seconds, next_run_at,
            last_started_at, last_completed_at, last_result, last_error, updated_at
     FROM public.maintenance_job_state
     WHERE job_name = $1`,
    [RETENTION_MAINTENANCE_JOB]
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    jobName: row.job_name,
    enabled: Boolean(row.enabled),
    mode: row.mode,
    status: row.status,
    intervalSeconds: Number(row.interval_seconds) || null,
    nextRunAt: row.next_run_at || null,
    lastStartedAt: row.last_started_at || null,
    lastCompletedAt: row.last_completed_at || null,
    lastResult: row.last_result || null,
    lastError: row.last_error || null,
    updatedAt: row.updated_at || null,
  };
}

export async function runDueRetentionPreview({
  pool,
  settings,
  enabled = true,
  intervalSeconds = 86_400,
  initialDelaySeconds = 60,
} = {}) {
  const database = pool || await getDefaultPool();
  const client = await database.connect();
  let locked = false;
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [LOCK_NAME]
    );
    locked = Boolean(lock.rows?.[0]?.locked);
    if (!locked) return { status: "busy" };

    await ensureMaintenanceJobState({
      query: (text, values) => client.query(text, values),
      enabled,
      intervalSeconds,
      initialDelaySeconds,
    });
    const claim = await client.query(
      `UPDATE public.maintenance_job_state
       SET status = 'running',
           last_started_at = CURRENT_TIMESTAMP,
           last_error = NULL,
           next_run_at = CURRENT_TIMESTAMP + make_interval(secs => interval_seconds),
           updated_at = CURRENT_TIMESTAMP
       WHERE job_name = $1
         AND enabled = TRUE
         AND mode = 'dry-run'
         AND (
           next_run_at <= CURRENT_TIMESTAMP OR
           (status = 'running' AND last_started_at < CURRENT_TIMESTAMP - INTERVAL '30 minutes')
         )
       RETURNING job_name`,
      [RETENTION_MAINTENANCE_JOB]
    );
    if (!claim.rowCount) return { status: "not-due" };

    const preview = await calculateRetentionPreview({
      query: (text, values) => client.query(text, values),
      settings,
    });
    await client.query(
      `UPDATE public.maintenance_job_state
       SET status = 'idle', last_completed_at = CURRENT_TIMESTAMP,
           last_result = $2::jsonb, last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE job_name = $1`,
      [RETENTION_MAINTENANCE_JOB, JSON.stringify(preview)]
    );
    return { status: "completed", preview };
  } catch (error) {
    try {
      await client.query(
        `UPDATE public.maintenance_job_state
         SET status = 'failed', last_completed_at = CURRENT_TIMESTAMP,
             last_error = $2, updated_at = CURRENT_TIMESTAMP
         WHERE job_name = $1`,
        [RETENTION_MAINTENANCE_JOB, safeError(error)]
      );
    } catch {
      // Preserve the original failure when status persistence is unavailable.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
      } catch {
        // The connection close releases the session lock if explicit unlock fails.
      }
    }
    client.release();
  }
}

export const maintenanceRepositoryInternals = Object.freeze({ LOCK_NAME, safeError });
