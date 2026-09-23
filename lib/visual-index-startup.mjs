const STARTUP_STATE = Symbol.for("alpr.visual-index.startup.state.v1");

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

function safeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: String(error?.code || ""),
    message: String(error?.message || error || "Unknown visual index startup error")
      .trim()
      .slice(0, 1000),
  };
}

async function loadDefaultStarter() {
  const runtime = await import("./visual-index-runtime.mjs");
  if (typeof runtime.startVisualIndexRuntime !== "function") {
    throw new Error("Visual index runtime did not expose startVisualIndexRuntime()");
  }
  return runtime.startVisualIndexRuntime;
}

export async function startVisualIndexRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime,
  loadStartRuntime = loadDefaultStarter,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (startRuntime !== undefined && typeof startRuntime !== "function") {
    throw new Error("Visual index startup startRuntime must be a function");
  }
  if (typeof loadStartRuntime !== "function" || typeof schedule !== "function" || typeof cancel !== "function") {
    throw new Error("Visual index startup loaders and timer functions must be functions");
  }
  const delay = Number.isInteger(Number(retryDelayMs))
    ? Math.min(3_600_000, Math.max(100, Number(retryDelayMs)))
    : 30_000;
  const state = getStartupState(stateHost);
  if (state.started) return { status: "started", reused: true, error: null };
  if (state.startingPromise) return state.startingPromise;

  const attempt = (async () => {
    try {
      const starter = startRuntime ?? await loadStartRuntime();
      await starter();
      state.started = true;
      state.lastError = null;
      if (state.retryTimer) cancel(state.retryTimer);
      state.retryTimer = null;
      logger?.info?.("Visual index runtime started");
      return { status: "started", reused: false, error: null };
    } catch (error) {
      state.lastError = safeError(error);
      if (!state.retryTimer) {
        state.retryTimer = schedule(async () => {
          state.retryTimer = null;
          return startVisualIndexRuntimeWithRetry({
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
      logger?.error?.("Visual index runtime startup failed; retry scheduled", {
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

export const visualIndexStartupInternals = Object.freeze({
  STARTUP_STATE,
  getStartupState,
  safeError,
});
