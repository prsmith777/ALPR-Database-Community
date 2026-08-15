function safeError(error) {
  return {
    code: String(error?.code || "").trim().slice(0, 80),
    message: String(error?.message || error || "Shadow vehicle event worker failed")
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

export class VehicleEventShadowWorker {
  constructor({ service, logger = console, sleep = defaultSleep, now = () => new Date() } = {}) {
    if (!service || typeof service.processBatch !== "function") {
      throw new Error("Shadow vehicle event worker requires a service");
    }
    this.service = service;
    this.logger = logger;
    this.sleep = sleep;
    this.now = now;
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.startedAt = null;
    this.lastBatch = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastBatch: this.lastBatch,
      lastError: this.lastError,
    };
  }

  async runOnce() {
    const result = await this.service.processBatch();
    this.lastBatch = { at: this.now().toISOString(), ...result };
    this.lastError = null;
    return { delayMs: result.processed > 0 || result.retired > 0 ? 250 : 30_000 };
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
    if (this.stopped) return Promise.reject(new Error("Shadow vehicle event worker has stopped"));
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.startedAt = this.now().toISOString();
    this.loopPromise = (async () => {
      while (!this.stopped) {
        let delayMs = 30_000;
        try {
          ({ delayMs } = await this.runOnce());
        } catch (error) {
          this.lastError = safeError(error);
          this.logger?.error?.("Shadow vehicle event worker batch failed", {
            error: this.lastError,
          });
        }
        if (!this.stopped) await this.wait(delayMs);
      }
      this.running = false;
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

export const vehicleEventShadowWorkerInternals = Object.freeze({ defaultSleep, safeError });
