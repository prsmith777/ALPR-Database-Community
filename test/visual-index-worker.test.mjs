import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVisualIndexPace,
  normalizeVisualIndexSettings,
  visualIndexPace,
} from "../lib/visual-index-settings.mjs";
import { VisualIndexWorker } from "../lib/visual-index-worker.mjs";
import {
  getVisualIndexRuntimeStatus,
  probeVisualIndexSafety,
  startVisualIndexRuntime,
  visualIndexRuntimeInternals,
  wakeVisualIndexWorker,
} from "../lib/visual-index-runtime.mjs";
import { startVisualIndexRuntimeWithRetry } from "../lib/visual-index-startup.mjs";

test("visual index settings are bounded and expose stable pace presets", () => {
  assert.deepEqual(normalizeVisualIndexSettings({}), {
    enabled: true,
    paused: false,
    batchSize: 20,
    intervalSeconds: 30,
    minimumFreeDiskGb: 5,
    maximumLoadPercent: 90,
  });
  const fast = applyVisualIndexPace({ paused: true }, "fast");
  assert.equal(fast.paused, true);
  assert.equal(fast.batchSize, 40);
  assert.equal(fast.intervalSeconds, 15);
  assert.equal(visualIndexPace(fast), "fast");
  assert.equal(normalizeVisualIndexSettings({ batchSize: 100 }).batchSize, 50);
});

test("one automatic worker batch records progress, throughput, and an ETA", async () => {
  const statuses = [
    { ready: 60, pending: 40, retryable: 0 },
    { ready: 80, pending: 20, retryable: 0 },
  ];
  let batchLimit = null;
  const times = [
    new Date("2026-07-23T12:00:00.000Z"),
    new Date("2026-07-23T12:00:10.000Z"),
  ];
  const worker = new VisualIndexWorker({
    service: {
      async getStatus() { return statuses[0]; },
      async indexBatch({ limit }) {
        batchLimit = limit;
        return { processed: 20, succeeded: 20, failed: 0, busy: false, status: statuses[1] };
      },
    },
    loadSettings: async () => ({ visualIndex: { batchSize: 20, intervalSeconds: 30 } }),
    safetyProbe: async () => ({ safe: true }),
    now: () => times.shift(),
    logger: {},
  });

  const result = await worker.runOnce();
  assert.equal(result.delayMs, 30_000);
  assert.equal(batchLimit, 20);
  assert.equal(worker.snapshot().lastBatch.succeeded, 20);
  assert.equal(worker.snapshot().itemsPerMinute, 30);
  assert.equal(worker.snapshot().estimatedSecondsRemaining, 40);
  assert.equal(worker.snapshot().phase, "sleeping");
});

test("the paced worker drains historical direction work after image indexing", async () => {
  let directionLimit = null;
  let indexCalls = 0;
  const times = [
    new Date("2026-07-23T12:00:00.000Z"),
    new Date("2026-07-23T12:00:05.000Z"),
  ];
  const worker = new VisualIndexWorker({
    service: {
      async getStatus() {
        return { pending: 0, retryable: 0, direction: { pending: 20 } };
      },
      async indexBatch() { indexCalls += 1; return {}; },
      async backfillDirectionBatch({ limit }) {
        directionLimit = limit;
        return { processed: 20, succeeded: 19, failed: 1, busy: false };
      },
    },
    loadSettings: async () => ({ visualIndex: { batchSize: 20, intervalSeconds: 30 } }),
    now: () => times.shift(),
    logger: {},
  });

  await worker.runOnce();

  assert.equal(indexCalls, 0);
  assert.equal(directionLimit, 20);
  assert.equal(worker.snapshot().lastBatch.kind, "vehicle-direction");
  assert.equal(worker.snapshot().lastBatch.succeeded, 19);
});

test("image indexing and historical directions alternate when both have a backlog", async () => {
  let indexCalls = 0;
  let directionCalls = 0;
  const times = [
    new Date("2026-07-23T12:00:00.000Z"),
    new Date("2026-07-23T12:00:01.000Z"),
    new Date("2026-07-23T12:00:02.000Z"),
    new Date("2026-07-23T12:00:03.000Z"),
  ];
  const service = {
    async getStatus() {
      return { pending: 40, retryable: 0, direction: { pending: 40 } };
    },
    async indexBatch() {
      indexCalls += 1;
      return { processed: 20, succeeded: 20, failed: 0, busy: false };
    },
    async backfillDirectionBatch() {
      directionCalls += 1;
      return { processed: 20, succeeded: 20, failed: 0, busy: false };
    },
  };
  const worker = new VisualIndexWorker({
    service,
    loadSettings: async () => ({ visualIndex: { batchSize: 20, intervalSeconds: 30 } }),
    now: () => times.shift(),
    logger: {},
  });

  await worker.runOnce();
  assert.equal(worker.snapshot().lastBatch.kind, "vehicle-direction");
  await worker.runOnce();
  assert.equal(worker.snapshot().lastBatch.kind, "visual-index");
  assert.equal(directionCalls, 1);
  assert.equal(indexCalls, 1);
});

