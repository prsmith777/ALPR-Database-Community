import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyVehicleOrientation,
  directionFromOrientation,
  normalizeDirectionProfile,
} from "../lib/vehicle-direction.mjs";
import { CaptureAssetRepository } from "../lib/capture-asset-repository.mjs";
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
    blueIrisMotionEnabled: false,
    blueIrisFrontTriggerType: null,
    blueIrisRearTriggerType: null,
  });
  assert.throws(
    () => normalizeDirectionProfile({ cameraName: "Street", frontDirectionLabel: "West", rearDirectionLabel: " west " }),
    (error) => error.code === "INVALID_DIRECTION_PROFILE"
  );
});

test("Blue Iris-only profile saves do not refresh or invalidate ReID direction", async () => {
  let refreshCount = 0;
  let savedProfileVersion = 4;
  const repository = {
    getLatestCameraRead: async () => ({ id: 42 }),
    getDirectionProfile: async () => ({
      camera_name: "Street LPR 1",
      profile_version: 4,
      blue_iris_motion_profile_version: 2,
    }),
    saveDirectionProfile: async () => ({
      camera_name: "Street LPR 1",
      profile_version: savedProfileVersion,
      blue_iris_motion_profile_version: 3,
    }),
  };
  const service = new CaptureAssetService({ repository, fileStorage: {} });
  service.refreshCameraDirection = async () => {
    refreshCount += 1;
    return { evaluated: 0 };
  };
  const input = {
    cameraName: "Street LPR 1",
    enabled: true,
    frontDirectionLabel: "Eastbound",
    rearDirectionLabel: "Westbound",
    minimumConfidence: 0.68,
    blueIrisMotionEnabled: true,
    blueIrisFrontTriggerType: "MOTION_A>B",
    blueIrisRearTriggerType: "MOTION_B>A",
  };

  await service.saveDirectionProfile(input, { id: 1 });
  assert.equal(refreshCount, 0);

  savedProfileVersion = 5;
  await service.saveDirectionProfile({ ...input, frontDirectionLabel: "Entering" }, { id: 1 });
  assert.equal(refreshCount, 1);
});

test("direction profile persistence advances ReID and Blue Iris revisions independently", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("INSERT INTO public.camera_direction_profiles")) {
          return { rows: [{
            camera_name: "Street LPR 1",
            enabled: true,
            front_direction_label: "Eastbound",
            rear_direction_label: "Westbound",
            minimum_confidence: 0.68,
            blue_iris_motion_enabled: true,
            blue_iris_front_trigger_type: "MOTION_A>B",
            blue_iris_rear_trigger_type: "MOTION_B>A",
            blue_iris_motion_profile_version: 3,
            profile_version: 4,
          }] };
        }
        return { rows: [] };
      },
    },
  });

  await repository.saveDirectionProfile({
    cameraName: "Street LPR 1",
    enabled: true,
    frontDirectionLabel: "Eastbound",
    rearDirectionLabel: "Westbound",
    minimumConfidence: 0.68,
    blueIrisMotionEnabled: true,
    blueIrisFrontTriggerType: "MOTION_A>B",
    blueIrisRearTriggerType: "MOTION_B>A",
  }, { id: 1 });

  const upsert = calls[0].text;
  const blueIrisRevision = upsert.match(
    /blue_iris_motion_profile_version = CASE WHEN([\s\S]*?)THEN public\.camera_direction_profiles\.blue_iris_motion_profile_version/
  )?.[1] || "";
  const reidRevision = upsert.match(
    /\n\s+profile_version = CASE WHEN([\s\S]*?)THEN public\.camera_direction_profiles\.profile_version/
  )?.[1] || "";
  assert.match(blueIrisRevision, /blue_iris_front_trigger_type/);
  assert.match(blueIrisRevision, /blue_iris_rear_trigger_type/);
  assert.match(blueIrisRevision, /front_direction_label/);
  assert.match(blueIrisRevision, /rear_direction_label/);
  assert.doesNotMatch(reidRevision, /blue_iris_/);
  assert.match(reidRevision, /minimum_confidence/);
});

