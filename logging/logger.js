import fs from "fs";
import path from "path";
import winston from "winston";
import { sanitizeLogValue } from "./sanitize.mjs";

export { sanitizeLogValue } from "./sanitize.mjs";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20;
const MAX_STRING_LENGTH = 512;
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
