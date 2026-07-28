import assert from "node:assert/strict";
import test from "node:test";

import {
  BlueIrisVehicleFrameQueue,
  blueIrisVehicleFrameQueueInternals,
} from "../lib/blue-iris-vehicle-frame-queue.mjs";
import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";
import { BlueIrisVehicleFrameWorker } from "../lib/blue-iris-vehicle-frame-worker.mjs";
import { startBlueIrisVehicleFrameRuntimeWithRetry } from "../lib/blue-iris-vehicle-frame-startup.mjs";

const configured = {
  blueiris: {
    host: "blueiris.local:81",
    username: "alpr",
    password: "secret",
  },
};

test("automatic vehicle-frame queue maps display camera names to Blue Iris IDs", async () => {
  const calls = [];
  const reads = [{
    id: 81,
    plate_number: "ERGW43",
    camera_name: "Street LPR 2",
    timestamp: "2026-07-22T17:46:50.000Z",
    vehicle_image_path: null,
  }];
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNext(options) { calls.push(["claim", options]); return reads.shift() || null; },
      async markFailed() { assert.fail("mapped camera must not fail"); },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [{ id: "Cam146", name: "Street LPR 2" }] };
      },
    }),
    serviceFactory: () => ({
      async processRead(input) {
        calls.push(["process", input]);
        return { status: "ready", readId: input.read.id };
      },
    }),
  });

  const result = await queue.processBatch({ limit: 2 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(calls[0][1].includeHistorical, false);
  assert.equal(calls[1][1].camera, "Cam146");
  assert.equal(calls[1][1].alreadyClaimed, true);
});

test("unconfigured Blue Iris leaves queued reads untouched", async () => {
  let claimed = false;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNext() { claimed = true; return null; },
    },
    fileStorage: {},
    loadConfig: async () => ({ blueiris: { host: "Your Blue Iris Hostname or IP address" } }),
  });
  const result = await queue.processBatch();
  assert.equal(result.configured, false);
  assert.equal(claimed, false);
});

test("missing camera mappings receive an explicit terminal status", async () => {
  let failure = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: false }; },
      async claimNext() {
        return { id: 82, camera_name: "Retired LPR", timestamp: "2026-07-22T17:46:50Z" };
      },
      async markFailed(id, input) { failure = { id, ...input }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({ async testConnection() { return { cameras: [] }; } }),
  });
  const result = await queue.processBatch();
  assert.equal(result.results[0].errorCode, "CAMERA_NOT_MAPPED");
  assert.deepEqual(failure, {
    id: 82,
    status: "unavailable",
    errorCode: "CAMERA_NOT_MAPPED",
    retryable: false,
  });
});

test("worker drains queued reads quickly and sleeps when idle", async () => {
  const batches = [
    { configured: true, processed: 1, succeeded: 1, failed: 0 },
    { configured: true, processed: 0, succeeded: 0, failed: 0 },
  ];
  const worker = new BlueIrisVehicleFrameWorker({
    queue: { async processBatch() { return batches.shift(); } },
    intervalMs: 5_000,
  });
  assert.equal((await worker.runOnce()).processed, 1);
  assert.equal(worker.phase, "sleeping");
  assert.equal((await worker.runOnce()).processed, 0);
  assert.equal(worker.phase, "idle");
});

test("camera matching and configured checks normalize safely", () => {
  assert.equal(blueIrisVehicleFrameQueueInternals.normalizedCameraKey(" Street LPR 2 "), "street lpr 2");
  assert.equal(blueIrisVehicleFrameQueueInternals.blueIrisConfigured(configured), true);
  assert.equal(blueIrisVehicleFrameQueueInternals.blueIrisConfigured({ blueiris: {} }), false);
});

test("vehicle-frame startup schedules a retry without blocking application startup", async () => {
  const stateHost = {};
  let scheduled = null;
  const result = await startBlueIrisVehicleFrameRuntimeWithRetry({
    stateHost,
    retryDelayMs: 1_000,
    startRuntime: async () => { throw new Error("database is starting"); },
    logger: { error() {} },
    schedule(callback, delay) {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
  });
  assert.equal(result.status, "retry-scheduled");
  assert.equal(scheduled.delay, 1_000);
  assert.equal(typeof scheduled.callback, "function");
});

test("historical claims include only explicitly queued work", async () => {
  let statement = "";
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statement = sql;
      return { rows: [] };
    },
  });
  await repository.claimNext({ includeHistorical: true });
  assert.doesNotMatch(statement, /vehicle_image_status IS NULL/);
  assert.match(statement, /vehicle_image_queue_kind[^\n]*historical/);
  assert.match(statement, /FOR UPDATE SKIP LOCKED/);
  assert.match(statement, /vehicle_image_status = 'processing'/);
});
