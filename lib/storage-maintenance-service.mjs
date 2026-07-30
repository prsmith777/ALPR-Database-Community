import fileStorage from "./fileStorage.js";
import { getPool } from "./db.js";
import { getConfig } from "./settings.js";
import { getStorageHealth } from "./storage-health-runtime.mjs";
import { deliverStorageMaintenanceEmailTest } from "./storage-maintenance-email.mjs";
import { deliverStorageMaintenanceWebhookTest } from "./storage-maintenance-webhook.mjs";
import { MaintenanceAlertRepository } from "./maintenance-alert-repository.mjs";
import {
  acknowledgeAutomaticCleanupFailure,
  getAutomaticCleanupApproval,
  setAutomaticCleanupApproval,
} from "./automatic-storage-cleanup.mjs";
import { getPostgresMaintenanceObservability } from "./postgres-maintenance-observability.mjs";
import {
  acknowledgeHostMaintenanceBreaker,
  getHostMaintenanceOverview,
  getHostMaintenanceRequestStatus,
  requestHostMaintenanceExecution,
  requestHostMaintenancePreview,
  setScheduledHostMaintenance,
} from "./host-maintenance-control.mjs";
import {
  createStorageCleanupPreview,
  executeStorageCleanupPreview,
  getStorageCleanupOverview,
  STORAGE_CLEANUP_CONFIRMATION,
} from "./storage-cleanup.mjs";
import {
  clearStorageMaintenanceWebhook,
  getMaintenanceRuntimeState,
  getStorageMaintenanceConfig,
  publicStorageMaintenanceConfig,
  replaceStorageMaintenanceWebhook,
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
  const [settings, health, runs, alerts, runtime, automatic, postgresMaintenance, hostMaintenance] = await Promise.all([
    getStorageMaintenanceConfig({ executor: pool }),
    getStorageHealth(),
    getStorageCleanupOverview({ executor: pool }),
    new MaintenanceAlertRepository({ pool }).overview(),
    getMaintenanceRuntimeState({ executor: pool, runtimeName: "maintenance-scheduler" }),
    getAutomaticCleanupApproval({ executor: pool }),
    getPostgresMaintenanceObservability({ executor: pool }).catch((error) => ({
      available: false,
      error: String(error?.message || "PostgreSQL statistics are unavailable").slice(0, 500),
      executionEnabled: false,
    })),
    getHostMaintenanceOverview({ executor: pool }),
  ]);
  const currentSeverity = storageSeverity(health.filesystem?.usedPercent, settings);
  const schedulerDisabled = isMaintenanceSchedulerDisabled(health);
  return {
    settings: publicStorageMaintenanceConfig(settings),
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
    automaticCleanup: {
      ...automatic,
      ...automaticCleanupDecision(automatic),
    },
    postgresMaintenance,
    hostMaintenance,
    confirmationPhrase: STORAGE_CLEANUP_CONFIRMATION,
  };
}

export async function updateStorageMaintenanceSettings({ input, actor } = {}) {
  return publicStorageMaintenanceConfig(await saveStorageMaintenanceConfig({ config: input, actor }));
}

export async function replaceStorageMaintenanceWebhookDestination({ webhookUrl, actor } = {}) {
  return replaceStorageMaintenanceWebhook({ webhookUrl, actor });
}

export async function clearStorageMaintenanceWebhookDestination({ actor } = {}) {
  return clearStorageMaintenanceWebhook({ actor });
}

export async function testStorageMaintenanceWebhookDestination({
  webhookUrl = "",
  loadMaintenanceConfig = getStorageMaintenanceConfig,
  loadApplicationConfig = getConfig,
  deliverTest = deliverStorageMaintenanceWebhookTest,
} = {}) {
  const maintenance = await loadMaintenanceConfig();
  const application = await loadApplicationConfig();
  return deliverTest({
    webhookUrl,
    savedWebhookUrl: maintenance.webhookUrl,
    applicationConfig: application,
  });
}

export async function testStorageMaintenanceEmailRecipients({
  recipients = [],
  loadApplicationConfig = getConfig,
  deliverTest = deliverStorageMaintenanceEmailTest,
} = {}) {
  const application = await loadApplicationConfig();
  return deliverTest({ recipients, applicationConfig: application });
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

export async function updateAutomaticCleanupApproval({ input, actor } = {}) {
  return setAutomaticCleanupApproval({
    actor,
    enabled: input?.enabled === true,
    confirmation: String(input?.confirmation || ""),
    intervalSeconds: input?.intervalSeconds,
    graceSeconds: input?.graceSeconds,
  });
}

export async function acknowledgeAutomaticCleanup({ confirmation, actor } = {}) {
  return acknowledgeAutomaticCleanupFailure({ actor, confirmation });
}

export async function createHostMaintenancePreview({ category, actor } = {}) {
  return requestHostMaintenancePreview({ category, actor });
}

export async function readHostMaintenanceRequest({ requestId, actor } = {}) {
  return getHostMaintenanceRequestStatus({ requestId, actor });
}

export async function createHostMaintenanceExecution({ requestId, previewToken, confirmation, actor } = {}) {
  return requestHostMaintenanceExecution({ requestId, previewToken, confirmation, actor });
}

export async function updateScheduledHostMaintenance({ input, actor } = {}) {
  return setScheduledHostMaintenance({ ...input, actor });
}

export async function acknowledgeHostMaintenanceFailure({ input, actor } = {}) {
  return acknowledgeHostMaintenanceBreaker({ ...input, actor });
}

export { STORAGE_CLEANUP_CONFIRMATION };
