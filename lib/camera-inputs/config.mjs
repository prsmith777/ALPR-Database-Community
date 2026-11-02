import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { deviceKey, InputError, text, validateTopicFilter } from "./axis.mjs";

export function newCredential() {
  return randomBytes(32).toString("hex");
}
export function hashCredential(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function verifySourceCredential(request, input) {
  if (
    !input?.enabled ||
    input.source !== "axis" ||
    !["http", "both"].includes(input.transport) ||
    !input.credential_hash
  )
    return false;
  if (new URL(request.url).search) return false;
  const authorization = request.headers.get("authorization") || "";
  let credential =
    request.headers.get("x-api-key") ||
    authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
  const basic = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)?.[1];
  if (!credential && basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (decoded.slice(0, split) !== input.id) return false;
    credential = decoded.slice(split + 1);
  }
  if (!credential || credential.length > 512) return false;
  const actual = Buffer.from(hashCredential(credential));
  const expected = Buffer.from(input.credential_hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validateInput(data, previous = null) {
  const source = data.source ?? previous?.source ?? "axis";
  const cameraName = text(data.camera_name ?? previous?.camera_name, 30);
  if (!cameraName)
    throw new InputError("Camera name is required (maximum 30 characters)");
  if (!["axis", "blue_iris"].includes(source))
    throw new InputError("Choose Blue Iris or Axis License Plate Verifier");
  const transport =
    source === "blue_iris"
      ? "http"
      : (data.transport ?? previous?.transport ?? "http");
  if (!["http", "mqtt", "both"].includes(transport))
    throw new InputError("Choose HTTP or MQTT");
  const brokerId =
    data.broker_id === ""
      ? null
      : (data.broker_id ?? previous?.broker_id ?? null);
  if (
    ["mqtt", "both"].includes(transport) &&
    (!Number.isSafeInteger(Number(brokerId)) || Number(brokerId) < 1)
  )
    throw new InputError("Select an MQTT broker");
  const mode = data.processing_mode ?? previous?.processing_mode ?? "immediate";
  if (!["immediate", "final"].includes(mode))
    throw new InputError("Choose immediate or finalized processing");
  const qos = Number(data.qos ?? previous?.qos ?? 1);
  if (![0, 1].includes(qos))
    throw new InputError("MQTT subscription QoS must be 0 or 1");
  const boolean = (key, fallback) => {
    const value = data[key] ?? previous?.[key] ?? fallback;
    if (typeof value !== "boolean")
      throw new InputError(`Invalid ${key} value`);
    return value;
  };
  return {
    id: previous?.id ?? randomUUID(),
    camera_name: cameraName,
    source,
    transport,
    enabled: boolean("enabled", true),
    device_id:
      source === "axis"
        ? deviceKey(data.device_id ?? previous?.device_id)
        : null,
    broker_id: ["mqtt", "both"].includes(transport) ? Number(brokerId) : null,
    topic_filter: ["mqtt", "both"].includes(transport)
      ? validateTopicFilter(data.topic_filter ?? previous?.topic_filter)
      : null,
    qos,
    processing_mode: mode,
    roi_filter: text(data.roi_filter ?? previous?.roi_filter, 30) || null,
    store_images: boolean("store_images", true),
    direction_in: text(data.direction_in ?? previous?.direction_in ?? "In", 80),
    direction_out: text(
      data.direction_out ?? previous?.direction_out ?? "Out",
      80,
    ),
  };
}
export function publicInput(row) {
  if (!row) return null;
  const { credential_hash: _credentialHash, ...safe } = row;
  return { ...safe, credential_configured: Boolean(row.credential_hash) };
}