test("a paused historical direction queue does not keep the worker busy", async () => {
  let directionCalls = 0;
  const service = {
    async getStatus() {
      return {
        pending: 0,
        retryable: 0,
        direction: { pending: 25, actionablePending: 0, reevaluationPaused: true },
      };
    },
    async indexBatch() {
      return { processed: 0, succeeded: 0, failed: 0, busy: false };
    },
    async backfillDirectionBatch() {
      directionCalls += 1;
      return { processed: 0, succeeded: 0, failed: 0, busy: false };
    },
  };
  const worker = new VisualIndexWorker({
    service,
    loadSettings: async () => ({ visualIndex: { batchSize: 20, intervalSeconds: 30 } }),
    logger: {},
  });

  await worker.runOnce();

  assert.equal(directionCalls, 0);
  assert.equal(worker.snapshot().phase, "idle");
});

test("pause and safety thresholds prevent indexing without losing backlog state", async () => {
  let indexCalls = 0;
  const service = {
    async getStatus() { return { ready: 1, pending: 99, retryable: 0 }; },
    async indexBatch() { indexCalls += 1; return {}; },
  };
  const paused = new VisualIndexWorker({
    service,
    loadSettings: async () => ({ paused: true }),
    logger: {},
  });
  await paused.runOnce();
  assert.equal(paused.snapshot().phase, "paused");

  const throttled = new VisualIndexWorker({
    service,
    loadSettings: async () => ({}),
    safetyProbe: async () => ({ safe: false, reason: "Only 2.0 GB of free storage remains" }),
    logger: {},
  });
  const result = await throttled.runOnce();
  assert.equal(result.delayMs, 60_000);
  assert.equal(throttled.snapshot().phase, "throttled");
  assert.match(throttled.snapshot().safetyReason, /free storage/);
  assert.equal(indexCalls, 0);
});

test("disk and normalized CPU load probes enforce configured safety limits", async () => {
  const healthy = await probeVisualIndexSafety({
    storagePath: "/storage",
    minimumFreeDiskGb: 5,
    maximumLoadPercent: 90,
    statfsFn: async () => ({ bavail: 10 * 1024, bsize: 1024 ** 2 }),
    loadAverage: () => [2],
    cpuCount: () => 4,
  });
  assert.equal(healthy.safe, true);
  assert.equal(healthy.availableDiskGb, 10);
  assert.equal(healthy.loadPercent, 50);

  const lowDisk = await probeVisualIndexSafety({
    storagePath: "/storage",
    minimumFreeDiskGb: 5,
    statfsFn: async () => ({ bavail: 2 * 1024, bsize: 1024 ** 2 }),
    loadAverage: () => [0],
    cpuCount: () => 4,
  });
  assert.equal(lowDisk.safe, false);
  assert.match(lowDisk.reason, /2\.0 GB/);

  const highLoad = await probeVisualIndexSafety({
    storagePath: "/storage",
    maximumLoadPercent: 75,
    statfsFn: async () => ({ bavail: 10 * 1024, bsize: 1024 ** 2 }),
    loadAverage: () => [4],
    cpuCount: () => 4,
  });
  assert.equal(highLoad.safe, false);
  assert.match(highLoad.reason, /100%/);
});

test("runtime initialization is singleton, visible, and wakeable", async () => {
  const stateHost = {};
  let starts = 0;
  let wakes = 0;
  const worker = {
    running: false,
    stopped: false,
    start() {
      starts += 1;
      this.running = true;
      return new Promise(() => {});
    },
    wake() { wakes += 1; },
    snapshot() { return { running: this.running, phase: "sleeping" }; },
  };
  const options = {
    stateHost,
    loadDependencies: async () => ({}),
    workerFactory: () => worker,
  };
  const [first, second] = await Promise.all([
    startVisualIndexRuntime(options),
    startVisualIndexRuntime(options),
  ]);
  assert.equal(first, second);
  assert.equal(starts, 1);
  assert.equal(getVisualIndexRuntimeStatus({ stateHost }).phase, "sleeping");
  assert.equal(wakeVisualIndexWorker({ stateHost }), true);
  assert.equal(wakes, 1);
  assert.equal(visualIndexRuntimeInternals.getRuntimeState(stateHost).worker, worker);
});

test("temporary visual-index startup failures schedule a retry", async () => {
  const stateHost = {};
  const timers = [];
  let attempts = 0;
  const result = await startVisualIndexRuntimeWithRetry({
    stateHost,
    retryDelayMs: 1234,
    schedule(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel() {},
    logger: {},
    async startRuntime() {
      attempts += 1;
      if (attempts === 1) throw new Error("database starting");
    },
  });
  assert.equal(result.status, "retry-scheduled");
  assert.equal(timers[0].delay, 1234);
  const retry = await timers[0].callback();
  assert.equal(retry.status, "started");
  assert.equal(attempts, 2);
});
