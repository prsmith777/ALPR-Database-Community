import { lstat, readdir } from "node:fs/promises";

import { ensureMaintenanceJobState, getMaintenanceJobStatus } from "./maintenance-repository.mjs";
import { resolveStoragePath } from "./storage-path.mjs";
import {
  buildReconciliationResult,
  inspectDatabaseReferences,
  inspectFilesystemEntries,
  joinStorageRelativePath,
  normalizeStorageRelativePath,
  selectDirectoryEntries,
  STORAGE_RECONCILIATION_JOB,
  STORAGE_RECONCILIATION_ROOTS,
} from "./storage-reconciliation.mjs";

const LOCK_NAME = "alpr_storage_reconciliation";

async function getDefaultPool() {
  const database = await import("./db.js");
  return database.getPool();
}

function safeError(error) {
  return String(error?.message || error || "Unknown storage reconciliation error")
    .trim()
    .slice(0, 2000);
}

function boundedBatchSize(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(1_000, Math.max(25, parsed)) : 250;
}

function storageStat(baseDir, relativePath) {
  return lstat(resolveStoragePath(baseDir, normalizeStorageRelativePath(relativePath)));
}

async function referencedPathSet(client, paths) {
  if (!paths.length) return new Set();
  const result = await client.query(
    `SELECT DISTINCT path
     FROM (
       SELECT image_path AS path FROM public.plate_reads WHERE image_path = ANY($1::text[])
       UNION ALL
       SELECT thumbnail_path AS path FROM public.plate_reads WHERE thumbnail_path = ANY($1::text[])
       UNION ALL
       SELECT source_image_path AS path FROM public.capture_assets WHERE source_image_path = ANY($1::text[])
       UNION ALL
       SELECT derived_path AS path FROM public.capture_assets WHERE derived_path = ANY($1::text[])
     ) references
     WHERE path IS NOT NULL`,
    [paths]
  );
  return new Set((result.rows || []).map((row) => normalizeStorageRelativePath(row.path)));
}

async function insertDirectories(client, runId, directories) {
  if (!directories.length) return;
  await client.query(
    `INSERT INTO public.storage_reconciliation_directories (run_id, relative_path)
     SELECT $1, queued.relative_path
     FROM unnest($2::text[]) AS queued(relative_path)
     ON CONFLICT (run_id, relative_path) DO NOTHING`,
    [runId, directories]
  );
}

async function insertOrphanFindings(client, runId, files) {
  if (!files.length) return 0;
  const result = await client.query(
    `INSERT INTO public.storage_reconciliation_items (
       run_id, finding_type, relative_path, size_bytes, modified_at
     )
     SELECT $1, 'orphan-file', path, size_bytes, modified_at
     FROM unnest($2::text[], $3::bigint[], $4::timestamptz[])
       AS finding(path, size_bytes, modified_at)
     ON CONFLICT (run_id, finding_type, relative_path) DO NOTHING
     RETURNING id`,
    [
      runId,
      files.map((file) => file.relativePath),
      files.map((file) => file.sizeBytes),
      files.map((file) => file.modifiedAt),
    ]
  );
  return result.rowCount || 0;
}

async function insertMissingFindings(client, runId, references) {
  if (!references.length) return 0;
  const result = await client.query(
    `INSERT INTO public.storage_reconciliation_items (
       run_id, finding_type, relative_path, reference_type, owner_id
     )
     SELECT $1, 'missing-reference', path, reference_type, owner_id
     FROM unnest($2::text[], $3::varchar[], $4::bigint[])
       AS finding(path, reference_type, owner_id)
     ON CONFLICT (run_id, finding_type, relative_path) DO NOTHING
     RETURNING id`,
    [
      runId,
      references.map((item) => item.relativePath),
      references.map((item) => item.referenceType),
      references.map((item) => item.ownerId),
    ]
  );
  return result.rowCount || 0;
}

