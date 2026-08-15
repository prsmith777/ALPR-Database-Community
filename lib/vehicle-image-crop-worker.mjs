function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Vehicle crop worker failed")
      .trim().slice(0, 500),
  };
}

function sleep(milliseconds, signal) {
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

export class VehicleImageCropWorker {
  constructor({ service, logger = console, wait = sleep, now = () => new Date() } = {}) {
    if (!service || typeof service.processBatch !== "function") {
      throw new Error("Vehicle crop worker requires a campaign service");
    }
    this.service = service;
    this.logger = logger;
    this.wait = wait;
    this.now = now;
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.startedAt = null;
    this.lastBatch = null;
    this.lastError = null;
    this.phase = "starting";
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

  wake() { this.waitController?.abort(); }

  async runOnce() {
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
    this.phase = result.phase || "idle";
    return result.processed > 0 ? 100 : result.runId ? 2_000 : 30_000;
  }

  start() {
    if (this.stopped) return Promise.reject(new Error("Vehicle crop worker has stopped"));
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.startedAt = this.now().toISOString();
    this.loopPromise = (async () => {
      while (!this.stopped) {
        let delay = 30_000;
        try {
          delay = await this.runOnce();
        } catch (error) {
          this.phase = "error";
          this.lastError = safeError(error);
          this.logger?.error?.("Canonical Overview vehicle crop worker failed", {
            error: this.lastError,
          });
        }
        if (!this.stopped) {
          this.waitController = new AbortController();
          try { await this.wait(delay, this.waitController.signal); }
          finally { this.waitController = null; }
        }
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

export const vehicleImageCropWorkerInternals = Object.freeze({ safeError, sleep });
