import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { VehicleImageAssetCatalogService } from "../lib/vehicle-image-asset-catalog.mjs";
import {
  VehicleImageAssetCatalogCampaignService,
  vehicleImageAssetCatalogCampaignInternals,
} from "../lib/vehicle-image-asset-catalog-campaign.mjs";
import { VehicleImageAssetCatalogWorker } from "../lib/vehicle-image-asset-catalog-worker.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function readySnapshot(overrides = {}) {
  return {
    id: 101,
    camera_name: "Street LPR 1",
    timestamp: "2026-08-14 12:00:00.123456+00",
    vehicle_image_status: "ready",
    vehicle_image_path: "derived/overview/101.jpg",
    vehicle_image_timestamp: "2026-08-14 12:00:00.223456+00",
    vehicle_image_score: 0.9,
    vehicle_image_detection_confidence: 0.95,
    vehicle_image_detection_box: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
    vehicle_image_width: 640,
    vehicle_image_height: 360,
    vehicle_image_sampled_count: 61,
    vehicle_image_selection_metadata: { sourceCameraName: "Street Overview" },
    vehicle_image_source_kind: "overview_primary",
    vehicle_image_source_read_id: null,
    vehicle_image_updated_at: "2026-08-14 12:00:01.123456+00",
    ...overrides,
  };
}

