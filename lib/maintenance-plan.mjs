export const RETENTION_MAINTENANCE_JOB = "retention-preview";

export const RETENTION_PLAN_SQL = `
  WITH totals AS (
    SELECT COUNT(*)::bigint AS read_count
    FROM public.plate_reads
  ),
  limits AS (
    SELECT
      read_count,
      CASE
        WHEN read_count > FLOOR($1::numeric * 1.1)
        THEN GREATEST(read_count - $1::bigint, 0)
        ELSE 0
      END AS record_candidate_count,
      CURRENT_TIMESTAMP - make_interval(months => $2::integer) AS retention_cutoff
    FROM totals
  ),
  record_candidates AS (
    SELECT pr.image_path, pr.thumbnail_path
    FROM public.plate_reads pr
    ORDER BY pr."timestamp" ASC, pr.id ASC
    LIMIT (SELECT record_candidate_count FROM limits)
  ),
  record_summary AS (
    SELECT
      COUNT(*)::bigint AS candidate_count,
      COUNT(*) FILTER (WHERE image_path IS NOT NULL)::bigint AS source_reference_count,
      COUNT(*) FILTER (WHERE thumbnail_path IS NOT NULL)::bigint AS thumbnail_reference_count
    FROM record_candidates
  ),
  retention_summary AS (
    SELECT
      COUNT(*)::bigint AS eligible_read_count,
      COUNT(*) FILTER (WHERE pr.image_path IS NOT NULL)::bigint AS source_reference_count,
      COUNT(*) FILTER (WHERE pr.thumbnail_path IS NOT NULL)::bigint AS thumbnail_reference_count
    FROM public.plate_reads pr, limits
    WHERE pr."timestamp" < limits.retention_cutoff
  )
  SELECT
    limits.read_count,
    limits.retention_cutoff,
    record_summary.candidate_count AS record_candidate_count,
    record_summary.source_reference_count AS record_source_reference_count,
    record_summary.thumbnail_reference_count AS record_thumbnail_reference_count,
    retention_summary.eligible_read_count AS retention_eligible_read_count,
    retention_summary.source_reference_count AS retention_source_reference_count,
    retention_summary.thumbnail_reference_count AS retention_thumbnail_reference_count
  FROM limits, record_summary, retention_summary`;

function boundedInteger(value, { fallback, min, max }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeRetentionSettings(settings = {}) {
  return {
    maxRecords: boundedInteger(settings.maxRecords, {
      fallback: 100_000,
      min: 1_000,
      max: 100_000_000,
    }),
    retentionMonths: boundedInteger(settings.retentionMonths, {
      fallback: 3,
      min: 1,
      max: 120,
    }),
  };
}

export function buildRetentionPreview(row = {}, settings = {}) {
  const normalized = normalizeRetentionSettings(settings);
  return {
    mode: "dry-run",
    destructive: false,
    maxRecords: normalized.maxRecords,
    retentionMonths: normalized.retentionMonths,
    currentReadCount: count(row.read_count),
    retentionCutoff: isoDate(row.retention_cutoff),
    recordPruning: {
      candidateReads: count(row.record_candidate_count),
      sourceReferences: count(row.record_source_reference_count),
      thumbnailReferences: count(row.record_thumbnail_reference_count),
    },
    retention: {
      eligibleReads: count(row.retention_eligible_read_count),
      sourceReferences: count(row.retention_source_reference_count),
      thumbnailReferences: count(row.retention_thumbnail_reference_count),
    },
    note: "Database references only; no filesystem scan or deletion was performed.",
  };
}

export async function calculateRetentionPreview({ query, settings } = {}) {
  if (typeof query !== "function") throw new Error("Maintenance preview query must be a function");
  const normalized = normalizeRetentionSettings(settings);
  const result = await query(RETENTION_PLAN_SQL, [
    normalized.maxRecords,
    normalized.retentionMonths,
  ]);
  return buildRetentionPreview(result.rows?.[0] || {}, normalized);
}

