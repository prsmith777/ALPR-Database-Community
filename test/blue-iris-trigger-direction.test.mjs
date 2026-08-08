import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
  BLUE_IRIS_TRIGGER_DIRECTION_PROFILE_SQL,
  blueIrisTriggerDirectionColumns,
  normalizeBlueIrisDirectionalTrigger,
  normalizeBlueIrisDirectionProfile,
  normalizeBlueIrisTriggerType,
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

test("camera mappings require two exact reverse crossings before shadow collection is enabled", () => {
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

test("an ordered Blue Iris trigger maps to the camera semantic direction without replacing live direction", () => {
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
  assert.equal(
    resolveBlueIrisTriggerDirection(profile, "MOTION_C>D").errorCode,
    "TRIGGER_TYPE_UNMAPPED"
  );
  assert.equal(
    resolveBlueIrisTriggerDirection({ ...profile, blue_iris_motion_enabled: false }, "MOTION_A>B").errorCode,
    "BLUE_IRIS_DIRECTION_MAPPING_DISABLED"
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
  assert.equal(omitted, null);
  assert.equal(calls.length, beforeOmitted);
  assert.deepEqual(blueIrisTriggerDirectionColumns(omitted), {
    bi_trigger_type: null,
    bi_trigger_direction_status: null,
    bi_trigger_direction_label: null,
    bi_trigger_direction_profile_version: null,
    bi_trigger_direction_algorithm: null,
    bi_trigger_direction_error_code: null,
  });
});

test("plate ingestion uses executable trigger evidence columns as isolated shadow data", async () => {
  const [route, migration, settings, readme] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(route, /data\.trigger_type/);
  assert.match(route, /resolveBlueIrisTriggerDirectionForRead/);
  assert.match(route, /blueIrisTriggerDirectionColumns/);
  assert.match(route, /\.\.\.blueIrisTriggerColumns/);
  assert.match(migration, /2026080702_blue_iris_trigger_direction_shadow/);
  assert.match(migration, /2026080703_blue_iris_trigger_direction_hardening/);
  assert.match(settings, /Blue Iris zone-crossing shadow/);
  assert.match(readme, /"trigger_type":"&TYPE"/);
});
