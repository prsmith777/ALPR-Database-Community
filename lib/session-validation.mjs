const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/i;
const REQUIRED_SESSION_TIMESTAMPS = ["createdAt", "lastUsed", "expiresAt"];

export function isValidSessionId(sessionId) {
  return (
    typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)
  );
}

export function isOrdinaryObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isValidSessionRecord(session) {
  if (!isOrdinaryObject(session)) return false;

  return REQUIRED_SESSION_TIMESTAMPS.every(
    (field) => Object.hasOwn(session, field) && Number.isFinite(session[field])
  );
}

export function normalizeSessionMap(sessions) {
  const normalized = Object.create(null);
  if (!isOrdinaryObject(sessions)) return normalized;

  for (const [sessionId, session] of Object.entries(sessions)) {
    normalized[sessionId] = session;
  }

  return normalized;
}

export function getOwnValidSession(sessions, sessionId) {
  if (!isValidSessionId(sessionId) || !isOrdinaryObject(sessions)) {
    return null;
  }

  if (!Object.hasOwn(sessions, sessionId)) return null;

  const session = sessions[sessionId];
  return isValidSessionRecord(session) ? session : null;
}
