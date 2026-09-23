const STARTUP_STATE = Symbol.for("alpr.storage.maintenance.monitor.startup.v1");

function state(host = globalThis) {
  if (!host[STARTUP_STATE]) host[STARTUP_STATE] = { started: false, starting: null, timer: null };
  return host[STARTUP_STATE];
}

export async function startStorageMaintenanceMonitorWithRetry({
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
      const starter = startRuntime || (await import("./storage-maintenance-monitor-runtime.mjs")).startStorageMaintenanceMonitor;
      await starter({ logger });
      current.started = true;
      current.timer = null;
      return { status: "started", reused: false };
    } catch (error) {
      if (!current.timer) {
        current.timer = schedule(() => {
          current.timer = null;
          return startStorageMaintenanceMonitorWithRetry({ stateHost, logger, retryDelayMs, startRuntime, schedule });
        }, retryDelayMs);
        current.timer?.unref?.();
      }
      logger?.error?.("Storage maintenance monitor startup failed; retry scheduled", {
        retryDelayMs,
        error: String(error?.message || error).slice(0, 1000),
      });
      return { status: "retry-scheduled", reused: false, error: String(error?.message || error) };
    }
  })();
  current.starting = starting;
  try { return await starting; }
  finally { if (current.starting === starting) current.starting = null; }
}

export const storageMaintenanceMonitorStartupInternals = Object.freeze({ STARTUP_STATE, state });
