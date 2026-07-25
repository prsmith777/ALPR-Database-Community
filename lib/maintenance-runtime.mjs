const RUNTIME_STATE = Symbol.for("alpr.maintenance.runtime.state.v1");

async function defaultGetDatabase() {
  const database = await import("./db.js");
  return database.getPool();
}

async function defaultLoadSettings() {
  const settings = await import("./settings.js");
  return settings.getConfig();
}

async function defaultEnsureState(options) {
  const repository = await import("./maintenance-repository.mjs");
  return repository.ensureMaintenanceJobState(options);
}

async function defaultRunDue(options) {
  const repository = await import("./maintenance-repository.mjs");
  return repository.runDueRetentionPreview(options);
}

function boundedEnvInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getMaintenanceRuntimeConfig(env = process.env) {
  const enabledValue = String(env.MAINTENANCE_PREVIEW_ENABLED ?? "true").trim().toLowerCase();
  return {
    enabled: !["false", "0", "no", "off"].includes(enabledValue),
    intervalSeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_INTERVAL_SECONDS, 86_400, 3_600, 604_800),
    pollSeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_POLL_SECONDS, 60, 10, 3_600),
    initialDelaySeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_INITIAL_DELAY_SECONDS, 60, 10, 3_600),
    mode: "dry-run",
  };
}

function runtimeState(host = globalThis) {
  if (!host[RUNTIME_STATE]) {
    host[RUNTIME_STATE] = {
      started: false,
      timer: null,
      running: null,
      lastError: null,
    };
  }
  return host[RUNTIME_STATE];
}

export async function startMaintenanceRuntime({
  stateHost = globalThis,
  logger = console,
  env = process.env,
  schedule = (callback, delay) => setTimeout(callback, delay),
  getDatabase = defaultGetDatabase,
  loadSettings = defaultLoadSettings,
  ensureState = defaultEnsureState,
  runDue = defaultRunDue,
} = {}) {
  if ([schedule, getDatabase, loadSettings, ensureState, runDue].some((value) => typeof value !== "function")) {
    throw new Error("Maintenance runtime dependencies must be functions");
  }
  const state = runtimeState(stateHost);
  if (state.started) return { status: "started", reused: true, mode: "dry-run" };

  const config = getMaintenanceRuntimeConfig(env);
  const pool = await getDatabase();
  await ensureState({
    query: (text, values) => pool.query(text, values),
    enabled: config.enabled,
    intervalSeconds: config.intervalSeconds,
    initialDelaySeconds: config.initialDelaySeconds,
  });
  state.started = true;

  if (!config.enabled) {
    logger?.info?.("Maintenance preview scheduler is disabled");
    return { status: "started", reused: false, enabled: false, mode: "dry-run" };
  }

  const scheduleNext = (delaySeconds) => {
    state.timer = schedule(tick, delaySeconds * 1000);
    state.timer?.unref?.();
  };
  const tick = async () => {
    if (state.running) return state.running;
    const attempt = (async () => {
      try {
        const currentSettings = await loadSettings();
        const result = await runDue({
          pool,
          settings: {
            maxRecords: currentSettings.general?.maxRecords,
            retentionMonths: currentSettings.general?.retention,
          },
          enabled: config.enabled,
          intervalSeconds: config.intervalSeconds,
          initialDelaySeconds: config.initialDelaySeconds,
        });
        state.lastError = null;
        if (result.status === "completed") {
          logger?.info?.("Maintenance retention preview completed", result.preview);
        }
        return result;
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0, 1000);
        logger?.error?.("Maintenance retention preview failed", { error: state.lastError });
        return { status: "failed", error: state.lastError };
      } finally {
        scheduleNext(config.pollSeconds);
      }
    })();
    state.running = attempt;
    try {
      return await attempt;
    } finally {
      if (state.running === attempt) state.running = null;
    }
  };

  scheduleNext(config.initialDelaySeconds);
  logger?.info?.("Maintenance preview scheduler started", {
    mode: config.mode,
    intervalSeconds: config.intervalSeconds,
  });
  return { status: "started", reused: false, enabled: true, mode: "dry-run" };
}

export const maintenanceRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  runtimeState,
});
