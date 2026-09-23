export const BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM = "blue-iris-zone-crossing-v2-primary";
export const BLUE_IRIS_TRIGGER_DIRECTION_LEGACY_SHADOW_ALGORITHM = "blue-iris-zone-crossing-v1-shadow";
export const BLUE_IRIS_TRIGGER_DIRECTION_EMBEDDING_MODEL = "blue-iris-zone-crossing";

export const BLUE_IRIS_TRIGGER_DIRECTION_PROFILE_SQL = `SELECT enabled,
       front_direction_label, rear_direction_label,
       blue_iris_motion_enabled, blue_iris_front_trigger_type,
       blue_iris_rear_trigger_type, blue_iris_motion_profile_version
FROM public.camera_direction_profiles
WHERE camera_key = LOWER(BTRIM($1))`;

const SAFE_TRIGGER_TYPE = /^[A-Z0-9_!>,+\-]{1,80}$/;
const DIRECTIONAL_MOTION_TRIGGER = /^MOTION_([A-H])>([A-H])$/;
const MAX_TRIGGER_EVIDENCE_LENGTH = 256;

export class BlueIrisTriggerDirectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BlueIrisTriggerDirectionError";
    this.code = code;
  }
}

function cleanText(value, maximum = 80) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

export function normalizeBlueIrisTriggerType(value) {
  const normalized = cleanText(value).toUpperCase();
  if (!normalized || !SAFE_TRIGGER_TYPE.test(normalized)) return null;
  return normalized;
}

export function normalizeBlueIrisTriggerEvidence(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const raw = String(value).trim();
  if (
    !raw
    || raw.length > MAX_TRIGGER_EVIDENCE_LENGTH
    || /[\u0000-\u001f\u007f]/.test(raw)
  ) return null;

  const normalized = raw.replace(/\s+/g, " ").toUpperCase();
  const exactTrigger = normalizeBlueIrisTriggerType(normalized);
  if (exactTrigger && !normalized.includes(",")) return exactTrigger;

  const tokens = normalized.split(",").map((token) => token.trim());
  const leadingTrigger = normalizeBlueIrisTriggerType(tokens[0]);
  if (
    tokens.length < 2
    || tokens.slice(1).some((token) => !token)
    || !leadingTrigger
    || !DIRECTIONAL_MOTION_TRIGGER.test(leadingTrigger)
  ) return null;

  const conflictingCrossing = tokens.slice(1).some((token) => {
    const normalizedToken = normalizeBlueIrisTriggerType(token);
    return normalizedToken && DIRECTIONAL_MOTION_TRIGGER.test(normalizedToken);
  });
  return conflictingCrossing ? null : leadingTrigger;
}

export function normalizeBlueIrisDirectionalTrigger(value, label = "Blue Iris trigger") {
  const normalized = normalizeBlueIrisTriggerType(value);
  if (!normalized || !DIRECTIONAL_MOTION_TRIGGER.test(normalized)) {
    throw new BlueIrisTriggerDirectionError(
      "INVALID_BLUE_IRIS_DIRECTION_TRIGGER",
      `${label} must use an ordered Blue Iris zone crossing such as MOTION_A>B.`
    );
  }
  const [, fromZone, toZone] = normalized.match(DIRECTIONAL_MOTION_TRIGGER);
  if (fromZone === toZone) {
    throw new BlueIrisTriggerDirectionError(
      "INVALID_BLUE_IRIS_DIRECTION_TRIGGER",
      `${label} must cross between two different zones.`
    );
  }
  return normalized;
}