async function startRun(client, { intervalSeconds }) {
  await client.query("BEGIN");
  try {
    const claim = await client.query(
      `UPDATE public.maintenance_job_state
       SET status = 'running', last_started_at = CURRENT_TIMESTAMP,
           last_error = NULL,
           next_run_at = CURRENT_TIMESTAMP + make_interval(secs => interval_seconds),
           updated_at = CURRENT_TIMESTAMP
       WHERE job_name = $1 AND enabled = TRUE AND mode = 'dry-run'
         AND next_run_at <= CURRENT_TIMESTAMP
       RETURNING job_name`,
      [STORAGE_RECONCILIATION_JOB]
    );
    if (!claim.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const bounds = await client.query(
      `SELECT
         COALESCE((SELECT MAX(id) FROM public.plate_reads), 0)::bigint AS max_plate_read_id,
         COALESCE((SELECT MAX(id) FROM public.capture_assets), 0)::bigint AS max_capture_asset_id`
    );
    const run = await client.query(
      `INSERT INTO public.storage_reconciliation_runs (
         status, phase, max_plate_read_id, max_capture_asset_id
       ) VALUES ('running', 'filesystem', $1, $2)
       RETURNING *`,
      [bounds.rows[0].max_plate_read_id, bounds.rows[0].max_capture_asset_id]
    );
    await insertDirectories(client, run.rows[0].id, [...STORAGE_RECONCILIATION_ROOTS]);
    await client.query("COMMIT");
    return run.rows[0];
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

async function processFilesystemDirectory(client, run, { baseDir, batchSize }) {
  const directoryResult = await client.query(
    `SELECT * FROM public.storage_reconciliation_directories
     WHERE run_id = $1 AND completed = FALSE
     ORDER BY relative_path ASC
     LIMIT 1`,
    [run.id]
  );
  const directory = directoryResult.rows?.[0];
  if (!directory) {
    await client.query(
      `UPDATE public.storage_reconciliation_runs
       SET phase = 'plate-reads', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [run.id]
    );
    return { status: "running", phase: "plate-reads", runId: Number(run.id) };
  }

  let entries;
  try {
    entries = await readdir(
      resolveStoragePath(baseDir, normalizeStorageRelativePath(directory.relative_path)),
      { withFileTypes: true }
    );
  } catch {
    await client.query(
      `UPDATE public.storage_reconciliation_directories
       SET completed = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [directory.id]
    );
    await client.query(
      `UPDATE public.storage_reconciliation_runs
       SET error_count = error_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [run.id]
    );
    return { status: "running", phase: "filesystem", runId: Number(run.id) };
  }

  const batch = selectDirectoryEntries(entries, {
    cursor: directory.cursor_name,
    limit: batchSize,
  });
  const possibleFilePaths = batch.entries
    .filter((entry) => entry.isFile?.() && !entry.isSymbolicLink?.())
    .map((entry) => joinStorageRelativePath(directory.relative_path, entry.name));
  const references = await referencedPathSet(client, possibleFilePaths);
  const inspection = await inspectFilesystemEntries({
    parent: directory.relative_path,
    entries: batch.entries,
    scanStartedAt: run.scan_started_at,
    statPath: (relativePath) => storageStat(baseDir, relativePath),
    referencedPaths: references,
  });
  await insertDirectories(client, run.id, inspection.directories);
  await insertOrphanFindings(client, run.id, inspection.orphanFiles);
  const bytes = inspection.inspectedFiles.reduce((total, file) => total + file.sizeBytes, 0);
  await client.query(
    `UPDATE public.storage_reconciliation_runs
     SET files_scanned = files_scanned + $2,
         bytes_scanned = bytes_scanned + $3,
         recent_files_skipped = recent_files_skipped + $4,
         skipped_entries = skipped_entries + $5,
         error_count = error_count + $6,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      run.id,
      inspection.inspectedFiles.length,
      bytes,
      inspection.recentFilesSkipped,
      inspection.skippedEntries,
      inspection.errorCount,
    ]
  );
  await client.query(
    `UPDATE public.storage_reconciliation_directories
     SET cursor_name = $2, completed = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [directory.id, batch.nextCursor, batch.complete]
  );
  return { status: "running", phase: "filesystem", runId: Number(run.id) };
}

function plateReadReferences(rows) {
  return rows.flatMap((row) => [
    row.image_path && { relativePath: row.image_path, referenceType: "plate-read-image", ownerId: row.id },
    row.thumbnail_path && { relativePath: row.thumbnail_path, referenceType: "plate-read-thumbnail", ownerId: row.id },
  ].filter(Boolean));
}

function captureAssetReferences(rows) {
  return rows.flatMap((row) => [
    row.source_image_path && { relativePath: row.source_image_path, referenceType: "capture-source", ownerId: row.id },
    row.derived_path && { relativePath: row.derived_path, referenceType: "capture-derived", ownerId: row.id },
  ].filter(Boolean));
}

async function processReferencePhase(client, run, { baseDir, batchSize, phase }) {
  const platePhase = phase === "plate-reads";
  const table = platePhase ? "plate_reads" : "capture_assets";
  const cursorColumn = platePhase ? "plate_read_cursor" : "capture_asset_cursor";
  const upperBound = platePhase ? run.max_plate_read_id : run.max_capture_asset_id;
  const selectColumns = platePhase
    ? "id, image_path, thumbnail_path"
    : "id, source_image_path, derived_path";
  const rowsResult = await client.query(
    `SELECT ${selectColumns} FROM public.${table}
     WHERE id > $1 AND id <= $2
     ORDER BY id ASC LIMIT $3`,
    [run[cursorColumn], upperBound, batchSize]
  );
  const rows = rowsResult.rows || [];
  const references = platePhase ? plateReadReferences(rows) : captureAssetReferences(rows);
  const inspection = await inspectDatabaseReferences({
    references,
    statPath: (relativePath) => storageStat(baseDir, relativePath),
  });
  await insertMissingFindings(client, run.id, inspection.missing);
  const nextCursor = rows.at(-1)?.id || run[cursorColumn];
  const nextPhase = rows.length < batchSize
    ? (platePhase ? "capture-assets" : "completed")
    : phase;
  await client.query(
    `UPDATE public.storage_reconciliation_runs
     SET ${cursorColumn} = $2,
         phase = $3,
         references_checked = references_checked + $4,
         error_count = error_count + $5,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [run.id, nextCursor, nextPhase, inspection.checked, inspection.errorCount]
  );
  return { status: "running", phase: nextPhase, runId: Number(run.id) };
}

async function finalizeRun(client, run) {
  const summary = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE finding_type = 'orphan-file')::bigint AS orphan_files,
       COALESCE(SUM(size_bytes) FILTER (WHERE finding_type = 'orphan-file'), 0)::bigint AS orphan_bytes,
       COUNT(*) FILTER (WHERE finding_type = 'missing-reference')::bigint AS missing_reference_paths
     FROM public.storage_reconciliation_items WHERE run_id = $1`,
    [run.id]
  );
  const completed = await client.query(
    `UPDATE public.storage_reconciliation_runs
     SET status = 'completed', phase = 'completed', completed_at = CURRENT_TIMESTAMP,
         orphan_files = $2, orphan_bytes = $3, missing_reference_paths = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING *`,
    [
      run.id,
      summary.rows[0].orphan_files,
      summary.rows[0].orphan_bytes,
      summary.rows[0].missing_reference_paths,
    ]
  );
  const result = buildReconciliationResult(completed.rows[0]);
  await client.query(
    `UPDATE public.maintenance_job_state
     SET status = 'idle', last_completed_at = CURRENT_TIMESTAMP,
         last_result = $2::jsonb, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE job_name = $1`,
    [STORAGE_RECONCILIATION_JOB, JSON.stringify(result)]
  );
  return { status: "completed", result };
}

export async function runStorageReconciliationBatch({
  pool,
  baseDir,
  enabled = true,
  intervalSeconds = 604_800,
  initialDelaySeconds = 90,
  batchSize = 250,
} = {}) {
  if (!baseDir) throw new Error("Storage reconciliation requires a storage directory");
  const database = pool || await getDefaultPool();
  const client = await database.connect();
  let locked = false;
  let activeRunId = null;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [LOCK_NAME]);
    locked = Boolean(lock.rows?.[0]?.locked);
    if (!locked) return { status: "busy" };
    await ensureMaintenanceJobState({
      query: (text, values) => client.query(text, values),
      jobName: STORAGE_RECONCILIATION_JOB,
      enabled,
      intervalSeconds,
      initialDelaySeconds,
    });
    if (!enabled) return { status: "disabled" };

    const active = await client.query(
      `SELECT * FROM public.storage_reconciliation_runs
       WHERE status = 'running' ORDER BY id DESC LIMIT 1`
    );
    const run = active.rows?.[0] || await startRun(client, { intervalSeconds });
    if (!run) return { status: "not-due" };
    activeRunId = run.id;
    const size = boundedBatchSize(batchSize);
    if (run.phase === "filesystem") {
      return await processFilesystemDirectory(client, run, { baseDir, batchSize: size });
    }
    if (["plate-reads", "capture-assets"].includes(run.phase)) {
      return await processReferencePhase(client, run, { baseDir, batchSize: size, phase: run.phase });
    }
    return await finalizeRun(client, run);
  } catch (error) {
    try {
      if (activeRunId) {
        await client.query(
          `UPDATE public.storage_reconciliation_runs
           SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
               last_error = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'running'`,
          [activeRunId, safeError(error)]
        );
      }
      await client.query(
        `UPDATE public.maintenance_job_state
         SET status = 'failed', last_error = $2, updated_at = CURRENT_TIMESTAMP
         WHERE job_name = $1`,
        [STORAGE_RECONCILIATION_JOB, safeError(error)]
      );
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
      } catch {
        // Releasing the client also releases the session lock.
      }
    }
    client.release();
  }
}

export async function getStorageReconciliationStatus({ query } = {}) {
  const databaseQuery = query || (async (text, values) => {
    const pool = await getDefaultPool();
    return pool.query(text, values);
  });
  const [job, runResult] = await Promise.all([
    getMaintenanceJobStatus({ query: databaseQuery, jobName: STORAGE_RECONCILIATION_JOB }),
    databaseQuery(
      `SELECT * FROM public.storage_reconciliation_runs
       ORDER BY id DESC LIMIT 1`
    ),
  ]);
  const run = runResult.rows?.[0];
  if (!job && !run) return null;
  let findings = [];
  let liveSummary = null;
  if (run) {
    const [findingsResult, summaryResult] = await Promise.all([
      databaseQuery(
        `SELECT finding_type, relative_path, size_bytes, modified_at, reference_type, owner_id
         FROM public.storage_reconciliation_items
         WHERE run_id = $1
         ORDER BY finding_type ASC, relative_path ASC
         LIMIT 25`,
        [run.id]
      ),
      databaseQuery(
        `SELECT
           COUNT(*) FILTER (WHERE finding_type = 'orphan-file')::bigint AS orphan_files,
           COALESCE(SUM(size_bytes) FILTER (WHERE finding_type = 'orphan-file'), 0)::bigint AS orphan_bytes,
           COUNT(*) FILTER (WHERE finding_type = 'missing-reference')::bigint AS missing_reference_paths
         FROM public.storage_reconciliation_items WHERE run_id = $1`,
        [run.id]
      ),
    ]);
    liveSummary = summaryResult.rows?.[0] || null;
    findings = (findingsResult.rows || []).map((item) => ({
      findingType: item.finding_type,
      relativePath: item.relative_path,
      sizeBytes: item.size_bytes == null ? null : Number(item.size_bytes),
      modifiedAt: item.modified_at || null,
      referenceType: item.reference_type || null,
      ownerId: item.owner_id == null ? null : Number(item.owner_id),
    }));
  }
  return {
    ...job,
    run: run ? {
      ...buildReconciliationResult({ ...run, ...liveSummary }),
      status: run.status,
      phase: run.phase,
      plateReadCursor: Number(run.plate_read_cursor) || 0,
      captureAssetCursor: Number(run.capture_asset_cursor) || 0,
    } : null,
    findings,
  };
}

export const storageReconciliationRepositoryInternals = Object.freeze({
  LOCK_NAME,
  boundedBatchSize,
  referencedPathSet,
});
