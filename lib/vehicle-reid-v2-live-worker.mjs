function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Live ReID worker failed").trim().slice(0, 500),
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

export class VehicleReidV2LiveWorker {
  constructor({ service, logger = console, wait = sleep, now = () => new Date() } = {}) {
    if (!service || typeof service.processBatch !== "function") {
      throw new TypeError("VehicleReidV2LiveWorker requires a live ReID service.");
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
    this.phase = "starting";
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

  wake() {
    this.waitController?.abort();
  }

  async runOnce() {
    const result = await this.service.processBatch({ limit: 5 });
    this.lastBatch = {
      at: this.now().toISOString(),
      mode: result.mode || null,
      discovered: Number(result.discovered || 0),
      processed: Number(result.processed || 0),
      succeeded: Number(result.succeeded || 0),
      failed: Number(result.failed || 0),
    };
    this.lastError = null;
    this.phase = result.mode !== "v2_primary"
      ? "standby"
      : result.processed > 0 || result.discovered > 0 ? "working" : "idle";
    if (result.processed > 0) return 250;
    if (result.discovered > 0) return 2_000;
    return result.mode === "v2_primary" ? 10_000 : 30_000;
  }

  start() {
    if (this.stopped) return Promise.reject(new Error("Live ReID worker has stopped."));
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
          this.logger?.error?.("Authoritative ReID live worker failed", {
            error: this.lastError,
          });
        }
        if (!this.stopped) {
          this.waitController = new AbortController();
          try {
            await this.wait(delay, this.waitController.signal);
          } finally {
            this.waitController = null;
          }
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

export const vehicleReidV2LiveWorkerInternals = Object.freeze({ safeError, sleep });
