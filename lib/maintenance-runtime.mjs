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

async function defaultEnsureReconciliationState(options) {
  const [{ ensureMaintenanceJobState }, { STORAGE_RECONCILIATION_JOB }] = await Promise.all([
    import("./maintenance-repository.mjs"),
    import("./storage-reconciliation.mjs"),
  ]);
  return ensureMaintenanceJobState({ ...options, jobName: STORAGE_RECONCILIATION_JOB });
}

async function defaultRunReconciliation(options) {
  const repository = await import("./storage-reconciliation-repository.mjs");
  return repository.runStorageReconciliationBatch(options);
}

async function defaultGetStorageBaseDir() {
  const storage = await import("./fileStorage.js");
  return storage.default.baseDir;
}

async function defaultRecordHeartbeat({ pool, workerId, error = null, now = new Date() } = {}) {
  const repository = await import("./storage-maintenance-repository.mjs");
  return repository.recordMaintenanceHeartbeat({
    executor: pool,
    runtimeName: "maintenance-scheduler",
    workerId,
    error,
    now,
  });
}

function boundedEnvInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getMaintenanceRuntimeConfig(env = process.env) {
  const enabledValue = String(env.MAINTENANCE_PREVIEW_ENABLED ?? "true").trim().toLowerCase();
  const reconciliationEnabledValue = String(env.STORAGE_RECONCILIATION_ENABLED ?? "true").trim().toLowerCase();
  return {
    enabled: !["false", "0", "no", "off"].includes(enabledValue),
    intervalSeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_INTERVAL_SECONDS, 86_400, 3_600, 604_800),
    pollSeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_POLL_SECONDS, 60, 10, 3_600),
    initialDelaySeconds: boundedEnvInteger(env.MAINTENANCE_PREVIEW_INITIAL_DELAY_SECONDS, 60, 10, 3_600),
    reconciliationEnabled: !["false", "0", "no", "off"].includes(reconciliationEnabledValue),
    reconciliationIntervalSeconds: boundedEnvInteger(
      env.STORAGE_RECONCILIATION_INTERVAL_SECONDS,
      604_800,
      3_600,
      604_800
    ),
    reconciliationInitialDelaySeconds: boundedEnvInteger(
      env.STORAGE_RECONCILIATION_INITIAL_DELAY_SECONDS,
      90,
      10,
      3_600
    ),
    reconciliationBatchSize: boundedEnvInteger(env.STORAGE_RECONCILIATION_BATCH_SIZE, 250, 25, 1_000),
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
  ensureReconciliationState = defaultEnsureReconciliationState,
  runReconciliation = defaultRunReconciliation,
  getStorageBaseDir = defaultGetStorageBaseDir,
  recordHeartbeat = defaultRecordHeartbeat,
} = {}) {
  if ([schedule, getDatabase, loadSettings, ensureState, runDue, ensureReconciliationState, runReconciliation, getStorageBaseDir, recordHeartbeat].some((value) => typeof value !== "function")) {
    throw new Error("Maintenance runtime dependencies must be functions");
  }
  const state = runtimeState(stateHost);
  if (state.started) return { status: "started", reused: true, mode: "dry-run" };

  const config = getMaintenanceRuntimeConfig(env);
  const pool = await getDatabase();
  const workerId = `alpr-maintenance-${process.pid}`;
  await ensureState({
    query: (text, values) => pool.query(text, values),
    enabled: config.enabled,
    intervalSeconds: config.intervalSeconds,
    initialDelaySeconds: config.initialDelaySeconds,
  });
  await ensureReconciliationState({
    query: (text, values) => pool.query(text, values),
    enabled: config.reconciliationEnabled,
    intervalSeconds: config.reconciliationIntervalSeconds,
    initialDelaySeconds: config.reconciliationInitialDelaySeconds,
  });
  state.started = true;
  await recordHeartbeat({ pool, workerId }).catch((error) => {
    logger?.warn?.("Maintenance scheduler heartbeat could not be recorded", { error: String(error?.message || error).slice(0, 1000) });
  });

  if (!config.enabled && !config.reconciliationEnabled) {
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
        let retentionResult = { status: "disabled" };
        if (config.enabled) {
          const currentSettings = await loadSettings();
          retentionResult = await runDue({
            pool,
            settings: {
              maxRecords: currentSettings.general?.maxRecords,
              retentionMonths: currentSettings.general?.retention,
            },
            enabled: config.enabled,
            intervalSeconds: config.intervalSeconds,
            initialDelaySeconds: config.initialDelaySeconds,
          });
        }
        let reconciliationResult = { status: "disabled" };
        if (config.reconciliationEnabled) {
          reconciliationResult = await runReconciliation({
            pool,
            baseDir: await getStorageBaseDir(),
            enabled: true,
            intervalSeconds: config.reconciliationIntervalSeconds,
            initialDelaySeconds: config.reconciliationInitialDelaySeconds,
            batchSize: config.reconciliationBatchSize,
          });
        }
        state.lastError = null;
        if (retentionResult.status === "completed") {
          logger?.info?.("Maintenance retention preview completed", retentionResult.preview);
        }
        if (reconciliationResult.status === "completed") {
          logger?.info?.("Read-only storage reconciliation completed", reconciliationResult.result);
        }
        return { retention: retentionResult, reconciliation: reconciliationResult };
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0, 1000);
        logger?.error?.("Maintenance retention preview failed", { error: state.lastError });
        return { status: "failed", error: state.lastError };
      } finally {
        await recordHeartbeat({ pool, workerId, error: state.lastError }).catch((error) => {
          logger?.warn?.("Maintenance scheduler heartbeat could not be recorded", { error: String(error?.message || error).slice(0, 1000) });
        });
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
    storageReconciliation: config.reconciliationEnabled ? "read-only" : "disabled",
  });
  return { status: "started", reused: false, enabled: true, mode: "dry-run" };
}

export const maintenanceRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  runtimeState,
});
