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
        AS reads_last_7_days,
      COUNT(*) FILTER (
        WHERE COALESCE(vehicle_image_updated_at, "timestamp")
            >= CURRENT_TIMESTAMP - INTERVAL '7 days'
          AND vehicle_image_status = 'ready'
          AND NULLIF(BTRIM(vehicle_image_path), '') IS NOT NULL
          AND vehicle_image_source_kind IN (
            'overview_primary','entry_overview_primary','overview_fallback',
            'overview_pair_share','entry_overview_route_fallback',
            'entry_overview_history'
          )
      )::bigint AS eligible_overview_reads_last_7_days
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
  ),
  vehicle_image_asset_link_metrics AS (
    SELECT
      links.asset_id,
      COUNT(*)::bigint AS read_link_count,
      COUNT(*) FILTER (
        WHERE reads.vehicle_image_status = 'ready'
          AND reads.vehicle_image_path = links.source_path_snapshot
          AND reads.vehicle_image_source_kind = links.source_kind
          AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
      )::bigint AS current_read_link_count
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    GROUP BY links.asset_id
  ),
  vehicle_image_asset_metrics AS (
    SELECT
      COUNT(*)::bigint AS vehicle_image_asset_count,
      COALESCE(SUM(byte_size), 0)::bigint AS vehicle_image_asset_bytes,
      COALESCE(SUM(byte_size) FILTER (
        WHERE COALESCE(link_metrics.current_read_link_count, 0) > 0
      ), 0)::bigint AS vehicle_image_asset_current_linked_bytes,
      COUNT(*) FILTER (
        WHERE COALESCE(link_metrics.read_link_count, 0) = 0
      )::bigint AS vehicle_image_asset_zero_link_count,
      COALESCE(SUM(byte_size) FILTER (
        WHERE COALESCE(link_metrics.read_link_count, 0) = 0
      ), 0)::bigint AS vehicle_image_asset_zero_link_bytes,
      (SELECT COUNT(*)::bigint FROM public.vehicle_image_asset_reads)
        AS vehicle_image_asset_read_links,
      COALESCE(SUM(link_metrics.current_read_link_count), 0)::bigint
        AS vehicle_image_asset_current_read_links,
      (
        (SELECT COUNT(*)::bigint FROM public.vehicle_image_asset_reads)
        - COALESCE(SUM(link_metrics.current_read_link_count), 0)::bigint
      )::bigint AS vehicle_image_asset_stale_read_links
    FROM public.vehicle_image_assets assets
    LEFT JOIN vehicle_image_asset_link_metrics link_metrics
      ON link_metrics.asset_id = assets.id
  ),
  vehicle_image_crop_metrics AS (
    SELECT
      COUNT(*)::bigint AS vehicle_image_crop_count,
      COUNT(DISTINCT storage_path)::bigint AS vehicle_image_crop_file_count,
      COALESCE(SUM(byte_size), 0)::bigint AS vehicle_image_crop_logical_bytes,
      COALESCE((
        SELECT SUM(files.byte_size)::bigint
        FROM (
          SELECT storage_path, MAX(byte_size)::bigint AS byte_size
          FROM public.vehicle_image_derivatives
          WHERE derivative_kind = 'vehicle_crop'
          GROUP BY storage_path
        ) files
      ), 0)::bigint AS vehicle_image_crop_physical_bytes,
      COALESCE((
        SELECT COUNT(*)::bigint
        FROM public.vehicle_image_derivatives current_derivatives
        JOIN public.vehicle_image_asset_reads links
          ON links.asset_id = current_derivatives.asset_id
        JOIN public.plate_reads reads ON reads.id = links.read_id
        WHERE current_derivatives.derivative_kind = 'vehicle_crop'
          AND current_derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
          AND links.identity_eligible = TRUE
          AND reads.vehicle_image_status = 'ready'
          AND reads.vehicle_image_path = links.source_path_snapshot
          AND reads.vehicle_image_source_kind = links.source_kind
          AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
      ), 0)::bigint AS vehicle_image_crop_current_read_links,
      COALESCE((
        SELECT SUM(current_files.byte_size)::bigint
        FROM (
          SELECT derivatives.storage_path, MAX(derivatives.byte_size)::bigint AS byte_size
          FROM public.vehicle_image_derivatives derivatives
          WHERE derivatives.derivative_kind = 'vehicle_crop'
            AND derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
            AND EXISTS (
              SELECT 1
              FROM public.vehicle_image_asset_reads links
              JOIN public.plate_reads reads ON reads.id = links.read_id
              WHERE links.asset_id = derivatives.asset_id
                AND links.identity_eligible = TRUE
                AND reads.vehicle_image_status = 'ready'
                AND reads.vehicle_image_path = links.source_path_snapshot
                AND reads.vehicle_image_source_kind = links.source_kind
                AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
            )
          GROUP BY derivatives.storage_path
        ) current_files
      ), 0)::bigint AS vehicle_image_crop_current_physical_bytes
    FROM public.vehicle_image_derivatives
    WHERE derivative_kind = 'vehicle_crop'
  )
  SELECT
    pg_database_size(current_database())::bigint AS database_bytes,
    pg_total_relation_size('public.plate_reads')::bigint AS plate_read_relation_bytes,
    (SELECT COUNT(*)::bigint FROM public.plates) AS plate_count,
    read_metrics.*,
    asset_metrics.*,
    vehicle_image_asset_metrics.*,
    vehicle_image_crop_metrics.*
  FROM read_metrics
  CROSS JOIN asset_metrics
  CROSS JOIN vehicle_image_asset_metrics
  CROSS JOIN vehicle_image_crop_metrics`;

export const STORAGE_HEALTH_SAMPLE_SQL = `
  SELECT
    pr.id,
    pr.image_path,
    pr.thumbnail_path,
    pr.vehicle_image_path,
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

