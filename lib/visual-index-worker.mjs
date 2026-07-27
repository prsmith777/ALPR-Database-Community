import { normalizeVisualIndexSettings } from "./visual-index-settings.mjs";

function safeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: String(error?.code || ""),
    message: String(error?.message || error || "Unknown visual index worker error")
      .trim()
      .slice(0, 1000),
  };
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isoTime(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nextMaintenanceKind({ lastKind, direction, vehicleType, vehicleColor }) {
  const order = ["vehicle-direction", "vehicle-type", "vehicle-color"];
  const available = new Set([
    ...(direction ? ["vehicle-direction"] : []),
    ...(vehicleType ? ["vehicle-type"] : []),
    ...(vehicleColor ? ["vehicle-color"] : []),
  ]);
  if (available.size === 0) return null;
  const lastIndex = order.indexOf(lastKind);
  for (let offset = 1; offset <= order.length; offset += 1) {
    const candidate = order[(Math.max(lastIndex, -1) + offset) % order.length];
    if (available.has(candidate)) return candidate;
  }
  return null;
}

export class VisualIndexWorker {
  constructor({
    service,
    loadSettings,
    safetyProbe = async () => ({ safe: true, reason: "" }),
    logger = console,
    now = () => new Date(),
    sleep = defaultSleep,
  } = {}) {
    if (!service || typeof service.indexBatch !== "function" || typeof service.getStatus !== "function") {
      throw new Error("Visual index worker requires a capture asset service");
    }
    if (typeof loadSettings !== "function") {
      throw new Error("Visual index worker requires a settings loader");
    }
    if (typeof safetyProbe !== "function" || typeof now !== "function" || typeof sleep !== "function") {
      throw new Error("Visual index worker dependencies must be functions");
    }

    this.service = service;
    this.loadSettings = loadSettings;
    this.safetyProbe = safetyProbe;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.phase = "starting";
    this.settings = normalizeVisualIndexSettings();
    this.startedAt = null;
    this.nextRunAt = null;
    this.lastBatch = null;
    this.lastError = null;
    this.safetyReason = "";
    this.itemsPerMinute = null;
    this.status = null;
  }

  async readSettings() {
    const loaded = await this.loadSettings();
    this.settings = normalizeVisualIndexSettings(loaded?.visualIndex ?? loaded);
    return this.settings;
  }

  estimateSeconds(status = this.status) {
    if (!status || !this.itemsPerMinute || this.itemsPerMinute <= 0) return null;
    const remaining = Number(status.pending || 0)
      + Number(status.retryable || 0)
      + Number(status.direction?.pending || 0)
      + Number(status.attributes?.vehicleTypePending || 0)
      + Number(status.attributes?.vehicleColorPending || 0);
    return Math.max(0, Math.round(remaining / this.itemsPerMinute * 60));
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      settings: this.settings,
      startedAt: this.startedAt,
      nextRunAt: this.nextRunAt,
      lastBatch: this.lastBatch,
      lastError: this.lastError,
      safetyReason: this.safetyReason,
      itemsPerMinute: this.itemsPerMinute === null
        ? null
        : Number(this.itemsPerMinute.toFixed(1)),
      estimatedSecondsRemaining: this.estimateSeconds(),
    };
  }

  async runOnce() {
    const settings = await this.readSettings();
    this.status = await this.service.getStatus();
    const delayMs = settings.intervalSeconds * 1000;

    if (!settings.enabled) {
      this.phase = "disabled";
      this.safetyReason = "";
      return { delayMs };
    }
    if (settings.paused) {
      this.phase = "paused";
      this.safetyReason = "";
      return { delayMs };
    }

    const safety = await this.safetyProbe(settings);
    if (!safety?.safe) {
      this.phase = "throttled";
      this.safetyReason = String(safety?.reason || "System safety threshold reached");
      return { delayMs: Math.max(delayMs, 60_000) };
    }
    this.safetyReason = "";

    const remaining = Number(this.status.pending || 0) + Number(this.status.retryable || 0);
    const directionRemaining = Number(
      this.status.direction?.actionablePending ?? this.status.direction?.pending ?? 0
    );
    const vehicleTypeRemaining = Number(this.status.attributes?.vehicleTypePending || 0);
    const vehicleColorRemaining = Number(this.status.attributes?.vehicleColorPending || 0);
    if (
      remaining === 0
      && directionRemaining === 0
      && vehicleTypeRemaining === 0
      && vehicleColorRemaining === 0
    ) {
      this.phase = "idle";
      return { delayMs };
    }

    const canProcessDirections = directionRemaining > 0
      && typeof this.service.backfillDirectionBatch === "function";
    const canProcessVehicleTypes = remaining === 0
      && vehicleTypeRemaining > 0
      && typeof this.service.analyzeRecentVehicleTypes === "function";
    const canProcessVehicleColors = remaining === 0
      && vehicleColorRemaining > 0
      && typeof this.service.analyzeRecentVehicleColors === "function";
    const maintenanceKind = remaining === 0
      ? nextMaintenanceKind({
          lastKind: this.lastBatch?.kind,
          direction: canProcessDirections,
          vehicleType: canProcessVehicleTypes,
          vehicleColor: canProcessVehicleColors,
        })
      : null;
    const processingDirections = remaining > 0
      ? canProcessDirections && this.lastBatch?.kind !== "vehicle-direction"
      : maintenanceKind === "vehicle-direction";
    const processingVehicleTypes = maintenanceKind === "vehicle-type";
    const processingVehicleColors = maintenanceKind === "vehicle-color";
    this.phase = processingDirections
      ? "direction-backfill"
      : processingVehicleTypes
        ? "vehicle-type-backfill"
        : processingVehicleColors
          ? "vehicle-color-backfill"
        : "indexing";
    const started = this.now();
    const result = processingDirections
      ? await this.service.backfillDirectionBatch({ limit: settings.batchSize })
      : processingVehicleTypes
        ? await this.service.analyzeRecentVehicleTypes(settings.batchSize)
        : processingVehicleColors
          ? await this.service.analyzeRecentVehicleColors(settings.batchSize)
        : await this.service.indexBatch({ limit: settings.batchSize });
    const finished = this.now();
    const elapsedMs = Math.max(1, finished.getTime() - started.getTime());
    const succeeded = Number(result.succeeded || 0);
    const cycleMs = elapsedMs + settings.intervalSeconds * 1000;
    const instantaneousRate = succeeded > 0 ? succeeded / cycleMs * 60_000 : null;
    if (instantaneousRate) {
      this.itemsPerMinute = this.itemsPerMinute === null
        ? instantaneousRate
        : this.itemsPerMinute * 0.75 + instantaneousRate * 0.25;
    }
    this.status = processingDirections || processingVehicleTypes || processingVehicleColors
      ? await this.service.getStatus()
      : result.status || await this.service.getStatus();
    this.lastBatch = {
      kind: processingDirections
        ? "vehicle-direction"
        : processingVehicleTypes
          ? "vehicle-type"
          : processingVehicleColors
            ? "vehicle-color"
          : "visual-index",
      at: isoTime(finished),
      durationMs: elapsedMs,
      processed: Number(result.processed || 0),
      succeeded,
      failed: Number(result.failed || 0),
      busy: result.busy === true,
    };
    this.lastError = null;
    this.phase = result.busy ? "waiting" : "sleeping";

    this.logger?.info?.("Visual intelligence worker batch complete", {
      ...this.lastBatch,
      pending: Number(this.status.pending || 0),
      retryable: Number(this.status.retryable || 0),
    });
    return { delayMs };
  }

  async wait(delayMs) {
    this.nextRunAt = isoTime(this.now().getTime() + delayMs);
    this.waitController = new AbortController();
    try {
      await this.sleep(delayMs, this.waitController.signal);
    } finally {
      this.waitController = null;
      this.nextRunAt = null;
    }
  }

  wake() {
    this.waitController?.abort();
  }

  start() {
    if (this.stopped) return Promise.reject(new Error("Visual index worker has been stopped"));
    if (this.loopPromise) return this.loopPromise;

    this.running = true;
    this.startedAt = isoTime(this.now());
    this.loopPromise = (async () => {
      while (!this.stopped) {
        let delayMs = this.settings.intervalSeconds * 1000;
        try {
          ({ delayMs } = await this.runOnce());
        } catch (error) {
          this.phase = "error";
          this.lastError = safeError(error);
          this.logger?.error?.("Visual index worker batch failed", { error: this.lastError });
          delayMs = Math.max(delayMs, 60_000);
        }
        if (!this.stopped) await this.wait(delayMs);
      }
      this.running = false;
      this.phase = "stopped";
    })().finally(() => {
      this.running = false;
      this.loopPromise = null;
    });
    return this.loopPromise;
  }

  async stop() {
    this.stopped = true;
    this.wake();
    await this.loopPromise;
  }
}

export const visualIndexWorkerInternals = Object.freeze({
  defaultSleep,
  safeError,
});
