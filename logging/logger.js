import fs from "fs";
import path from "path";
import winston from "winston";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20;
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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedString(value) {
  const text = String(value);
  return text.length <= MAX_STRING_LENGTH
    ? text
    : `${text.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}

/**
 * Return a bounded, JSON-safe representation suitable for operational logs.
 * Payload bodies, images, plate values, credentials, paths, and Error details
 * are intentionally not emitted.
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

export function createOperationalLogger({ env = process.env, cwd = process.cwd() } = {}) {
  const logDirectory = path.resolve(env.ALPR_LOG_DIR || path.join(cwd, "logs"));
  const maxsize = positiveInteger(
    env.ALPR_OPERATIONAL_LOG_FILE_MAX_BYTES,
    DEFAULT_MAX_FILE_BYTES
  );
  const maxFiles = positiveInteger(
    env.ALPR_OPERATIONAL_LOG_MAX_FILES,
    DEFAULT_MAX_FILES
  );
  const transports = [new winston.transports.Console()];

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    transports.push(
      new winston.transports.File({
        filename: path.join(logDirectory, "app.log"),
        maxsize,
        maxFiles,
        tailable: true,
      })
    );
  } catch {
    // Console JSON remains available when the bounded file cannot be opened.
  }

  const logger = winston.createLogger({
    level: env.ALPR_LOG_LEVEL || "info",
    defaultMeta: { service: "alpr-community" },
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports,
  });

  function emit(level, event, fields = {}) {
    const safeEvent = boundedString(event || "operational_event");
    const safeFields = sanitizeLogValue(fields);
    logger.log({ ...safeFields, level, message: safeEvent });
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
    log: (event, fields) => emit("info", event, fields),
    close: () => logger.close(),
  };
}

const globalKey = Symbol.for("alpr.operationalLogger");

function singletonLogger() {
  if (typeof window !== "undefined") {
    return {
      info() {},
      warn() {},
      error() {},
      debug() {},
      log() {},
      close() {},
    };
  }
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = createOperationalLogger();
  }
  return globalThis[globalKey];
}

export const appLogger = singletonLogger();

export function createComponentLogger(component) {
  const safeComponent = boundedString(component || "application");
  const withComponent = (fields) => ({ ...(fields || {}), component: safeComponent });
  return {
    info: (event, fields) => appLogger.info(event, withComponent(fields)),
    warn: (event, fields) => appLogger.warn(event, withComponent(fields)),
    error: (event, fields) => appLogger.error(event, withComponent(fields)),
    debug: (event, fields) => appLogger.debug(event, withComponent(fields)),
    log: (event, fields) => appLogger.info(event, withComponent(fields)),
  };
}
