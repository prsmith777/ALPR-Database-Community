const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_LENGTH = 25;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 5;

const SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "session",
  "sessionid",
  "username",
  "plate",
  "platenumber",
  "image",
  "jpeg",
  "base64",
  "aidump",
  "raw",
  "rawtext",
  "body",
  "payload",
  "path",
  "alertpath",
  "clip",
  "alertclip",
  "file",
  "filename",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "authorization",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "sessionid",
  "username",
  "platenumber",
  "image",
  "jpeg",
  "base64",
  "aidump",
  "rawtext",
  "body",
  "payload",
  "path",
  "alertpath",
  "clip",
  "alertclip",
  "filename",
];

function sensitiveLogKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_KEY_NAMES.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((name) =>
      normalized.endsWith(name) && normalized.length > name.length
    )
  );
}

function boundedString(value) {
  const text = String(value);
  return text.length <= MAX_STRING_LENGTH
    ? text
    : `${text.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}

/**
 * Return a bounded, JSON-safe representation suitable for operational logs
 * and the protected System Logs viewer.
 */
export function sanitizeLogValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string" || typeof value === "bigint") {
    return boundedString(value);
  }

  if (value instanceof Error) {
    return {
      name: boundedString(value.name || "Error"),
      ...(value.code ? { code: boundedString(value.code) } : {}),
    };
  }

  if (
    (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) ||
    ArrayBuffer.isView(value)
  ) {
    return { type: "binary", bytes: value.byteLength };
  }

  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (typeof value !== "object") return boundedString(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => sanitizeLogValue(entry, depth + 1, seen));
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (sensitiveLogKey(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }
    sanitized[key] = sanitizeLogValue(entry, depth + 1, seen);
  }
  return sanitized;
}

export const logSanitizerInternals = Object.freeze({
  boundedString,
  sensitiveLogKey,
});
