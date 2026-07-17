const STARTUP_STATE = Symbol.for("alpr.mqtt.startup.state.v2");

function normalizeDelay(value, fallback = 30_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 3_600_000) {
    return fallback;
  }
  return parsed;
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown MQTT startup error")
      .trim()
      .slice(0, 4000),
  };
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  if (details === undefined) method.call(logger, message);
  else method.call(logger, message, details);
}

function getStartupState(stateHost = globalThis) {
  if (!stateHost[STARTUP_STATE]) {
    stateHost[STARTUP_STATE] = {
      started: false,
      startingPromise: null,
      retryTimer: null,
      lastError: null,
    };
  }
  return stateHost[STARTUP_STATE];
}

async function loadDefaultStartRuntime() {
  const runtime = await import("./runtime.mjs");
  if (typeof runtime.startMqttRuntime !== "function") {
    throw new Error("MQTT runtime did not expose startMqttRuntime()");
  }
  return runtime.startMqttRuntime;
}

/**
 * Start the durable MQTT worker without preventing the web application from
 * starting. A temporary initialization failure schedules another attempt, so
 * queued deliveries resume even when PostgreSQL is briefly unavailable during
 * a container restart.
 */
export async function startMqttRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime,
  loadStartRuntime = loadDefaultStartRuntime,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (startRuntime !== undefined && typeof startRuntime !== "function") {
    throw new Error("MQTT startup startRuntime must be a function");
  }
  if (typeof loadStartRuntime !== "function") {
    throw new Error("MQTT startup loader must be a function");
  }
  if (typeof schedule !== "function" || typeof cancel !== "function") {
    throw new Error("MQTT startup timer functions must be functions");
  }

  const state = getStartupState(stateHost);
  const retryDelay = normalizeDelay(retryDelayMs);

  if (state.started) {
    return {
      status: "started",
      reused: true,
      retryDelayMs: retryDelay,
      error: null,
    };
  }

  if (state.startingPromise) return state.startingPromise;

  const attemptPromise = (async () => {
    try {
      const starter = startRuntime ?? (await loadStartRuntime());
      if (typeof starter !== "function") {
        throw new Error("MQTT startup loader did not return a function");
      }

      await starter();
      state.started = true;
      state.lastError = null;

      if (state.retryTimer) {
        cancel(state.retryTimer);
        state.retryTimer = null;
      }

      safelyLog(logger, "info", "MQTT delivery runtime started");

      return {
        status: "started",
        reused: false,
        retryDelayMs: retryDelay,
        error: null,
      };
    } catch (error) {
      const normalized = safeError(error);
      state.lastError = normalized;

      if (!state.retryTimer) {
        const retryCallback = async () => {
          state.retryTimer = null;
          return startMqttRuntimeWithRetry({
            stateHost,
            logger,
            retryDelayMs: retryDelay,
            startRuntime,
            loadStartRuntime,
            schedule,
            cancel,
          });
        };

        state.retryTimer = schedule(retryCallback, retryDelay);
        state.retryTimer?.unref?.();
      }

      safelyLog(logger, "error", "MQTT delivery runtime startup failed; retry scheduled", {
        retryDelayMs: retryDelay,
        error: normalized,
      });

      return {
        status: "retry-scheduled",
        reused: false,
        retryDelayMs: retryDelay,
        error: normalized,
      };
    }
  })();

  state.startingPromise = attemptPromise;

  try {
    return await attemptPromise;
  } finally {
    if (state.startingPromise === attemptPromise) {
      state.startingPromise = null;
    }
  }
}

export const mqttStartupInternals = Object.freeze({
  STARTUP_STATE,
  getStartupState,
  normalizeDelay,
  safeError,
});
