import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyVehicleOrientation,
  directionFromOrientation,
  normalizeDirectionProfile,
} from "../lib/vehicle-direction.mjs";
import { CaptureAssetService } from "../lib/capture-asset-service.mjs";
import { VEHICLE_REID_MODEL } from "../lib/vehicle-reid.mjs";

function vector(x, y) {
  const value = new Float32Array(512);
  value[0] = x;
  value[1] = y;
  return value;
}

test("camera direction profiles accept custom meanings and reject ambiguous mappings", () => {
  assert.deepEqual(normalizeDirectionProfile({
    cameraName: " Entry LPR 2 ",
    frontDirectionLabel: "Entering driveway",
    rearDirectionLabel: "Exiting driveway",
    minimumConfidence: 0.72,
  }), {
    cameraName: "Entry LPR 2",
    enabled: true,
    frontDirectionLabel: "Entering driveway",
    rearDirectionLabel: "Exiting driveway",
    minimumConfidence: 0.72,
  });
  assert.throws(
    () => normalizeDirectionProfile({ cameraName: "Street", frontDirectionLabel: "West", rearDirectionLabel: " west " }),
    (error) => error.code === "INVALID_DIRECTION_PROFILE"
  );
});

test("orientation remains collecting until each view has enough examples", () => {
  const result = classifyVehicleOrientation({
    embedding: vector(1, 0),
    samples: [
      { orientation: "front", embedding: vector(1, 0) },
      { orientation: "rear", embedding: vector(0, 1) },
    ],
  });
  assert.deepEqual(result, {
    status: "collecting",
    orientation: "unknown",
    confidence: null,
    counts: { front: 1, rear: 1 },
  });
});

test("orientation uses continuous confidence and camera-configured labels", () => {
  const samples = [
    ...[0, 0.03, -0.03].map((y) => ({ orientation: "front", embedding: vector(1, y) })),
    ...[0, 0.03, -0.03].map((x) => ({ orientation: "rear", embedding: vector(x, 1) })),
  ];
  const result = classifyVehicleOrientation({ embedding: vector(0.98, 0.08), samples, minimumConfidence: 0.68 });
  assert.equal(result.status, "ready");
  assert.equal(result.orientation, "front");
  assert.ok(result.confidence > 0.68 && result.confidence <= 1);
  assert.equal(directionFromOrientation({
    enabled: true,
    frontDirectionLabel: "Eastbound",
    rearDirectionLabel: "Westbound",
  }, result), "Eastbound");
});

test("low-confidence orientation stays unknown", () => {
  const samples = [
    ...[0, 0.02, -0.02].map((y) => ({ orientation: "front", embedding: vector(1, y) })),
    ...[0, 0.02, -0.02].map((x) => ({ orientation: "rear", embedding: vector(x, 1) })),
  ];
  const result = classifyVehicleOrientation({ embedding: vector(0.7, 0.7), samples, minimumConfidence: 0.8 });
  assert.equal(result.status, "unknown");
  assert.equal(result.orientation, "unknown");
  assert.equal(directionFromOrientation({ enabled: true }, result), null);
});

test("a reviewed front or rear capture receives its camera direction immediately", async () => {
  const observations = [];
  const profile = {
    camera_name: "Entry LPR 2",
    enabled: true,
    front_direction_label: "Exiting driveway",
    rear_direction_label: "Entering driveway",
    minimum_confidence: 0.68,
    profile_version: 4,
  };
  const repository = {
    getAsset: async () => ({
      read_id: 42,
      camera_name: "Entry LPR 2",
      embedding_model: VEHICLE_REID_MODEL,
      vehicle_embedding: "indexed",
    }),
    saveOrientationLabel: async ({ orientation }) => ({
      id: 7,
      read_id: 42,
      orientation,
      revision: 1,
    }),
    listDirectionAssets: async () => [{
      read_id: 42,
      vehicle_embedding: "indexed",
    }],
    getDirectionProfile: async () => profile,
    listOrientationSamples: async () => [
      { read_id: 41, orientation: "front" },
      { read_id: 42, orientation: "rear" },
    ],
    saveDirectionObservation: async (observation) => {
      observations.push(observation);
      return observation;
    },
  };
  const service = new CaptureAssetService({ repository, fileStorage: {} });

  const result = await service.recordOrientationLabel({
    readId: 42,
    orientation: "rear",
    actor: { id: 1, username: "reviewer", displayName: "Reviewer" },
  });

  assert.deepEqual(result.observation, {
    status: "ready",
    orientation: "rear",
    confidence: 1,
    counts: { front: 1, rear: 1 },
    directionLabel: "Entering driveway",
  });
  assert.equal(observations.at(-1).result.orientation, "rear");
  assert.equal(observations.at(-1).directionLabel, "Entering driveway");
  assert.equal(observations[0].result.orientation, "rear");
  assert.equal(observations[0].result.confidence, 1);
});

test("direction schema and administrator setup are durable and camera driven", async () => {
  const [migration, settings, actions] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.camera_direction_profiles/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_orientation_labels/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_direction_observations/i);
  assert.match(migration, /2026072504_vehicle_direction_profiles/i);
  assert.match(settings, /When the front of the vehicle is visible/);
  assert.match(settings, /When the rear of the vehicle is visible/);
  assert.match(settings, /Anything below this level stays Unknown/);
  assert.doesNotMatch(settings, /Street LPR|Entry LPR/);
  assert.match(actions, /saveVehicleDirectionProfile[\s\S]*?requirePermission\("system\.manage_settings"\)/);
  assert.match(actions, /labelVehicleOrientation[\s\S]*?requirePermission\("system\.manage_settings"\)/);
  assert.match(migration, /2026072601_vehicle_direction_notifications/i);
  assert.match(migration, /vehicle\.direction_classified/i);
  assert.match(migration, /'direction'/i);
  assert.match(migration, /2026072602_reviewed_vehicle_direction_truth/i);
  assert.match(migration, /ON CONFLICT \(read_id\) DO UPDATE SET/i);
});
