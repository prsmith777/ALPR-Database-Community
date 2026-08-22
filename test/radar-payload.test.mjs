import assert from "node:assert/strict";
import test from "node:test";

import { parseRadarPayload } from "../lib/radar/payload.mjs";

function payload(value) {
  return Buffer.from(JSON.stringify(value));
}

test("OPS9243 velocity JSON is normalized to an inbound mph event", () => {
  const event = parseRadarPayload({
    topic: "A26260220/json",
    payload: payload({
      DetectedObjectVelocity: 37.25,
      timestamp: "2026-08-22T18:20:31.456Z",
      source: "OPS9243-A-PE",
      label: "vehicle",
    }),
    receivedAt: new Date("2026-08-22T18:20:32.000Z"),
  });

  assert.equal(event.speedMph, 37.3);
  assert.equal(event.signedSpeed, 37.25);
  assert.equal(event.direction, "inbound");
  assert.equal(event.sourceUnit, "mph");
  assert.equal(event.eventTimestamp.toISOString(), "2026-08-22T18:20:31.456Z");
  assert.equal(event.source, "OPS9243-A-PE");
  assert.equal(event.label, "vehicle");
  assert.match(event.messageHash, /^[0-9a-f]{64}$/);
});

test("negative velocity is outbound and metric speeds convert to mph", () => {
  const event = parseRadarPayload({
    topic: "A26260220/json",
    payload: payload({ speed: -80, units: "km/h", timestamp: 1_787_422_831_456 }),
  });

  assert.equal(event.speedMph, 49.7);
  assert.equal(event.direction, "outbound");
  assert.equal(event.sourceUnit, "kmh");
  assert.equal(event.eventTimestamp.toISOString(), "2026-08-22T18:20:31.456Z");
});

test("explicit direction wins over velocity sign", () => {
  const event = parseRadarPayload({
    topic: "A26260220/events",
    payload: payload({ velocity: -22, direction: "approaching" }),
    receivedAt: new Date("2026-08-22T18:20:31.456Z"),
  });

  assert.equal(event.direction, "inbound");
  assert.equal(event.eventTimestamp.toISOString(), "2026-08-22T18:20:31.456Z");
});

test("aggregate, malformed, impossible, and oversized messages are ignored", () => {
  assert.equal(parseRadarPayload({
    topic: "A26260220/json",
    payload: payload({ TimedSpeedCounts: { inbound: 3 } }),
  }), null);
  assert.equal(parseRadarPayload({ topic: "A26260220/json", payload: Buffer.from("not-json") }), null);
  assert.equal(parseRadarPayload({
    topic: "A26260220/json",
    payload: payload({ speed: 250, direction: "inbound" }),
  }), null);
  assert.equal(parseRadarPayload({
    topic: "A26260220/json",
    payload: Buffer.alloc(16 * 1024 + 1, 65),
  }), null);
});
