const STARTUP_STATE = Symbol.for("alpr.vehicle-asset-embedding.startup.v1");

function stateFor(host = globalThis) {
  if (!host[STARTUP_STATE]) {
    host[STARTUP_STATE] = { started: false, starting: null, retryTimer: null, lastError: null };
  }
  return host[STARTUP_STATE];
}

function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Crop embedding startup failed").trim().slice(0, 500),
  };
}

async function defaultStarter() {
  const runtime = await import("./vehicle-asset-embedding-runtime.mjs");
  return runtime.startVehicleAssetEmbeddingRuntime();
}

export async function startVehicleAssetEmbeddingRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime = defaultStarter,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  const state = stateFor(stateHost);
  if (state.started) return { status: "started", reused: true, error: null };
  if (state.starting) return state.starting;
  const delay = Math.min(3_600_000, Math.max(100, Number(retryDelayMs) || 30_000));
  state.starting = (async () => {
    try {
      await startRuntime();
      state.started = true;
      state.lastError = null;
      return { status: "started", reused: false, error: null };
    } catch (error) {
      state.lastError = safeError(error);
      if (!state.retryTimer) {
        state.retryTimer = schedule(() => {
          state.retryTimer = null;
          return startVehicleAssetEmbeddingRuntimeWithRetry({
            stateHost, logger, retryDelayMs: delay, startRuntime, schedule,
          });
        }, delay);
        state.retryTimer?.unref?.();
      }
      logger?.error?.("Canonical crop embedding startup failed; retry scheduled", {
        retryDelayMs: delay,
        error: state.lastError,
      });
      return { status: "retry-scheduled", reused: false, error: state.lastError };
    }
  })();
  try { return await state.starting; }
  finally { state.starting = null; }
}

export const vehicleAssetEmbeddingStartupInternals = Object.freeze({
  STARTUP_STATE,
  safeError,
  stateFor,
});
