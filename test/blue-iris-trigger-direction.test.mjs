import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
  BLUE_IRIS_TRIGGER_DIRECTION_LEGACY_SHADOW_ALGORITHM,
  BLUE_IRIS_TRIGGER_DIRECTION_PROFILE_SQL,
  applyBlueIrisDirectionEligibility,
  blueIrisTriggerDirectionColumns,
  normalizeBlueIrisDirectionalTrigger,
  normalizeBlueIrisDirectionProfile,
  normalizeBlueIrisTriggerEvidence,
  normalizeBlueIrisTriggerType,
  persistBlueIrisPrimaryDirectionForRead,
  primaryDirectionObservationFromBlueIris,
  resolveBlueIrisTriggerDirection,
  resolveBlueIrisTriggerDirectionForRead,
} from "../lib/blue-iris-trigger-direction.mjs";

test("Blue Iris trigger types retain an ordered zone crossing safely", () => {
  assert.equal(normalizeBlueIrisTriggerType(" motion_a>b "), "MOTION_A>B");
  assert.equal(normalizeBlueIrisTriggerType("MOTION_B-C"), "MOTION_B-C");
  assert.equal(normalizeBlueIrisTriggerType("MOTION_A>B\nDROP TABLE"), null);
  assert.equal(normalizeBlueIrisDirectionalTrigger("motion_c>b"), "MOTION_C>B");
  assert.throws(
    () => normalizeBlueIrisDirectionalTrigger("MOTION_B-C"),
    /ordered Blue Iris zone crossing/i
  );
});

test("Blue Iris 6 composite trigger evidence retains only its ordered crossing", () => {
  assert.equal(
    normalizeBlueIrisTriggerEvidence("Motion_A>B,Zone A,Zone B,Zone C"),
    "MOTION_A>B"
  );
  assert.equal(
    normalizeBlueIrisTriggerEvidence("Motion_B>A,Driveway,Street"),
    "MOTION_B>A"
  );
  assert.equal(normalizeBlueIrisTriggerEvidence("MOTION_A>B"), "MOTION_A>B");
  assert.equal(
    normalizeBlueIrisTriggerEvidence("MOTION_A>B,MOTION_B>A"),
    null,
    "conflicting ordered crossings must fail closed"
  );
  assert.equal(normalizeBlueIrisTriggerEvidence("Zone A,MOTION_A>B"), null);
  assert.equal(normalizeBlueIrisTriggerEvidence("MOTION_A>B,Zone A\nZone B"), null);
});

test("camera mappings require two exact reverse crossings before primary direction is enabled", () => {
  assert.deepEqual(normalizeBlueIrisDirectionProfile({
    blueIrisMotionEnabled: true,
    blueIrisFrontTriggerType: "MOTION_A>B",
    blueIrisRearTriggerType: "MOTION_B>A",
  }), {
    enabled: true,
    frontTriggerType: "MOTION_A>B",
    rearTriggerType: "MOTION_B>A",
  });
  assert.throws(
    () => normalizeBlueIrisDirectionProfile({
      blueIrisMotionEnabled: true,
      blueIrisFrontTriggerType: "MOTION_A>B",
      blueIrisRearTriggerType: "MOTION_C>B",
    }),
    /exact reverses/i
  );
  assert.throws(
    () => normalizeBlueIrisDirectionProfile({ blueIrisMotionEnabled: true }),
    /both ordered Blue Iris zone crossings/i
  );
});

test("an ordered Blue Iris trigger maps to the camera semantic direction", () => {
  const profile = {
    blue_iris_motion_enabled: true,
    blue_iris_front_trigger_type: "MOTION_A>B",
    blue_iris_rear_trigger_type: "MOTION_B>A",
    front_direction_label: "Eastbound",
    rear_direction_label: "Westbound",
    blue_iris_motion_profile_version: 4,
  };
  assert.deepEqual(resolveBlueIrisTriggerDirection(profile, "MOTION_A>B"), {
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "ready",
    triggerType: "MOTION_A>B",
    orientation: "front",
    directionLabel: "Eastbound",
    profileVersion: 4,
    errorCode: null,
  });
  assert.deepEqual(
    resolveBlueIrisTriggerDirection(profile, "Motion_B>A,Zone A,Zone B,Zone C"),
    {
      algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
      status: "ready",
      triggerType: "MOTION_B>A",
      orientation: "rear",
      directionLabel: "Westbound",
      profileVersion: 4,
      errorCode: null,
    }
  );
  assert.equal(
    resolveBlueIrisTriggerDirection(profile, "MOTION_C>D").errorCode,
    "TRIGGER_TYPE_UNMAPPED"
  );
  assert.equal(
    resolveBlueIrisTriggerDirection({ ...profile, blue_iris_motion_enabled: false }, "MOTION_A>B").errorCode,
    "BLUE_IRIS_DIRECTION_MAPPING_DISABLED"
  );
});