export function normalizeBlueIrisDirectionProfile(input = {}) {
  const enabled = input.blueIrisMotionEnabled === true || input.blue_iris_motion_enabled === true;
  const frontValue = input.blueIrisFrontTriggerType ?? input.blue_iris_front_trigger_type;
  const rearValue = input.blueIrisRearTriggerType ?? input.blue_iris_rear_trigger_type;
  const frontTriggerType = cleanText(frontValue)
    ? normalizeBlueIrisDirectionalTrigger(frontValue, "The trigger for the front-view direction")
    : null;
  const rearTriggerType = cleanText(rearValue)
    ? normalizeBlueIrisDirectionalTrigger(rearValue, "The trigger for the rear-view direction")
    : null;

  if (enabled && (!frontTriggerType || !rearTriggerType)) {
    throw new BlueIrisTriggerDirectionError(
      "INCOMPLETE_BLUE_IRIS_DIRECTION_PROFILE",
      "Enter both ordered Blue Iris zone crossings before enabling Blue Iris direction mapping."
    );
  }
  if (frontTriggerType && rearTriggerType && frontTriggerType === rearTriggerType) {
    throw new BlueIrisTriggerDirectionError(
      "AMBIGUOUS_BLUE_IRIS_DIRECTION_PROFILE",
      "The two Blue Iris zone crossings must be different."
    );
  }
  if (frontTriggerType && rearTriggerType) {
    const frontMatch = frontTriggerType.match(DIRECTIONAL_MOTION_TRIGGER);
    const rearMatch = rearTriggerType.match(DIRECTIONAL_MOTION_TRIGGER);
    if (frontMatch[1] !== rearMatch[2] || frontMatch[2] !== rearMatch[1]) {
      throw new BlueIrisTriggerDirectionError(
        "NON_REVERSE_BLUE_IRIS_DIRECTION_PROFILE",
        "The two Blue Iris zone crossings must be exact reverses, such as MOTION_A>B and MOTION_B>A."
      );
    }
  }
  return { enabled, frontTriggerType, rearTriggerType };
}

export function resolveBlueIrisTriggerDirection(profile, value) {
  const triggerType = normalizeBlueIrisTriggerEvidence(value);
  const profileVersion = Number(
    profile?.blue_iris_motion_profile_version ?? profile?.blueIrisMotionProfileVersion ?? 0
  ) || null;
  const result = {
    algorithm: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    status: "unknown",
    triggerType,
    orientation: null,
    directionLabel: null,
    profileVersion,
    errorCode: null,
  };
  if (!triggerType) return { ...result, errorCode: "TRIGGER_TYPE_UNAVAILABLE" };
  if (!DIRECTIONAL_MOTION_TRIGGER.test(triggerType)) {
    return { ...result, errorCode: "TRIGGER_NOT_DIRECTIONAL" };
  }
  if (!profile) return { ...result, errorCode: "CAMERA_DIRECTION_PROFILE_UNAVAILABLE" };
  if (profile.blue_iris_motion_enabled !== true && profile.blueIrisMotionEnabled !== true) {
    return { ...result, errorCode: "BLUE_IRIS_DIRECTION_MAPPING_DISABLED" };
  }

  const frontTrigger = normalizeBlueIrisTriggerType(
    profile.blue_iris_front_trigger_type ?? profile.blueIrisFrontTriggerType
  );
  const rearTrigger = normalizeBlueIrisTriggerType(
    profile.blue_iris_rear_trigger_type ?? profile.blueIrisRearTriggerType
  );
  if (triggerType === frontTrigger) {
    return {
      ...result,
      status: "ready",
      orientation: "front",
      directionLabel: cleanText(profile.front_direction_label ?? profile.frontDirectionLabel),
    };
  }
  if (triggerType === rearTrigger) {
    return {
      ...result,
      status: "ready",
      orientation: "rear",
      directionLabel: cleanText(profile.rear_direction_label ?? profile.rearDirectionLabel),
    };
  }
  return { ...result, errorCode: "TRIGGER_TYPE_UNMAPPED" };
}

