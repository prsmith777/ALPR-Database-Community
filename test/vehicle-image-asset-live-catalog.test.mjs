import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { VehicleImageAssetCatalogCampaignService } from "../lib/vehicle-image-asset-catalog-campaign.mjs";
import { VehicleImageAssetCatalogWorker } from "../lib/vehicle-image-asset-catalog-worker.mjs";
import { VehicleImageAssetLiveCatalogService } from "../lib/vehicle-image-asset-live-catalog.mjs";
import {
  vehicleImageAssetLiveCatalogRepositoryInternals,
} from "../lib/vehicle-image-asset-live-catalog-repository.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function job(overrides = {}) {
  return {
    id: 9,
    read_id: 401,
    claim_token: "11111111-1111-4111-8111-111111111111",
    attempt_count: 1,
    ...overrides,
  };
}

test("automatic catalog remains inert until enabled after a completed campaign", async () => {
  let materialized = 0;
  let claimed = 0;
  const service = new VehicleImageAssetLiveCatalogService({
    repository: {
      async reclaimExpiredClaims() { return 0; },
      async getActivation() {
        return {
          enabled: false,
          completedCampaign: true,
          activeCampaign: false,
          state: "disabled",
        };
      },
      async materializeCandidates() { materialized += 1; },
      async claimNext() { claimed += 1; },
    },
    catalog: { async catalogRead() { assert.fail("disabled catalog must not read files"); } },
  });

  const result = await service.processBatch({ limit: 5 });
  assert.equal(result.status, "idle");
  assert.equal(result.activation, "disabled");
  assert.equal(materialized, 0);
  assert.equal(claimed, 0);
});

test("operator preview fails closed while automatic cataloging is enabled", async () => {
  let previewCreated = false;
  const service = new VehicleImageAssetCatalogCampaignService({
    repository: {
      async createPreview() { previewCreated = true; },
    },
    catalog: {},
    liveCatalog: {
      async getOverview() { return { enabled: true, state: "active" }; },
    },
  });

  await assert.rejects(
    service.createPreview({ actorUserId: 5 }),
    /Disable automatic canonical Overview cataloging/
  );
  assert.equal(previewCreated, false);
});

test("automatic catalog discovers and links a bounded current read", async () => {
  const calls = [];
  let claimCount = 0;
  const claimedJob = job();
  const service = new VehicleImageAssetLiveCatalogService({
    repository: {
      async reclaimExpiredClaims() { calls.push("reclaim"); },
      async getActivation() {
        return {
          enabled: true,
          completedCampaign: true,
          activeCampaign: false,
          state: "active",
        };
      },
      async materializeCandidates({ limit }) { calls.push(["discover", limit]); return 1; },
      async claimNext() { return claimCount++ === 0 ? claimedJob : null; },
      async completeJob(received, result) {
        calls.push(["complete", received.id, result.asset.id]);
        return true;
      },
      async failClaimedJob() { assert.fail("successful job must not fail"); },
    },
    catalog: {
      async catalogRead(readId) {
        calls.push(["catalog", readId]);
        return {
          status: "cataloged",
          asset: { id: 88 },
          assetCreated: true,
          linkCreated: true,
          linkUpdated: false,
        };
      },
    },
  });

  const result = await service.processBatch({ limit: 5 });
  assert.equal(result.discovered, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, [
    "reclaim",
    ["discover", 25],
    ["catalog", 401],
    ["complete", 9, 88],
  ]);
});

test("automatic catalog terminalizes changed reads and bounds missing-source retries", async () => {
  const failures = [];
  let mode = "missing-read";
  const service = new VehicleImageAssetLiveCatalogService({
    repository: {
      async failClaimedJob(received, failure) {
        failures.push({ job: received, failure });
        return true;
      },
    },
    catalog: {
      async catalogRead() {
        if (mode === "missing-read") return { status: "missing" };
        const error = new Error("source absent");
        error.code = "VEHICLE_IMAGE_ASSET_SOURCE_MISSING";
        throw error;
      },
    },
    logger: { warn() {} },
  });

  assert.equal((await service.processItem(job())).status, "superseded");
  assert.equal(failures[0].failure.retryable, false);

  mode = "missing-file";
  assert.equal((await service.processItem(job({ attempt_count: 4 }))).status, "failed");
  assert.equal(failures[1].failure.retryable, true);
  assert.equal((await service.processItem(job({ attempt_count: 5 }))).status, "unavailable");
  assert.equal(failures[2].failure.retryable, false);
});

