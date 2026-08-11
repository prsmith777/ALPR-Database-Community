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

function nextWorkerDelay(result, intervalMs, nowMs = Date.now()) {
  const backoffUntilMs = Date.parse(String(result?.backoffUntil || ""));
  if (Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs) {
    return Math.max(intervalMs, backoffUntilMs - nowMs);
  }
  if (result?.backoff === true) {
    return Math.max(intervalMs, Number(result?.backoffMs) || 30_000);
  }
  return result?.processed > 0 ? 1_000 : intervalMs;
}

export class BlueIrisVehicleFrameWorker {
  constructor({ queue, logger = console, intervalMs = 5_000, now = () => Date.now() } = {}) {
    if (!queue || typeof queue.processBatch !== "function") {
      throw new Error("Blue Iris vehicle-frame worker requires a queue");
    }
    this.queue = queue;
    this.logger = logger;
    this.intervalMs = Math.max(5_000, Number(intervalMs) || 5_000);
    this.now = now;
    this.running = false;
    this.stopped = false;
    this.loopPromise = null;
    this.waitController = null;
    this.phase = "starting";
    this.lastBatch = null;
    this.lastError = null;
    this.backoffUntilMs = 0;
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      lastBatch: this.lastBatch,
      lastError: this.lastError,
      backoffUntil: this.backoffUntilMs > this.now()
        ? new Date(this.backoffUntilMs).toISOString()
        : null,
    };
  }

  async runOnce() {
    const nowMs = this.now();
    if (this.backoffUntilMs > nowMs) {
      this.phase = "backoff";
      return {
        configured: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        backoff: true,
        backoffUntil: new Date(this.backoffUntilMs).toISOString(),
      };
    }
    this.backoffUntilMs = 0;
    this.phase = "processing";
    try {
      const result = await this.queue.processBatch({ limit: 1 });
      this.lastBatch = { ...result, at: new Date().toISOString() };
      this.lastError = null;
      if (result.backoff === true) {
        const delay = nextWorkerDelay(result, this.intervalMs, this.now());
        this.backoffUntilMs = this.now() + delay;
        result.backoffUntil = new Date(this.backoffUntilMs).toISOString();
        this.phase = "backoff";
      } else {
        this.phase = result.busy
          ? "busy"
          : result.configured === false
            ? "not-configured"
            : result.processed > 0 ? "sleeping" : "idle";
      }
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

  wake({ force = false } = {}) {
    if (!force && this.backoffUntilMs > this.now()) return false;
    this.waitController?.abort();
    return true;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.stopped = false;
    this.loopPromise = (async () => {
      while (!this.stopped) {
        const result = await this.runOnce();
        const delay = nextWorkerDelay(result, this.intervalMs, this.now());
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
    this.wake({ force: true });
    await this.loopPromise;
  }
}

export const blueIrisVehicleFrameWorkerInternals = Object.freeze({ nextWorkerDelay });
