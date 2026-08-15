import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { VehicleImageCropCampaignService } from "../lib/vehicle-image-crop-campaign.mjs";
import {
  vehicleCropLiveFailureDisposition,
  VehicleImageCropLiveService,
} from "../lib/vehicle-image-crop-live.mjs";
import {
  vehicleImageCropLiveRepositoryInternals,
} from "../lib/vehicle-image-crop-live-repository.mjs";
import { VehicleImageCropWorker } from "../lib/vehicle-image-crop-worker.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function claimedJob(overrides = {}) {
  return {
    id: 19,
    asset_id: 77,
    claim_token: "11111111-1111-4111-8111-111111111111",
    attempt_count: 1,
    source_sha256: "a".repeat(64),
    source_path: "derived/vehicle-assets/aa/source.jpg",
    source_width: 1920,
    source_height: 1080,
    evidence_read_id: 401,
    evidence_source_kind: "overview_primary",
    evidence_source_path: "derived/vehicle-assets/aa/source.jpg",
    evidence_source_updated_at: new Date("2026-08-15T12:00:00.123Z"),
    evidence_source_updated_at_exact: "2026-08-15 12:00:00.123456+00",
    detection_box: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
    detection_confidence: 0.9,
    ...overrides,
  };
}

test("automatic crops remain inert until enabled after a completed campaign", async () => {
  let discovered = 0;
  let claimed = 0;
  const service = new VehicleImageCropLiveService({
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
      async materializeCandidates() { discovered += 1; },
      async claimNext() { claimed += 1; },
    },
    cropService: { async preview() { assert.fail("disabled crop must not read files"); } },
  });

  const result = await service.processBatch();
  assert.equal(result.status, "idle");
  assert.equal(result.activation, "disabled");
  assert.equal(discovered, 0);
  assert.equal(claimed, 0);
});

test("operator crop preview fails closed while automatic cropping is enabled", async () => {
  let created = false;
  const service = new VehicleImageCropCampaignService({
    repository: { async createPreview() { created = true; } },
    cropService: {},
    liveCrop: { async getOverview() { return { enabled: true, state: "active" }; } },
  });
  await assert.rejects(
    service.createPreview({ actorUserId: 5 }),
    /Disable automatic vehicle cropping/
  );
  assert.equal(created, false);
});