test("only current mapped crossings become primary direction observations", async () => {
  const evidence = {
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "ready",
    triggerType: "MOTION_A>B",
    orientation: "front",
    directionLabel: "Eastbound",
    profileVersion: 8,
    errorCode: null,
  };
  assert.deepEqual(primaryDirectionObservationFromBlueIris(evidence), {
    status: "ready",
    orientation: "front",
    confidence: 1,
    directionLabel: "Eastbound",
    profileVersion: 8,
    embeddingModel: "blue-iris-zone-crossing",
    classifierVersion: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    counts: { front: 0, rear: 0, source: "blue_iris_zone_crossing" },
    source: "blue_iris_zone_crossing",
  });
  assert.equal(primaryDirectionObservationFromBlueIris({
    ...evidence,
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_LEGACY_SHADOW_ALGORITHM,
  }), null);
  assert.equal(primaryDirectionObservationFromBlueIris({
    ...evidence,
    status: "unknown",
    directionLabel: null,
  }), null);

  const calls = [];
  const persisted = await persistBlueIrisPrimaryDirectionForRead({
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ read_id: 39001 }] };
    },
    readId: 39001,
    camera: "Street LPR 1",
    evidence,
  });
  assert.equal(persisted.directionLabel, "Eastbound");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO public\.vehicle_direction_observations/);
  assert.match(calls[0].text, /ON CONFLICT \(read_id\) DO NOTHING/);
  assert.equal(calls[0].values[0], 39001);
  assert.equal(calls[0].values[1], "Street LPR 1");

  const historicalCalls = [];
  const historical = await persistBlueIrisPrimaryDirectionForRead({
    query: async (...args) => historicalCalls.push(args),
    readId: 38999,
    camera: "Street LPR 1",
    evidence: { ...evidence, algorithm: BLUE_IRIS_TRIGGER_DIRECTION_LEGACY_SHADOW_ALGORITHM },
  });
  assert.equal(historical, null);
  assert.equal(historicalCalls.length, 0);
});

test("monochrome nighttime evidence cannot become a Blue Iris direction", () => {
  const suppressed = applyBlueIrisDirectionEligibility({
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "ready",
    triggerType: "MOTION_A>B",
    orientation: "front",
    directionLabel: "Eastbound",
    profileVersion: 8,
    errorCode: null,
  }, {
    eligible: false,
    reason: "monochrome_night_capture",
  });
  assert.deepEqual(suppressed, {
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "unknown",
    triggerType: "MOTION_A>B",
    orientation: null,
    directionLabel: null,
    profileVersion: 8,
    errorCode: "MONOCHROME_NIGHT_DIRECTION_UNAVAILABLE",
  });
  assert.equal(primaryDirectionObservationFromBlueIris(suppressed), null);

  const missingTrigger = {
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "unknown",
    triggerType: null,
    orientation: null,
    directionLabel: null,
    profileVersion: 8,
    errorCode: "TRIGGER_TYPE_UNAVAILABLE",
  };
  assert.deepEqual(
    applyBlueIrisDirectionEligibility(missingTrigger, {
      eligible: false,
      reason: "monochrome_night_capture",
    }),
    missingTrigger
  );
});

