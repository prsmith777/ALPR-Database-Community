export const MANUAL_CLEANUP_CATEGORIES = Object.freeze(["derived"]);
export const AUTOMATIC_CLEANUP_CATEGORIES = Object.freeze(["derived-orphans"]);
export const AUTOMATIC_CLEANUP_LIMITS = Object.freeze({
  maximumFiles: 100,
  maximumBytes: 1_073_741_824,
  maximumDurationMs: 300_000,
  minimumIntervalSeconds: 86_400,
  minimumGraceSeconds: 604_800,
  reconciliationFreshnessSeconds: 691_200,
});

export const DEFAULT_STORAGE_MAINTENANCE_CONFIG = Object.freeze({
  warningPercent: 80,
  criticalPercent: 90,
  checkIntervalSeconds: 3600,
  staleAfterSeconds: 10_800,
  alertCooldownSeconds: 21_600,
  emailEnabled: false,
  emailRecipients: Object.freeze([]),
  webhookEnabled: false,
  webhookUrl: "",
  cleanupEnabled: false,
  cleanupIntervalSeconds: 86_400,
  automaticCategories: Object.freeze([]),
  orphanGraceSeconds: 604_800,
});

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function percent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(99.9, Math.max(1, parsed)) * 100) / 100;
}

function recipients(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
    .slice(0, 10);
}

export function normalizeStorageMaintenanceConfig(value = {}) {
  const warningPercent = Math.min(98.9, percent(value.warningPercent, DEFAULT_STORAGE_MAINTENANCE_CONFIG.warningPercent));
  const proposedCritical = percent(value.criticalPercent, DEFAULT_STORAGE_MAINTENANCE_CONFIG.criticalPercent);
  const criticalPercent = proposedCritical > warningPercent
    ? proposedCritical
    : Math.min(99.9, Math.max(warningPercent + 1, DEFAULT_STORAGE_MAINTENANCE_CONFIG.criticalPercent));

  return {
    warningPercent,
    criticalPercent,
    checkIntervalSeconds: integer(value.checkIntervalSeconds, 3600, 60, 86_400),
    staleAfterSeconds: integer(value.staleAfterSeconds, 10_800, 120, 604_800),
    alertCooldownSeconds: integer(value.alertCooldownSeconds, 21_600, 300, 2_592_000),
    emailEnabled: value.emailEnabled === true,
    emailRecipients: recipients(value.emailRecipients),
    webhookEnabled: value.webhookEnabled === true,
    webhookUrl: String(value.webhookUrl ?? "").trim().slice(0, 2048),
    // Phase 1 starts with automation disabled and no approved automatic
    // categories. Persisted or forged values cannot widen this boundary.
    cleanupEnabled: false,
    cleanupIntervalSeconds: integer(value.cleanupIntervalSeconds, 86_400, 3_600, 604_800),
    automaticCategories: [],
    orphanGraceSeconds: integer(value.orphanGraceSeconds, 604_800, 86_400, 31_536_000),
  };
}

export function storageSeverity(usedPercent, config = DEFAULT_STORAGE_MAINTENANCE_CONFIG) {
  const normalized = normalizeStorageMaintenanceConfig(config);
  const used = Number(usedPercent);
  if (!Number.isFinite(used) || used < 0) return "unknown";
  if (used >= normalized.criticalPercent) return "critical";
  if (used >= normalized.warningPercent) return "warning";
  return "ok";
}

export function runtimeLiveness(heartbeatAt, {
  now = new Date(),
  staleAfterSeconds = DEFAULT_STORAGE_MAINTENANCE_CONFIG.staleAfterSeconds,
} = {}) {
  if (!heartbeatAt) return { status: "missing", ageSeconds: null };
  const heartbeat = new Date(heartbeatAt);
  const current = new Date(now);
  if (Number.isNaN(heartbeat.getTime()) || Number.isNaN(current.getTime())) {
    return { status: "missing", ageSeconds: null };
  }
  const ageSeconds = Math.max(0, Math.floor((current.getTime() - heartbeat.getTime()) / 1000));
  return {
    status: ageSeconds > integer(staleAfterSeconds, 10_800, 120, 604_800) ? "stale" : "healthy",
    ageSeconds,
  };
}

export function isMaintenanceSchedulerDisabled(health = {}) {
  return health.maintenance?.enabled === false && health.reconciliation?.enabled === false;
}

export function automaticCleanupDecision(config = {}) {
  const approval = config.approval || null;
  const state = config.state || null;
  const enabled = approval?.enabled === true && state?.circuitBreakerOpen !== true;
  return {
    enabled,
    categories: enabled ? ["derived-orphans"] : [],
    reason: state?.circuitBreakerOpen
      ? "Automatic cleanup is suspended until a fresh reconciliation and Administrator acknowledgement."
      : approval?.enabled
        ? "Derived-orphan automatic cleanup is approved."
        : "Automatic cleanup is disabled pending Administrator approval.",
  };
}

export function storageMonitorFailureDelay(value = 30) {
  return Math.max(5, Math.min(300, Number(value) || 30));
}
