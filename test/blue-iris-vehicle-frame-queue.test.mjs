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

test("existing vehicle views can be queued for reevaluation without deleting their current image", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] };
    },
  });

  const result = await repository.queueHistorical({ replaceExisting: true });
  assert.equal(result.queued, 2);
  assert.deepEqual(parameters, [null, null, null, true]);
  assert.match(statement, /\$4::boolean = TRUE AND vehicle_image_path IS NOT NULL/);
  assert.doesNotMatch(statement, /SET[\s\S]*vehicle_image_path\s*=/);
});

test("pending historical work can be cancelled by camera and date without touching saved images", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rowCount: 21_416, rows: [] };
    },
  });
  const result = await repository.cancelHistorical({
    cameraName: "Street LPR 2",
    startDate: "2026-07-01T06:00:00.000Z",
    endDate: "2026-08-01T05:59:59.999Z",
  });
  assert.equal(result.cancelled, 21_416);
  assert.deepEqual(parameters, [
    "Street LPR 2",
    "2026-07-01T06:00:00.000Z",
    "2026-08-01T05:59:59.999Z",
  ]);
  assert.match(statement, /vehicle_image_queue_kind = 'historical'/);
  assert.match(statement, /vehicle_image_status IN \('pending', 'failed'\)/);
  assert.match(statement, /WHEN vehicle_image_path IS NULL THEN NULL/);
  assert.match(statement, /ELSE 'ready'/);
  assert.doesNotMatch(statement, /vehicle_image_path\s*=/);
});

test("an administrator can explicitly retry a failed or unavailable read", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return {
        rows: [{
          id: 82,
          vehicle_image_status: "pending",
          vehicle_image_queue_kind: "manual",
          vehicle_image_attempt_count: 0,
          vehicle_image_retryable: true,
        }],
      };
    },
  });

  const result = await repository.retryRead(82);
  assert.equal(result.vehicle_image_status, "pending");
  assert.deepEqual(parameters, [82]);
  assert.match(statement, /vehicle_image_queue_kind = 'manual'/);
  assert.match(statement, /vehicle_image_attempt_count = 0/);
  assert.match(statement, /vehicle_image_status IN \('failed', 'unavailable'\)/);
  assert.match(statement, /vehicle_image_path IS NULL/);
});

test("the selected vehicle frame persists bounded quality and tracking diagnostics", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [] };
    },
  });
  const selectionMetadata = {
    algorithm: "blue-iris-vehicle-frame-v2",
    selectedOffsetMs: 2500,
    trackedCount: 7,
    scoreBreakdown: { completenessTier: 2, sharpness: 0.88 },
  };
  await repository.markReady(91, {
    framePath: "derived/vehicle.jpg",
    frameTimestamp: "2026-07-28T12:00:02.500Z",
    frameScore: 0.91,
    detectionConfidence: 0.87,
    detectionBox: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 },
    imageWidth: 1920,
    imageHeight: 1080,
    sampledCount: 29,
    selectionMetadata,
  });
  assert.match(statement, /vehicle_image_selection_metadata = \$10::jsonb/);
  assert.deepEqual(JSON.parse(parameters[9]), selectionMetadata);
});

test("motion direction shadow evidence is stored separately from displayed direction", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [] };
    },
  });
  await repository.saveMotionDirectionObservation(92, {
    algorithmVersion: "plate-anchored-motion-v2-shadow",
    captureMode: "day_color",
    status: "ready",
    imageDirection: "left",
    confidence: 0.88,
    tracker: "plate_anchored_vehicle_detection",
    sampleCount: 17,
    trackedCount: 8,
    vector: { deltaX: -0.2, deltaY: 0.01 },
    diagnostics: { monochromeRatio: 0.1 },
    errorCode: null,
  });
  assert.match(statement, /INSERT INTO public\.vehicle_motion_direction_observations/);
  assert.match(statement, /LEFT JOIN public\.vehicle_direction_observations fallback/);
  assert.doesNotMatch(statement, /UPDATE public\.vehicle_direction_observations/);
  assert.equal(parameters[0], 92);
  assert.equal(parameters[1], "plate-anchored-motion-v2-shadow");
  assert.deepEqual(JSON.parse(parameters[9]), { deltaX: -0.2, deltaY: 0.01 });
});

test("vehicle-frame status exposes a bounded recent motion shadow review", async () => {
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      if (sql.includes("FROM public.vehicle_frame_processing_control")) {
        return { rows: [{ historical_paused: true, updated_at: null }] };
      }
      if (sql.includes("FROM public.vehicle_motion_direction_observations shadow")) {
        return { rows: [{
          read_id: 93,
          plate_number: "ABC123",
          camera_name: "Test Camera",
          read_timestamp: new Date("2026-08-07T12:00:00Z"),
          capture_mode: "day_color",
          status: "ready",
          image_direction: "right",
          confidence: "0.91",
          error_code: null,
          evaluated_at: new Date("2026-08-07T12:00:10Z"),
          comparison_direction_label: "Eastbound",
          comparison_direction_confidence: "0.84",
        }] };
      }
      if (sql.includes("FROM public.vehicle_motion_direction_observations")) {
        return { rows: [{ observed: 2, ready: 1, unknown: 1, failed: 0, daytime: 1, night_disabled: 1 }] };
      }
      return { rows: [{}] };
    },
  });
  const status = await repository.getQueueStatus();
  assert.equal(status.motionShadow.observed, 2);
  assert.equal(status.motionShadow.nightDisabled, 1);
  assert.deepEqual(status.motionShadow.recent[0], {
    readId: 93,
    plateNumber: "ABC123",
    cameraName: "Test Camera",
    readTimestamp: "2026-08-07T12:00:00.000Z",
    captureMode: "day_color",
    status: "ready",
    imageDirection: "right",
    confidence: 0.91,
    errorCode: null,
    evaluatedAt: "2026-08-07T12:00:10.000Z",
    comparisonDirectionLabel: "Eastbound",
    comparisonDirectionConfidence: 0.84,
  });
});
