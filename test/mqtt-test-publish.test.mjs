import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  mqttTestPublishInternals,
  queueMqttTestPublish,
} from "../lib/mqtt/test-publish.mjs";

function makeRepository() {
  const deliveries = [];
  return {
    deliveries,
    async enqueueDelivery(delivery) {
      deliveries.push(delivery);
      return {
        id: 91,
        inserted: true,
        ...delivery,
      };
    },
  };
}

const broker = {
  id: 4,
  name: "Home MQTT",
  enabled: true,
};

const settings = {
  defaultQos: 1,
  retainMessages: false,
  localTimezone: "America/Denver",
  hourFormat: 12,
};

test("MQTT test publishing queues one standard payload through the durable outbox", async () => {
  const repository = makeRepository();
  const observedAt = new Date("2026-07-17T15:30:45.250Z");

  const result = await queueMqttTestPublish({
    repository,
    broker,
    settings,
    input: {
      brokerId: 4,
      topic: "Blue Iris/ALPR/entry-lpr-1",
      cameraName: "Entry LPR 1",
      cameraKey: "entry-lpr-1",
      plateNumber: "TEST123",
      message: "MQTT test message",
    },
    now: () => observedAt,
    createEventId: () => "test-event-1",
  });

  assert.equal(result.status, "queued");
  assert.equal(result.deliveryId, 91);
  assert.equal(result.eventId, "test-event-1");
  assert.equal(repository.deliveries.length, 1);

  const delivery = repository.deliveries[0];
  assert.equal(delivery.readId, null);
  assert.equal(delivery.cameraId, null);
  assert.equal(delivery.cameraKey, "entry-lpr-1");
  assert.equal(delivery.brokerId, 4);
  assert.equal(delivery.topic, "Blue Iris/ALPR/entry-lpr-1");
  assert.equal(delivery.qos, 1);
  assert.equal(delivery.retain, false);
  assert.equal(delivery.payload.event_type, "test");
  assert.equal(delivery.payload.plate_number, "TEST123");
  assert.equal(delivery.payload.camera, "Entry LPR 1");
  assert.equal(delivery.payload.camera_key, "entry-lpr-1");
  assert.equal(delivery.payload.timestamp, observedAt.toISOString());
  assert.equal(delivery.payload.timestamp_source, "blue_iris");
  assert.equal(delivery.payload.matched_rules, "MQTT Test");
  assert.equal(delivery.payload.message, "MQTT test message");
});

test("MQTT test publishing rejects disabled brokers and malformed destinations", async () => {
  const repository = makeRepository();

  await assert.rejects(
    () =>
      queueMqttTestPublish({
        repository,
        broker: { ...broker, enabled: false },
        settings,
        input: {
          brokerId: 4,
          topic: "Blue Iris/ALPR/test",
        },
      }),
    /broker is disabled/i
  );

  await assert.rejects(
    () =>
      queueMqttTestPublish({
        repository,
        broker,
        settings,
        input: {
          brokerId: 4,
          topic: "Blue Iris/+/test",
        },
      }),
    /wildcards/i
  );

  await assert.rejects(
    () =>
      queueMqttTestPublish({
        repository,
        broker,
        settings,
        input: {
          brokerId: 4,
          topic: "Blue Iris/ALPR/test",
          cameraKey: "Entry LPR 1",
        },
      }),
    /lowercase letters/i
  );
});

test("MQTT test input inherits QoS and retain defaults while allowing explicit overrides", () => {
  assert.deepEqual(
    mqttTestPublishInternals.normalizeTestInput(
      {
        brokerId: 3,
        topic: "Blue Iris/ALPR/test",
      },
      {
        defaultQos: 2,
        retainMessages: true,
      }
    ),
    {
      brokerId: 3,
      topic: "Blue Iris/ALPR/test",
      cameraName: "MQTT Test",
      cameraKey: "mqtt-test",
      plateNumber: "TEST123",
      message: "MQTT test message",
      qos: 2,
      retain: true,
    }
  );

  const explicit = mqttTestPublishInternals.normalizeTestInput(
    {
      brokerId: 3,
      topic: "Blue Iris/ALPR/test",
      qos: 0,
      retain: false,
    },
    {
      defaultQos: 2,
      retainMessages: true,
    }
  );

  assert.equal(explicit.qos, 0);
  assert.equal(explicit.retain, false);
});

test("the MQTT test API uses the runtime outbox instead of direct best-effort publishing", async () => {
  const source = await readFile(
    new URL("../app/api/mqtt/test/route.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /startMqttRuntime/);
  assert.match(source, /queueMqttTestPublish/);
  assert.equal(source.includes("clientManager.publish"), false);
  assert.equal(source.includes("sendMqttNotificationByPlate"), false);
});