test("plate-read trigger lookup executes mapped, unmapped, invalid, and omitted evidence paths", async () => {
  const calls = [];
  const profile = {
    blue_iris_motion_enabled: true,
    blue_iris_front_trigger_type: "MOTION_A>B",
    blue_iris_rear_trigger_type: "MOTION_B>A",
    blue_iris_motion_profile_version: 7,
    front_direction_label: "Eastbound",
    rear_direction_label: "Westbound",
  };
  const query = async (text, values) => {
    calls.push({ text, values });
    return { rows: [profile] };
  };

  const mapped = await resolveBlueIrisTriggerDirectionForRead({
    query,
    camera: "Street LPR 1",
    value: "MOTION_A>B",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, BLUE_IRIS_TRIGGER_DIRECTION_PROFILE_SQL);
  assert.deepEqual(calls[0].values, ["Street LPR 1"]);
  assert.deepEqual(blueIrisTriggerDirectionColumns(mapped), {
    bi_trigger_type: "MOTION_A>B",
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    bi_trigger_direction_profile_version: 7,
    bi_trigger_direction_algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    bi_trigger_direction_error_code: null,
  });

  const compositeMapped = await resolveBlueIrisTriggerDirectionForRead({
    query,
    camera: "Street LPR 1",
    value: "Motion_A>B,Zone A,Zone B,Zone C",
  });
  assert.deepEqual(blueIrisTriggerDirectionColumns(compositeMapped), {
    bi_trigger_type: "MOTION_A>B",
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    bi_trigger_direction_profile_version: 7,
    bi_trigger_direction_algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    bi_trigger_direction_error_code: null,
  });

  const unmapped = await resolveBlueIrisTriggerDirectionForRead({
    query,
    camera: "Street LPR 1",
    value: "MOTION_C>D",
  });
  assert.equal(unmapped.status, "unknown");
  assert.equal(unmapped.errorCode, "TRIGGER_TYPE_UNMAPPED");
  assert.equal(unmapped.profileVersion, 7);

  const invalid = await resolveBlueIrisTriggerDirectionForRead({
    query,
    camera: "Street LPR 1",
    value: "MOTION_A>B\nDROP TABLE",
  });
  assert.deepEqual(blueIrisTriggerDirectionColumns(invalid), {
    bi_trigger_type: null,
    bi_trigger_direction_status: "unknown",
    bi_trigger_direction_label: null,
    bi_trigger_direction_profile_version: 7,
    bi_trigger_direction_algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    bi_trigger_direction_error_code: "TRIGGER_TYPE_UNAVAILABLE",
  });

  const beforeOmitted = calls.length;
  const omitted = await resolveBlueIrisTriggerDirectionForRead({
    query,
    camera: "Street LPR 1",
    value: "  ",
  });
  assert.equal(calls.length, beforeOmitted + 1);
  assert.deepEqual(blueIrisTriggerDirectionColumns(omitted), {
    bi_trigger_type: null,
    bi_trigger_direction_status: "unknown",
    bi_trigger_direction_label: null,
    bi_trigger_direction_profile_version: 7,
    bi_trigger_direction_algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    bi_trigger_direction_error_code: "TRIGGER_TYPE_UNAVAILABLE",
  });
});

test("plate ingestion promotes current mapped crossings while preserving legacy shadow data", async () => {
  const [route, migration, settings, readme] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(route, /data\.trigger_type/);
  assert.match(route, /resolveBlueIrisTriggerDirectionForRead/);
  assert.match(route, /blueIrisTriggerDirectionColumns/);
  assert.match(route, /persistBlueIrisPrimaryDirectionForRead/);
  assert.match(route, /assessDirectionImageEligibility/);
  assert.match(route, /applyBlueIrisDirectionEligibility/);
  assert.match(route, /triggerType: blueIrisTriggerColumns\.bi_trigger_type/);
  assert.match(route, /directionStatus: blueIrisTriggerColumns\.bi_trigger_direction_status/);
  assert.match(route, /directionErrorCode: blueIrisTriggerColumns\.bi_trigger_direction_error_code/);
  assert.match(route, /processVehicleDirection/);
  assert.match(route, /\.\.\.blueIrisTriggerColumns/);
  assert.match(migration, /2026080702_blue_iris_trigger_direction_shadow/);
  assert.match(migration, /2026080703_blue_iris_trigger_direction_hardening/);
  assert.match(settings, /Blue Iris zone-crossing direction/);
  assert.match(settings, /primary direction source for new reads/);
  assert.match(readme, /"trigger_type":"&TYPE"/);
});
