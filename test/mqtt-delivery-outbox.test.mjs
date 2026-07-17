import test from "node:test";
import assert from "node:assert/strict";

import {
  MQTT_DELIVERY_STATUSES,
  calculateRetryDelayMs,
  classifyDeliveryError,
  createDeliveryDedupeKey,
  isDeliveryDue,
  isProcessingLeaseExpired,
  normalizeDeliveryEnvelope,
  planDeliveryFailure,
  planDeliverySuccess,
} from "../lib/mqtt/delivery-outbox.mjs";

const BASE_PUBLICATION = {
  eventId: "read-87321-entry-lpr-1",
  readId: 87321,
  cameraId: 7,
  cameraKey: "entry-lpr-1",
  cameraName: "Entry LPR 1",
  brokerId: 3,
  topic: "Blue Iris/ALPR/entry-lpr-1",
  payload: {
    event_id: "read-87321-entry-lpr-1",
    plate_number: "DP0M90",
    matched_plate_number: "DPOM90",
  },
};

test("delivery deduplication suppresses only the same camera event and destination", () => {
  const original = createDeliveryDedupeKey(BASE_PUBLICATION);
  const repeated = createDeliveryDedupeKey({ ...BASE_PUBLICATION });
  const otherCamera = createDeliveryDedupeKey({
    ...BASE_PUBLICATION,
    cameraKey: "entry-lpr-2",
  });
  const otherBroker = createDeliveryDedupeKey({
    ...BASE_PUBLICATION,
    brokerId: 4,
  });
  const otherTopic = createDeliveryDedupeKey({
    ...BASE_PUBLICATION,
    topic: "Blue Iris/ALPR/custom",
  });

  assert.equal(original, repeated);
  assert.notEqual(original, otherCamera);
  assert.notEqual(original, otherBroker);
  assert.notEqual(original, otherTopic);
  assert.match(original, /^mqtt-v2:[a-f0-9]{64}$/);
});

test("delivery envelopes normalize IDs, QoS, retention, payload, and retry limits", () => {
  const envelope = normalizeDeliveryEnvelope({
    ...BASE_PUBLICATION,
    qos: "1",
    retain: true,
    maxAttempts: "6",
  });

  assert.equal(envelope.eventId, BASE_PUBLICATION.eventId);
  assert.equal(envelope.readId, 87321);
  assert.equal(envelope.cameraId, 7);
  assert.equal(envelope.cameraKey, "entry-lpr-1");
  assert.equal(envelope.cameraName, "Entry LPR 1");
  assert.equal(envelope.brokerId, 3);
  assert.equal(envelope.qos, 1);
  assert.equal(envelope.retain, true);
  assert.equal(envelope.maxAttempts, 6);
  assert.deepEqual(envelope.payload, BASE_PUBLICATION.payload);
});

test("delivery envelopes reject malformed identities, topics, payloads, and dedupe keys", () => {
  assert.throws(
    () => normalizeDeliveryEnvelope({ ...BASE_PUBLICATION, cameraKey: "Entry LPR 1" }),
    /camera key/i
  );
  assert.throws(
    () => normalizeDeliveryEnvelope({ ...BASE_PUBLICATION, topic: "Blue Iris/#" }),
    /wildcards/i
  );
  assert.throws(
    () => normalizeDeliveryEnvelope({ ...BASE_PUBLICATION, payload: ["not", "object"] }),
    /JSON object/i
  );
  assert.throws(
    () => normalizeDeliveryEnvelope({ ...BASE_PUBLICATION, maxAttempts: 21 }),
    /maximum attempts/i
  );
  assert.throws(
    () =>
      normalizeDeliveryEnvelope({
        ...BASE_PUBLICATION,
        dedupeKey: "mqtt-v2:not-the-right-key",
      }),
    /does not match/i
  );
});

test("retry delays use bounded exponential backoff", () => {
  assert.equal(calculateRetryDelayMs(1), 1000);
  assert.equal(calculateRetryDelayMs(2), 2000);
  assert.equal(calculateRetryDelayMs(3), 4000);
  assert.equal(calculateRetryDelayMs(20), 300_000);
  assert.equal(
    calculateRetryDelayMs(4, { baseDelayMs: 500, maximumDelayMs: 2500 }),
    2500
  );
});

