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

test("read-owned overview work resolves an exact direction profile and source camera", async () => {
  const claims = [];
  let servicesCreated = 0;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() {
        claims.push("overview_read");
        return claims.length === 1
          ? {
              id: 901,
              camera_name: "Street LPR 2",
              timestamp: "2026-08-08T18:00:00Z",
              bi_trigger_direction_label: "Eastbound",
              vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
              overview_profile_id: 42,
              overview_source_camera_name: "Street Overview",
              overview_expected_delta_ms: 4_500,
              overview_tolerance_ms: 2_000,
              overview_profile_priority: 0,
              overview_profile_updated_at: "2026-08-08T17:00:00Z",
            }
          : null;
      },
      async claimNextOverviewCandidate() { assert.fail("candidate work must not own live reads"); },
      async claimNextOverviewAssociation() { assert.fail("candidate association must not own live reads"); },
      async claimNext() { claims.push("legacy"); return null; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [{ id: "Cam149", name: "Street Overview" }] };
      },
    }),
    serviceFactory: (options) => {
      servicesCreated += 1;
      if (servicesCreated === 2) {
        assert.equal(options.sampleOffsetsMs.length, 61);
        assert.equal(options.sampleOffsetsMs[0], -1_500);
        assert.equal(options.sampleOffsetsMs.at(-1), 4_500);
        assert.deepEqual(options.extensionOffsetsMs, []);
      }
      return {
        async processOverviewRead(input) {
          assert.equal(input.camera, "Cam149");
          assert.equal(input.read.id, 901);
          assert.equal(input.profile.expected_delta_ms, 4_500);
          return { kind: "overview_read", status: "ready", readId: input.read.id };
        },
      };
    },
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(claims, ["overview_read"]);
  assert.equal(servicesCreated, 2);
});

test("persisted candidate rows are no longer claimed or associated into live overview reads", async () => {
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return null; },
      async claimNextOverviewCandidate() { assert.fail("candidate rows must remain dormant"); },
      async claimNextOverviewAssociation() { assert.fail("candidate associations must remain dormant"); },
      async claimNext() { return null; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() { return { cameras: [] }; },
    }),
    serviceFactory: () => ({}),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.processed, 0);
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
  assert.equal(worker.intervalMs, 5_000);
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
  assert.match(statement, /WHEN vehicle_image_queue_kind = 'overview' THEN 'overview'/);
  assert.match(statement, /ELSE 'manual'/);
  assert.match(statement, /vehicle_image_attempt_count = 0/);
  assert.match(statement, /vehicle_image_status IN \('failed', 'unavailable'\)/);
  assert.match(statement, /vehicle_image_path IS NULL/);
});

test("retrying a read-owned overview preserves the overview queue instead of using the plate camera", async () => {
  let statement = "";
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statement = sql;
      return { rows: [{
        id: 104,
        vehicle_image_status: "pending",
        vehicle_image_queue_kind: "overview",
        vehicle_image_attempt_count: 0,
        vehicle_image_retryable: true,
      }] };
    },
  });

  const result = await repository.retryRead(104);
  assert.equal(result.vehicle_image_queue_kind, "overview");
  assert.match(statement, /WHEN vehicle_image_queue_kind = 'overview' THEN 'overview'/);
  assert.doesNotMatch(statement, /COALESCE\(vehicle_image_queue_kind, ''\) <> 'overview'/);
});

