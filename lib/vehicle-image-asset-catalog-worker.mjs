function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Canonical Overview catalog worker failed")
      .trim().slice(0, 500),
  };
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class VehicleImageAssetCatalogWorker {
  constructor({ service, logger = console, sleep = defaultSleep, now = () => new Date() } = {}) {
    if (!service || typeof service.processBatch !== "function") {
      throw new Error("Canonical Overview catalog worker requires a campaign service");
    }
    this.service = service;
    this.logger = logger;
    this.sleep = sleep;
    this.now = now;
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.phase = "starting";
    this.startedAt = null;
    this.lastBatch = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      startedAt: this.startedAt,
      lastBatch: this.lastBatch,
      lastError: this.lastError,
    };
  }

  async runOnce() {
    this.phase = "checking";
    const result = await this.service.processBatch({ limit: 5 });
    this.lastBatch = {
      at: this.now().toISOString(),
      processed: Number(result.processed || 0),
      succeeded: Number(result.succeeded || 0),
      failed: Number(result.failed || 0),
      runId: result.runId || null,
      phase: result.phase || null,
    };
    this.lastError = null;
    this.phase = result.processed > 0 ? (result.phase || "working") : "idle";
    return { delayMs: result.processed > 0 ? 100 : result.status === "idle" ? 30_000 : 2_000 };
  }

  async wait(delayMs) {
    this.waitController = new AbortController();
    try {
      await this.sleep(delayMs, this.waitController.signal);
    } finally {
      this.waitController = null;
    }
  }

  wake() {
    this.waitController?.abort();
  }

  start() {
    if (this.stopped) return Promise.reject(new Error("Canonical Overview catalog worker has stopped"));
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.startedAt = this.now().toISOString();
    this.loopPromise = (async () => {
      while (!this.stopped) {
        let delayMs = 30_000;
        try {
          ({ delayMs } = await this.runOnce());
        } catch (error) {
          this.phase = "error";
          this.lastError = safeError(error);
          this.logger?.error?.("Canonical Overview catalog worker batch failed", {
            error: this.lastError,
          });
          delayMs = 30_000;
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

export const vehicleImageAssetCatalogWorkerInternals = Object.freeze({ defaultSleep, safeError });