test("automatic crop previews and re-renders one exact asset snapshot", async () => {
  const calls = [];
  const job = claimedJob();
  let claims = 0;
  const service = new VehicleImageCropLiveService({
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
      async claimNext() { return claims++ === 0 ? job : null; },
      async completeJob(received, result) {
        calls.push(["complete", received.id, result.derivative.id]);
        return true;
      },
      async failClaimedJob() { assert.fail("successful crop must not fail"); },
    },
    cropService: {
      async preview(snapshot) {
        calls.push(["preview", snapshot.evidence_source_updated_at]);
        return {
          contentSha256: "b".repeat(64),
          storagePath: "derived/vehicle-crops/bb/crop.jpg",
          byteSize: 1234,
          imageWidth: 800,
          imageHeight: 500,
          cropBox: { left: 10, top: 10, width: 800, height: 500, paddingRatio: 0.04 },
        };
      },
      async catalog(snapshot) {
        calls.push(["catalog", snapshot.preview_sha256, snapshot.evidence_source_updated_at]);
        return { derivative: { id: 88 }, derivativeCreated: true, fileCreated: true };
      },
    },
  });

  const result = await service.processBatch({ limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(calls, [
    "reclaim",
    ["discover", 25],
    ["preview", "2026-08-15 12:00:00.123456+00"],
    ["catalog", "b".repeat(64), "2026-08-15 12:00:00.123456+00"],
    ["complete", 19, 88],
  ]);
});

test("automatic crop failures distinguish immutable changes and bounded source retries", () => {
  assert.equal(vehicleCropLiveFailureDisposition(
    Object.assign(new Error("changed"), { code: "VEHICLE_IMAGE_CROP_SOURCE_CHANGED" }),
    { attempt_count: 1 }
  ).status, "source_changed");
  assert.equal(vehicleCropLiveFailureDisposition(
    Object.assign(new Error("missing"), { code: "VEHICLE_IMAGE_CROP_SOURCE_MISSING" }),
    { attempt_count: 4 }
  ).retryable, true);
  assert.equal(vehicleCropLiveFailureDisposition(
    Object.assign(new Error("missing"), { code: "VEHICLE_IMAGE_CROP_SOURCE_MISSING" }),
    { attempt_count: 5 }
  ).status, "unavailable");
  assert.equal(vehicleCropLiveFailureDisposition(
    Object.assign(new Error("conflict"), { code: "VEHICLE_IMAGE_CROP_CONFLICT" }),
    { attempt_count: 1 }
  ).status, "invalid");
});

test("shared crop worker gives operator campaigns priority and throttles automatic crops", async () => {
  let liveCalls = 0;
  const campaignWorker = new VehicleImageCropWorker({
    service: {
      async processBatch() {
        return { processed: 0, status: "working", runId: 17, phase: "preview" };
      },
    },
    liveCrop: { async processBatch() { liveCalls += 1; return { processed: 1 }; } },
  });
  assert.equal(await campaignWorker.runOnce(), 2_000);
  assert.equal(liveCalls, 0);

  const automaticWorker = new VehicleImageCropWorker({
    service: { async processBatch() { return { processed: 0, status: "idle" }; } },
    liveCrop: {
      async processBatch({ limit }) {
        assert.equal(limit, 1);
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
  assert.equal(await automaticWorker.runOnce(), 2_000);
  assert.equal(liveCalls, 1);
  assert.equal(automaticWorker.snapshot().phase, "automatic");
  assert.equal(automaticWorker.snapshot().lastBatch.mode, "automatic");
});

test("automatic crop migration, runtime, actions, and UI are inert and provider neutral", async () => {
  const [migration, repository, service, runtime, actions, panel, postgresGate] = await Promise.all([
    fs.readFile(path.join(ROOT, "migrations.sql"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-crop-live-repository.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-crop-live.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-image-crop-runtime.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "app/actions.js"), "utf8"),
    fs.readFile(path.join(ROOT, "components/settings/VehicleImageCropPanel.jsx"), "utf8"),
    fs.readFile(path.join(ROOT, "scripts/test-vehicle-image-crop-postgres.mjs"), "utf8"),
  ]);
  assert.match(migration, /2026081501_vehicle_image_crop_live_worker/);
  assert.match(migration, /vehicle_image_crop_live_control/);
  assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /vehicle_image_crop_live_jobs/);
  const migrationSlice = migration.slice(
    migration.indexOf("-- Durable, default-off crop generation")
  );
  assert.doesNotMatch(
    migrationSlice,
    /INSERT INTO public\.vehicle_image_crop_live_jobs[\s\S]*SELECT[\s\S]*vehicle_image_assets/
  );
  assert.match(repository, /FOR UPDATE OF jobs SKIP LOCKED/);
  assert.match(repository, /activation\.active_campaign = FALSE/);
  assert.match(repository, /derivatives\.id IS NULL/);
  assert.match(runtime, /VehicleImageCropLiveService/);
  assert.match(runtime, /VehicleImageCropLiveRepository/);
  assert.match(actions, /export async function setVehicleImageCropLiveEnabled/);
  assert.match(actions, /export async function retryVehicleImageCropLiveJob/);
  assert.match(panel, /Automatic new canonical vehicle cropping/);
  assert.match(panel, /Disable automatic cropping/);
  assert.match(postgresGate, /runAutomaticCrop/);
  assert.match(postgresGate, /VehicleImageCropLiveService/);
  assert.match(postgresGate, /2026-08-15T12:00:00\.654321Z/);
  assert.doesNotMatch(`${migrationSlice}\n${repository}\n${service}`, /plate recognizer|platerecognizer/i);
  assert.doesNotMatch(`${repository}\n${service}`, /capture_assets|vehicle_attribute_observations/);
});

test("automatic crop activation state fails closed", () => {
  const { activationState } = vehicleImageCropLiveRepositoryInternals;
  assert.equal(activationState({ enabled: false }), "disabled");
  assert.equal(activationState({
    enabled: true,
    completed_campaign: false,
    active_campaign: false,
  }), "waiting_for_initial_campaign");
  assert.equal(activationState({
    enabled: true,
    completed_campaign: true,
    active_campaign: true,
  }), "paused_for_operator_campaign");
  assert.equal(activationState({
    enabled: true,
    completed_campaign: true,
    active_campaign: false,
  }), "active");
});
