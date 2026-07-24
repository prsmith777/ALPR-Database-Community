export const STORAGE_HEALTH_SAMPLE_LIMIT = 120;
export const STORAGE_CAPACITY_THRESHOLDS = Object.freeze([70, 80, 90]);

export const STORAGE_HEALTH_METRICS_SQL = `
  WITH read_metrics AS (
    SELECT
      COUNT(*)::bigint AS read_count,
      COUNT(*) FILTER (WHERE image_path IS NOT NULL)::bigint AS image_reference_count,
      COUNT(*) FILTER (WHERE image_path IS NULL)::bigint AS records_without_image_path,
      COUNT(*) FILTER (WHERE "timestamp" >= CURRENT_TIMESTAMP - INTERVAL '24 hours')::bigint
        AS reads_last_24_hours,
      COUNT(*) FILTER (WHERE "timestamp" >= CURRENT_TIMESTAMP - INTERVAL '7 days')::bigint
        AS reads_last_7_days
    FROM public.plate_reads
  ),
  latest_assets AS (
    SELECT DISTINCT ON (read_id)
      read_id, status, error_code, indexed_at
    FROM public.capture_assets
    ORDER BY read_id, updated_at DESC, id DESC
  ),
  asset_metrics AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'ready')::bigint AS ready_count,
      COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed_count,
      COUNT(*) FILTER (
        WHERE status = 'failed' AND error_code = 'SOURCE_IMAGE_MISSING'
      )::bigint AS source_missing_count,
      MAX(indexed_at) FILTER (WHERE status = 'ready') AS last_indexed_at
    FROM latest_assets
  )
  SELECT
    pg_database_size(current_database())::bigint AS database_bytes,
    pg_total_relation_size('public.plate_reads')::bigint AS plate_read_relation_bytes,
    (SELECT COUNT(*)::bigint FROM public.plates) AS plate_count,
    read_metrics.*,
    asset_metrics.*
  FROM read_metrics CROSS JOIN asset_metrics`;

export const STORAGE_HEALTH_SAMPLE_SQL = `
  SELECT
    pr.id,
    pr.image_path,
    pr.thumbnail_path,
    asset.derived_path
  FROM public.plate_reads pr
  LEFT JOIN LATERAL (
    SELECT ca.derived_path
    FROM public.capture_assets ca
    WHERE ca.read_id = pr.id
      AND ca.status = 'ready'
      AND ca.derived_path IS NOT NULL
    ORDER BY ca.indexed_at DESC NULLS LAST, ca.id DESC
    LIMIT 1
  ) asset ON TRUE
  WHERE pr.image_path IS NOT NULL
  ORDER BY pr."timestamp" DESC, pr.id DESC
  LIMIT $1`;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildCapacityProjections({
  totalBytes,
  usedBytes,
  estimatedBytesPerDay,
  measuredAt = new Date(),
  thresholds = STORAGE_CAPACITY_THRESHOLDS,
} = {}) {
  const total = finiteNonNegative(totalBytes);
  const used = finiteNonNegative(usedBytes);
  const dailyGrowth = finiteNonNegative(estimatedBytesPerDay);
  const measured = new Date(measuredAt);
  const measuredMs = Number.isNaN(measured.getTime()) ? Date.now() : measured.getTime();

  return thresholds.map((threshold) => {
    const percent = Math.min(100, Math.max(0, finiteNonNegative(threshold)));
    const thresholdBytes = total * percent / 100;
    const remainingBytes = Math.max(0, thresholdBytes - used);

    if (!total) {
      return { percent, status: "unavailable", days: null, projectedAt: null };
    }
    if (remainingBytes === 0) {
      return { percent, status: "reached", days: 0, projectedAt: null };
    }
    if (!dailyGrowth) {
      return { percent, status: "stable", days: null, projectedAt: null };
    }

    const days = Math.ceil(remainingBytes / dailyGrowth);
    return {
      percent,
      status: "projected",
      days,
      projectedAt: new Date(measuredMs + days * 86_400_000).toISOString(),
    };
  });
}

export function unavailableStorageHealth(message = "Storage measurements are unavailable") {
  return {
    measuredAt: new Date().toISOString(),
    readOnly: true,
    filesystem: null,
    database: null,
    assets: null,
    growth: null,
    errors: [message],
  };
}

