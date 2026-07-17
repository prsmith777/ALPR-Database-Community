import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMqttPlateReadPayload,
  getStandardMqttPayloadKeys,
  MQTT_PAYLOAD_VERSION,
  serializeMqttPayload,
} from "../lib/mqtt/payload.mjs";

const DENVER_SETTINGS = {
  localTimezone: "America/Denver",
  hourFormat: 12,
};

test("known fuzzy matches preserve OCR evidence and expose canonical identity", () => {
  const payload = buildMqttPlateReadPayload({
    read: {
      id: 87321,
      plate_number: "dp0m-90",
      timestamp: "7/16/2026, 9:03:37.800 PM",
      confidence: "0.94",
    },
    camera: {
      id: 1,
      cameraName: "Entry LPR 1",
      cameraKey: "entry-lpr-1",
    },
    publication: {
      matchedPlateNumber: "DPOM90",
      matchDistance: 1,
      matchMethods: ["fuzzy", "fuzzy"],
      matchedBy: ["tag", "any_known_plate"],
      ruleNames: ["Family Vehicles", "Known Vehicles"],
      candidate: {
        plate_number: "DPOM90",
        name: "Liz's Lexus",
        tags: ["Family", { name: "Resident" }, "family"],
      },
      matches: [{ matchQuality: "strong" }],
    },
    settings: DENVER_SETTINGS,
  });

  assert.equal(payload.payload_version, MQTT_PAYLOAD_VERSION);
  assert.equal(payload.event_id, "read-87321");
  assert.equal(payload.event_type, "plate_read");
  assert.equal(payload.read_id, 87321);
  assert.equal(payload.plate_number, "DP0M-90");
  assert.equal(payload.plate_number_normalized, "DP0M90");
  assert.equal(payload.matched_plate_number, "DPOM90");
  assert.equal(payload.plate_name, "Liz's Lexus");
  assert.equal(payload.known_plate, 1);
  assert.equal(payload.tags, "Family, Resident");
  assert.equal(payload.camera, "Entry LPR 1");
  assert.equal(payload.camera_key, "entry-lpr-1");
  assert.equal(payload.timestamp, "2026-07-17T03:03:37.800Z");
  assert.match(payload.timestamp_local, /7\/16\/2026/);
  assert.match(payload.timestamp_local, /9:03:37\.800 PM/);
  assert.equal(payload.timestamp_epoch, 1784257417800);
  assert.equal(payload.timestamp_source, "provided");
  assert.equal(payload.confidence, 0.94);
  assert.equal(payload.match_method, "fuzzy");
  assert.equal(payload.match_distance, 1);
  assert.equal(payload.match_quality, "strong");
  assert.equal(payload.matched_by, "tag, any_known_plate");
  assert.equal(payload.matched_rules, "Family Vehicles, Known Vehicles");
  assert.equal(payload.message, "");
});

test("unknown plates emit every standard field with empty scalar identity values", () => {
  const fallbackNow = new Date("2026-01-15T18:20:30.456Z");
  const payload = buildMqttPlateReadPayload({
    read: {
      id: 44,
      plate_number: "QRS456",
      timestamp: "not-a-date",
      confidence: null,
      camera_name: "Road Entrance LPR",
    },
    camera: {},
    publication: {
      matchMethods: ["exact"],
      matchedBy: ["any_plate"],
      ruleNames: ["All Road Traffic"],
      matches: [{ matchQuality: "exact" }],
    },
    settings: DENVER_SETTINGS,
    now: () => fallbackNow,
  });

  assert.deepEqual(Object.keys(payload), getStandardMqttPayloadKeys());
  assert.equal(payload.event_id, "read-44");
  assert.equal(payload.plate_number, "QRS456");
  assert.equal(payload.matched_plate_number, "");
  assert.equal(payload.plate_name, "");
  assert.equal(payload.known_plate, 0);
  assert.equal(payload.tags, "");
  assert.equal(payload.camera, "Road Entrance LPR");
  assert.equal(payload.camera_key, "road-entrance-lpr");
  assert.equal(payload.timestamp, fallbackNow.toISOString());
  assert.equal(payload.timestamp_epoch, fallbackNow.getTime());
  assert.equal(payload.timestamp_source, "server-receipt-fallback");
  assert.equal(payload.confidence, "");
  assert.equal(payload.match_distance, "");
  assert.equal(payload.message, "");

  for (const key of getStandardMqttPayloadKeys()) {
    assert.equal(Object.hasOwn(payload, key), true, `missing ${key}`);
    assert.notEqual(payload[key], null, `${key} should not be null`);
    assert.notEqual(payload[key], undefined, `${key} should not be undefined`);
  }
});