export async function resolveBlueIrisTriggerDirectionForRead({ query, camera, value } = {}) {
  let profile = null;
  const cameraName = String(camera ?? "").trim().slice(0, 100);
  if (cameraName) {
    if (typeof query !== "function") {
      throw new TypeError("Blue Iris trigger direction lookup requires a database query function.");
    }
    const result = await query(BLUE_IRIS_TRIGGER_DIRECTION_PROFILE_SQL, [cameraName]);
    profile = result?.rows?.[0] || null;
  }
  return resolveBlueIrisTriggerDirection(profile, value);
}

export function blueIrisTriggerDirectionColumns(evidence) {
  return {
    bi_trigger_type: evidence?.triggerType || null,
    bi_trigger_direction_status: evidence?.status || null,
    bi_trigger_direction_label: evidence?.directionLabel || null,
    bi_trigger_direction_profile_version: evidence?.profileVersion || null,
    bi_trigger_direction_algorithm: evidence?.algorithm || null,
    bi_trigger_direction_error_code: evidence?.errorCode || null,
  };
}

export function applyBlueIrisDirectionEligibility(evidence, eligibility) {
  if (
    !evidence
    || evidence.status !== "ready"
    || eligibility?.eligible !== false
  ) return evidence;
  return {
    ...evidence,
    status: "unknown",
    orientation: null,
    directionLabel: null,
    errorCode: eligibility.reason === "monochrome_night_capture"
      ? "MONOCHROME_NIGHT_DIRECTION_UNAVAILABLE"
      : "DIRECTION_IMAGE_ASSESSMENT_UNAVAILABLE",
  };
}

export function primaryDirectionObservationFromBlueIris(evidence) {
  const profileVersion = Number(evidence?.profileVersion);
  const orientation = evidence?.orientation === "front" || evidence?.orientation === "rear"
    ? evidence.orientation
    : null;
  const directionLabel = cleanText(evidence?.directionLabel);
  if (
    evidence?.algorithm !== BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM
    || evidence?.status !== "ready"
    || !orientation
    || !directionLabel
    || !Number.isSafeInteger(profileVersion)
    || profileVersion < 1
  ) {
    return null;
  }
  return {
    status: "ready",
    orientation,
    confidence: 1,
    directionLabel,
    profileVersion,
    embeddingModel: BLUE_IRIS_TRIGGER_DIRECTION_EMBEDDING_MODEL,
    classifierVersion: BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM,
    counts: { front: 0, rear: 0, source: "blue_iris_zone_crossing" },
    source: "blue_iris_zone_crossing",
  };
}

export async function persistBlueIrisPrimaryDirectionForRead({
  query,
  readId,
  camera,
  evidence,
} = {}) {
  const observation = primaryDirectionObservationFromBlueIris(evidence);
  if (!observation) return null;
  if (typeof query !== "function") {
    throw new TypeError("Blue Iris primary direction persistence requires a database query function.");
  }
  const normalizedReadId = Number(readId);
  const cameraName = cleanText(camera, 100);
  if (!Number.isSafeInteger(normalizedReadId) || normalizedReadId < 1 || !cameraName) {
    throw new TypeError("Blue Iris primary direction persistence requires a read and camera.");
  }
  const result = await query(
    `INSERT INTO public.vehicle_direction_observations (
       read_id, camera_key, embedding_model, classifier_version, profile_version,
       status, orientation, orientation_confidence, direction_label, sample_counts
     ) VALUES ($1, LOWER(BTRIM($2)), $3, $4, $5, 'ready', $6, $7, $8, $9::jsonb)
     ON CONFLICT (read_id) DO NOTHING
     RETURNING read_id`,
    [
      normalizedReadId,
      cameraName,
      observation.embeddingModel,
      observation.classifierVersion,
      observation.profileVersion,
      observation.orientation,
      observation.confidence,
      observation.directionLabel,
      JSON.stringify(observation.counts),
    ]
  );
  if (Array.isArray(result?.rows) && result.rows.length === 0) return null;
  return observation;
}

export const blueIrisTriggerDirectionInternals = Object.freeze({
  DIRECTIONAL_MOTION_TRIGGER,
  SAFE_TRIGGER_TYPE,
});