test("shared worker gives operator campaigns priority and uses automatic work only when idle", async () => {
  let liveCalls = 0;
  const campaignActive = new VehicleImageAssetCatalogWorker({
    service: {
      async processBatch() {
        return { processed: 0, status: "working", runId: 17, phase: "preview" };
      },
    },
    liveCatalog: {
      async processBatch() { liveCalls += 1; return { processed: 1 }; },
    },
  });
  assert.equal((await campaignActive.runOnce()).delayMs, 2_000);
  assert.equal(liveCalls, 0);

  const idleCampaign = new VehicleImageAssetCatalogWorker({
    service: {
      async processBatch() { return { processed: 0, status: "idle" }; },
    },
    liveCatalog: {
      async processBatch() {
        liveCalls += 1;
        return {
          processed: 1,
          succeeded: 1,
          failed: 0,
          discovered: 1,
          status: "working",
          activation: "active",
        };
      },
    },
  });
  assert.equal((await idleCampaign.runOnce()).delayMs, 100);
  assert.equal(liveCalls, 1);
  assert.equal(idleCampaign.snapshot().phase, "automatic");
  assert.equal(idleCampaign.snapshot().lastBatch.mode, "automatic");
});

test("automatic catalog migration and discovery are gated, durable, and provider-neutral", async () => {
  const [migration, repository, service, runtime] = await Promise.all([
    fs.readFile(path.join(ROOT, "migrations.sql"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-asset-live-catalog-repository.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-asset-live-catalog.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-asset-catalog-runtime.mjs"), "utf8"),
  ]);
  assert.match(migration, /2026081404_vehicle_image_asset_live_catalog/);
  assert.match(migration, /vehicle_image_asset_live_catalog_control/);
  assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /vehicle_image_asset_live_catalog_jobs/);
  const jobDefinition = migration.slice(
    migration.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_live_catalog_jobs"),
    migration.indexOf("CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_live_catalog_claim")
  );
  assert.doesNotMatch(jobDefinition, /read_id INTEGER NOT NULL REFERENCES public\.plate_reads/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf("2026081404_vehicle_image_asset_live_catalog")),
    /INSERT INTO public\.vehicle_image_asset_live_catalog_jobs[\s\S]*SELECT[\s\S]*plate_reads/
  );
  assert.match(repository, /completed_campaign = TRUE/);
  assert.match(repository, /active_campaign = FALSE/);
  assert.match(repository, /FOR UPDATE OF jobs SKIP LOCKED/);
  assert.match(repository, /status = 'cataloged'/);
  assert.match(repository, /operator_retry_count/);
  assert.match(runtime, /VehicleImageAssetLiveCatalogService/);
  assert.match(runtime, /VehicleImageAssetLiveCatalogRepository/);
  assert.doesNotMatch(`${migration}\n${repository}\n${service}`, /plate recognizer|platerecognizer/i);
  assert.doesNotMatch(`${repository}\n${service}`, /capture_assets|vehicle_attribute_observations/);
});

test("automatic catalog activation state is fail-closed", () => {
  const { activationState } = vehicleImageAssetLiveCatalogRepositoryInternals;
  assert.equal(activationState({ enabled: false }), "disabled");
  assert.equal(
    activationState({ enabled: true, completed_campaign: false, active_campaign: false }),
    "waiting_for_initial_campaign"
  );
  assert.equal(
    activationState({ enabled: true, completed_campaign: true, active_campaign: true }),
    "paused_for_operator_campaign"
  );
  assert.equal(
    activationState({ enabled: true, completed_campaign: true, active_campaign: false }),
    "active"
  );
});
