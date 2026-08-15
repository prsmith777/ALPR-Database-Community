import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import { vehicleCropFailureDisposition } from "../lib/vehicle-image-crop-campaign.mjs";
import {
  canonicalVehicleCropPath,
  normalizeOverviewDetectionBox,
  paddedVehicleCropBox,
  VehicleImageCropService,
  VEHICLE_IMAGE_CROP_ALGORITHM,
} from "../lib/vehicle-image-crop.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

function job(overrides = {}) {
  return {
    id: 1,
    asset_id: 7,
    source_sha256: "",
    source_path: "derived/vehicle-assets/aa/source.jpg",
    source_width: 100,
    source_height: 80,
    evidence_read_id: 12,
    detection_box: { left: 0.2, top: 0.25, right: 0.8, bottom: 0.75 },
    detection_confidence: 0.91,
    ...overrides,
  };
}

test("vehicle crop box is normalized, padded, and bounded", () => {
  assert.deepEqual(normalizeOverviewDetectionBox([0.2, 0.25, 0.8, 0.75]), {
    left: 0.2,
    top: 0.25,
    right: 0.8,
    bottom: 0.75,
  });
  assert.deepEqual(paddedVehicleCropBox(
    { left: 0.2, top: 0.25, right: 0.8, bottom: 0.75 }, 100, 80
  ), {
    left: 17,
    top: 18,
    width: 66,
    height: 44,
    paddingRatio: 0.04,
  });
  assert.throws(
    () => normalizeOverviewDetectionBox({ left: 0.8, top: 0, right: 0.2, bottom: 1 }),
    (error) => error.code === "VEHICLE_IMAGE_CROP_INVALID_BOX"
  );
});

test("vehicle crop preview encodes locally without publishing a file", async () => {
  const sourceBuffer = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#777777" },
  }).jpeg().toBuffer();
  const crypto = await import("node:crypto");
  const sourceSha256 = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
  let saved = 0;
  let registered = 0;
  const repository = {
    withStorageWriter: async (operation) => operation({
      registerDerivative: async () => { registered += 1; },
    }),
  };
  const fileStorage = {
    resolveExistingImagePath: async () => "source.jpg",
    saveDerivedImageIfAbsent: async () => { saved += 1; return { created: true }; },
  };
  const service = new VehicleImageCropService({
    repository,
    fileStorage,
    readFile: async () => sourceBuffer,
  });
  const preview = await service.preview(job({ source_sha256: sourceSha256 }));
  assert.equal(preview.imageWidth, 66);
  assert.equal(preview.imageHeight, 44);
  assert.equal(preview.storagePath, canonicalVehicleCropPath(preview.contentSha256));
  assert.equal(saved, 0);
  assert.equal(registered, 0);
});

test("confirmed vehicle crop publishes and registers the exact preview", async () => {
  const sourceBuffer = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#446688" },
  }).jpeg().toBuffer();
  const crypto = await import("node:crypto");
  const sourceSha256 = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
  const calls = [];
  const repository = {
    withStorageWriter: async (operation) => {
      calls.push("lock");
      return operation({
        registerDerivative: async (_job, derivative) => {
          calls.push(`register:${derivative.contentSha256}`);
          return { derivative: { id: 33 }, derivativeCreated: true };
        },
      });
    },
  };
  const fileStorage = {
    resolveExistingImagePath: async () => "source.jpg",
    saveDerivedImageIfAbsent: async (path, bytes) => {
      calls.push(`save:${path}:${bytes.length}`);
      return { created: true };
    },
  };
  const service = new VehicleImageCropService({
    repository,
    fileStorage,
    readFile: async () => sourceBuffer,
  });
  const baseJob = job({ source_sha256: sourceSha256 });
  const preview = await service.preview(baseJob);
  const result = await service.catalog({
    ...baseJob,
    preview_sha256: preview.contentSha256,
    preview_path: preview.storagePath,
    preview_byte_size: preview.byteSize,
    preview_width: preview.imageWidth,
    preview_height: preview.imageHeight,
    preview_crop_box: preview.cropBox,
  });
  assert.equal(result.derivativeCreated, true);
  assert.equal(result.fileCreated, true);
  assert.equal(calls[0], "lock");
  assert.match(calls[1], /^save:derived\/vehicle-crops\//);
  assert.match(calls[2], /^register:/);
});

test("confirmed crop fails closed when the preview no longer matches", async () => {
  const sourceBuffer = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#123456" },
  }).jpeg().toBuffer();
  const crypto = await import("node:crypto");
  const sourceSha256 = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
  const service = new VehicleImageCropService({
    repository: { withStorageWriter: async () => assert.fail("must not publish") },
    fileStorage: { resolveExistingImagePath: async () => "source.jpg" },
    readFile: async () => sourceBuffer,
  });
  await assert.rejects(
    service.catalog({
      ...job({ source_sha256: sourceSha256 }),
      preview_sha256: "0".repeat(64),
      preview_path: canonicalVehicleCropPath("0".repeat(64)),
      preview_byte_size: 1,
      preview_width: 1,
      preview_height: 1,
      preview_crop_box: { left: 0, top: 0, width: 1, height: 1, paddingRatio: 0.04 },
    }),
    (error) => error.code === "VEHICLE_IMAGE_CROP_PREVIEW_CHANGED"
  );
});

