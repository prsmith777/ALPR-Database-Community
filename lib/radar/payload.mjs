import { createHash } from "node:crypto";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 255;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function boundedText(value, maximumLength = MAX_TEXT_LENGTH) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function parseTimestamp(value, receivedAt) {
  if (value === undefined || value === null || value === "") {
    return new Date(receivedAt);
  }

  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function normalizeUnit(value) {
  const normalized = String(value || "mph").trim().toLowerCase().replace(/\s+/g, "");
  if (["mph", "mi/h", "miles/hour", "milesperhour"].includes(normalized)) return "mph";
  if (["kmh", "kph", "km/h", "kilometers/hour", "kilometersperhour"].includes(normalized)) return "kmh";
  if (["mps", "m/s", "meters/second", "meterspersecond"].includes(normalized)) return "mps";
  return null;
}

function speedInMph(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const magnitude = Math.abs(numeric);
  const mph = unit === "kmh" ? magnitude * 0.6213711922
    : unit === "mps" ? magnitude * 2.2369362921
      : magnitude;
  if (!Number.isFinite(mph) || mph <= 0 || mph > 200) return null;
  return Math.round(mph * 10) / 10;
}

function normalizeDirection(value, signedSpeed) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["inbound", "incoming", "approaching", "approach", "entering", "toward", "towards"].includes(normalized)) {
    return "inbound";
  }
  if (["outbound", "outgoing", "receding", "departing", "departure", "exiting", "away"].includes(normalized)) {
    return "outbound";
  }
  if (Number.isFinite(signedSpeed) && signedSpeed !== 0) {
    // OmniPreSense reports positive DetectedObjectVelocity as inbound and
    // negative velocity as outbound when an explicit direction is absent.
    return signedSpeed > 0 ? "inbound" : "outbound";
  }
  return null;
}

export function parseRadarPayload({ topic, payload, receivedAt = new Date() } = {}) {
  const topicText = boundedText(topic, 512);
  if (!topicText || !Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;

  // TimedSpeedCounts is a periodic aggregate, not one vehicle observation.
  if (parsed.TimedSpeedCounts && parsed.DetectedObjectVelocity === undefined && parsed.speed === undefined) {
    return null;
  }

  const nested = parsed.event && typeof parsed.event === "object" ? parsed.event : parsed;
  const rawSpeed = firstDefined(
    nested.DetectedObjectVelocity,
    nested.detectedObjectVelocity,
    nested.speed,
    nested.velocity,
    nested.Speed,
  );
  const signedSpeed = Number(rawSpeed);
  const sourceUnit = normalizeUnit(firstDefined(nested.unit, nested.units, nested.speed_unit, nested.speedUnit, "mph"));
  const speedMph = sourceUnit ? speedInMph(rawSpeed, sourceUnit) : null;
  const direction = normalizeDirection(
    firstDefined(nested.direction, nested.Direction, nested.travel_direction, nested.travelDirection),
    signedSpeed,
  );
  const eventTimestamp = parseTimestamp(
    firstDefined(nested.timestamp, nested.time, nested.event_timestamp, nested.eventTimestamp, nested.ts),
    receivedAt,
  );

  if (speedMph === null || !direction || !eventTimestamp) return null;

  const messageHash = createHash("sha256")
    .update(topicText, "utf8")
    .update("\0")
    .update(payload)
    .digest("hex");

  return {
    topic: topicText,
    eventTimestamp,
    receivedAt: new Date(receivedAt),
    speedMph,
    signedSpeed: Number.isFinite(signedSpeed) ? signedSpeed : null,
    sourceUnit,
    direction,
    source: boundedText(firstDefined(nested.source, nested.radarName, parsed.source), 255),
    label: boundedText(firstDefined(nested.label, nested.object_label, nested.objectLabel, parsed.label), 255),
    messageHash,
    payload: parsed,
  };
}

export const radarPayloadInternals = Object.freeze({
  MAX_PAYLOAD_BYTES,
  normalizeDirection,
  normalizeUnit,
  parseTimestamp,
  speedInMph,
});
