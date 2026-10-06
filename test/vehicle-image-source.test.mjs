import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeVehicleImageSource } from "../lib/vehicle-image-source.mjs";
import { BlueIrisVehicleFrameService } from "../lib/blue-iris-vehicle-frame.mjs";
import { isOverviewAssetCandidate, overviewSourceCameraName } from "../lib/vehicle-image-asset-model.mjs";

test("explicit LPR source binds its own camera at the plate event, without accepting an overview alias", () => {
  const input = { plateCameraName: "My driveway", directionLabel: "Arriving", sourceCameraShortName: "Cam42", sourceMode: "lpr_camera" };
  const result = normalizeVehicleImageSource({ ...input, sourceCameraName: "Wrong camera", expectedDeltaMs: 8000 });
  assert.equal(result.sourceCameraName, "My driveway");
  assert.equal(result.expectedDeltaMs, 0);
  for (const invalid of [{ ...input, sourceMode: "invalid" }, { ...input, sourceCameraShortName: "" },
    { ...input, toleranceMs: 5000 }, { ...input, sourceMode: "overview", sourceCameraName: "MY DRIVEWAY" }]) {
    assert.throws(() => normalizeVehicleImageSource(invalid));
  }
  assert.equal(normalizeVehicleImageSource({ ...input, sourceMode: "overview", sourceCameraName: "Wide view", expectedDeltaMs: -1500 }).expectedDeltaMs, -1500);
});

async function frameFixture({ incomplete = false, plateOnly = false, monochrome = false } = {}) {
  const buffer = await sharp({ create: { width: 320, height: 200, channels: 3,
    background: monochrome ? { r: 90, g: 90, b: 90 } : { r: 15, g: 70, b: 160 } } })
    .composite([{ input: { create: { width: 200, height: 100, channels: 3,
      background: monochrome ? { r: 180, g: 180, b: 180 } : { r: 215, g: 40, b: 20 } } }, left: 40, top: 50 }]).jpeg().toBuffer();
  let ready, failed;
  const service = new BlueIrisVehicleFrameService({
    client: { async fetchTimelineJpeg({ timestamp }) { return { buffer, timestamp: new Date(timestamp).toISOString() }; } },
    detector: { async detectAll() { return plateOnly ? [] : [{ confidence: 0.95, area: 0.3,
      left: incomplete ? 0.006 : 0.12, top: 0.2, right: 0.8, bottom: 0.85 }]; } },
    repository: { async markReady(_id, frame) { ready = frame; return { id: 7 }; },
      async markFailed(_id, failure) { failed = failure; return { id: 7 }; } },
    fileStorage: { async saveDerivedImageAtomic(_path, contents) { assert.ok(contents.length); }, async deleteImage() {} },
  });
  const result = await service.processOverviewRead({
    read: { id: 7, camera_name: "Driveway LPR", plate_number: "FIXTURE", timestamp: new Date().toISOString(),
      bi_trigger_direction_label: "Arriving", vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111" },
    profile: { id: 1, source_mode: "lpr_camera", source_camera_name: "Driveway LPR", source_camera_short_name: "Cam42",
      expected_delta_ms: 0, tolerance_ms: 250, revision: 1 }, camera: "Cam42", alreadyClaimed: true,
  });
  return { result, ready, failed };
}

test("whole-vehicle LPR recordings retain provenance and enter the existing crop/ReID asset catalog", async () => {
  const { result, ready } = await frameFixture();
  assert.equal(result.status, "ready");
  assert.equal(ready.selectionMetadata.sourceMode, "lpr_camera");
  const read = { vehicle_image_status: "ready", vehicle_image_path: ready.framePath,
    vehicle_image_source_kind: ready.sourceKind, vehicle_image_selection_metadata: ready.selectionMetadata };
  assert.ok(isOverviewAssetCandidate(read));
  assert.equal(overviewSourceCameraName(read), "Driveway LPR");
  assert.ok(ready.detectionBox && ready.imageWidth === 320);
});

test("plate-only, clipped, and monochrome LPR recordings never become identity evidence", async () => {
  for (const scenario of [{ plateOnly: true }, { incomplete: true }, { monochrome: true }]) {
    const { result, ready, failed } = await frameFixture(scenario);
    assert.equal(ready, undefined);
    assert.equal(result.status, "unavailable");
    assert.equal(failed.retryable, false);
  }
});
