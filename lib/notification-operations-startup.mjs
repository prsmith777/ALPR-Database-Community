const STARTUP_STATE = Symbol.for("alpr.notification.operations.startup.v1");

function state(host = globalThis) {
  if (!host[STARTUP_STATE]) host[STARTUP_STATE] = { started: false, starting: null, timer: null };
  return host[STARTUP_STATE];
}

export async function startNotificationOperationsRuntimeWithRetry({
  stateHost = globalThis,
  logger = console,
  retryDelayMs = 30_000,
  startRuntime,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  const current = state(stateHost);
  if (current.started) return { status: "started", reused: true };
  if (current.starting) return current.starting;
  const starting = (async () => {
    try {
      const starter = startRuntime || (await import("./notification-operations-runtime.mjs")).startNotificationOperationsRuntime;
      await starter();
      current.started = true;
      current.timer = null;
      logger?.info?.("Notification operations runtime started");
      return { status: "started", reused: false };
    } catch (error) {
      if (!current.timer) {
        current.timer = schedule(() => {
          current.timer = null;
          return startNotificationOperationsRuntimeWithRetry({ stateHost, logger, retryDelayMs, startRuntime, schedule });
        }, retryDelayMs);
        current.timer?.unref?.();
      }
      logger?.error?.("Notification operations startup failed; retry scheduled", {
        retryDelayMs,
        error: String(error?.message ?? error).slice(0, 1000),
      });
      return { status: "retry-scheduled", reused: false, error: String(error?.message ?? error) };
    }
  })();
  current.starting = starting;
  try { return await starting; }
  finally { if (current.starting === starting) current.starting = null; }
}

export const notificationOperationsStartupInternals = Object.freeze({ STARTUP_STATE, state });
