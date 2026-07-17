import { randomUUID } from "node:crypto";

import {
  createDeliveryDedupeKey,
} from "./delivery-outbox.mjs";
import { buildMqttPlateReadPayload } from "./payload.mjs";
import { normalizeCameraKey, normalizePlate } from "./plate-normalize.mjs";
import { validatePublishTopic } from "./topic-template.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`${name} must be a function`);
  }
  return value;
}

function requireText(value, name, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return Boolean(value);
}

function normalizeTestInput(input = {}, settings = {}) {
  const brokerId = normalizeId(input.brokerId ?? input.broker_id, "MQTT broker ID");
  const topic = validatePublishTopic(input.topic);
  const cameraName = requireText(
    input.cameraName ?? input.camera_name ?? "MQTT Test",
    "MQTT test camera name",
    255
  );
  const requestedKey = String(
    input.cameraKey ?? input.camera_key ?? ""
  ).trim();
  const cameraKey = requestedKey || normalizeCameraKey(cameraName) || "mqtt-test";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cameraKey)) {
    throw new Error(
      "MQTT test camera key must contain only lowercase letters, numbers, and hyphens"
    );
  }

  const plateNumber = requireText(
    input.plateNumber ?? input.plate_number ?? "TEST123",
    "MQTT test plate number",
    100
  ).toUpperCase();
  const normalizedPlate = normalizePlate(plateNumber);
  if (!normalizedPlate) {
    throw new Error("MQTT test plate number must contain letters or numbers");
  }

  const qos = Number(input.qos ?? settings.defaultQos ?? settings.default_qos ?? 1);
  if (!Number.isInteger(qos) || qos < 0 || qos > 2) {
    throw new Error("MQTT test QoS must be 0, 1, or 2");
  }

  return {
    brokerId,
    topic,
    cameraName,
    cameraKey,
    plateNumber,
    message: String(input.message ?? "MQTT test message").trim().slice(0, 4000),
    qos,
    retain: normalizeBoolean(
      input.retain,
      Boolean(settings.retainMessages ?? settings.retain_messages ?? false)
    ),
  };
}

export async function queueMqttTestPublish({
  repository,
  broker,
  settings,
  input,
  now = () => new Date(),
  createEventId = () => `test-${Date.now()}-${randomUUID()}`,
} = {}) {
  if (!repository || typeof repository.enqueueDelivery !== "function") {
    throw new Error("MQTT test publisher requires an outbox repository");
  }
  requireFunction(now, "MQTT test clock");
  requireFunction(createEventId, "MQTT test event ID factory");

  const normalized = normalizeTestInput(input, settings);
  if (!broker) throw new Error("MQTT test broker was not found");
  if (Number(broker.id) !== normalized.brokerId) {
    throw new Error("MQTT test broker identity does not match the request");
  }
  if (!broker.enabled) throw new Error("MQTT test broker is disabled");

  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new Error("MQTT test clock returned an invalid date");
  }

  const eventId = requireText(createEventId(), "MQTT test event ID", 255);
  const payload = buildMqttPlateReadPayload({
    read: {
      plate_number: normalized.plateNumber,
      timestamp: observedAt.toISOString(),
      confidence: "",
    },
    camera: {
      cameraName: normalized.cameraName,
      cameraKey: normalized.cameraKey,
    },
    publication: {
      matchMethods: ["test"],
      matchDistance: "",
      matchedBy: ["test"],
      ruleNames: ["MQTT Test"],
      matches: [{ matchQuality: "test" }],
    },
    settings,
    eventId,
    message: normalized.message,
    now: observedAt,
  });
  payload.event_type = "test";
  payload.timestamp_source = "server_test";

  const dedupeKey = createDeliveryDedupeKey({
    eventId,
    cameraKey: normalized.cameraKey,
    brokerId: normalized.brokerId,
    topic: normalized.topic,
  });

  const delivery = await repository.enqueueDelivery({
    dedupeKey,
    eventId,
    readId: null,
    cameraId: null,
    cameraKey: normalized.cameraKey,
    cameraName: normalized.cameraName,
    brokerId: normalized.brokerId,
    topic: normalized.topic,
    payload,
    qos: normalized.qos,
    retain: normalized.retain,
    maxAttempts: 5,
  });

  return {
    status: delivery?.inserted === false ? "duplicate" : "queued",
    eventId,
    deliveryId: Number(delivery?.id ?? 0),
    brokerId: normalized.brokerId,
    topic: normalized.topic,
    cameraKey: normalized.cameraKey,
    payload,
  };
}

export const mqttTestPublishInternals = Object.freeze({
  normalizeTestInput,
  normalizeId,
  normalizeBoolean,
});
