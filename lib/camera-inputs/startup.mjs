const STATE = Symbol.for("alpr.camera-input-startup.v1");
export async function startCameraInputsWithRetry({
  stateHost = globalThis,
  logger = console,
  startRuntime,
  schedule = setTimeout,
} = {}) {
  const state = (stateHost[STATE] ||= {
    starting: null,
    started: false,
    timer: null,
  });
  if (state.started) return { status: "started", reused: true };
  if (state.starting) return state.starting;
  state.starting = (async () => {
    try {
      const starter =
        startRuntime ?? (await import("./runtime.mjs")).startCameraInputRuntime;
      await starter();
      state.started = true;
      return { status: "started" };
    } catch {
      if (!state.timer) {
        state.timer = schedule(() => {
          state.timer = null;
          void startCameraInputsWithRetry({
            stateHost,
            logger,
            startRuntime,
            schedule,
          });
        }, 30000);
        state.timer?.unref?.();
      }
      logger.error?.("Camera input startup failed; retry scheduled");
      return { status: "retry-scheduled" };
    }
  })();
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}
