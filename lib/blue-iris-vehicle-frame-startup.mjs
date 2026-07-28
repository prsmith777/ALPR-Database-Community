const STARTUP_STATE = Symbol.for("alpr.blue-iris-vehicle-frame.startup.v1");

export async function startBlueIrisVehicleFrameRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  const state = stateHost[STARTUP_STATE] ||= { started: false, starting: null, timer: null };
  if (state.started) return { status: "started", reused: true };
  if (state.starting) return state.starting;
  state.starting = (async () => {
    try {
      const starter = startRuntime || (await import("./blue-iris-vehicle-frame-runtime.mjs")).startBlueIrisVehicleFrameRuntime;
      await starter();
      state.started = true;
      return { status: "started", reused: false };
    } catch (error) {
      logger?.error?.("Blue Iris vehicle-frame runtime startup failed; retry scheduled", {
        message: String(error?.message || error),
      });
      if (!state.timer) {
        state.timer = schedule(() => {
          state.timer = null;
          startBlueIrisVehicleFrameRuntimeWithRetry({ stateHost, logger, retryDelayMs, startRuntime, schedule });
        }, Math.max(1_000, Number(retryDelayMs) || 30_000));
        state.timer?.unref?.();
      }
      return { status: "retry-scheduled", reused: false, error: String(error?.message || error) };
    } finally {
      state.starting = null;
    }
  })();
  return state.starting;
}

export const blueIrisVehicleFrameStartupInternals = Object.freeze({ STARTUP_STATE });