async function jpeg() {
  return sharp({
    create: {
      width: 80,
      height: 45,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  }).jpeg({ quality: 90 }).toBuffer();
}

test("preview inspects exact frozen bytes without publishing or linking", async () => {
  const snapshot = readySnapshot();
  const bytes = await jpeg();
  let writerCalls = 0;
  let saveCalls = 0;
  const repository = {
    async getRead() { return snapshot; },
    async withStorageWriter() { writerCalls += 1; throw new Error("must not write"); },
  };
  const fileStorage = {
    async getImage() { return bytes; },
    async saveDerivedImageIfAbsent() { saveCalls += 1; },
  };
  const service = new VehicleImageAssetCatalogService({ repository, fileStorage });
  const result = await service.previewSnapshot(snapshot);
  assert.equal(result.byteSize, bytes.length);
  assert.equal(result.imageWidth, 80);
  assert.equal(result.imageHeight, 45);
  assert.match(result.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(writerCalls, 0);
  assert.equal(saveCalls, 0);
});

test("legacy malformed Overview metadata terminalizes one item before file access", async () => {
  const snapshot = readySnapshot({
    vehicle_image_detection_confidence: 1.5,
    vehicle_image_detection_box: [0, 0, 1, 1],
  });
  let sourceReads = 0;
  const service = new VehicleImageAssetCatalogService({
    repository: { async getRead() { return snapshot; } },
    fileStorage: { async getImage() { sourceReads += 1; return jpeg(); } },
  });
  await assert.rejects(
    () => service.previewSnapshot(snapshot),
    { code: "VEHICLE_IMAGE_ASSET_INVALID_METADATA" }
  );
  assert.equal(sourceReads, 0);
  assert.equal(
    vehicleImageAssetCatalogCampaignInternals.failureDisposition(
      { code: "VEHICLE_IMAGE_ASSET_INVALID_METADATA" },
      { attempt_count: 1 }
    ).status,
    "invalid"
  );
});

test("catalog execution rejects a byte or revision change before canonical publication", async () => {
  const snapshot = readySnapshot();
  const bytes = await jpeg();
  let saveCalls = 0;
  let registerCalls = 0;
  const repository = {
    async getRead() { return snapshot; },
    async withStorageWriter(operation) { return operation(this); },
    async registerAssetForRead() {
      registerCalls += 1;
      return {
        asset: { id: 1 }, assetCreated: true, linkCreated: true, linkUpdated: false,
      };
    },
  };
  const fileStorage = {
    async getImage() { return bytes; },
    async saveDerivedImageIfAbsent() {
      saveCalls += 1;
      return { created: true };
    },
  };
  const service = new VehicleImageAssetCatalogService({ repository, fileStorage });
  const preview = await service.previewSnapshot(snapshot);
  await assert.rejects(
    () => service.catalogSnapshot({
      readSnapshot: snapshot,
      expectedContentSha256: "0".repeat(64),
      expectedByteSize: preview.byteSize,
      expectedImageWidth: preview.imageWidth,
      expectedImageHeight: preview.imageHeight,
    }),
    { code: "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED" }
  );
  assert.equal(saveCalls, 0);
  assert.equal(registerCalls, 0);

  repository.getRead = async () => readySnapshot({
    vehicle_image_updated_at: "2026-08-14 12:00:01.123457+00",
  });
  await assert.rejects(
    () => service.catalogSnapshot({
      readSnapshot: snapshot,
      expectedContentSha256: preview.contentSha256,
      expectedByteSize: preview.byteSize,
      expectedImageWidth: preview.imageWidth,
      expectedImageHeight: preview.imageHeight,
    }),
    { code: "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED" }
  );
  assert.equal(saveCalls, 0);
});

test("campaign preview work is resumable and never invokes catalog publication", async () => {
  const calls = [];
  let claimCount = 0;
  const item = {
    id: 1,
    read_id: 101,
    claim_token: "claim-preview",
    attempt_count: 1,
    readSnapshot: readySnapshot(),
  };
  const repository = {
    async reclaimExpiredClaims() { calls.push("reclaim"); },
    async getLatestRun() { return { id: 7, status: "previewing", phase: "preview" }; },
    async materializePreviewWindow() { calls.push("materialize"); return { materialized: 0 }; },
    async claimPreviewItem() { return claimCount++ === 0 ? item : null; },
    async completePreviewItem(received, preview) {
      calls.push(["previewed", received.id, preview.contentSha256]);
      return true;
    },
    async failClaimedItem() { throw new Error("unexpected failure"); },
    async finalizePreview() { calls.push("finalize"); },
  };
  let catalogWrites = 0;
  const catalog = {
    async previewSnapshot() {
      return {
        contentSha256: "a".repeat(64),
        byteSize: 100,
        imageWidth: 80,
        imageHeight: 45,
        storagePath: `derived/vehicle-assets/aa/${"a".repeat(64)}.jpg`,
      };
    },
    async catalogSnapshot() { catalogWrites += 1; },
  };
  const service = new VehicleImageAssetCatalogCampaignService({ repository, catalog });
  const result = await service.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(catalogWrites, 0);
  assert.deepEqual(calls.slice(0, 2), ["reclaim", "materialize"]);
  assert.equal(calls.at(-1), "finalize");
});

test("confirmed catalog work binds all preview facts and settles after its bounded batch", async () => {
  let claimCount = 0;
  let settledRun = null;
  const item = {
    id: 2,
    read_id: 102,
    claim_token: "claim-catalog",
    attempt_count: 1,
    readSnapshot: readySnapshot({ id: 102 }),
    preview_sha256: "b".repeat(64),
    preview_byte_size: 200,
    preview_width: 100,
    preview_height: 50,
  };
  const repository = {
    async reclaimExpiredClaims() {},
    async getLatestRun() { return { id: 8, status: "running", phase: "catalog" }; },
    async claimCatalogItem() { return claimCount++ === 0 ? item : null; },
    async completeCatalogItem(received, result) {
      assert.equal(received, item);
      assert.equal(result.asset.id, 44);
      return true;
    },
    async failClaimedItem() { throw new Error("unexpected failure"); },
    async settleCatalogRun(runId) { settledRun = runId; },
  };
  const catalog = {
    async catalogSnapshot(input) {
      assert.equal(input.expectedContentSha256, item.preview_sha256);
      assert.equal(input.expectedByteSize, 200);
      assert.equal(input.expectedImageWidth, 100);
      assert.equal(input.expectedImageHeight, 50);
      return {
        asset: { id: 44 }, assetCreated: false, linkCreated: true, linkUpdated: false,
      };
    },
  };
  const service = new VehicleImageAssetCatalogCampaignService({ repository, catalog });
  const result = await service.processBatch({ limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].status, "cataloged");
  assert.equal(settledRun, 8);
});

test("campaign failures fail closed with bounded and terminal dispositions", () => {
  const { failureDisposition } = vehicleImageAssetCatalogCampaignInternals;
  assert.deepEqual(
    failureDisposition({ code: "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED", message: "changed" }, { attempt_count: 1 }),
    { code: "VEHICLE_IMAGE_ASSET_PREVIEW_CHANGED", message: "changed", status: "superseded", retryable: false }
  );
  assert.equal(
    failureDisposition({ code: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING" }, { attempt_count: 2 }).retryable,
    true
  );
  assert.deepEqual(
    failureDisposition({ code: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING", message: "missing" }, { attempt_count: 3 }),
    { code: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING", message: "missing", status: "unavailable", retryable: false }
  );
});

test("dedicated worker remains idle without confirmed work and wakes safely", async () => {
  const service = {
    async processBatch() {
      return { processed: 0, succeeded: 0, failed: 0, status: "idle" };
    },
  };
  const worker = new VehicleImageAssetCatalogWorker({ service });
  const result = await worker.runOnce();
  assert.equal(result.delayMs, 30_000);
  assert.equal(worker.snapshot().phase, "idle");
  assert.equal(worker.snapshot().lastBatch.processed, 0);
  assert.doesNotThrow(() => worker.wake());
});

test("campaign migration and repository preserve preview-first and archival safety", async () => {
  const [migration, repository, campaign, instrumentation] = await Promise.all([
    fs.readFile(path.join(ROOT, "migrations.sql"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-asset-catalog-campaign-repository.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-asset-catalog-campaign.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "instrumentation.node.js"), "utf8"),
  ]);
  assert.match(migration, /2026081403_vehicle_image_asset_catalog_campaign/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_image_asset_catalog_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_image_asset_catalog_items/);
  assert.match(migration, /idx_vehicle_image_asset_catalog_one_active/);
  const campaignItemsDefinition = migration.slice(
    migration.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_catalog_items"),
    migration.indexOf("CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_run")
  );
  assert.doesNotMatch(
    campaignItemsDefinition,
    /read_id INTEGER NOT NULL REFERENCES public\.plate_reads/,
    "campaign evidence must not block the existing read-deletion lifecycle"
  );
  assert.doesNotMatch(
    campaignItemsDefinition,
    /source_read_id INTEGER REFERENCES public\.plate_reads/,
    "fingerprinted source provenance must remain immutable after live read deletion"
  );
  assert.match(repository, /preview_fingerprint/);
  assert.match(repository, /FOR UPDATE OF items, runs SKIP LOCKED/);
  assert.match(repository, /snapshot_fingerprint/);
  assert.match(repository, /"paused"/);
  assert.match(repository, /'cancelled'/);
  assert.match(repository, /operator_retry_count/);
  assert.match(repository, /outcome = "succeeded"/);
  assert.match(repository, /VALUES \(\$1, 'browser'/);
  assert.match(repository, /item\.run_status === "cancelled"/);
  assert.match(repository, /\["ready", "completed", "failed"\]\.includes\(item\.run_status\)/);
  assert.match(repository, /current canonical Overview item to finish before cancelling/);
  assert.match(campaign, /previewSnapshot/);
  assert.match(campaign, /catalogSnapshot/);
  assert.match(instrumentation, /startVehicleImageAssetCatalogRuntimeWithRetry/);
  assert.doesNotMatch(`${migration}\n${repository}\n${campaign}`, /plate recognizer|platerecognizer/i);
  assert.doesNotMatch(`${repository}\n${campaign}`, /capture_assets|vehicle_attribute_observations/);
});
