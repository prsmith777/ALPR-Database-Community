import { createHash } from "node:crypto";

import { validateQos } from "./client-manager.mjs";
import { isValidCameraKey } from "./plate-normalize.mjs";
import { validatePublishTopic } from "./topic-template.mjs";

export const MQTT_DELIVERY_STATUSES = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  RETRY: "retry",
  SUCCEEDED: "succeeded",
  DEAD: "dead",
});

const PERMANENT_ERROR_CODES = new Set([
  "ERR_MQTT_CONFIG",
  "ERR_MQTT_TOPIC",
  "ERR_MQTT_QOS",
  "ERR_MQTT_PAYLOAD",
  "ERR_MQTT_AUTH",
  "CONNACK_REFUSED_BAD_USERNAME_OR_PASSWORD",
  "CONNACK_REFUSED_NOT_AUTHORIZED",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

const PERMANENT_MESSAGE_PATTERNS = [
  /broker host cannot be empty/i,
  /broker is disabled/i,
  /publish topics? cannot/i,
  /topic cannot be empty/i,
  /topic exceeds/i,
  /qos must be/i,
  /payload could not be serialized/i,
  /not authorized/i,
  /bad user name or password/i,
  /client manager is shutting down/i,
];

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function requireText(value, name, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeInteger(
  value,
  { name, minimum, maximum, fallback = undefined, optional = false }
) {
  if ((value === undefined || value === null || value === "") && optional) {
    return null;
  }

  const source = firstDefined(value, fallback);
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeDate(value, name = "date") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date;
}

function normalizePayload(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Buffer.isBuffer(payload)
  ) {
    throw new Error("MQTT outbox payload must be a JSON object");
  }

  try {
    JSON.stringify(payload);
  } catch (error) {
    throw new Error(`MQTT outbox payload could not be serialized: ${error.message}`);
  }

  return payload;
}

function normalizeError(error) {
  const message = String(error?.message ?? error ?? "Unknown MQTT delivery error")
    .trim()
    .slice(0, 4000);
  const code = String(error?.code ?? "").trim().toUpperCase();
  return { code, message: message || "Unknown MQTT delivery error" };
}

export function createDeliveryDedupeKey({
  eventId,
  cameraKey,
  brokerId,
  topic,
} = {}) {
  const normalizedEventId = requireText(eventId, "MQTT event ID", 255);
  const normalizedCameraKey = requireText(cameraKey, "MQTT camera key", 100);
  if (!isValidCameraKey(normalizedCameraKey)) {
    throw new Error(
      "MQTT camera key must contain only lowercase letters, numbers, and hyphens"
    );
  }
  const normalizedBrokerId = normalizeInteger(brokerId, {
    name: "MQTT broker ID",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  const normalizedTopic = validatePublishTopic(topic);

  const digest = createHash("sha256")
    .update(
      `${normalizedEventId}\u0000${normalizedCameraKey}\u0000${normalizedBrokerId}\u0000${normalizedTopic}`,
      "utf8"
    )
    .digest("hex");

  return `mqtt-v2:${digest}`;
}

export function normalizeDeliveryEnvelope({
  dedupeKey,
  eventId,
  readId = null,
  cameraId = null,
  cameraKey,
  cameraName,
  brokerId,
  topic,
  payload,
  qos = 1,
  retain = false,
  maxAttempts = 5,
} = {}) {
  const normalizedEventId = requireText(eventId, "MQTT event ID", 255);
  const normalizedCameraKey = requireText(cameraKey, "MQTT camera key", 100);
  if (!isValidCameraKey(normalizedCameraKey)) {
    throw new Error(
      "MQTT camera key must contain only lowercase letters, numbers, and hyphens"
    );
  }

  const normalizedCameraName = requireText(cameraName, "MQTT camera name", 255);
  const normalizedBrokerId = normalizeInteger(brokerId, {
    name: "MQTT broker ID",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  const normalizedReadId = normalizeInteger(readId, {
    name: "Plate read ID",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    optional: true,
  });
  const normalizedCameraId = normalizeInteger(cameraId, {
    name: "MQTT camera ID",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    optional: true,
  });
  const normalizedTopic = validatePublishTopic(topic);
  const normalizedQos = validateQos(qos);
  const normalizedMaxAttempts = normalizeInteger(maxAttempts, {
    name: "MQTT maximum attempts",
    minimum: 1,
    maximum: 20,
  });
  const normalizedPayload = normalizePayload(payload);
  const generatedDedupeKey = createDeliveryDedupeKey({
    eventId: normalizedEventId,
    cameraKey: normalizedCameraKey,
    brokerId: normalizedBrokerId,
    topic: normalizedTopic,
  });

  if (dedupeKey && String(dedupeKey).trim() !== generatedDedupeKey) {
    throw new Error("MQTT delivery deduplication key does not match its envelope");
  }

  return {
    dedupeKey: generatedDedupeKey,
    eventId: normalizedEventId,
    readId: normalizedReadId,
    cameraId: normalizedCameraId,
    cameraKey: normalizedCameraKey,
    cameraName: normalizedCameraName,
    brokerId: normalizedBrokerId,
    topic: normalizedTopic,
    payload: normalizedPayload,
    qos: normalizedQos,
    retain: Boolean(retain),
    maxAttempts: normalizedMaxAttempts,
  };
}

export function calculateRetryDelayMs(
  attemptNumber,
  { baseDelayMs = 1000, maximumDelayMs = 300_000 } = {}
) {
  const attempt = normalizeInteger(attemptNumber, {
    name: "MQTT attempt number",
    minimum: 1,
    maximum: 1000,
  });
  const base = normalizeInteger(baseDelayMs, {
    name: "MQTT base retry delay",
    minimum: 1,
    maximum: 3_600_000,
  });
  const maximum = normalizeInteger(maximumDelayMs, {
    name: "MQTT maximum retry delay",
    minimum: base,
    maximum: 86_400_000,
  });

  return Math.min(maximum, base * 2 ** Math.min(attempt - 1, 30));
}

export function classifyDeliveryError(error) {
  const normalized = normalizeError(error);

  if (error?.retryable === false) {
    return { ...normalized, retryable: false, classification: "permanent" };
  }
  if (error?.retryable === true) {
    return { ...normalized, retryable: true, classification: "transient" };
  }
  if (PERMANENT_ERROR_CODES.has(normalized.code)) {
    return { ...normalized, retryable: false, classification: "permanent" };
  }
  if (TRANSIENT_ERROR_CODES.has(normalized.code)) {
    return { ...normalized, retryable: true, classification: "transient" };
  }
  if (PERMANENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized.message))) {
    return { ...normalized, retryable: false, classification: "permanent" };
  }

  return { ...normalized, retryable: true, classification: "transient" };
}

export function planDeliveryFailure({
  attemptCount = 0,
  maxAttempts = 5,
  error,
  now = new Date(),
  baseDelayMs = 1000,
  maximumDelayMs = 300_000,
} = {}) {
  const previousAttempts = normalizeInteger(attemptCount, {
    name: "MQTT attempt count",
    minimum: 0,
    maximum: 1000,
  });
  const maximumAttempts = normalizeInteger(maxAttempts, {
    name: "MQTT maximum attempts",
    minimum: 1,
    maximum: 20,
  });
  const attemptNumber = previousAttempts + 1;
  const failure = classifyDeliveryError(error);
  const currentTime = normalizeDate(now, "MQTT failure time");
  const exhausted = attemptNumber >= maximumAttempts;

  if (!failure.retryable || exhausted) {
    return {
      status: MQTT_DELIVERY_STATUSES.DEAD,
      attemptCount: attemptNumber,
      attemptNumber,
      retryable: false,
      reason: failure.retryable ? "attempts-exhausted" : "permanent-error",
      nextAttemptAt: null,
      lastError: failure.message,
      errorCode: failure.code,
      lockedAt: null,
      lockedBy: null,
    };
  }

  const retryDelayMs = calculateRetryDelayMs(attemptNumber, {
    baseDelayMs,
    maximumDelayMs,
  });

  return {
    status: MQTT_DELIVERY_STATUSES.RETRY,
    attemptCount: attemptNumber,
    attemptNumber,
    retryable: true,
    reason: "transient-error",
    retryDelayMs,
    nextAttemptAt: new Date(currentTime.getTime() + retryDelayMs).toISOString(),
    lastError: failure.message,
    errorCode: failure.code,
    lockedAt: null,
    lockedBy: null,
  };
}

export function planDeliverySuccess({ attemptCount = 0, now = new Date() } = {}) {
  const previousAttempts = normalizeInteger(attemptCount, {
    name: "MQTT attempt count",
    minimum: 0,
    maximum: 1000,
  });
  const publishedAt = normalizeDate(now, "MQTT publish time").toISOString();

  return {
    status: MQTT_DELIVERY_STATUSES.SUCCEEDED,
    attemptCount: previousAttempts + 1,
    attemptNumber: previousAttempts + 1,
    publishedAt,
    nextAttemptAt: null,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
  };
}

export function isDeliveryDue(delivery, now = new Date()) {
  const status = String(delivery?.status ?? "");
  if (
    status !== MQTT_DELIVERY_STATUSES.PENDING &&
    status !== MQTT_DELIVERY_STATUSES.RETRY
  ) {
    return false;
  }

  const nextAttemptAt = normalizeDate(
    delivery?.nextAttemptAt ?? delivery?.next_attempt_at,
    "MQTT next-attempt time"
  );
  return nextAttemptAt.getTime() <= normalizeDate(now, "MQTT current time").getTime();
}

export function isProcessingLeaseExpired(
  delivery,
  { now = new Date(), leaseMs = 60_000 } = {}
) {
  if (String(delivery?.status ?? "") !== MQTT_DELIVERY_STATUSES.PROCESSING) {
    return false;
  }

  const lockedAtValue = delivery?.lockedAt ?? delivery?.locked_at;
  if (!lockedAtValue) return true;

  const lockedAt = normalizeDate(lockedAtValue, "MQTT lock time");
  const currentTime = normalizeDate(now, "MQTT current time");
  const lease = normalizeInteger(leaseMs, {
    name: "MQTT worker lease",
    minimum: 1,
    maximum: 86_400_000,
  });

  return currentTime.getTime() - lockedAt.getTime() >= lease;
}
