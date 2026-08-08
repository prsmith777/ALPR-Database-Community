import crypto from "node:crypto";

export function normalizeOverviewTriggerType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9_!>,+\-]{1,80}$/.test(normalized) ? normalized : null;
}
export function createOverviewCandidateIdentity({
  sourceCameraName,
  eventTimestamp,
  alertClip = null,
  alertPath = null,
} = {}) {
  const camera = String(sourceCameraName || "").trim().toLowerCase();
  const timestamp = new Date(eventTimestamp).toISOString();
  return crypto
    .createHash("sha256")
    .update([camera, timestamp, String(alertClip || ""), String(alertPath || "")].join("\u0000"))
    .digest("hex");
}

export function overviewNighttimeState(eligibility) {
  if (eligibility?.evaluated !== true) {
    return {
      accepted: false,
      status: "invalid",
      errorCode: "DAYLIGHT_IMAGE_REQUIRED",
    };
  }
  if (eligibility.monochrome === true || eligibility.eligible === false) {
    return {
      accepted: true,
      daylightStatus: "nighttime",
      status: "unavailable",
      retryable: false,
      errorCode: "NIGHTTIME_UNAVAILABLE",
    };
  }
  return {
    accepted: true,
    daylightStatus: "daytime",
    status: "pending",
    retryable: true,
    errorCode: null,
  };
}