test("transient MQTT failures are scheduled for another bounded attempt", () => {
  const result = planDeliveryFailure({
    attemptCount: 0,
    maxAttempts: 5,
    error: Object.assign(new Error("Connection refused"), {
      code: "ECONNREFUSED",
    }),
    now: new Date("2026-07-17T03:03:37.800Z"),
  });

  assert.equal(result.status, MQTT_DELIVERY_STATUSES.RETRY);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.retryable, true);
  assert.equal(result.retryDelayMs, 1000);
  assert.equal(result.nextAttemptAt, "2026-07-17T03:03:38.800Z");
  assert.equal(result.lockedAt, null);
  assert.equal(result.lockedBy, null);
});

test("permanent MQTT configuration failures move directly to dead status", () => {
  const classified = classifyDeliveryError(
    new Error("Publish topics cannot contain MQTT wildcards (+ or #)")
  );
  assert.equal(classified.retryable, false);

  const result = planDeliveryFailure({
    attemptCount: 0,
    maxAttempts: 5,
    error: new Error("MQTT QoS must be 0, 1, or 2"),
    now: new Date("2026-07-17T03:03:37.800Z"),
  });

  assert.equal(result.status, MQTT_DELIVERY_STATUSES.DEAD);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.reason, "permanent-error");
  assert.equal(result.nextAttemptAt, null);
});

test("a transient failure becomes dead after the configured attempt limit", () => {
  const result = planDeliveryFailure({
    attemptCount: 4,
    maxAttempts: 5,
    error: Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }),
    now: new Date("2026-07-17T03:03:37.800Z"),
  });

  assert.equal(result.status, MQTT_DELIVERY_STATUSES.DEAD);
  assert.equal(result.attemptCount, 5);
  assert.equal(result.reason, "attempts-exhausted");
  assert.equal(result.retryable, false);
});

test("successful delivery records the completed attempt and publish time", () => {
  const result = planDeliverySuccess({
    attemptCount: 2,
    now: new Date("2026-07-17T03:03:37.800Z"),
  });

  assert.deepEqual(result, {
    status: MQTT_DELIVERY_STATUSES.SUCCEEDED,
    attemptCount: 3,
    attemptNumber: 3,
    publishedAt: "2026-07-17T03:03:37.800Z",
    nextAttemptAt: null,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
  });
});

test("due checks accept pending or retry rows and reject completed rows", () => {
  const now = new Date("2026-07-17T03:03:37.800Z");

  assert.equal(
    isDeliveryDue(
      { status: "pending", next_attempt_at: "2026-07-17T03:03:37.799Z" },
      now
    ),
    true
  );
  assert.equal(
    isDeliveryDue(
      { status: "retry", nextAttemptAt: "2026-07-17T03:03:37.801Z" },
      now
    ),
    false
  );
  assert.equal(
    isDeliveryDue(
      { status: "succeeded", next_attempt_at: "2026-07-17T03:03:00.000Z" },
      now
    ),
    false
  );
});

test("processing leases expire after the configured worker interval", () => {
  const now = new Date("2026-07-17T03:04:37.800Z");

  assert.equal(
    isProcessingLeaseExpired(
      {
        status: "processing",
        locked_at: "2026-07-17T03:03:37.800Z",
      },
      { now, leaseMs: 60_000 }
    ),
    true
  );
  assert.equal(
    isProcessingLeaseExpired(
      {
        status: "processing",
        locked_at: "2026-07-17T03:04:37.799Z",
      },
      { now, leaseMs: 60_000 }
    ),
    false
  );
  assert.equal(
    isProcessingLeaseExpired(
      { status: "processing", locked_at: null },
      { now, leaseMs: 60_000 }
    ),
    true
  );
  assert.equal(
    isProcessingLeaseExpired(
      { status: "pending", locked_at: "2026-07-17T03:03:37.800Z" },
      { now, leaseMs: 60_000 }
    ),
    false
  );
});
