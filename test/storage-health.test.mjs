import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCapacityProjections,
  collectStorageHealth,
  STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL,
  STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL,
  STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL,
  STORAGE_HEALTH_LIVE_CATALOG_SQL,
  STORAGE_HEALTH_LIVE_CROP_RELATION_SQL,
  STORAGE_HEALTH_LIVE_CROP_SQL,
  STORAGE_HEALTH_METRICS_SQL,
  STORAGE_HEALTH_SAMPLE_SQL,
} from "../lib/storage-health.mjs";

test("capacity projections identify reached, projected, and stable thresholds", () => {
  const projected = buildCapacityProjections({
    totalBytes: 1_000,
    usedBytes: 750,
    estimatedBytesPerDay: 25,
    measuredAt: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.deepEqual(projected[0], {
    percent: 70,
    status: "reached",
    days: 0,
    projectedAt: null,
  });
  assert.deepEqual(projected[1], {
    percent: 80,
    status: "projected",
    days: 2,
    projectedAt: "2026-07-26T12:00:00.000Z",
  });
  assert.equal(projected[2].days, 6);

  const stable = buildCapacityProjections({
    totalBytes: 1_000,
    usedBytes: 500,
    estimatedBytesPerDay: 0,
  });
  assert.equal(stable[0].status, "stable");
});

test("storage health combines exact database and filesystem facts with a bounded sample", async () => {
  const queries = [];
  const metricRow = {
    database_bytes: "5000",
    plate_read_relation_bytes: "2000",
    plate_count: "8",
    read_count: "10",
    image_reference_count: "9",
    records_without_image_path: "1",
    reads_last_24_hours: "12",
    reads_last_7_days: "70",
    eligible_overview_reads_last_7_days: "14",
    ready_count: "7",
    failed_count: "1",
    source_missing_count: "1",
    last_indexed_at: "2026-07-24T11:30:00.000Z",
    vehicle_image_asset_count: "4",
    vehicle_image_asset_bytes: "1200",
    vehicle_image_asset_current_linked_bytes: "900",
    vehicle_image_asset_read_links: "7",
    vehicle_image_asset_current_read_links: "6",
    vehicle_image_asset_stale_read_links: "1",
    vehicle_image_asset_zero_link_count: "1",
    vehicle_image_asset_zero_link_bytes: "300",
    vehicle_image_crop_count: "2",
    vehicle_image_crop_file_count: "2",
    vehicle_image_crop_logical_bytes: "400",
    vehicle_image_crop_physical_bytes: "400",
    vehicle_image_crop_current_read_links: "2",
    vehicle_image_crop_current_physical_bytes: "400",
  };
  const sampleRows = [
    { image_path: "images/a.jpg", thumbnail_path: "thumbnails/a.jpg", derived_path: "derived/a.jpg" },
    { image_path: "images/b.jpg", thumbnail_path: "thumbnails/b.jpg", derived_path: "derived/b.jpg" },
  ];
  const sizes = new Map([
    ["images/a.jpg", 100],
    ["thumbnails/a.jpg", 20],
    ["derived/a.jpg", 30],
    ["images/b.jpg", 200],
    ["thumbnails/b.jpg", 50],
  ]);

  const snapshot = await collectStorageHealth({
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql === STORAGE_HEALTH_METRICS_SQL) return { rows: [metricRow] };
      if (sql === STORAGE_HEALTH_SAMPLE_SQL) return { rows: sampleRows };
      if (sql === STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL) {
        return { rows: [{
          runs_relation: "vehicle_image_asset_catalog_runs",
          items_relation: "vehicle_image_asset_catalog_items",
        }] };
      }
      if (sql === STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL) {
        return { rows: [{
          run_id: "19",
          status: "ready",
          phase: "catalog",
          unique_new_assets: "2",
          projected_new_bytes: "2500",
        }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL) {
        return { rows: [{
          control_relation: "vehicle_image_asset_live_catalog_control",
          runs_relation: "vehicle_image_asset_catalog_runs",
        }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CATALOG_SQL) {
        return { rows: [{ enabled: false, completed_campaign: true }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CROP_RELATION_SQL) {
        return { rows: [{
          control_relation: "vehicle_image_crop_live_control",
          runs_relation: "vehicle_image_crop_runs",
        }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CROP_SQL) {
        return { rows: [{ enabled: false, completed_campaign: true }] };
      }
      assert.fail("Unexpected storage-health query");
    },
    storagePath: "/capture-storage",
    statfs: async () => ({ bsize: 100, blocks: 100, bavail: 40 }),
    resolvePath: (relativePath) => relativePath,
    statPath: async (relativePath) => {
      if (!sizes.has(relativePath)) throw new Error("missing");
      return { size: sizes.get(relativePath), isFile: () => true };
    },
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    sampleLimit: 2,
  });

  assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.filesystem, {
    totalBytes: 10_000,
    usedBytes: 6_000,
    availableBytes: 4_000,
    usedPercent: 60,
  });
  assert.equal(snapshot.database.readsPerDay, 10);
  assert.equal(snapshot.database.plateReadBytesPerRead, 200);
  assert.equal(snapshot.assets.readyCount, 7);
  assert.equal(snapshot.assets.pendingCount, 1);
  assert.equal(snapshot.assets.sampledReads, 2);
  assert.equal(snapshot.assets.averageAssetBytesPerRead, 200);
  assert.equal(snapshot.assets.missingReferences, 1);
  assert.equal(snapshot.assets.canonicalVehicleImageCount, 4);
  assert.equal(snapshot.assets.canonicalVehicleImageBytes, 1_200);
  assert.equal(snapshot.assets.canonicalVehicleImageCurrentLinkedBytes, 900);
  assert.equal(snapshot.assets.canonicalVehicleImageReadLinks, 7);
  assert.equal(snapshot.assets.canonicalVehicleImageCurrentReadLinks, 6);
  assert.equal(snapshot.assets.canonicalVehicleImageStaleReadLinks, 1);
  assert.equal(snapshot.assets.canonicalVehicleImageZeroLinkCount, 1);
  assert.equal(snapshot.assets.canonicalVehicleImageZeroLinkBytes, 300);
  assert.equal(snapshot.assets.canonicalVehicleImageRetentionPolicy, "archive");
  assert.deepEqual(snapshot.assets.canonicalVehicleImageActiveCampaign, {
    runId: 19,
    status: "ready",
    phase: "catalog",
    uniqueNewAssets: 2,
    projectedNewBytes: 2_500,
  });
  assert.deepEqual(snapshot.assets.canonicalVehicleImageLiveCatalog, {
    enabled: false,
    completedCampaign: true,
  });
  assert.equal(snapshot.assets.canonicalVehicleCropCount, 2);
  assert.equal(snapshot.assets.canonicalVehicleCropPhysicalBytes, 400);
  assert.equal(snapshot.assets.canonicalVehicleCropCurrentReadLinks, 2);
  assert.equal(snapshot.assets.canonicalVehicleCropCurrentPhysicalBytes, 400);
  assert.deepEqual(snapshot.assets.canonicalVehicleCropLive, {
    enabled: false,
    completedCampaign: true,
  });
  assert.equal(snapshot.growth.estimatedBytesPerRead, 400);
  assert.equal(snapshot.growth.estimatedBytesPerDay, 4_000);
  assert.equal(snapshot.growth.canonicalBytesPerLinkedRead, 150);
  assert.equal(snapshot.growth.canonicalContributionIncludedInDailyEstimate, false);
  assert.equal(snapshot.growth.cropContributionIncludedInDailyEstimate, false);
  assert.equal(snapshot.growth.activeCampaignProjectedCanonicalBytes, 2_500);
  assert.equal(snapshot.growth.projectedUsedBytesAfterActiveCampaign, 8_500);
  assert.equal(snapshot.growth.projections[0].days, 1);
  assert.equal(snapshot.growth.projectionsAfterActiveCampaign[1].status, "reached");
  assert.equal(queries[1].sql, STORAGE_HEALTH_SAMPLE_SQL);
  assert.deepEqual(queries[1].values, [2]);
  assert.match(STORAGE_HEALTH_METRICS_SQL, /vehicle_image_asset_metrics\.\*/);
  assert.match(STORAGE_HEALTH_METRICS_SQL, /vehicle_image_asset_zero_link_bytes/);
  assert.match(STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL, /GROUP BY items\.run_id, items\.preview_sha256/);
  assert.match(STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL, /items\.status IN \('previewed', 'queued', 'processing'\)/);
  assert.match(STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL, /NOT EXISTS[\s\S]*vehicle_image_assets/);
});

test("catalog campaign projection is optional across migration boundaries", async () => {
  const metricRow = {
    database_bytes: "100",
    plate_read_relation_bytes: "40",
    plate_count: "1",
    read_count: "2",
    image_reference_count: "0",
    records_without_image_path: "2",
    reads_last_24_hours: "0",
    reads_last_7_days: "0",
    eligible_overview_reads_last_7_days: "0",
    ready_count: "0",
    failed_count: "0",
    source_missing_count: "0",
    vehicle_image_asset_count: "1",
    vehicle_image_asset_bytes: "80",
    vehicle_image_asset_current_linked_bytes: "0",
    vehicle_image_asset_read_links: "0",
    vehicle_image_asset_current_read_links: "0",
    vehicle_image_asset_stale_read_links: "0",
    vehicle_image_asset_zero_link_count: "1",
    vehicle_image_asset_zero_link_bytes: "80",
  };

  for (const campaignState of ["absent", "query-failed"]) {
    const snapshot = await collectStorageHealth({
      query: async (sql) => {
        if (sql === STORAGE_HEALTH_METRICS_SQL) return { rows: [metricRow] };
        if (sql === STORAGE_HEALTH_SAMPLE_SQL) return { rows: [] };
        if (sql === STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL) {
          return campaignState === "absent"
            ? { rows: [{ runs_relation: null, items_relation: null }] }
            : { rows: [{
              runs_relation: "vehicle_image_asset_catalog_runs",
              items_relation: "vehicle_image_asset_catalog_items",
            }] };
        }
        if (sql === STORAGE_HEALTH_CATALOG_CAMPAIGN_SQL) {
          throw new Error("campaign schema is still migrating");
        }
        if (sql === STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL) {
          return { rows: [{ control_relation: null, runs_relation: null }] };
        }
        if (sql === STORAGE_HEALTH_LIVE_CROP_RELATION_SQL) {
          return { rows: [{ control_relation: null, runs_relation: null }] };
        }
        assert.fail("Unexpected storage-health query");
      },
      storagePath: "/capture-storage",
      statfs: async () => ({ bsize: 1, blocks: 1_000, bavail: 500 }),
      resolvePath: (value) => value,
      statPath: async () => ({ size: 0, isFile: () => true }),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });

    assert.deepEqual(snapshot.errors, [], campaignState);
    assert.equal(snapshot.assets.canonicalVehicleImageActiveCampaign, null, campaignState);
    assert.equal(snapshot.assets.canonicalVehicleImageLiveCatalog, null, campaignState);
    assert.equal(snapshot.assets.canonicalVehicleCropLive, null, campaignState);
    assert.equal(snapshot.assets.canonicalVehicleImageZeroLinkCount, 1, campaignState);
    assert.equal(snapshot.growth.canonicalBytesPerLinkedRead, 0, campaignState);
    assert.equal(snapshot.growth.canonicalContributionIncludedInDailyEstimate, false, campaignState);
    assert.equal(snapshot.growth.cropContributionIncludedInDailyEstimate, false, campaignState);
    assert.equal(snapshot.growth.projectionsAfterActiveCampaign, null, campaignState);
  }
});

test("enabled automatic catalog and crops contribute observed growth to capacity forecasts", async () => {
  const snapshot = await collectStorageHealth({
    query: async (sql) => {
      if (sql === STORAGE_HEALTH_METRICS_SQL) {
        return { rows: [{
          database_bytes: "1000",
          plate_read_relation_bytes: "200",
          plate_count: "5",
          read_count: "10",
          image_reference_count: "10",
          records_without_image_path: "0",
          reads_last_24_hours: "10",
          reads_last_7_days: "70",
          eligible_overview_reads_last_7_days: "14",
          ready_count: "0",
          failed_count: "0",
          source_missing_count: "0",
          vehicle_image_asset_count: "10",
          vehicle_image_asset_bytes: "1000",
          vehicle_image_asset_current_linked_bytes: "1000",
          vehicle_image_asset_read_links: "10",
          vehicle_image_asset_current_read_links: "10",
          vehicle_image_asset_stale_read_links: "0",
          vehicle_image_asset_zero_link_count: "0",
          vehicle_image_asset_zero_link_bytes: "0",
          vehicle_image_crop_count: "10",
          vehicle_image_crop_file_count: "10",
          vehicle_image_crop_logical_bytes: "400",
          vehicle_image_crop_physical_bytes: "400",
          vehicle_image_crop_current_read_links: "10",
          vehicle_image_crop_current_physical_bytes: "400",
        }] };
      }
      if (sql === STORAGE_HEALTH_SAMPLE_SQL) {
        return { rows: [{ image_path: "images/current.jpg" }] };
      }
      if (sql === STORAGE_HEALTH_CATALOG_CAMPAIGN_RELATION_SQL) {
        return { rows: [{ runs_relation: null, items_relation: null }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CATALOG_RELATION_SQL) {
        return { rows: [{
          control_relation: "vehicle_image_asset_live_catalog_control",
          runs_relation: "vehicle_image_asset_catalog_runs",
        }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CATALOG_SQL) {
        return { rows: [{ enabled: true, completed_campaign: true }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CROP_RELATION_SQL) {
        return { rows: [{
          control_relation: "vehicle_image_crop_live_control",
          runs_relation: "vehicle_image_crop_runs",
        }] };
      }
      if (sql === STORAGE_HEALTH_LIVE_CROP_SQL) {
        return { rows: [{ enabled: true, completed_campaign: true }] };
      }
      assert.fail("Unexpected storage-health query");
    },
    storagePath: "/capture-storage",
    statfs: async () => ({ bsize: 100, blocks: 100, bavail: 60 }),
    resolvePath: (value) => value,
    statPath: async () => ({ size: 100, isFile: () => true }),
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  });

  assert.equal(snapshot.database.readsPerDay, 10);
  assert.equal(snapshot.database.eligibleOverviewReadsPerDay, 2);
  assert.equal(snapshot.growth.baseEstimatedBytesPerRead, 120);
  assert.equal(snapshot.growth.baseEstimatedBytesPerDay, 1_200);
  assert.equal(snapshot.growth.canonicalBytesPerLinkedRead, 100);
  assert.equal(snapshot.growth.canonicalEstimatedBytesPerDay, 200);
  assert.equal(snapshot.growth.canonicalBytesPerPlateRead, 20);
  assert.equal(snapshot.growth.cropBytesPerLinkedRead, 40);
  assert.equal(snapshot.growth.cropEstimatedBytesPerDay, 80);
  assert.equal(snapshot.growth.cropBytesPerPlateRead, 8);
  assert.equal(snapshot.growth.estimatedBytesPerRead, 148);
  assert.equal(snapshot.growth.estimatedBytesPerDay, 1_480);
  assert.equal(snapshot.growth.canonicalContributionIncludedInDailyEstimate, true);
  assert.equal(snapshot.growth.cropContributionIncludedInDailyEstimate, true);
  assert.match(snapshot.growth.basis, /eligible Overview rate/);
});

test("storage health degrades to partial read-only results when database probes fail", async () => {
  const snapshot = await collectStorageHealth({
    query: async () => { throw new Error("offline"); },
    storagePath: "/capture-storage",
    statfs: async () => ({ bsize: 1, blocks: 100, bavail: 25 }),
    resolvePath: (value) => value,
    statPath: async () => ({ size: 0, isFile: () => true }),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(snapshot.filesystem.usedPercent, 75);
  assert.equal(snapshot.database, null);
  assert.equal(snapshot.growth, null);
  assert.match(snapshot.errors[0], /Database and image-asset measurements/);
});

test("storage measurement stays read-only while maintenance controls are separate and permissioned", async () => {
  const [page, settings, card, controls, actions] = await Promise.all([
    readFile(new URL("../app/settings/SettingsSectionPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/StorageHealthCard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/StorageMaintenancePanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /needsStorageMaintenance \? getStorageMaintenanceOverview\(\)/);
  assert.match(settings, /<StorageHealthCard snapshot=\{initialStorageHealth\} view="storage" \/>/);
  assert.match(settings, /<StorageHealthCard snapshot=\{initialStorageHealth\} view="monitoring" \/>/);
  assert.match(card, /view === "monitoring" \? "Maintenance previews" : "Storage health"/);
  assert.match(settings, /<StorageMaintenancePanel/);
  assert.match(card, /Read only/);
  assert.match(card, /cannot delete or modify data/i);
  assert.match(card, /Measurement never performs cleanup/);
  assert.doesNotMatch(card, /onClick=.*(?:delete|prune|vacuum|cleanup)/i);
  assert.match(controls, /Run cleanup preview/);
  assert.match(controls, /Review and confirm cleanup/);
  assert.match(controls, /Automatic derived-orphan cleanup/);
  assert.match(controls, /Default off, separately approved/);
  assert.match(controls, /Cleanup safety status/);
  assert.match(controls, /Derived-orphan safety policy/);
  assert.match(controls, /Save cleanup safety policy/);
  assert.match(actions, /saveStorageMaintenanceSettings[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /previewStorageCleanup[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /runConfirmedStorageCleanup[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /setAutomaticStorageCleanupApproval[\s\S]*?requirePermission\("maintenance\.automatic_cleanup\.approve"\)/);
});