test("Blue Iris shadow diagnostics are restricted to one selected camera", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("COUNT(*)::integer AS received")) {
          return { rows: [{ received: 3, ready: 2, unknown: 1, unmapped: 1, latest_at: null }] };
        }
        return { rows: [] };
      },
    },
  });

  const result = await repository.getBlueIrisTriggerDirectionStatus("Street LPR 1");

  assert.equal(result.received, 3);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.values, ["Street LPR 1"]);
    assert.match(call.text, /camera_name = \$1/);
    assert.match(call.text, /bi_trigger_direction_status IS NOT NULL/);
  }
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

test("historical evaluation discovers and preserves an existing human orientation label", async () => {
  const observations = [];
  const repository = {
    getAsset: async () => ({
      read_id: 42,
      camera_name: "Street LPR 2",
      embedding_model: VEHICLE_REID_MODEL,
      vehicle_embedding: "indexed",
    }),
    getDirectionProfile: async () => ({
      camera_name: "Street LPR 2",
      enabled: true,
      front_direction_label: "Eastbound",
      rear_direction_label: "Westbound",
      minimum_confidence: 0.68,
      profile_version: 3,
    }),
    listOrientationSamples: async () => [
      { read_id: 40, orientation: "front" },
      { read_id: 41, orientation: "front" },
      { read_id: 42, orientation: "rear" },
    ],
    saveDirectionObservation: async (observation) => observations.push(observation),
  };
  const service = new CaptureAssetService({ repository, fileStorage: {} });

  const result = await service.refreshDirectionObservation(42);

  assert.equal(result.status, "ready");
  assert.equal(result.orientation, "rear");
  assert.equal(result.confidence, 1);
  assert.equal(result.directionLabel, "Westbound");
  assert.equal(observations[0].result.orientation, "rear");
});

test("historical direction backfill is bounded, resumable, and records individual failures", async () => {
  const cleared = [];
  const failures = [];
  const repository = {
    listDirectionBackfillCandidates: async (_model, _classifier, limit, options) => {
      assert.equal(limit, 2);
      assert.equal(options.includeReevaluation, true);
      return [
        { read_id: 11, profile_version: 4 },
        { read_id: 12, profile_version: 4 },
      ];
    },
    clearDirectionBackfillFailure: async (readId) => cleared.push(readId),
    recordDirectionBackfillFailure: async (failure) => failures.push(failure),
    getDirectionBackfillStatus: async () => ({
      eligible: 10,
      populated: 5,
      completed: 6,
      pending: 4,
      ready: 4,
      unknown: 1,
      failed: 1,
    }),
  };
  const service = new CaptureAssetService({ repository, fileStorage: {}, logger: {} });
  service.refreshDirectionObservation = async (readId) => {
    if (readId === 12) {
      const error = new Error("bad descriptor");
      error.code = "INVALID_EMBEDDING";
      throw error;
    }
    return { status: "ready" };
  };

  const result = await service.backfillDirectionBatch({ limit: 2 });

  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(cleared, [11]);
  assert.equal(failures[0].readId, 12);
  assert.equal(failures[0].profileVersion, 4);
  assert.equal(result.status.pending, 4);
});

test("pausing historical re-evaluation still allows ordinary live direction work", async () => {
  let includeReevaluation = null;
  const repository = {
    listDirectionBackfillCandidates: async (_model, _classifier, _limit, options) => {
      includeReevaluation = options.includeReevaluation;
      return [];
    },
    getDirectionBackfillStatus: async () => ({
      eligible: 50,
      populated: 40,
      completed: 40,
      pending: 10,
      actionablePending: 0,
      newPending: 0,
      reevaluationPending: 10,
      reevaluationPaused: true,
      ready: 35,
      unknown: 5,
      failed: 0,
    }),
  };
  const service = new CaptureAssetService({ repository, fileStorage: {} });

  const result = await service.backfillDirectionBatch({ limit: 20 });

  assert.equal(includeReevaluation, false);
  assert.equal(result.processed, 0);
  assert.equal(result.status.reevaluationPaused, true);
});