async function inspectSample(rows, { statPath, resolvePath }) {
  const inspections = await Promise.all(rows.map(async (row) => {
    let bytes = 0;
    let foundReferences = 0;
    let missingReferences = 0;
    let sourceFound = false;

    for (const relativePath of [row.image_path, row.thumbnail_path, row.derived_path]) {
      if (!relativePath) continue;
      try {
        const file = await statPath(resolvePath(relativePath));
        if (!file?.isFile?.()) throw new Error("Referenced asset is not a file");
        bytes += finiteNonNegative(file.size);
        foundReferences += 1;
        if (relativePath === row.image_path) sourceFound = true;
      } catch {
        missingReferences += 1;
      }
    }

    return { bytes, foundReferences, missingReferences, sourceFound };
  }));

  const sourceBacked = inspections.filter((item) => item.sourceFound);
  const sampledBytes = sourceBacked.reduce((total, item) => total + item.bytes, 0);
  return {
    requestedReads: rows.length,
    sampledReads: sourceBacked.length,
    sampledBytes,
    averageAssetBytesPerRead: sourceBacked.length
      ? Math.round(sampledBytes / sourceBacked.length)
      : 0,
    inspectedReferences: inspections.reduce((total, item) => total + item.foundReferences, 0),
    missingReferences: inspections.reduce((total, item) => total + item.missingReferences, 0),
  };
}

export async function collectStorageHealth({
  query,
  storagePath,
  statfs,
  statPath,
  resolvePath,
  now = () => new Date(),
  sampleLimit = STORAGE_HEALTH_SAMPLE_LIMIT,
} = {}) {
  const measuredAt = now();
  const result = {
    measuredAt: measuredAt.toISOString(),
    readOnly: true,
    filesystem: null,
    database: null,
    assets: null,
    growth: null,
    errors: [],
  };

  try {
    const filesystem = await statfs(storagePath);
    const blockSize = finiteNonNegative(filesystem.bsize);
    const totalBytes = finiteNonNegative(filesystem.blocks) * blockSize;
    const availableBytes = finiteNonNegative(filesystem.bavail) * blockSize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    result.filesystem = {
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: totalBytes ? Number((usedBytes / totalBytes * 100).toFixed(1)) : 0,
    };
  } catch {
    result.errors.push("Mounted capture-storage capacity could not be measured.");
  }

  let metrics = null;
  let sample = null;
  try {
    const [metricsResult, sampleResult] = await Promise.all([
      query(STORAGE_HEALTH_METRICS_SQL),
      query(STORAGE_HEALTH_SAMPLE_SQL, [sampleLimit]),
    ]);
    metrics = metricsResult.rows?.[0] || {};
    sample = await inspectSample(sampleResult.rows || [], { statPath, resolvePath });

    const readCount = finiteNonNegative(metrics.read_count);
    const imageReferenceCount = finiteNonNegative(metrics.image_reference_count);
    const readyCount = finiteNonNegative(metrics.ready_count);
    const failedCount = finiteNonNegative(metrics.failed_count);
    const pendingCount = Math.max(0, imageReferenceCount - readyCount - failedCount);
    const plateReadRelationBytes = finiteNonNegative(metrics.plate_read_relation_bytes);

    result.database = {
      totalBytes: finiteNonNegative(metrics.database_bytes),
      plateReadRelationBytes,
      plateReadBytesPerRead: readCount ? Math.round(plateReadRelationBytes / readCount) : 0,
      readCount,
      plateCount: finiteNonNegative(metrics.plate_count),
      imageReferenceCount,
      recordsWithoutImagePath: finiteNonNegative(metrics.records_without_image_path),
      readsLast24Hours: finiteNonNegative(metrics.reads_last_24_hours),
      readsLast7Days: finiteNonNegative(metrics.reads_last_7_days),
      readsPerDay: Number((finiteNonNegative(metrics.reads_last_7_days) / 7).toFixed(1)),
    };
    result.assets = {
      readyCount,
      failedCount,
      pendingCount,
      sourceMissingCount: finiteNonNegative(metrics.source_missing_count),
      lastIndexedAt: isoDate(metrics.last_indexed_at),
      sampleLimit,
      ...sample,
    };
  } catch {
    result.errors.push("Database and image-asset measurements could not be completed.");
  }

  if (result.filesystem && result.database && result.assets) {
    const estimatedBytesPerRead = result.assets.averageAssetBytesPerRead
      + result.database.plateReadBytesPerRead;
    const estimatedBytesPerDay = Math.round(
      estimatedBytesPerRead * result.database.readsPerDay
    );
    result.growth = {
      estimatedBytesPerRead,
      estimatedBytesPerDay,
      basis: "Seven-day read rate × recent bounded asset sample + current plate-read relation bytes/read",
      projections: buildCapacityProjections({
        totalBytes: result.filesystem.totalBytes,
        usedBytes: result.filesystem.usedBytes,
        estimatedBytesPerDay,
        measuredAt,
      }),
    };
  }

  return result;
}
