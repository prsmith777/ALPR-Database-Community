import { createHash } from "node:crypto";

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  return text;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Plate read timestamp must be a valid date");
  }
  return timestamp.toISOString();
}

export function createPlateReadEventIdentity({
  plateNumber,
  timestamp,
  cameraName = null,
} = {}) {
  const canonicalEvent = JSON.stringify([
    requireText(plateNumber, "Plate number").toUpperCase(),
    normalizeTimestamp(timestamp),
    cameraName === null || cameraName === undefined
      ? null
      : String(cameraName),
  ]);

  const digest = createHash("sha256")
    .update(canonicalEvent, "utf8")
    .digest("hex");

  return `plate-read-v1:${digest}`;
}

export const plateReadEventIdentityInternals = Object.freeze({
  normalizeTimestamp,
});