test("historical direction queries join camera profiles through their declared read alias", async () => {
  const queries = [];
  const repository = new CaptureAssetRepository({
    executor: {
      query: async (text) => {
        queries.push(text);
        return { rows: queries.length === 1 ? [{}] : [] };
      },
    },
  });

  await repository.getDirectionBackfillStatus(VEHICLE_REID_MODEL, "vehicle-orientation-v1");
  await repository.listDirectionBackfillCandidates(VEHICLE_REID_MODEL, "vehicle-orientation-v1", 5);

  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query, /JOIN public\.plate_reads reads ON reads\.id = ca\.read_id/i);
    assert.match(query, /cvp\.camera_key = LOWER\(BTRIM\(reads\.camera_name\)\)/i);
    assert.doesNotMatch(query, /BTRIM\(pr\.camera_name\)/i);
  }
});

test("historical direction re-evaluation queues machine results and preserves manual reviews", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("WITH eligible AS")) {
          return { rows: [{
            eligible: 120,
            camera_count: 1,
            manual_preserved: 20,
            queued: 100,
            previous_ready: 60,
            previous_unknown: 35,
            already_pending: 5,
          }] };
        }
        if (text.includes("INSERT INTO public.vehicle_direction_reevaluation_queue")) {
          return { rows: Array.from({ length: 100 }, (_, index) => ({ read_id: index + 1 })) };
        }
        if (text.includes("DELETE FROM public.vehicle_direction_backfill_failures")) {
          return { rows: [{ read_id: 8 }] };
        }
        return { rows: [] };
      },
    },
  });

  const result = await repository.queueDirectionReevaluation({
    cameraName: "Street LPR 2",
    embeddingModel: VEHICLE_REID_MODEL,
    classifierVersion: "vehicle-orientation-v1",
    actor: { id: 1 },
  });

  assert.equal(result.queued, 100);
  assert.equal(result.manualPreserved, 20);
  assert.equal(result.preserved, 100);
  assert.equal(result.failuresCleared, 1);
  assert.equal(calls.some((call) => call.text.includes("DELETE FROM public.vehicle_direction_observations")), false);
  const queueCall = calls.find((call) => call.text.includes("INSERT INTO public.vehicle_direction_reevaluation_queue"));
  assert.match(queueCall.text, /LEFT JOIN public\.vehicle_orientation_labels labels/i);
  assert.match(queueCall.text, /labels\.read_id IS NULL/i);
  assert.match(queueCall.text, /LOWER\(BTRIM\(reads\.camera_name\)\) = LOWER\(BTRIM\(\$4\)\)/i);
  assert.equal(queueCall.values[3], "Street LPR 2");
  assert.match(calls.at(-1).text, /vehicle\.direction_reevaluation_queued/i);
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
  assert.match(migration, /2026072603_vehicle_direction_backfill/i);
  assert.match(migration, /vehicle_direction_backfill_failures/i);
  assert.match(migration, /vehicle_direction_reevaluation_queue/i);
  assert.match(migration, /vehicle_direction_reevaluation_control/i);
  assert.match(settings, /Historical direction backfill/);
  assert.match(settings, /Run one direction batch now/);
  assert.match(settings, /Camera for selected re-evaluation/);
  assert.match(settings, /Re-evaluate \{cameraName \|\| "selected camera"\}/);
  assert.match(settings, /Re-evaluate all cameras/);
  assert.match(settings, /Pause re-evaluation/);
  assert.match(settings, /Resume re-evaluation/);
  assert.match(actions, /runVehicleDirectionBackfillBatch[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /queueVehicleDirectionReevaluation[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /setVehicleDirectionReevaluationPaused[\s\S]*?requirePermission\("maintenance\.manage"\)/);
});
