import { getPool } from "./db.js";
import { getStorageHealth } from "./storage-health-runtime.mjs";
import { MaintenanceAlertRepository } from "./maintenance-alert-repository.mjs";
import {
  getMaintenanceRuntimeState,
  getStorageMaintenanceConfig,
  recordMaintenanceHeartbeat,
  recordStorageMeasurement,
} from "./storage-maintenance-repository.mjs";
import {
  isMaintenanceSchedulerDisabled,
  runtimeLiveness,
  storageMonitorFailureDelay,
  storageSeverity,
} from "./storage-maintenance-policy.mjs";
import {
  getStorageCleanupOverview,
  recoverInterruptedStorageCleanupRuns,
} from "./storage-cleanup.mjs";
import { runScheduledStorageCleanup } from "./automatic-storage-cleanup.mjs";
import fileStorage from "./fileStorage.js";

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("Storage maintenance monitor wait aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class StorageMaintenanceMonitor {
  constructor({
    pool,
    loadSettings = getStorageMaintenanceConfig,
    loadHealth = getStorageHealth,
    alertRepository,
    now = () => new Date(),
    logger = console,
    workerId = `alpr-storage-monitor-${process.pid}`,
    failureRetrySeconds = 30,
  } = {}) {
    this.pool = pool;
    this.loadSettings = loadSettings;
    this.loadHealth = loadHealth;
    this.alertRepository = alertRepository;
    this.now = now;
    this.logger = logger;
    this.workerId = workerId;
    this.failureRetrySeconds = storageMonitorFailureDelay(failureRetrySeconds);
    this.startedAt = this.now();
    this.currentRun = null;
    this.loopPromise = null;
    this.stopped = false;
    this.waitController = null;
  }

  async database() { return this.pool || await getPool(); }

  async runBatch() {
    const pool = await this.database();
    await recoverInterruptedStorageCleanupRuns({ executor: pool, now: this.now() });
    const settings = await this.loadSettings({ executor: pool });
    const health = await this.loadHealth();
    await recordStorageMeasurement({ executor: pool, snapshot: health });
    const alerts = this.alertRepository || new MaintenanceAlertRepository({ pool });
    const severity = storageSeverity(health.filesystem?.usedPercent, settings);
    if (severity !== "unknown") {
      await alerts.observe({
        eventKey: "storage.disk-usage",
        severity,
        message: severity === "ok"
          ? `Storage usage recovered to ${health.filesystem.usedPercent}%.`
          : `Storage usage is ${health.filesystem.usedPercent}% (${severity}).`,
        details: {
          usedPercent: health.filesystem.usedPercent,
          warningPercent: settings.warningPercent,
          criticalPercent: settings.criticalPercent,
          availableBytes: health.filesystem.availableBytes,
        },
        settings,
        now: this.now(),
      });
    }
    const scheduler = await getMaintenanceRuntimeState({ executor: pool, runtimeName: "maintenance-scheduler" });
    const liveness = runtimeLiveness(scheduler?.heartbeat_at, {
      now: this.now(),
      staleAfterSeconds: settings.staleAfterSeconds,
    });
    const schedulerDisabled = isMaintenanceSchedulerDisabled(health);
    const monitorAgeSeconds = Math.max(0, Math.floor((this.now().getTime() - this.startedAt.getTime()) / 1000));
    if (schedulerDisabled) {
      await alerts.observe({
        eventKey: "maintenance.scheduler-liveness",
        severity: "ok",
        message: "The storage maintenance scheduler is intentionally disabled.",
        details: { status: "disabled", heartbeatAt: scheduler?.heartbeat_at || null },
        settings,
        now: this.now(),
      });
    } else if (scheduler || monitorAgeSeconds >= settings.staleAfterSeconds) {
      await alerts.observe({
        eventKey: "maintenance.scheduler-liveness",
        severity: liveness.status === "healthy" ? "ok" : "critical",
        message: liveness.status === "healthy"
          ? "The storage maintenance scheduler heartbeat recovered."
          : "The storage maintenance scheduler heartbeat is missing or stale.",
        details: { ...liveness, heartbeatAt: scheduler?.heartbeat_at || null },
        settings,
        now: this.now(),
      });
    }
    for (const job of [health.maintenance, health.reconciliation].filter(Boolean)) {
      await alerts.observe({
        eventKey: `maintenance.job-failure:${job.jobName}`,
        severity: job.status === "failed" ? "critical" : "ok",
        message: job.status === "failed"
          ? `${job.jobName} failed: ${job.lastError || "unknown failure"}`
          : `${job.jobName} recovered and is no longer failed.`,
        details: { jobName: job.jobName, status: job.status, lastError: job.lastError || null },
        settings,
        now: this.now(),
      });
    }
    const runs = await getStorageCleanupOverview({ executor: pool });
    const latestExecution = runs.find((run) => run.mode === "execute");
    if (latestExecution) {
      await alerts.observe({
        eventKey: "maintenance.job-failure:storage-cleanup",
        severity: latestExecution.status === "failed" ? "critical" : "ok",
        message: latestExecution.status === "failed"
          ? `Storage cleanup failed: ${latestExecution.lastError || "unknown failure"}`
          : "Storage cleanup is no longer failed.",
        details: { runId: latestExecution.id, status: latestExecution.status, lastError: latestExecution.lastError },
        settings,
        now: this.now(),
      });
    }
    await recordMaintenanceHeartbeat({
      executor: pool,
      runtimeName: "storage-monitor",
      workerId: this.workerId,
      now: this.now(),
    });
    let cleanup;
    try {
      cleanup = await runScheduledStorageCleanup({
        pool,
        storagePath: fileStorage.baseDir,
        now: this.now,
      });
    } catch (error) {
      cleanup = { status: "failed", automatic: true, error: String(error?.message || error).slice(0, 1000) };
      this.logger?.error?.("Automatic storage cleanup failed; further runs are fail-closed", { error: cleanup.error });
      await alerts.observe({
        eventKey: "maintenance.job-failure:storage-cleanup",
        severity: "critical",
        message: `Automatic storage cleanup failed; further runs are fail-closed: ${cleanup.error}`,
        details: { status: "failed", automatic: true, lastError: cleanup.error },
        settings,
        now: this.now(),
      });
    }
    return { severity, liveness, cleanup };
  }

  runOnce() {
    if (this.currentRun) return this.currentRun;
    const run = this.runBatch().finally(() => { if (this.currentRun === run) this.currentRun = null; });
    this.currentRun = run;
    return run;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.stopped = false;
    const loop = (async () => {
      while (!this.stopped) {
        let delaySeconds = 3600;
        try {
          const pool = await this.database();
          const settings = await this.loadSettings({ executor: pool });
          delaySeconds = settings.checkIntervalSeconds;
          await this.runOnce();
        } catch (error) {
          delaySeconds = Math.min(delaySeconds, this.failureRetrySeconds);
          this.logger?.error?.("Storage maintenance monitor failed", { error: String(error?.message || error).slice(0, 1000) });
        }
        if (this.stopped) break;
        this.waitController = new AbortController();
        try { await sleep(delaySeconds * 1000, this.waitController.signal); }
        catch (error) { if (error?.name !== "AbortError") throw error; }
        finally { this.waitController = null; }
      }
    })().finally(() => { if (this.loopPromise === loop) this.loopPromise = null; });
    this.loopPromise = loop;
    return loop;
  }

  async stop() {
    this.stopped = true;
    this.waitController?.abort();
    await Promise.allSettled([this.currentRun, this.loopPromise].filter(Boolean));
  }
}