test("overview reads are claimed atomically only after validated Blue Iris direction is ready", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [{
        id: 103,
        camera_name: "Street LPR 1",
        timestamp: "2026-08-08T18:00:00Z",
        bi_trigger_direction_label: "Westbound",
        vehicle_image_queue_kind: "overview",
        vehicle_image_claim_token: values[0],
      }] };
    },
  });

  const read = await repository.claimNextOverviewRead();
  assert.equal(read.id, 103);
  assert.match(statement, /vehicle_image_queue_kind = 'overview'/);
  assert.match(statement, /bi_trigger_direction_status = 'ready'/);
  assert.match(statement, /FOR UPDATE OF reads SKIP LOCKED/);
  assert.match(statement, /vehicle_image_status = 'processing'/);
  assert.match(statement, /profile\.expected_delta_ms \* INTERVAL '1 millisecond'/);
  assert.match(statement, /\(6000 - profile\.tolerance_ms\) \* INTERVAL '1 millisecond'/);
  assert.match(statement, /CURRENT_TIMESTAMP - INTERVAL '5 seconds'/);
  assert.match(statement, /\+ INTERVAL '1 second'/);
  assert.match(statement, /ORDER BY reads\."timestamp" ASC, reads\.id ASC/);
  assert.match(statement, /vehicle_image_hard_deadline_at = CURRENT_TIMESTAMP \+ INTERVAL '5 minutes'/);
  assert.match(statement, /vehicle_image_attempt_count = COALESCE\(reads\.vehicle_image_attempt_count, 0\) \+ 1/);
  assert.match(statement, /vehicle_image_claim_token = \$1::uuid/);
  assert.match(statement, /LOWER\(BTRIM\(source_camera_name\)\) <> LOWER\(BTRIM\(plate_camera_name\)\)/);
  assert.match(read.vehicle_image_claim_token || "", /^[0-9a-f-]{36}$/i);
  assert.equal(read.vehicle_image_claim_token, parameters[0]);
});

test("a downloaded timeline export becomes terminal without a remote-delete schedule", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [{ status: "downloaded" }] };
    },
  });
  const result = await repository.markTimelineExportDownloaded(
    "11111111-1111-4111-8111-111111111111",
    { uri: "@owned.mp4", fileSize: 100, width: 2688, height: 1520, durationMs: 8000 }
  );
  assert.equal(result.status, "downloaded");
  assert.equal(parameters.length, 6);
  assert.match(statement, /status = 'downloaded'/);
  assert.match(statement, /next_delete_attempt_at = NULL/);
  assert.doesNotMatch(statement, /delete_pending/);
});

test("incomplete overview recovery is bounded to transient errors and preserves scene decisions", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  });
  const result = await repository.recoverIncompleteOverviewReads({ sinceHours: 48 });
  assert.deepEqual(result, { queued: 1, sinceHours: 48 });
  assert.deepEqual(parameters, [48]);
  assert.match(statement, /vehicle_image_status = 'pending'/);
  assert.match(statement, /vehicle_image_status = 'processing'[\s\S]*vehicle_image_hard_deadline_at/);
  assert.match(statement, /'EXPORT_TIMEOUT'/);
  assert.match(statement, /'MEDIA_TOOL_FAILED'/);
  assert.doesNotMatch(statement, /VEHICLE_NOT_VISIBLE/);
  assert.doesNotMatch(statement, /MULTIPLE_VEHICLES_VISIBLE/);
  assert.doesNotMatch(statement, /EXPORT_RESOLUTION_TOO_LOW/);
});

test("expired second-attempt overview claims are terminalized instead of remaining stuck", async () => {
  let statement = "";
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statement = sql;
      return { rows: [{ id: 9 }], rowCount: 1 };
    },
  });
  assert.deepEqual(await repository.terminalizeExpiredOverviewReads(), { terminalized: 1 });
  assert.match(statement, /vehicle_image_attempt_count, 0\) >= 2/);
  assert.match(statement, /vehicle_image_status = 'failed'/);
  assert.match(statement, /vehicle_image_retryable = FALSE/);
  assert.match(statement, /OVERVIEW_PROCESSING_DEADLINE/);
});

test("primary overview profiles require an exact plate-camera and direction match", async () => {
  let parameters = null;
  let statement = "";
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [] };
    },
  });

  await repository.listPrimaryOverviewProfilesForRead({
    plateCameraName: "Street LPR 2",
    directionLabel: "Eastbound",
  });
  assert.deepEqual(parameters, ["Street LPR 2", "Eastbound"]);
  assert.match(statement, /source_role = 'primary'/);
  assert.match(statement, /LOWER\(BTRIM\(plate_camera_name\)\) = LOWER\(BTRIM\(\$1\)\)/);
  assert.match(statement, /LOWER\(BTRIM\(direction_label\)\) = LOWER\(BTRIM\(\$2\)\)/);
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
