import { normalizeCameraKey, normalizePlate } from "./plate-normalize.mjs";
import { normalizeTimestamp } from "./timestamp.mjs";

export const MQTT_PAYLOAD_VERSION = 2;

const STANDARD_PAYLOAD_KEYS = Object.freeze([
  "payload_version",
  "event_id",
  "event_type",
  "read_id",
  "plate_number",
  "plate_number_normalized",
  "matched_plate_number",
  "plate_name",
  "known_plate",
  "tags",
  "camera",
  "camera_key",
  "timestamp",
  "timestamp_local",
  "timestamp_epoch",
  "timestamp_source",
  "confidence",
  "match_method",
  "match_distance",
  "match_quality",
  "matched_by",
  "matched_rules",
  "message",
]);

export function getStandardMqttPayloadKeys() {
  return [...STANDARD_PAYLOAD_KEYS];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of values ?? []) {
    const text = toTrimmedString(
      typeof value === "string" ? value : firstDefined(value?.name, value?.tag_name, "")
    );
    if (!text) continue;

    const identity = text.toLocaleLowerCase("en-US");
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(text);
  }

  return output;
}

function joinScalar(values = []) {
  return uniqueStrings(values).join(", ");
}

function normalizeConfidence(value) {
  if (value === "" || value === null || value === undefined) return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : "";
}

function normalizeReadId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function getCameraName(camera, read) {
  return toTrimmedString(
    firstDefined(
      camera?.cameraName,
      camera?.camera_name,
      camera?.name,
      read?.cameraName,
      read?.camera_name,
      read?.camera,
      ""
    )
  );
}

function getCameraKey(camera, cameraName) {
  const configuredKey = toTrimmedString(
    firstDefined(camera?.cameraKey, camera?.camera_key, "")
  );
  return configuredKey || normalizeCameraKey(cameraName);
}

function getCandidate(publication) {
  if (publication?.identityConflict) return null;
  return publication?.candidate ?? null;
}

function getCandidatePlate(candidate) {
  return normalizePlate(
    firstDefined(candidate?.plateNumber, candidate?.plate_number, "")
  );
}

function getCandidateName(candidate) {
  return toTrimmedString(firstDefined(candidate?.name, candidate?.plate_name, ""));
}

function getCandidateTags(candidate) {
  return uniqueStrings(candidate?.tags ?? []);
}

function getMatchQualities(publication) {
  const matches = Array.isArray(publication?.evidenceMatches)
    ? publication.evidenceMatches
    : publication?.matches ?? [];

  const qualities = matches.map(
    (match) => match?.matchQuality ?? match?.match_quality ?? ""
  );

  if (publication?.identityConflict) qualities.unshift("conflict");
  return qualities;
}

function getMessage(publication, explicitMessage) {
  if (toTrimmedString(explicitMessage)) return toTrimmedString(explicitMessage);

  const messages = (publication?.matches ?? []).map(
    (match) => match?.message ?? match?.ruleMessage ?? match?.rule_message ?? ""
  );
  return joinScalar(messages);
}

/**
 * Build a flat, stable MQTT payload for one accepted camera observation.
 *
 * plate_number preserves the camera/database observation. The canonical known
 * identity, when exact or fuzzy matching succeeds, is carried separately in
 * matched_plate_number. Empty values are emitted as empty strings rather than
 * omitted or null so stateful MQTT consumers do not retain stale attributes.
 */
export function buildMqttPlateReadPayload({
  read = {},
  camera = {},
  publication = {},
  settings = {},
  eventId = "",
  message = "",
  now,
} = {}) {
  const readId = normalizeReadId(
    firstDefined(read?.id, read?.readId, read?.read_id, 0)
  );
  const observedPlate = toTrimmedString(
    firstDefined(read?.plateNumber, read?.plate_number, "")
  ).toUpperCase();
  const normalizedObservedPlate = normalizePlate(observedPlate);
  const cameraName = getCameraName(camera, read);
  const cameraKey = getCameraKey(camera, cameraName);

  const timeZone = toTrimmedString(
    firstDefined(settings?.localTimezone, settings?.local_timezone, "UTC")
  );
  const hourFormat = Number(
    firstDefined(settings?.hourFormat, settings?.hour_format, 12)
  );
  const timestamp = normalizeTimestamp(
    firstDefined(read?.timestamp, read?.eventTime, read?.event_time, ""),
    {
      timeZone,
      hour12: hourFormat !== 24,
      ...(now ? { now } : {}),
    }
  );

  const candidate = getCandidate(publication);
  const candidatePlate = getCandidatePlate(candidate);
  const plannedMatchedPlate = normalizePlate(
    firstDefined(
      publication?.matchedPlateNumber,
      publication?.matched_plate_number,
      ""
    )
  );
  const matchedPlateNumber = publication?.identityConflict
    ? ""
    : plannedMatchedPlate || candidatePlate;
  const candidateName = getCandidateName(candidate);
  const candidateTags = getCandidateTags(candidate);
  const knownPlate = Boolean(candidate && (candidatePlate || candidateName || candidateTags.length));

  const resolvedEventId =
    toTrimmedString(eventId) ||
    (readId > 0 ? `read-${readId}` : `test-${timestamp.timestampEpoch}`);

  const payload = {
    payload_version: MQTT_PAYLOAD_VERSION,
    event_id: resolvedEventId,
    event_type: "plate_read",
    read_id: readId,
    plate_number: observedPlate,
    plate_number_normalized: normalizedObservedPlate,
    matched_plate_number: matchedPlateNumber,
    plate_name: knownPlate ? candidateName : "",
    known_plate: knownPlate ? 1 : 0,
    tags: knownPlate ? joinScalar(candidateTags) : "",
    camera: cameraName,
    camera_key: cameraKey,
    timestamp: timestamp.timestamp,
    timestamp_local: timestamp.timestampLocal,
    timestamp_epoch: timestamp.timestampEpoch,
    timestamp_source: timestamp.source,
    confidence: normalizeConfidence(
      firstDefined(read?.confidence, read?.plateConfidence, read?.plate_confidence, "")
    ),
    match_method: joinScalar(
      firstDefined(publication?.matchMethods, publication?.match_methods, [])
    ),
    match_distance: Number.isInteger(publication?.matchDistance)
      ? publication.matchDistance
      : Number.isInteger(publication?.match_distance)
        ? publication.match_distance
        : "",
    match_quality: joinScalar(getMatchQualities(publication)),
    matched_by: joinScalar(
      firstDefined(publication?.matchedBy, publication?.matched_by, [])
    ),
    matched_rules: joinScalar(
      firstDefined(publication?.ruleNames, publication?.rule_names, [])
    ),
    message: getMessage(publication, message),
  };

  for (const key of STANDARD_PAYLOAD_KEYS) {
    if (!(key in payload)) {
      throw new Error(`MQTT payload is missing standard field: ${key}`);
    }
  }

  return payload;
}

export function serializeMqttPayload(payload) {
  return JSON.stringify(payload);
}
