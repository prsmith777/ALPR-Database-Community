const STARTUP_STATE = Symbol.for("alpr.vehicle-event-shadow.startup.v1");

function stateFor(host = globalThis) {
  if (!host[STARTUP_STATE]) {
    host[STARTUP_STATE] = {
      started: false,
      startingPromise: null,
      retryTimer: null,
      lastError: null,
    };
  }
  return host[STARTUP_STATE];
}

function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Shadow vehicle event startup failed")
      .trim().slice(0, 500),
  };
}

async function loadDefaultStarter() {
  const runtime = await import("./vehicle-event-shadow-runtime.mjs");
  if (typeof runtime.startVehicleEventShadowRuntime !== "function") {
    throw new Error("Shadow vehicle event runtime did not expose its starter");
  }
  return runtime.startVehicleEventShadowRuntime;
}

export async function startVehicleEventShadowRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime,
  loadStartRuntime = loadDefaultStarter,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (startRuntime !== undefined && typeof startRuntime !== "function") {
    throw new Error("Shadow vehicle event startup starter must be a function");
  }
  if (typeof loadStartRuntime !== "function" || typeof schedule !== "function") {
    throw new Error("Shadow vehicle event startup dependencies must be functions");
  }
  const state = stateFor(stateHost);
  if (state.started) return { status: "started", reused: true, error: null };
  if (state.startingPromise) return state.startingPromise;
  const delay = Math.min(3_600_000, Math.max(100, Number(retryDelayMs) || 30_000));
  const attempt = (async () => {
    try {
      const starter = startRuntime || await loadStartRuntime();
      await starter();
      state.started = true;
      state.lastError = null;
      if (state.retryTimer) cancel(state.retryTimer);
      state.retryTimer = null;
      logger?.info?.("Shadow vehicle event runtime started");
      return { status: "started", reused: false, error: null };
    } catch (error) {
      state.lastError = safeError(error);
      if (!state.retryTimer) {
        state.retryTimer = schedule(() => {
          state.retryTimer = null;
          return startVehicleEventShadowRuntimeWithRetry({
            stateHost,
            logger,
            retryDelayMs: delay,
            startRuntime,
            loadStartRuntime,
            schedule,
            cancel,
          });
        }, delay);
        state.retryTimer?.unref?.();
      }
      logger?.error?.("Shadow vehicle event runtime startup failed; retry scheduled", {
        retryDelayMs: delay,
        error: state.lastError,
      });
      return { status: "retry-scheduled", reused: false, error: state.lastError };
    }
  })();
  state.startingPromise = attempt;
  try {
    return await attempt;
  } finally {
    if (state.startingPromise === attempt) state.startingPromise = null;
  }
}

export const vehicleEventShadowStartupInternals = Object.freeze({
  STARTUP_STATE,
  stateFor,
  safeError,
});