test("identity conflicts never attach a known name, tags, or canonical plate", () => {
  const payload = buildMqttPlateReadPayload({
    read: {
      id: 45,
      plate_number: "ABC129",
      timestamp: "2026-07-17T03:03:37.800Z",
    },
    camera: {
      camera_name: "Entry LPR 2",
      camera_key: "entry-lpr-2",
    },
    publication: {
      identityConflict: true,
      matchedPlateNumber: "ABC123",
      candidate: {
        plate_number: "ABC123",
        name: "Incorrect Vehicle",
        tags: ["Family"],
      },
      matchMethods: ["fuzzy"],
      matchedBy: ["tag"],
      ruleNames: ["Family Vehicles"],
      matches: [{ matchQuality: "strong" }],
    },
    settings: DENVER_SETTINGS,
  });

  assert.equal(payload.matched_plate_number, "");
  assert.equal(payload.plate_name, "");
  assert.equal(payload.known_plate, 0);
  assert.equal(payload.tags, "");
  assert.equal(payload.match_quality, "conflict, strong");
});

test("different camera reads get independent event IDs even one millisecond apart", () => {
  const first = buildMqttPlateReadPayload({
    read: {
      id: 1001,
      plate_number: "ABC123",
      timestamp: "2026-07-17T03:03:37.100Z",
    },
    camera: { camera_name: "Entry LPR 1", camera_key: "entry-lpr-1" },
    settings: DENVER_SETTINGS,
  });
  const second = buildMqttPlateReadPayload({
    read: {
      id: 1002,
      plate_number: "ABC123",
      timestamp: "2026-07-17T03:03:37.101Z",
    },
    camera: { camera_name: "Entry LPR 2", camera_key: "entry-lpr-2" },
    settings: DENVER_SETTINGS,
  });

  assert.equal(first.event_id, "read-1001");
  assert.equal(second.event_id, "read-1002");
  assert.notEqual(first.event_id, second.event_id);
  assert.equal(first.camera_key, "entry-lpr-1");
  assert.equal(second.camera_key, "entry-lpr-2");
  assert.equal(second.timestamp_epoch - first.timestamp_epoch, 1);
});

test("payload serialization remains plain JSON with scalar HomeSeer-friendly fields", () => {
  const payload = buildMqttPlateReadPayload({
    read: {
      id: 88,
      plate_number: "ABC123",
      timestamp: "2026-07-17T03:03:37Z",
    },
    camera: { camera_name: "Entry LPR 1", camera_key: "entry-lpr-1" },
    publication: {
      candidate: { plate_number: "ABC123", name: "Test Car", tags: ["Family"] },
      matchedPlateNumber: "ABC123",
      matchMethods: ["exact"],
      matchedBy: ["tag"],
      ruleNames: ["Family Vehicles"],
      matches: [{ matchQuality: "exact" }],
    },
    settings: DENVER_SETTINGS,
    message: "Vehicle detected",
  });

  const serialized = serializeMqttPayload(payload);
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed, payload);
  assert.equal(Array.isArray(parsed.tags), false);
  assert.equal(parsed.tags, "Family");
  assert.equal(parsed.message, "Vehicle detected");
  assert.equal(typeof parsed.known_plate, "number");
  assert.equal(typeof parsed.timestamp_epoch, "number");
});
