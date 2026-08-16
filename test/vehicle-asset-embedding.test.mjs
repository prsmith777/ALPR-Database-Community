import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import {
  vehicleAssetEmbeddingFailureDisposition,
  VehicleAssetEmbeddingCampaignService,
} from "../lib/vehicle-asset-embedding-campaign.mjs";
import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
  VehicleAssetEmbeddingService,
} from "../lib/vehicle-asset-embedding.mjs";
import { VehicleAssetEmbeddingWorker } from "../lib/vehicle-asset-embedding-worker.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

async function fixture() {
  const bytes = await sharp({
    create: { width: 96, height: 64, channels: 3, background: "#426987" },
  }).jpeg().toBuffer();
  return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function job(overrides = {}) {
  return {
    id: 9,
    derivative_id: 22,
    asset_id: 12,
    source_sha256: "a".repeat(64),
    source_path: "derived/vehicle-crops/aa/crop.jpg",
    source_width: 96,
    source_height: 64,
    source_algorithm_version: "canonical-overview-detection-box-v1",
    evidence_read_id: 408,
    evidence_source_kind: "overview_primary",
    evidence_source_path: "derived/vehicle-assets/bb/source.jpg",
    evidence_source_updated_at: "2026-08-15 12:00:00.123456+00",
    model_name: VEHICLE_ASSET_EMBEDDING_MODEL,
    algorithm_version: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
    claim_token: "11111111-1111-4111-8111-111111111111",
    attempt_count: 1,
    ...overrides,
  };
}

function engine() {
  return {
    calls: 0,
    async embed() {
      this.calls += 1;
      return Float32Array.from({ length: 512 }, (_value, index) => index + 1);
    },
  };
}

test("canonical crop embedding preview is local and stores no row", async () => {
  const image = await fixture();
  const localEngine = engine();
  let registrations = 0;
  const service = new VehicleAssetEmbeddingService({
    repository: { async registerEmbedding() { registrations += 1; } },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    engine: localEngine,
    readFile: async () => image.bytes,
  });
  const preview = await service.preview(job({ source_sha256: image.sha256 }));
  assert.equal(preview.embeddingDimensions, 512);
  assert.equal(preview.embeddingBytes, 2048);
  assert.match(preview.embeddingSha256, /^[0-9a-f]{64}$/);
  assert.equal(preview.modelName, VEHICLE_ASSET_EMBEDDING_MODEL);
  assert.equal(localEngine.calls, 1);
  assert.equal(registrations, 0);
});

test("confirmed crop embedding reruns exact inference and registers immutable bytes", async () => {
  const image = await fixture();
  const localEngine = engine();
  let registered = null;
  const service = new VehicleAssetEmbeddingService({
    repository: {
      async registerEmbedding(receivedJob, rendered) {
        registered = { receivedJob, rendered };
        return { embedding: { id: 88 }, embeddingCreated: true };
      },
    },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    engine: localEngine,
    readFile: async () => image.bytes,
  });
  const base = job({ source_sha256: image.sha256 });
  const preview = await service.preview(base);
  const result = await service.catalog({
    ...base,
    preview_embedding_sha256: preview.embeddingSha256,
    preview_embedding_dimensions: preview.embeddingDimensions,
    preview_embedding_bytes: preview.embeddingBytes,
  });
  assert.equal(result.embeddingCreated, true);
  assert.equal(localEngine.calls, 2);
  assert.equal(registered.receivedJob.derivative_id, 22);
  assert.equal(registered.rendered.embedding.length, 2048);
  assert.equal(registered.rendered.embeddingSha256, preview.embeddingSha256);
});

test("embedding fails closed on changed crop bytes and changed preview", async () => {
  const image = await fixture();
  const base = job({ source_sha256: image.sha256 });
  const service = new VehicleAssetEmbeddingService({
    repository: { async registerEmbedding() { assert.fail("changed output must not register"); } },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    engine: engine(),
    readFile: async () => image.bytes,
  });
  await assert.rejects(
    service.preview({ ...base, source_sha256: "0".repeat(64) }),
    (error) => error.code === "VEHICLE_ASSET_EMBEDDING_SOURCE_CHANGED"
  );
  const preview = await service.preview(base);
  await assert.rejects(
    service.catalog({
      ...base,
      preview_embedding_sha256: "0".repeat(64),
      preview_embedding_dimensions: preview.embeddingDimensions,
      preview_embedding_bytes: preview.embeddingBytes,
    }),
    (error) => error.code === "VEHICLE_ASSET_EMBEDDING_PREVIEW_CHANGED"
  );
});

test("invalid model dimensions terminalize as invalid output, not a transient inference error", async () => {
  const image = await fixture();
  const service = new VehicleAssetEmbeddingService({
    repository: { async registerEmbedding() { assert.fail("invalid output must not register"); } },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    engine: { async embed() { return new Float32Array(3); } },
    readFile: async () => image.bytes,
  });
  await assert.rejects(
    service.preview(job({ source_sha256: image.sha256 })),
    (error) => error.code === "VEHICLE_ASSET_EMBEDDING_INVALID_OUTPUT"
  );
});

test("embedding failures separate terminal evidence from bounded transient retries", () => {
  assert.equal(vehicleAssetEmbeddingFailureDisposition(
    Object.assign(new Error("invalid"), { code: "VEHICLE_ASSET_EMBEDDING_INVALID_OUTPUT" }),
    { attempt_count: 1 }
  ).status, "invalid");
  assert.equal(vehicleAssetEmbeddingFailureDisposition(
    Object.assign(new Error("changed"), { code: "VEHICLE_ASSET_EMBEDDING_PREVIEW_CHANGED" }),
    { attempt_count: 1 }
  ).status, "source_changed");
  assert.equal(vehicleAssetEmbeddingFailureDisposition(new Error("transient"), {
    attempt_count: 1,
  }).retryable, true);
  assert.equal(vehicleAssetEmbeddingFailureDisposition(new Error("transient"), {
    attempt_count: 3,
  }).retryable, false);
});

test("campaign worker remains idle until an operator-created run has claimable work", async () => {
  let batches = 0;
  const worker = new VehicleAssetEmbeddingWorker({
    service: {
      async processBatch() {
        batches += 1;
        return { status: "idle", processed: 0, succeeded: 0, failed: 0 };
      },
    },
  });
  assert.equal(await worker.runOnce(), 30_000);
  assert.equal(batches, 1);
  assert.equal(worker.snapshot().phase, "idle");
});

test("campaign service previews and catalogs only claimed bounded jobs", async () => {
  const calls = [];
  let claimed = false;
  const campaign = new VehicleAssetEmbeddingCampaignService({
    repository: {
      async reclaimExpiredClaims() { calls.push("reclaim"); },
      async getLatestRun() { return { id: 4, status: "previewing" }; },
      async claimPreviewJob() {
        if (claimed) return null;
        claimed = true;
        return job();
      },
      async completePreviewJob(_job, preview) {
        calls.push(["complete", preview.embeddingBytes]);
        return true;
      },
      async failJob() { assert.fail("successful preview must not fail"); },
      async finalizePreview(runId) { calls.push(["finalize", runId]); },
    },
    embeddingService: {
      async preview() {
        return { embeddingSha256: "b".repeat(64), embeddingDimensions: 512, embeddingBytes: 2048 };
      },
    },
  });
  const result = await campaign.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(calls, ["reclaim", ["complete", 2048], ["finalize", 4]]);
});

test("embedding migration is additive, inert, asset-owned, and immutable", async () => {
  const migrations = await source("migrations.sql");
  const marker = migrations.indexOf("2026081505_vehicle_asset_embedding_campaign");
  assert.ok(marker > 0);
  const slice = migrations.slice(migrations.lastIndexOf("-- Provider-neutral embeddings", marker));
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_embeddings/);
  assert.match(slice, /embedding_dimensions = 512/);
  assert.match(slice, /OCTET_LENGTH\(embedding\) = 2048/);
  assert.match(slice, /UNIQUE \(derivative_id, model_name, algorithm_version\)/);
  assert.match(slice, /CREATE TRIGGER vehicle_asset_embeddings_immutable/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_embedding_runs/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_embedding_jobs/);
  assert.match(slice, /batch_size IN \(1,5,25,250\)/);
  assert.doesNotMatch(slice, /INSERT INTO public\.vehicle_asset_embedding_(?:runs|jobs)[\s\S]*SELECT/);
  assert.doesNotMatch(slice, /Plate Recognizer|plate_recognizer|vehicle_profiles|vehicle_clusters/);
});

