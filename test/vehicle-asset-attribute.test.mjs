import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import {
  vehicleAssetAttributeFailureDisposition,
  VehicleAssetAttributeCampaignService,
} from "../lib/vehicle-asset-attribute-campaign.mjs";
import {
  VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
} from "../lib/vehicle-asset-attribute-contract.mjs";
import { VehicleAssetAttributeService } from "../lib/vehicle-asset-attribute.mjs";
import { VehicleAssetAttributeWorker } from "../lib/vehicle-asset-attribute-worker.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

async function fixture(background = "#e52218") {
  const bytes = await sharp({
    create: { width: 96, height: 64, channels: 3, background },
  }).jpeg().toBuffer();
  return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function job(overrides = {}) {
  return {
    id: 11,
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
    algorithm_version: VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
    claim_token: "11111111-1111-4111-8111-111111111111",
    attempt_count: 1,
    ...overrides,
  };
}

function typeAnalyzer(result = {
  status: "ready",
  value: "truck",
  confidence: 0.91,
  scores: { car: 0.04, bus: 0.01, truck: 0.91, van: 0.04 },
}) {
  return { calls: 0, async analyze() { this.calls += 1; return result; } };
}

test("crop-owned attribute contract stays independent from the native inference runtime", async () => {
  const [contract, repository] = await Promise.all([
    source("lib/vehicle-asset-attribute-contract.mjs"),
    source("lib/vehicle-asset-attribute-repository.mjs"),
  ]);
  assert.doesNotMatch(contract, /openvino-node|vehicle-attributes\.mjs/);
  assert.match(repository, /vehicle-asset-attribute-contract\.mjs/);
  assert.doesNotMatch(repository, /vehicle-attributes\.mjs|openvino-node/);
  assert.equal(VEHICLE_ASSET_COLOR_ATTRIBUTE.attributeKey, "color");
  assert.equal(VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.attributeKey, "body_type");
});

test("attribute preview evaluates color and body type locally without storing observations", async () => {
  const image = await fixture();
  const analyzer = typeAnalyzer();
  let registrations = 0;
  const service = new VehicleAssetAttributeService({
    repository: { async registerObservations() { registrations += 1; } },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    vehicleTypeAnalyzer: analyzer,
    readFile: async () => image.bytes,
  });
  const preview = await service.preview(job({ source_sha256: image.sha256 }));
  assert.equal(preview.algorithmVersion, VEHICLE_ASSET_ATTRIBUTE_ALGORITHM);
  assert.match(preview.resultSha256, /^[0-9a-f]{64}$/);
  assert.ok(preview.resultBytes > 0);
  assert.deepEqual(preview.result.observations.map((item) => item.attributeKey), [
    "color", "body_type",
  ]);
  assert.equal(preview.result.observations[0].status, "ready");
  assert.equal(preview.result.observations[1].value, "truck");
  assert.equal(analyzer.calls, 1);
  assert.equal(registrations, 0);
});

test("confirmed attribute batch replays the exact result and registers two immutable observations", async () => {
  const image = await fixture();
  const analyzer = typeAnalyzer();
  let registered = null;
  const service = new VehicleAssetAttributeService({
    repository: {
      async registerObservations(receivedJob, rendered) {
        registered = { receivedJob, rendered };
        return { observations: [{ id: 1 }, { id: 2 }], observationsCreated: 2 };
      },
    },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    vehicleTypeAnalyzer: analyzer,
    readFile: async () => image.bytes,
  });
  const base = job({ source_sha256: image.sha256 });
  const preview = await service.preview(base);
  const result = await service.catalog({
    ...base,
    preview_result_sha256: preview.resultSha256,
    preview_result: preview.result,
    preview_result_bytes: preview.resultBytes,
  });
  assert.equal(result.observationsCreated, 2);
  assert.equal(analyzer.calls, 2);
  assert.equal(registered.receivedJob.derivative_id, 22);
  assert.equal(registered.rendered.result.observations.length, 2);
});

test("monochrome crops persist unknown color evidence instead of failing", async () => {
  const image = await fixture("#777777");
  const service = new VehicleAssetAttributeService({
    repository: {},
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    vehicleTypeAnalyzer: typeAnalyzer({
      status: "unknown", value: null, confidence: 0.5,
      scores: { car: 0.5, bus: 0.1, truck: 0.2, van: 0.2 },
    }),
    readFile: async () => image.bytes,
  });
  const preview = await service.preview(job({ source_sha256: image.sha256 }));
  const [color, bodyType] = preview.result.observations;
  assert.equal(color.status, "unknown");
  assert.equal(color.value, null);
  assert.equal(color.rawResult.reason, "monochrome_capture");
  assert.equal(bodyType.status, "unknown");
});

test("attribute evaluation fails closed on changed crop bytes and changed preview", async () => {
  const image = await fixture();
  const base = job({ source_sha256: image.sha256 });
  const service = new VehicleAssetAttributeService({
    repository: { async registerObservations() { assert.fail("changed evidence must not register"); } },
    fileStorage: { async resolveExistingImagePath() { return "crop.jpg"; } },
    vehicleTypeAnalyzer: typeAnalyzer(),
    readFile: async () => image.bytes,
  });
  await assert.rejects(
    service.preview({ ...base, source_sha256: "0".repeat(64) }),
    (error) => error.code === "VEHICLE_ASSET_ATTRIBUTE_SOURCE_CHANGED"
  );
  const preview = await service.preview(base);
  await assert.rejects(
    service.catalog({
      ...base,
      preview_result_sha256: "0".repeat(64),
      preview_result: preview.result,
      preview_result_bytes: preview.resultBytes,
    }),
    (error) => error.code === "VEHICLE_ASSET_ATTRIBUTE_PREVIEW_CHANGED"
  );
});

test("attribute failures separate terminal evidence from bounded transient retries", () => {
  assert.equal(vehicleAssetAttributeFailureDisposition(
    Object.assign(new Error("invalid"), { code: "VEHICLE_ASSET_ATTRIBUTE_INVALID_OUTPUT" }),
    { attempt_count: 1 }
  ).status, "invalid");
  assert.equal(vehicleAssetAttributeFailureDisposition(
    Object.assign(new Error("changed"), { code: "VEHICLE_ASSET_ATTRIBUTE_PREVIEW_CHANGED" }),
    { attempt_count: 1 }
  ).status, "source_changed");
  assert.equal(vehicleAssetAttributeFailureDisposition(new Error("transient"), {
    attempt_count: 1,
  }).retryable, true);
  assert.equal(vehicleAssetAttributeFailureDisposition(new Error("transient"), {
    attempt_count: 3,
  }).retryable, false);
});

test("attribute worker remains idle until an operator-created run has claimable work", async () => {
  const worker = new VehicleAssetAttributeWorker({
    service: {
      async processBatch() {
        return { status: "idle", processed: 0, succeeded: 0, failed: 0 };
      },
    },
  });
  assert.equal(await worker.runOnce(), 30_000);
  assert.equal(worker.snapshot().phase, "idle");
});

test("attribute campaign processes only claimed bounded preview jobs", async () => {
  const calls = [];
  let claimed = false;
  const campaign = new VehicleAssetAttributeCampaignService({
    repository: {
      async reclaimExpiredClaims() { calls.push("reclaim"); },
      async getLatestRun() { return { id: 4, status: "previewing" }; },
      async claimPreviewJob() {
        if (claimed) return null;
        claimed = true;
        return job();
      },
      async completePreviewJob(_job, preview) {
        calls.push(["complete", preview.resultBytes]);
        return true;
      },
      async failJob() { assert.fail("successful preview must not fail"); },
      async finalizePreview(runId) { calls.push(["finalize", runId]); },
    },
    attributeService: {
      async preview() {
        return { resultSha256: "b".repeat(64), result: {}, resultBytes: 20 };
      },
    },
  });
  const result = await campaign.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(calls, ["reclaim", ["complete", 20], ["finalize", 4]]);
});

test("attribute migration is additive, inert, crop-owned, and immutable", async () => {
  const migrations = await source("migrations.sql");
  const marker = migrations.indexOf("2026081506_vehicle_asset_attribute_campaign");
  const embeddingMarker = migrations.indexOf("2026081505_vehicle_asset_embedding_campaign");
  assert.ok(marker > embeddingMarker);
  const start = migrations.lastIndexOf(
    "-- Provider-neutral local attribute observations", marker
  );
  const end = migrations.indexOf("\n-- ", marker);
  const slice = migrations.slice(start, end > marker ? end : migrations.length);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_attribute_observations/);
  assert.match(slice, /attribute_key IN \('color','body_type'\)/);
  assert.match(slice, /UNIQUE \(\s*derivative_id, attribute_key, provider, model_version, algorithm_version/);
  assert.match(slice, /CREATE TRIGGER vehicle_asset_attribute_observations_immutable/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_attribute_runs/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_asset_attribute_jobs/);
  assert.match(slice, /batch_size IN \(1,5,25,250\)/);
  assert.doesNotMatch(slice, /INSERT INTO public\.vehicle_asset_attribute_(?:runs|jobs)[\s\S]*SELECT/);
  assert.doesNotMatch(slice, /Plate Recognizer|plate_recognizer|vehicle_profiles|vehicle_clusters/);
});

test("repository freezes current identity evidence and inserts one row per contract", async () => {
  const repository = await source("lib/vehicle-asset-attribute-repository.mjs");
  assert.match(repository, /\$\{links\}\.identity_eligible = TRUE/);
  assert.match(repository, /evidence_source_updated_at::text/);
  assert.match(repository, /FOR SHARE OF derivatives, links, reads/);
  assert.match(repository, /ON CONFLICT \(\s*derivative_id, attribute_key, provider, model_version, algorithm_version/);
  assert.match(repository, /preview_result_sha256/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /VEHICLE_ASSET_ATTRIBUTE_CLAIM_EXPIRED/);
  assert.doesNotMatch(repository, /vehicle_attribute_observations/);
});

test("Processing UI, guarded actions, and idle startup expose crop-owned attributes", async () => {
  const [instrumentation, actions, panel, settings, loader] = await Promise.all([
    source("instrumentation.node.js"),
    source("app/actions.js"),
    source("components/settings/VehicleAssetAttributePanel.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
  ]);
  assert.match(instrumentation, /loadVehicleAssetAttributeStartup/);
  for (const action of [
    "getVehicleAssetAttributeOverview",
    "previewVehicleAssetAttributes",
    "confirmVehicleAssetAttributeBatch",
    "setVehicleAssetAttributePaused",
    "cancelVehicleAssetAttributeCampaign",
    "retryVehicleAssetAttributeJob",
  ]) assert.match(actions, new RegExp(`export async function ${action}`));
  assert.match(panel, /Canonical crop attributes/);
  assert.match(panel, /does not replace current read attributes or ReID/);
  assert.match(panel, /Plate Recognizer/);
  assert.match(panel, /Unknown nighttime or monochrome results remain valid evidence/);
  assert.match(settings, /VehicleAssetAttributePanel/);
  assert.match(loader, /getVehicleAssetAttributeOverview/);
});

test("disposable PostgreSQL crop gate executes attribute lifecycle and cleanup", async () => {
  const [script, workflow] = await Promise.all([
    source("scripts/test-vehicle-image-crop-postgres.mjs"),
    source(".github/workflows/ci.yml"),
  ]);
  const guard = script.indexOf("async function guard()");
  const fixtureStart = script.indexOf("async function createFixture()");
  const attributes = script.indexOf("async function runAttributeCampaign()");
  assert.ok(guard > 0 && guard < fixtureStart && fixtureStart < attributes);
  assert.match(script, /VehicleAssetAttributeRepository/);
  assert.match(script, /preview_result_sha256/);
  assert.match(script, /observation_count\), 4/);
  assert.match(script, /vehicle_asset_attribute_observations\n\s+SET source_sha256/);
  assert.match(script, /DELETE FROM public\.vehicle_asset_attribute_jobs/);
  assert.match(workflow, /yarn test:vehicle-image-crop:postgres/);
});
