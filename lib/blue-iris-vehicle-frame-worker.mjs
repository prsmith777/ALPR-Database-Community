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

export class BlueIrisVehicleFrameWorker {
  constructor({ queue, logger = console, intervalMs = 5_000 } = {}) {
    if (!queue || typeof queue.processBatch !== "function") {
      throw new Error("Blue Iris vehicle-frame worker requires a queue");
    }
    this.queue = queue;
    this.logger = logger;
    this.intervalMs = Math.max(5_000, Number(intervalMs) || 5_000);
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.phase = "starting";
    this.lastBatch = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      lastBatch: this.lastBatch,
      lastError: this.lastError,
    };
  }

  async runOnce() {
    this.phase = "processing";
    try {
      const result = await this.queue.processBatch({ limit: 1 });
      this.lastBatch = { ...result, at: new Date().toISOString() };
      this.lastError = null;
      this.phase = result.busy
        ? "busy"
        : result.configured === false
          ? "not-configured"
          : result.processed > 0 ? "sleeping" : "idle";
      return result;
    } catch (error) {
      this.lastError = {
        code: String(error?.code || ""),
        message: String(error?.message || error).slice(0, 1000),
      };
      this.phase = "error";
      return { processed: 0, succeeded: 0, failed: 1, error: this.lastError };
    }
  }

  wake() {
    this.waitController?.abort();
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.stopped = false;
    this.loopPromise = (async () => {
      while (!this.stopped) {
        const result = await this.runOnce();
        const delay = result.processed > 0 ? 1_000 : this.intervalMs;
        if (this.stopped) break;
        this.waitController = new AbortController();
        await sleep(delay, this.waitController.signal);
        this.waitController = null;
      }
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
