import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
  normalizeBlueIrisDirectionalTrigger,
  normalizeBlueIrisDirectionProfile,
  normalizeBlueIrisTriggerType,
  resolveBlueIrisTriggerDirection,
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
    profile_version: 4,
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

test("plate ingestion persists trigger direction as isolated shadow evidence", async () => {
  const [route, migration, settings, readme] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(route, /data\.trigger_type/);
  assert.match(route, /resolveBlueIrisTriggerDirection/);
  assert.match(route, /bi_trigger_direction_status/);
  assert.match(migration, /2026080702_blue_iris_trigger_direction_shadow/);
  assert.match(settings, /Blue Iris zone-crossing shadow/);
  assert.match(readme, /"trigger_type":"&TYPE"/);
});