export const STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL = `
  SELECT
    to_regclass('public.vehicle_image_asset_catalog_runs')::text AS runs_relation,
    to_regclass('public.vehicle_image_asset_catalog_items')::text AS items_relation`;

export const STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL = `
  WITH latest_active_run AS (
    SELECT id, status, phase
    FROM public.vehicle_image_asset_catalog_runs
    WHERE status IN ('ready', 'running', 'paused')
    ORDER BY id DESC
    LIMIT 1
  ),
  unique_preview_assets AS (
    SELECT
      items.run_id,
      items.preview_sha256,
      MAX(items.preview_byte_size)::bigint AS byte_size
    FROM public.vehicle_image_asset_catalog_items items
    JOIN latest_active_run run ON run.id = items.run_id
    WHERE items.preview_sha256 IS NOT NULL
      AND items.preview_byte_size > 0
      AND (
        items.status IN ('previewed', 'queued', 'processing')
        OR (items.status = 'failed'
          AND items.failure_stage = 'catalog'
          AND items.retryable = TRUE)
      )
    GROUP BY items.run_id, items.preview_sha256
  ),
  new_preview_assets AS (
    SELECT preview.run_id, preview.preview_sha256, preview.byte_size
    FROM unique_preview_assets preview
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.vehicle_image_assets assets
      WHERE assets.content_sha256 = preview.preview_sha256
    )
  ),
  campaign_projection AS (
    SELECT
      COUNT(*)::bigint AS unique_new_assets,
      COALESCE(SUM(byte_size), 0)::bigint AS projected_new_bytes
    FROM new_preview_assets
  )
  SELECT
    run.id AS run_id,
    run.status,
    run.phase,
    projection.unique_new_assets,
    projection.projected_new_bytes
  FROM latest_active_run run
  CROSS JOIN campaign_projection projection`;

export const STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL = `
  SELECT
    to_regclass('public.vehicle_image_asset_live_catalog_control')::text
      AS control_relation,
    to_regclass('public.vehicle_image_asset_catalog_runs')::text
      AS runs_relation`;

export const STORAGE_HEALTH_LIVE_CATALOG_SQL = `
  SELECT
    COALESCE((SELECT enabled
      FROM public.vehicle_image_asset_live_catalog_control
      WHERE singleton = TRUE), FALSE) AS enabled,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_asset_catalog_runs
      WHERE status = 'completed' AND phase = 'completed'
    ) AS completed_campaign`;

export const STORAGE_HEALTH_LIVE_CROP_RELATION_SQL = `
  SELECT
    to_regclass('public.vehicle_image_crop_live_control')::text
      AS control_relation,
    to_regclass('public.vehicle_image_crop_runs')::text
      AS runs_relation`;

export const STORAGE_HEALTH_LIVE_CROP_SQL = `
  SELECT
    COALESCE((SELECT enabled
      FROM public.vehicle_image_crop_live_control
      WHERE singleton = TRUE), FALSE) AS enabled,
    EXISTS (
      SELECT 1 FROM public.vehicle_image_crop_runs
      WHERE status = 'completed'
    ) AS completed_campaign`;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function loadActiveCatalogCampaign(query) {
  try {
    const relationResult = await query(STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL);
    const relation = relationResult.rows?.[0] || {};
    if (!relation.runs_relation || !relation.items_relation) return null;
    const campaignResult = await query(STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL);
    const campaign = campaignResult.rows?.[0];
    if (!campaign) return null;
    return {
      runId: finiteNonNegative(campaign.run_id),
      status: String(campaign.status || ""),
      phase: String(campaign.phase || ""),
      uniqueNewAssets: finiteNonNegative(campaign.unique_new_assets),
      projectedNewBytes: finiteNonNegative(campaign.projected_new_bytes),
    };
  } catch {
    // Catalog campaigns were introduced after the canonical asset foundation.
    // Missing or partially migrated control-plane tables must not hide the
    // otherwise valid base storage-health measurements.
    return null;
  }
}