test("vehicle crop failures distinguish invalid evidence, changed sources, and retries", () => {
  assert.deepEqual(vehicleCropFailureDisposition(
    Object.assign(new Error("bad box"), { code: "VEHICLE_IMAGE_CROP_INVALID_BOX" }),
    { attempt_count: 1 }
  ).status, "invalid");
  assert.deepEqual(vehicleCropFailureDisposition(
    Object.assign(new Error("changed"), { code: "VEHICLE_IMAGE_CROP_SOURCE_CHANGED" }),
    { attempt_count: 1 }
  ).status, "source_changed");
  assert.equal(vehicleCropFailureDisposition(new Error("transient"), {
    attempt_count: 1,
  }).retryable, true);
  assert.equal(vehicleCropFailureDisposition(new Error("transient"), {
    attempt_count: 3,
  }).retryable, false);
});

test("vehicle crop migration is additive, inert, and asset owned", async () => {
  const migrations = await source("migrations.sql");
  const marker = migrations.indexOf("2026081406_vehicle_image_crop_campaign");
  assert.ok(marker > 0);
  const slice = migrations.slice(migrations.lastIndexOf("-- Asset-owned vehicle crops", marker));
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_image_derivatives/);
  assert.match(slice, /UNIQUE \(asset_id, derivative_kind, algorithm_version\)/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_image_crop_runs/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_image_crop_jobs/);
  assert.match(slice, /crop_box \?& ARRAY\['left','top','width','height','paddingRatio'\]/);
  assert.match(slice, /vehicle-image-derivatives/);
  assert.doesNotMatch(slice, /INSERT INTO public\.vehicle_image_crop_jobs[\s\S]*SELECT/);
  assert.doesNotMatch(slice, /Plate Recognizer|plate_recognizer|vehicle_asset_embeddings/);
  assert.equal(VEHICLE_IMAGE_CROP_ALGORITHM, "canonical-overview-detection-box-v1");
});

test("cleanup, reconciliation, runtime, actions, and Processing UI include crops", async () => {
  const [cleanup, reconciliation, repository, instrumentation, actions, panel, settings, loader] = await Promise.all([
    source("lib/storage-cleanup.mjs"),
    source("lib/storage-reconciliation-repository.mjs"),
    source("lib/vehicle-image-crop-repository.mjs"),
    source("instrumentation.node.js"),
    source("app/actions.js"),
    source("components/settings/VehicleImageCropPanel.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
  ]);
  assert.match(cleanup, /public\.vehicle_image_derivatives/);
  assert.match(cleanup, /vehicle_image_assets, public\.vehicle_image_derivatives IN SHARE MODE/);
  assert.match(reconciliation, /vehicle-image-derivatives/);
  assert.match(reconciliation, /referenceType: "vehicle-image-derivative"/);
  assert.match(repository, /unique_preview_files/);
  assert.match(repository, /GROUP BY preview_sha256/);
  assert.match(repository, /ORDER BY created_at DESC, id DESC LIMIT 8/);
  assert.match(instrumentation, /loadVehicleImageCropStartup/);
  for (const action of [
    "getVehicleImageCropOverview",
    "previewVehicleImageCrops",
    "confirmVehicleImageCropBatch",
  ]) assert.match(actions, new RegExp(`export async function ${action}`));
  assert.match(panel, /Canonical Overview vehicle crops/);
  assert.match(panel, /Full Overview JPEGs are retained/);
  assert.match(panel, /Recent canonical crops/);
  assert.match(panel, /Plate Recognizer/);
  assert.match(settings, /VehicleImageCropPanel/);
  assert.match(loader, /getVehicleImageCropOverview/);
});

test("real PostgreSQL crop gate is disposable-only and wired into CI", async () => {
  const [script, workflow, packageJson] = await Promise.all([
    source("scripts/test-vehicle-image-crop-postgres.mjs"),
    source(".github/workflows/ci.yml"),
    source("package.json"),
  ]);
  const guard = script.indexOf("async function guard()");
  const temp = script.indexOf("fs.mkdtemp");
  const insert = script.indexOf("INSERT INTO public.users");
  assert.ok(guard > 0 && guard < temp && temp < insert);
  assert.match(script, /VEHICLE_IMAGE_CROP_POSTGRES_TEST_OPT_IN/);
  assert.match(script, /current_database\(\)/);
  assert.match(script, /host_maintenance_environment_identity/);
  assert.match(script, /vehicle-image-crop:v1/);
  assert.match(script, /vehicle_image_crop_postgres_gate=passed/);
  assert.match(script, /validateAndDeleteCleanupCandidate/);
  assert.match(script, /skipped-referenced/);
  assert.match(workflow, /VEHICLE_IMAGE_CROP_POSTGRES_TEST_DATABASE='fixture_test'/);
  assert.match(workflow, /yarn test:vehicle-image-crop:postgres/);
  assert.match(packageJson, /"test:vehicle-image-crop:postgres"/);
});
