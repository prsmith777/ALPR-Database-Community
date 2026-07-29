import fileStorage from "./fileStorage.js";
import { getPool } from "./db.js";
import { getStorageHealth } from "./storage-health-runtime.mjs";
import { MaintenanceAlertRepository } from "./maintenance-alert-repository.mjs";
import {
  createStorageCleanupPreview,
  executeStorageCleanupPreview,
  getStorageCleanupOverview,
  STORAGE_CLEANUP_CONFIRMATION,
} from "./storage-cleanup.mjs";
import {
  getMaintenanceRuntimeState,
  getStorageMaintenanceConfig,
  saveStorageMaintenanceConfig,
} from "./storage-maintenance-repository.mjs";
import {
  automaticCleanupDecision,
  isMaintenanceSchedulerDisabled,
  runtimeLiveness,
  storageSeverity,
} from "./storage-maintenance-policy.mjs";

export async function getStorageMaintenanceOverview() {
  const pool = await getPool();
  const [settings, health, runs, alerts, runtime] = await Promise.all([
    getStorageMaintenanceConfig({ executor: pool }),
    getStorageHealth(),
    getStorageCleanupOverview({ executor: pool }),
    new MaintenanceAlertRepository({ pool }).overview(),
    getMaintenanceRuntimeState({ executor: pool, runtimeName: "maintenance-scheduler" }),
  ]);
  const currentSeverity = storageSeverity(health.filesystem?.usedPercent, settings);
  const schedulerDisabled = isMaintenanceSchedulerDisabled(health);
  return {
    settings,
    health: { ...health, severity: currentSeverity },
    severity: currentSeverity,
    breakdown: health.breakdown || null,
    jobs: {
      retention: health.maintenance || null,
      reconciliation: health.reconciliation || null,
      scheduler: schedulerDisabled ? {
        status: "disabled",
        ageSeconds: null,
        workerId: runtime?.worker_id || null,
        startedAt: runtime?.started_at || null,
        heartbeatAt: runtime?.heartbeat_at || null,
        lastError: null,
      } : runtime ? {
        workerId: runtime.worker_id,
        startedAt: runtime.started_at,
        heartbeatAt: runtime.heartbeat_at,
        lastError: runtime.last_error,
        ...runtimeLiveness(runtime.heartbeat_at, { staleAfterSeconds: settings.staleAfterSeconds }),
      } : { status: "missing", ageSeconds: null },
    },
    runs,
    cleanupPreview: runs.find((run) => run.mode === "preview") || null,
    alerts,
    automaticCleanup: automaticCleanupDecision(settings),
    confirmationPhrase: STORAGE_CLEANUP_CONFIRMATION,
  };
}

export async function updateStorageMaintenanceSettings({ input, actor } = {}) {
  return saveStorageMaintenanceConfig({ config: input, actor });
}

export async function runStorageMaintenancePreview({ actor } = {}) {
  const settings = await getStorageMaintenanceConfig();
  return createStorageCleanupPreview({
    actor,
    graceSeconds: settings.orphanGraceSeconds,
  });
}

export async function executeStorageCleanup({ previewToken, confirmation, actor } = {}) {
  return executeStorageCleanupPreview({
    storagePath: fileStorage.baseDir,
    previewToken,
    confirmation,
    actor,
  });
}

export { STORAGE_CLEANUP_CONFIRMATION };
