export const BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM = "blue-iris-zone-crossing-v1-shadow";

const SAFE_TRIGGER_TYPE = /^[A-Z0-9_!>,+\-]{1,80}$/;
const DIRECTIONAL_MOTION_TRIGGER = /^MOTION_([A-H])>([A-H])$/;

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
      "Enter both ordered Blue Iris zone crossings before enabling shadow direction mapping."
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
  const triggerType = normalizeBlueIrisTriggerType(value);
  const profileVersion = Number(profile?.profile_version ?? profile?.profileVersion ?? 0) || null;
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

export const blueIrisTriggerDirectionInternals = Object.freeze({
  DIRECTIONAL_MOTION_TRIGGER,
  SAFE_TRIGGER_TYPE,
});