async function loadLiveCatalogState(query) {
  try {
    const relationResult = await query(STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL);
    const relation = relationResult.rows?.[0] || {};
    if (!relation.control_relation || !relation.runs_relation) return null;
    const stateResult = await query(STORAGE_HEALTH_LIVE_CATALOG_SQL);
    const state = stateResult.rows?.[0] || {};
    return {
      enabled: state.enabled === true,
      completedCampaign: state.completed_campaign === true,
    };
  } catch {
    return null;
  }
}

async function loadLiveCropState(query) {
  try {
    const relationResult = await query(STORAGE_HEALTH_LIVE_CROP_RELATION_SQL);
    const relation = relationResult.rows?.[0] || {};
    if (!relation.control_relation || !relation.runs_relation) return null;
    const stateResult = await query(STORAGE_HEALTH_LIVE_CROP_SQL);
    const state = stateResult.rows?.[0] || {};
    return {
      enabled: state.enabled === true,
      completedCampaign: state.completed_campaign === true,
    };
  } catch {
    return null;
  }
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

    for (const relativePath of [row.image_path, row.thumbnail_path, row.vehicle_image_path, row.derived_path]) {
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
  let activeCatalogCampaign = null;
  let liveCatalog = null;
  let liveCrop = null;
  try {
    const [metricsResult, sampleResult] = await Promise.all([
      query(STORAGE_HEALTH_METRICS_SQL),
      query(STORAGE_HEALTH_SAMPLE_SQL, [sampleLimit]),
    ]);
    metrics = metricsResult.rows?.[0] || {};
    sample = await inspectSample(sampleResult.rows || [], { statPath, resolvePath });
    [activeCatalogCampaign, liveCatalog, liveCrop] = await Promise.all([
      loadActiveCatalogCampaign(query),
      loadLiveCatalogState(query),
      loadLiveCropState(query),
    ]);

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
      eligibleOverviewReadsLast7Days: finiteNonNegative(
        metrics.eligible_overview_reads_last_7_days
      ),
      eligibleOverviewReadsPerDay: Number((
        finiteNonNegative(metrics.eligible_overview_reads_last_7_days) / 7
      ).toFixed(1)),
    };
    result.assets = {
      readyCount,
      failedCount,
      pendingCount,
      sourceMissingCount: finiteNonNegative(metrics.source_missing_count),
      lastIndexedAt: isoDate(metrics.last_indexed_at),
      canonicalVehicleImageCount: finiteNonNegative(metrics.vehicle_image_asset_count),
      canonicalVehicleImageBytes: finiteNonNegative(metrics.vehicle_image_asset_bytes),
      canonicalVehicleImageCurrentLinkedBytes: finiteNonNegative(
        metrics.vehicle_image_asset_current_linked_bytes
      ),
      canonicalVehicleImageReadLinks: finiteNonNegative(metrics.vehicle_image_asset_read_links),
      canonicalVehicleImageCurrentReadLinks: finiteNonNegative(
        metrics.vehicle_image_asset_current_read_links
      ),
      canonicalVehicleImageStaleReadLinks: finiteNonNegative(
        metrics.vehicle_image_asset_stale_read_links
      ),
      canonicalVehicleImageZeroLinkCount: finiteNonNegative(
        metrics.vehicle_image_asset_zero_link_count
      ),
      canonicalVehicleImageZeroLinkBytes: finiteNonNegative(
        metrics.vehicle_image_asset_zero_link_bytes
      ),
      canonicalVehicleImageRetentionPolicy: "archive",
      canonicalVehicleImageActiveCampaign: activeCatalogCampaign,
      canonicalVehicleImageLiveCatalog: liveCatalog,
      canonicalVehicleCropCount: finiteNonNegative(metrics.vehicle_image_crop_count),
      canonicalVehicleCropFileCount: finiteNonNegative(
        metrics.vehicle_image_crop_file_count
      ),
      canonicalVehicleCropLogicalBytes: finiteNonNegative(
        metrics.vehicle_image_crop_logical_bytes
      ),
      canonicalVehicleCropPhysicalBytes: finiteNonNegative(
        metrics.vehicle_image_crop_physical_bytes
      ),
      canonicalVehicleCropCurrentReadLinks: finiteNonNegative(
        metrics.vehicle_image_crop_current_read_links
      ),
      canonicalVehicleCropCurrentPhysicalBytes: finiteNonNegative(
        metrics.vehicle_image_crop_current_physical_bytes
      ),
      canonicalVehicleCropLive: liveCrop,
      sampleLimit,
      ...sample,
    };
  } catch {
    result.errors.push("Database and image-asset measurements could not be completed.");
  }

  if (result.filesystem && result.database && result.assets) {
    const canonicalBytesPerLinkedRead = result.assets.canonicalVehicleImageCurrentReadLinks
      ? Math.round(
        result.assets.canonicalVehicleImageCurrentLinkedBytes
          / result.assets.canonicalVehicleImageCurrentReadLinks
      )
      : 0;
    const estimatedBytesPerRead = result.assets.averageAssetBytesPerRead
      + result.database.plateReadBytesPerRead;
    const baseEstimatedBytesPerDay = Math.round(
      estimatedBytesPerRead * result.database.readsPerDay
    );
    const liveCatalogGrowthEnabled = result.assets.canonicalVehicleImageLiveCatalog?.enabled === true
      && result.assets.canonicalVehicleImageLiveCatalog?.completedCampaign === true;
    const canonicalEstimatedBytesPerDay = liveCatalogGrowthEnabled
      ? Math.round(canonicalBytesPerLinkedRead * result.database.eligibleOverviewReadsPerDay)
      : 0;
    const canonicalBytesPerPlateRead = result.database.readsPerDay
      ? Math.round(canonicalEstimatedBytesPerDay / result.database.readsPerDay)
      : 0;
    const cropBytesPerLinkedRead = result.assets.canonicalVehicleCropCurrentReadLinks
      ? Math.round(
        result.assets.canonicalVehicleCropCurrentPhysicalBytes
          / result.assets.canonicalVehicleCropCurrentReadLinks
      )
      : 0;
    const liveCropGrowthEnabled = result.assets.canonicalVehicleCropLive?.enabled === true
      && result.assets.canonicalVehicleCropLive?.completedCampaign === true;
    const cropEstimatedBytesPerDay = liveCropGrowthEnabled
      ? Math.round(cropBytesPerLinkedRead * result.database.eligibleOverviewReadsPerDay)
      : 0;
    const cropBytesPerPlateRead = result.database.readsPerDay
      ? Math.round(cropEstimatedBytesPerDay / result.database.readsPerDay)
      : 0;
    const estimatedBytesPerReadWithCanonical = estimatedBytesPerRead
      + canonicalBytesPerPlateRead + cropBytesPerPlateRead;
    const estimatedBytesPerDay = baseEstimatedBytesPerDay
      + canonicalEstimatedBytesPerDay + cropEstimatedBytesPerDay;
    const activeCampaignProjectedCanonicalBytes = finiteNonNegative(
      result.assets.canonicalVehicleImageActiveCampaign?.projectedNewBytes
    );
    result.growth = {
      estimatedBytesPerRead: estimatedBytesPerReadWithCanonical,
      estimatedBytesPerDay,
      baseEstimatedBytesPerRead: estimatedBytesPerRead,
      baseEstimatedBytesPerDay,
      canonicalBytesPerLinkedRead,
      canonicalBytesPerPlateRead,
      canonicalEstimatedBytesPerDay,
      canonicalCurrentBytes: result.assets.canonicalVehicleImageBytes,
      canonicalCurrentReadLinks: result.assets.canonicalVehicleImageCurrentReadLinks,
      canonicalContributionIncludedInDailyEstimate: liveCatalogGrowthEnabled,
      cropBytesPerLinkedRead,
      cropBytesPerPlateRead,
      cropEstimatedBytesPerDay,
      cropContributionIncludedInDailyEstimate: liveCropGrowthEnabled,
      activeCampaignProjectedCanonicalBytes,
      projectedUsedBytesAfterActiveCampaign:
        result.filesystem.usedBytes + activeCampaignProjectedCanonicalBytes,
      basis: liveCatalogGrowthEnabled || liveCropGrowthEnabled
        ? "Seven-day read rate × recent bounded source sample and database bytes/read, plus eligible Overview rate × enabled observed canonical and crop bytes/current link"
        : "Seven-day read rate × recent bounded asset sample + current plate-read relation bytes/read",
      projections: buildCapacityProjections({
        totalBytes: result.filesystem.totalBytes,
        usedBytes: result.filesystem.usedBytes,
        estimatedBytesPerDay,
        measuredAt,
      }),
      projectionsAfterActiveCampaign: result.assets.canonicalVehicleImageActiveCampaign
        ? buildCapacityProjections({
          totalBytes: result.filesystem.totalBytes,
          usedBytes: result.filesystem.usedBytes + activeCampaignProjectedCanonicalBytes,
          estimatedBytesPerDay,
          measuredAt,
        })
        : null,
    };
  }

  return result;
}