test("repository freezes current identity evidence and verifies it again at insertion", async () => {
  const repository = await source("lib/vehicle-asset-embedding-repository.mjs");
  assert.match(repository, /\$\{links\}\.identity_eligible = TRUE/);
  assert.match(repository, /\$\{reads\}\.vehicle_image_path = \$\{links\}\.source_path_snapshot/);
  assert.match(repository, /evidence_source_updated_at::text/);
  assert.match(repository, /FOR SHARE OF derivatives, links, reads/);
  assert.match(repository, /ON CONFLICT \(derivative_id, model_name, algorithm_version\) DO NOTHING/);
  assert.match(repository, /preview_fingerprint/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /VEHICLE_ASSET_EMBEDDING_CLAIM_EXPIRED/);
  assert.match(repository, /attempt_count >= 3 THEN 'failed'/);
});

test("Processing UI, guarded actions, and idle startup expose canonical crop embeddings", async () => {
  const [instrumentation, actions, panel, settings, loader] = await Promise.all([
    source("instrumentation.node.js"),
    source("app/actions.js"),
    source("components/settings/VehicleAssetEmbeddingPanel.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
  ]);
  assert.match(instrumentation, /loadVehicleAssetEmbeddingStartup/);
  for (const action of [
    "getVehicleAssetEmbeddingOverview",
    "previewVehicleAssetEmbeddings",
    "confirmVehicleAssetEmbeddingBatch",
    "setVehicleAssetEmbeddingPaused",
    "cancelVehicleAssetEmbeddingCampaign",
    "retryVehicleAssetEmbeddingJob",
  ]) assert.match(actions, new RegExp(`export async function ${action}`));
  assert.match(panel, /Canonical crop embeddings/);
  assert.match(panel, /does not replace current ReID/);
  assert.match(panel, /Plate Recognizer/);
  assert.doesNotMatch(panel, /automatic embedding/i);
  assert.match(settings, /VehicleAssetEmbeddingPanel/);
  assert.match(loader, /getVehicleAssetEmbeddingOverview/);
  assert.equal(VEHICLE_ASSET_EMBEDDING_ALGORITHM, "canonical-overview-crop-embedding-v1");
});

test("disposable PostgreSQL crop gate executes embedding lifecycle and cleanup", async () => {
  const [script, workflow] = await Promise.all([
    source("scripts/test-vehicle-image-crop-postgres.mjs"),
    source(".github/workflows/ci.yml"),
  ]);
  const guard = script.indexOf("async function guard()");
  const fixture = script.indexOf("async function createFixture()");
  const embedding = script.indexOf("async function runEmbeddingCampaign()");
  assert.ok(guard > 0 && guard < fixture && fixture < embedding);
  assert.match(script, /VehicleAssetEmbeddingRepository/);
  assert.match(script, /preview_embedding_sha256/);
  assert.match(script, /embedding_count\), 2/);
  assert.match(script, /vehicle_asset_embeddings SET source_sha256/);
  assert.match(script, /DELETE FROM public\.vehicle_asset_embedding_jobs/);
  assert.match(workflow, /yarn test:vehicle-image-crop:postgres/);
});
