import assert from "node:assert/strict";
import test from "node:test";

import {
  BlueIrisVehicleFrameQueue,
  blueIrisVehicleFrameQueueInternals,
} from "../lib/blue-iris-vehicle-frame-queue.mjs";
import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";
import {
  BlueIrisVehicleFrameWorker,
  blueIrisVehicleFrameWorkerInternals,
} from "../lib/blue-iris-vehicle-frame-worker.mjs";
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
              overview_profile_revision: 7,
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
          assert.equal(input.profile.revision, 7);
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

test("Entry Overview resolves its reviewed Cam143 binding and preserves Entry context", async () => {
  const claims = [{
    id: 902,
    camera_name: "Entry LPR 1",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Entering",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 43,
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_context: "entry",
    overview_profile_match_count: 1,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 2,
  }];
  let processed = null;
  let connectionCount = 0;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed() { assert.fail("a reviewed Cam143 binding must not fail"); },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        connectionCount += 1;
        return { cameras: [{ id: "Cam143", name: "Entry Overview" }] };
      },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead(input) {
        processed = input;
        return { kind: "overview_read", status: "ready", readId: input.read.id };
      },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.succeeded, 1);
  assert.equal(connectionCount, 1);
  assert.equal(processed.camera, "Cam143");
  assert.equal(processed.profile.overview_context, "entry");
  assert.equal(processed.profile.source_camera_short_name, "Cam143");
});

test("Entry Overview rejects a blank short-camera binding before Blue Iris initialization", async () => {
  const claims = [{
    id: 904,
    camera_name: "Entry LPR 1",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Entering",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 43,
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "   ",
    overview_context: "entry",
    overview_profile_match_count: 1,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 2,
  }];
  let failure = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed(id, input) { failure = { id, ...input }; return { id }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => { assert.fail("a blank Entry binding must make zero Blue Iris calls"); },
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.results[0].errorCode, "OVERVIEW_CAMERA_BINDING_INVALID");
  assert.equal(failure.retryable, false);
  assert.equal(failure.selectionMetadata.overviewContext, "entry");
});

test("Entry Overview rejects a display-name and Cam143 mismatch without exporting", async () => {
  const claims = [{
    id: 905,
    camera_name: "Entry LPR 2",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Exiting",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 44,
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_context: "entry",
    overview_profile_match_count: 1,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 1,
  }];
  let failure = null;
  let exportCalls = 0;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed(id, input) { failure = { id, ...input }; return { id }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [
          { id: "Cam149", name: "Entry Overview" },
          { id: "Cam143", name: "Different Camera" },
        ] };
      },
      async startTimelineExport() { exportCalls += 1; },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead() { assert.fail("a mismatched binding must not be processed"); },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.results[0].errorCode, "OVERVIEW_CAMERA_BINDING_MISMATCH");
  assert.equal(exportCalls, 0);
  assert.equal(failure.retryable, false);
  assert.equal(failure.selectionMetadata.sourceCameraShortName, "Cam143");
});

test("Entry Overview rejects a missing display-name alias even when Cam143 exists", async () => {
  const claims = [{
    id: 906,
    camera_name: "Entry LPR 2",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Exiting",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 44,
    overview_source_camera_name: "Entry Overveiw",
    overview_source_camera_short_name: "Cam143",
    overview_context: "entry",
    overview_profile_match_count: 1,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 1,
  }];
  let failure = null;
  let exportCalls = 0;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed(id, input) { failure = { id, ...input }; return { id }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [{ id: "Cam143", name: "Entry Overview" }] };
      },
      async startTimelineExport() { exportCalls += 1; },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead() { assert.fail("a missing display alias must not be processed"); },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(result.results[0].errorCode, "OVERVIEW_CAMERA_BINDING_MISMATCH");
  assert.equal(exportCalls, 0);
  assert.equal(failure.retryable, false);
});

test("ambiguous Entry profiles fail closed before creating a Blue Iris client", async () => {
  const claims = [{
    id: 903,
    camera_name: "Entry LPR 2",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Exiting",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 44,
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_context: "entry",
    overview_profile_match_count: 2,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 1,
  }];
  let failure = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed(id, input) { failure = { id, ...input }; return { id }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => { assert.fail("ambiguous profiles must make zero Blue Iris calls"); },
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].errorCode, "OVERVIEW_PROFILE_AMBIGUOUS");
  assert.equal(failure.selectionMetadata.overviewContext, "entry");
  assert.equal(failure.selectionMetadata.sourceCameraId, "Cam143");
});

test("an idle or night-only queue makes zero Blue Iris calls", async () => {
  let factoryCalls = 0;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return null; },
      async claimNext() { return null; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => { factoryCalls += 1; return {}; },
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 5 });
  assert.equal(result.processed, 0);
  assert.equal(factoryCalls, 0);
});

function claimedEntryHistoryRead(overrides = {}) {
  return {
    id: 9_001,
    camera_name: "Entry LPR 1",
    timestamp: "2026-05-19T18:00:00Z",
    image_path: "plates/9001.jpg",
    image_data: null,
    vehicle_image_path: "derived/legacy-entry-view.jpg",
    vehicle_image_claim_token: "90010000-0000-4000-8000-000000009001",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview_backfill",
    vehicle_image_hard_deadline_at: "2099-01-01T00:00:00Z",
    entry_history_job_id: 501,
    entry_history_run_id: 51,
    entry_history_profile_id: 31,
    entry_history_profile_key: "a".repeat(64),
    entry_history_profile_revision: 2,
    entry_history_profile_kind: "entry_history",
    entry_history_algorithm_revision: "entry-overview-history-v1",
    entry_overview_source_kind: "entry_overview_history",
    overview_context: "entry",
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_expected_delta_ms: 250,
    overview_tolerance_ms: 3_000,
    ...overrides,
  };
}

test("historical monochrome Entry evidence terminates before any Blue Iris call", async () => {
  const read = claimedEntryHistoryRead();
  let clientCalls = 0;
  let recorded = null;
  let failed = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return null; },
      async claimNext() { return null; },
      async claimNextEntryOverviewBackfillJob() { return read; },
      async recordEntryOverviewBackfillDaylight(jobId, claimToken, input) {
        recorded = { jobId, claimToken, ...input };
        return { id: jobId };
      },
      async markEntryOverviewBackfillFailed(jobId, input) {
        failed = { jobId, ...input };
        return { id: read.id, status: "unavailable", retryable: false };
      },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => { clientCalls += 1; return {}; },
    historyDaylightAssessor: async () => ({
      status: "nighttime",
      errorCode: "NIGHTTIME_UNAVAILABLE",
      evidence: { evaluated: true, eligible: false, monochrome: true },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(clientCalls, 0);
  assert.equal(recorded.status, "nighttime");
  assert.equal(recorded.jobId, 501);
  assert.equal(failed.errorCode, "NIGHTTIME_UNAVAILABLE");
  assert.equal(failed.unavailable, true);
  assert.equal(result.results[0].kind, "entry_overview_backfill");
  assert.equal(result.results[0].status, "unavailable");
});

test("historical Entry work uses the exact Cam143 binding after live queues are empty", async () => {
  const read = claimedEntryHistoryRead();
  const claimOrder = [];
  let processed = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: false }; },
      async claimNextOverviewRead() { claimOrder.push("live_overview"); return null; },
      async claimNext({ includeHistorical }) {
        claimOrder.push(includeHistorical ? "legacy_history" : "live");
        return null;
      },
      async claimNextEntryOverviewBackfillJob() {
        claimOrder.push("entry_history");
        return read;
      },
      async recordEntryOverviewBackfillDaylight() { return { id: 501 }; },
      async heartbeatEntryOverviewBackfillJob() { return { id: 501 }; },
      async markEntryOverviewBackfillReady() { return { id: read.id }; },
      async markEntryOverviewBackfillFailed() { assert.fail("a valid history canary must not fail"); },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [{ id: "Cam143", name: "Entry Overview" }] };
      },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead(input) {
        processed = input;
        return { kind: "entry_overview_backfill", status: "ready", readId: input.read.id };
      },
    }),
    historyDaylightAssessor: async () => ({
      status: "eligible",
      errorCode: null,
      evidence: { evaluated: true, eligible: true, monochrome: false },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.deepEqual(claimOrder, ["live_overview", "live", "entry_history"]);
  assert.equal(result.succeeded, 1);
  assert.equal(processed.camera, "Cam143");
  assert.equal(processed.profile.profile_kind, "entry_history");
  assert.equal(processed.profile.direction_label, null);
  assert.equal(processed.profile.tolerance_ms, 3_000);
  assert.equal(processed.read.entry_overview_daylight_evidence.eligible, true);
  assert.equal(typeof processed.lifecycle.markReady, "function");
});

test("operator framing repair runs after live reads and before historical work", async () => {
  const claimOrder = [];
  let processed = null;
  const repairReads = [{
    id: 41117,
    camera_name: "Street LPR 2",
    timestamp: "2026-08-15T17:24:00Z",
    bi_trigger_direction_label: "Westbound",
    vehicle_image_claim_token: "33333333-3333-4333-8333-333333333333",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview_repair",
    framing_repair_job_id: 71,
    framing_repair_profile_id: 42,
    framing_repair_profile_revision: 7,
    framing_repair_source_kind: "overview_primary",
    framing_repair_overview_context: "street",
    framing_repair_source_camera_name: "Street Overview",
    framing_repair_source_camera_short_name: "Cam149",
    framing_repair_expected_delta_ms: 4_500,
    framing_repair_tolerance_ms: 1_500,
  }];
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: false }; },
      async claimNextOverviewRead() { claimOrder.push("live_overview"); return null; },
      async claimNext({ includeHistorical }) {
        claimOrder.push(includeHistorical ? "legacy_history" : "live");
        return null;
      },
      async claimNextOverviewFramingRepairJob() {
        claimOrder.push("framing_repair");
        return repairReads.shift() || null;
      },
      async heartbeatOverviewFramingRepairJob() { return { id: 71 }; },
      async markOverviewFramingRepairReady() { return { id: 71 }; },
      async markOverviewFramingRepairFailed() { assert.fail("valid repair must not fail"); },
      async claimNextEntryOverviewBackfillJob() {
        claimOrder.push("entry_history");
        return null;
      },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [{ id: "Cam149", name: "Street Overview" }] };
      },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead(input) {
        processed = input;
        return { kind: "overview_framing_repair", status: "ready", readId: input.read.id };
      },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });

  assert.deepEqual(claimOrder, ["live_overview", "live", "framing_repair"]);
  assert.equal(result.succeeded, 1);
  assert.equal(processed.camera, "Cam149");
  assert.equal(processed.profile.id, 42);
  assert.equal(processed.profile.revision, 7);
  assert.equal(processed.lifecycle.kind, "overview_framing_repair");
});

test("historical Entry binding mismatch fails closed without timeline processing", async () => {
  const read = claimedEntryHistoryRead();
  let failed = null;
  let processed = false;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return null; },
      async claimNext() { return null; },
      async claimNextEntryOverviewBackfillJob() { return read; },
      async recordEntryOverviewBackfillDaylight() { return { id: 501 }; },
      async markEntryOverviewBackfillFailed(jobId, input) {
        failed = { jobId, ...input };
        return { id: read.id, status: "unavailable" };
      },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        return { cameras: [
          { id: "Cam149", name: "Entry Overview" },
          { id: "Cam143", name: "Wrong Camera" },
        ] };
      },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({
      async processOverviewRead() { processed = true; },
    }),
    historyDaylightAssessor: async () => ({
      status: "eligible",
      errorCode: null,
      evidence: { evaluated: true, eligible: true, monochrome: false },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
  });

  const result = await queue.processBatch({ limit: 1 });
  assert.equal(processed, false);
  assert.equal(failed.errorCode, "OVERVIEW_CAMERA_BINDING_MISMATCH");
  assert.equal(failed.unavailable, true);
  assert.equal(result.results[0].status, "unavailable");
});

test("historical Entry initialization failure releases the job into bounded backoff", async () => {
  const read = claimedEntryHistoryRead();
  let failed = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { return null; },
      async claimNext() { return null; },
      async claimNextEntryOverviewBackfillJob() { return read; },
      async recordEntryOverviewBackfillDaylight() { return { id: 501 }; },
      async markEntryOverviewBackfillFailed(jobId, input) {
        failed = { jobId, ...input };
        return { id: read.id, status: "failed", retryable: true };
      },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() { throw new Error("Blue Iris is restarting"); },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    historyDaylightAssessor: async () => ({
      status: "eligible",
      errorCode: null,
      evidence: { evaluated: true, eligible: true, monochrome: false },
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
    logger: { error() {} },
  });

  const result = await queue.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.backoff, true);
  assert.equal(result.backoffMs, 30_000);
  assert.equal(failed.errorCode, "BLUE_IRIS_INITIALIZATION_FAILED");
  assert.equal(failed.retryable, true);
  assert.ok(Date.parse(failed.nextAttemptAt) > Date.now());
  assert.equal(result.results[0].status, "retry_scheduled");
});

test("Blue Iris initialization failure releases one claimed read into bounded backoff", async () => {
  const claims = Array.from({ length: 10 }, (_, index) => ({
    id: 1_000 + index,
    camera_name: "Entry LPR 1",
    timestamp: "2026-08-10T18:00:00Z",
    bi_trigger_direction_label: "Entering",
    vehicle_image_claim_token: "11111111-1111-4111-8111-111111111111",
    vehicle_image_attempt_count: 1,
    vehicle_image_queue_kind: "overview",
    overview_profile_id: 43,
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_context: "entry",
    overview_profile_match_count: 1,
    overview_expected_delta_ms: 0,
    overview_tolerance_ms: 1_500,
    overview_profile_priority: 0,
    overview_profile_revision: 2,
  }));
  let claimCount = 0;
  let connectionCount = 0;
  let failure = null;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { claimCount += 1; return claims.shift() || null; },
      async claimNext() { return null; },
      async markFailed(id, input) { failure = { id, ...input }; return { id }; },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() {
        connectionCount += 1;
        throw new Error("Blue Iris is restarting");
      },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    pairSharingFactory: () => ({ async processNext() { return null; } }),
    entryFallbackFactory: () => ({ async processNext() { return null; } }),
    logger: { error() {} },
  });

  const result = await queue.processBatch({ limit: 5 });
  assert.equal(result.processed, 1);
  assert.equal(result.backoff, true);
  assert.equal(result.backoffMs, 30_000);
  assert.ok(Date.parse(result.backoffUntil) > Date.now());
  assert.equal(claimCount, 1);
  assert.equal(connectionCount, 1);
  assert.equal(failure.errorCode, "BLUE_IRIS_INITIALIZATION_FAILED");
  assert.equal(failure.retryable, true);
  assert.ok(Date.parse(failure.nextAttemptAt) > Date.now());
  assert.equal(failure.selectionMetadata.overviewContext, "entry");
});

test("an active guarded pair share runs before another Blue Iris overview export", async () => {
  let overviewClaimed = false;
  let shared = false;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { overviewClaimed = true; return null; },
      async claimNext() { assert.fail("pair sharing must finish before legacy work"); },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() { return { cameras: [] }; },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({}),
    pairSharingFactory: () => ({
      async processNext() {
        shared = true;
        return {
          kind: "overview_pair_share",
          status: "shared",
          sourceReadId: 101,
          targetReadId: 102,
        };
      },
    }),
  });
  const result = await queue.processBatch({ limit: 1 });
  assert.equal(shared, true);
  assert.equal(overviewClaimed, false);
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].kind, "overview_pair_share");
});

test("an active Entry LPR fallback runs after Street sharing and before another overview export", async () => {
  let overviewClaimed = false;
  let pairChecked = false;
  let fallbackChecked = false;
  const queue = new BlueIrisVehicleFrameQueue({
    repository: {
      async getQueueStatus() { return { historicalPaused: true }; },
      async claimNextOverviewRead() { overviewClaimed = true; return null; },
      async claimNext() { assert.fail("Entry fallback must finish before legacy work"); },
    },
    fileStorage: {},
    loadConfig: async () => configured,
    clientFactory: () => ({
      async testConnection() { return { cameras: [] }; },
    }),
    timelineExportFactory: () => ({
      async sweepLocalWorkspaces() {},
      async reconcileRemoteExports() {},
    }),
    serviceFactory: () => ({}),
    pairSharingFactory: () => ({
      async processNext() { pairChecked = true; return null; },
    }),
    entryFallbackFactory: () => ({
      async processNext() {
        fallbackChecked = true;
        return {
          kind: "entry_lpr_fallback",
          status: "shared",
          sourceReadId: 201,
          targetReadId: 202,
        };
      },
    }),
  });
  const result = await queue.processBatch({ limit: 1 });
  assert.equal(pairChecked, true);
  assert.equal(fallbackChecked, true);
  assert.equal(overviewClaimed, false);
  assert.equal(result.processed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].kind, "entry_lpr_fallback");
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
  assert.equal(
    blueIrisVehicleFrameWorkerInternals.nextWorkerDelay({ processed: 1, backoff: true }, 5_000),
    30_000
  );
  assert.equal(
    blueIrisVehicleFrameWorkerInternals.nextWorkerDelay({ processed: 1 }, 5_000),
    1_000
  );
});

test("worker-wide Blue Iris backoff blocks backlog cycling and ordinary wakeups", async () => {
  let now = Date.parse("2026-08-10T18:00:00Z");
  let calls = 0;
  const worker = new BlueIrisVehicleFrameWorker({
    queue: {
      async processBatch() {
        calls += 1;
        if (calls === 1) {
          return {
            configured: true,
            processed: 1,
            succeeded: 0,
            failed: 1,
            backoff: true,
            backoffMs: 30_000,
          };
        }
        return { configured: true, processed: 0, succeeded: 0, failed: 0 };
      },
    },
    intervalMs: 5_000,
    now: () => now,
  });

  const failedBatch = await worker.runOnce();
  assert.equal(failedBatch.backoff, true);
  assert.equal(worker.phase, "backoff");
  assert.equal(calls, 1);
  worker.waitController = new AbortController();
  assert.equal(worker.wake(), false);
  assert.equal(worker.waitController.signal.aborted, false);

  const blockedBatch = await worker.runOnce();
  assert.equal(blockedBatch.processed, 0);
  assert.equal(blockedBatch.backoff, true);
  assert.equal(calls, 1);

  now += 30_001;
  const recoveredBatch = await worker.runOnce();
  assert.equal(recoveredBatch.processed, 0);
  assert.equal(calls, 2);
  assert.equal(worker.wake({ force: true }), true);
  assert.equal(worker.waitController.signal.aborted, true);
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
  assert.match(statement, /'EXPORT_TIMEOUT'/);
  assert.doesNotMatch(statement, /'EXPORT_START_UNCERTAIN'/);
  assert.doesNotMatch(statement, /'NIGHTTIME_UNAVAILABLE','/);
  assert.doesNotMatch(statement, /MULTIPLE_VEHICLES_VISIBLE/);
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
  assert.match(statement, /vehicle_image_status = 'pending'[\s\S]*vehicle_image_next_attempt_at/);
  assert.match(statement, /vehicle_image_claim_token = \$1::uuid/);
  assert.match(statement, /LOWER\(BTRIM\(source_camera_name\)\) <> LOWER\(BTRIM\(plate_camera_name\)\)/);
  assert.match(read.vehicle_image_claim_token || "", /^[0-9a-f-]{36}$/i);
  assert.equal(read.vehicle_image_claim_token, parameters[0]);
});

test("releasing an overview claim preserves its consumed attempt and caps profile-change retries", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [{ id: 103 }] };
    },
  });

  const released = await repository.releaseOverviewReadClaim(
    103,
    "11111111-1111-4111-8111-111111111111"
  );

  assert.equal(released.id, 103);
  assert.deepEqual(parameters, [
    103,
    "11111111-1111-4111-8111-111111111111",
    "OVERVIEW_PROFILE_CHANGED",
  ]);
  assert.doesNotMatch(statement, /vehicle_image_attempt_count\s*=/);
  assert.match(statement, /vehicle_image_attempt_count, 0\) >= 2 THEN 'failed'/);
  assert.match(statement, /vehicle_image_retryable = COALESCE\(vehicle_image_attempt_count, 0\) < 2/);
  assert.match(statement, /CURRENT_TIMESTAMP \+ INTERVAL '30 seconds'/);
  assert.match(statement, /vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP/);
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
    { uri: "@owned.mp4", fileSize: 100, width: 2688, height: 1520, durationMs: 8000 },
    { claimToken: "22222222-2222-4222-8222-222222222222" }
  );
  assert.equal(result.status, "downloaded");
  assert.equal(parameters.length, 7);
  assert.equal(parameters[6], "22222222-2222-4222-8222-222222222222");
  assert.match(statement, /status = 'downloaded'/);
  assert.match(statement, /next_delete_attempt_at = NULL/);
  assert.doesNotMatch(statement, /delete_pending/);
});

test("timeline export transitions are claim-owned and cannot regress a downloaded ledger", async () => {
  const statements = [];
  const values = [];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, parameters) {
      statements.push(sql);
      values.push(parameters);
      return { rows: [] };
    },
  });
  const exportToken = "11111111-1111-4111-8111-111111111111";
  const claimToken = "22222222-2222-4222-8222-222222222222";
  await repository.claimTimelineExportStart(exportToken, claimToken, ["@old.mp4", "@old.mp4"]);
  await repository.recordTimelineExportRemote(exportToken, {
    remotePath: "@new.mp4",
    uri: "@new.mp4",
    utc: Date.now(),
    durationMs: 8_000,
  }, { claimToken });
  await repository.markTimelineExportFailed(exportToken, {
    errorCode: "EXPORT_TIMEOUT",
  }, { claimToken });

  assert.match(statements[0], /automatic_start_count = 0/);
  assert.match(statements[0], /JOIN public\.plate_reads reads ON reads\.id = exports\.read_id/);
  assert.match(statements[0], /reads\.vehicle_image_claim_token = \$2::uuid/);
  assert.match(statements[0], /reads\.vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP/);
  assert.match(statements[0], /FOR SHARE OF reads/);
  assert.match(statements[0], /preexisting_remote_paths = \$3::jsonb/);
  assert.equal(values[0][2], '["@old.mp4"]');
  assert.match(statements[1], /claim_token = \$10::uuid/);
  assert.match(statements[1], /status IN \('starting','exporting','ready','failed'\)/);
  assert.equal(values[1][9], claimToken);
  assert.match(statements[2], /claim_token = \$4::uuid/);
  assert.match(statements[2], /status <> 'downloaded'/);
  assert.equal(values[2][3], claimToken);
});

test("stable export-ledger ownership can transfer only from the active unexpired read claim", async () => {
  const statements = [];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
  });
  const result = await repository.beginTimelineExport({
    exportKey: "a".repeat(64),
    readId: 39667,
    claimToken: "22222222-2222-4222-8222-222222222222",
    sourceCameraName: "Street Overview",
    requestedStartAt: "2026-08-10T16:09:42.000Z",
    requestedDurationMs: 8_000,
    hardDeadlineAt: "2026-08-10T16:15:00.000Z",
    pairProfileId: 9,
    profileRevision: 4,
    algorithmRevision: "overview-timeline-export-v2",
  });
  assert.equal(result, null);
  assert.equal(statements.length, 3);
  for (const statement of statements) {
    assert.match(statement, /FROM public\.plate_reads/);
    assert.match(statement, /vehicle_image_status = 'processing'/);
    assert.match(statement, /vehicle_image_claim_token = .*::uuid/);
    assert.match(statement, /vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP/);
    assert.match(statement, /FOR SHARE/);
  }
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
  const result = await repository.recoverIncompleteOverviewReads({
    startAt: "2026-08-08T19:08:00.000Z",
  });
  assert.deepEqual(result, { queued: 1, startAt: "2026-08-08T19:08:00.000Z" });
  assert.deepEqual(parameters, ["2026-08-08T19:08:00.000Z"]);
  assert.match(statement, /"timestamp" >= \$1::timestamptz/);
  assert.match(statement, /vehicle_image_status = 'pending'/);
  assert.match(statement, /vehicle_image_recovery_count = COALESCE\(vehicle_image_recovery_count, 0\) \+ 1/);
  assert.match(statement, /COALESCE\(vehicle_image_recovery_count, 0\) = 0/);
  assert.match(statement, /vehicle_image_status = 'processing'[\s\S]*vehicle_image_hard_deadline_at/);
  assert.match(statement, /'EXPORT_TIMEOUT'/);
  assert.match(statement, /'OVERVIEW_PROFILE_CHANGED'/);
  assert.match(statement, /'MEDIA_TOOL_FAILED'/);
  assert.doesNotMatch(statement, /VEHICLE_NOT_VISIBLE/);
  assert.doesNotMatch(statement, /MULTIPLE_VEHICLES_VISIBLE/);
  assert.doesNotMatch(statement, /EXPORT_RESOLUTION_TOO_LOW/);
});

test("incomplete overview recovery preview uses the identical exact-cutoff eligibility contract", async () => {
  let statement = "";
  let parameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statement = sql;
      parameters = values;
      return { rows: [{
        eligible: 12,
        oldest_at: "2026-08-08T19:10:00.000Z",
        newest_at: "2026-08-10T16:00:00.000Z",
        pending: 3,
        expired_processing: 2,
        operational_failures: 7,
      }] };
    },
  });
  const result = await repository.previewIncompleteOverviewReads({
    startAt: "2026-08-08T19:08:00.000Z",
  });
  assert.equal(result.eligible, 12);
  assert.equal(result.pending, 3);
  assert.deepEqual(parameters, ["2026-08-08T19:08:00.000Z"]);
  assert.match(statement, /COUNT\(\*\)::integer AS eligible/);
  assert.match(statement, /"timestamp" >= \$1::timestamptz/);
  assert.doesNotMatch(statement, /UPDATE public\.plate_reads/);
  assert.doesNotMatch(statement, /VEHICLE_NOT_VISIBLE/);
  assert.doesNotMatch(statement, /NIGHTTIME_UNAVAILABLE/);
});

test("overview status reports the active read queue and stable export ledger", async () => {
  const statements = [];
  const responses = [
    { rows: [{
      pending: 3,
      processing: 1,
      ready: 8,
      ambiguous: 2,
      unavailable: 4,
      nighttime_skipped: 5,
      failed: 1,
      street_ready: 7,
      entry_ready: 1,
      oldest_outstanding_at: "2026-08-10T12:00:00.000Z",
    }] },
    { rows: [{
      total: 12,
      active: 1,
      downloaded: 9,
      failed: 2,
      automatic_starts: 10,
      duplicate_start_violations: 0,
      last_transition_at: "2026-08-10T12:05:00.000Z",
    }] },
    { rows: [{ source_camera_name: "Entry Overview" }, { source_camera_name: "Street Overview" }] },
    { rows: [{
      read_id: 39667,
      plate_number: "ABC123",
      camera_name: "Entry LPR 1",
      vehicle_image_status: "processing",
      vehicle_image_attempt_count: 1,
      vehicle_image_recovery_count: 0,
      vehicle_image_source_kind: "entry_overview_primary",
      vehicle_image_selection_metadata: {
        overviewContext: "entry",
        sourceCameraName: "Entry Overview",
        sourceCameraId: "Cam143",
        profileRevision: 2,
      },
      export_key: "a".repeat(64),
      export_status: "exporting",
      automatic_start_count: 1,
      remote_uri_known: true,
      video_width: null,
      video_height: null,
    }] },
    { rows: [{
      mode: "shadow",
      observation_started_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:00:00.000Z",
      proposed: 2,
      processing: 0,
      applied: 0,
      rejected: 1,
      failed: 0,
    }] },
    { rows: [{
      id: 5,
      source_read_id: 39667,
      target_read_id: 39668,
      status: "proposed",
      decision_reason: "UNIQUE_STREET_PAIR",
      plate_number_snapshot: "ABC123",
      direction_label_snapshot: "Eastbound",
      source_camera_name_snapshot: "Street LPR 1",
      target_camera_name_snapshot: "Street LPR 2",
      anchor_delta_ms: 100,
    }] },
  ];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statements.push(sql);
      return responses[statements.length - 1];
    },
  });
  const status = await repository.getOverviewStatus();
  assert.equal(status.pending, 3);
  assert.equal(status.processing, 1);
  assert.equal(status.ready, 8);
  assert.equal(status.exports.automaticStarts, 10);
  assert.equal(status.exports.duplicateStartViolations, 0);
  assert.equal(status.byContext.streetReady, 7);
  assert.equal(status.byContext.entryReady, 1);
  assert.deepEqual(status.observedSources, ["Entry Overview", "Street Overview"]);
  assert.equal(status.recentJobs[0].readId, 39667);
  assert.equal(status.recentJobs[0].overviewContext, "entry");
  assert.equal(status.recentJobs[0].sourceCameraName, "Entry Overview");
  assert.equal(status.recentJobs[0].sourceCameraId, "Cam143");
  assert.equal(status.recentJobs[0].profileRevision, 2);
  assert.equal(status.recentJobs[0].automaticStartCount, 1);
  assert.equal(status.recentJobs[0].remoteUriKnown, true);
  assert.equal(status.pairSharing.mode, "shadow");
  assert.equal(status.pairSharing.proposed, 2);
  assert.equal(status.pairSharing.rejected, 1);
  assert.equal(status.pairSharing.recent[0].targetReadId, 39668);
  assert.match(statements[0], /FROM public\.plate_reads/);
  assert.doesNotMatch(statements[0], /vehicle_overview_candidates/);
  assert.match(statements[1], /FROM public\.blue_iris_timeline_exports/);
  assert.match(statements[2], /source_role = 'primary'/);
  assert.match(statements[3], /LEFT JOIN LATERAL/);
  assert.match(statements[3], /LIMIT 25/);
  assert.match(statements[4], /vehicle_overview_pair_sharing_settings/);
  assert.match(statements[5], /vehicle_overview_read_shares/);
});

test("overview framing audit inventory is frozen, bounded, and read-only", async () => {
  const statements = [];
  const parameters = [];
  const responses = [
    { rows: [{ max_read_id: 41121 }] },
    { rows: [{ total: 1275 }] },
    { rows: [{
      id: 41117,
      plate_number: "FIED65",
      camera_name: "Street LPR 2",
      timestamp: "2026-08-15T17:24:00.000Z",
      vehicle_image_path: "derived/jeep.jpg",
      vehicle_image_source_kind: "overview_primary",
      vehicle_image_detection_box: { left: 0.12, top: 0.15, right: 0.78, bottom: 0.72 },
    }] },
    { rows: [{ remaining: 0 }] },
  ];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, values) {
      statements.push(sql);
      parameters.push(values || []);
      return responses[statements.length - 1];
    },
  });

  const result = await repository.listOverviewFramingAuditCandidates({
    afterReadId: 41000,
    limit: 10,
  });

  assert.equal(result.maxReadId, 41121);
  assert.equal(result.total, 1275);
  assert.equal(result.remaining, 0);
  assert.equal(result.reads[0].id, 41117);
  assert.deepEqual(parameters[2], [41000, 41121, 10]);
  assert.ok(statements.every((statement) => /^SELECT/i.test(statement.trim())));
  assert.ok(statements.every((statement) => !/\b(?:UPDATE|INSERT|DELETE)\b/i.test(statement)));
  assert.ok(statements[0].includes("entry_overview_history"));
  assert.ok(statements[2].includes("overview_pair_share"));
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

test("a no-op overview profile save preserves the integer export revision", async () => {
  let upsert = "";
  let upsertParameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, parameters) {
      if (/INSERT INTO public\.vehicle_overview_pair_profiles/.test(sql)) {
        upsert = sql;
        upsertParameters = parameters;
        return { rows: [{
          id: 9,
          source_camera_name: "Street Overview",
          plate_camera_name: "Street LPR 1",
          direction_label: "Eastbound",
          source_role: "primary",
          overview_context: "street",
          source_camera_short_name: null,
          expected_delta_ms: 0,
          tolerance_ms: 1500,
          priority: 0,
          enabled: true,
          revision: 4,
        }] };
      }
      return { rows: [] };
    },
  });
  await repository.saveOverviewPairProfile({
    sourceCameraName: "Street Overview",
    plateCameraName: "Street LPR 1",
    directionLabel: "Eastbound",
    sourceRole: "primary",
    expectedDeltaMs: 0,
    toleranceMs: 1500,
    priority: 0,
    enabled: true,
  });
  assert.match(upsert, /ROW\([\s\S]*\) IS DISTINCT FROM ROW\(/);
  assert.match(upsert, /THEN vehicle_overview_pair_profiles\.revision \+ 1/);
  assert.match(upsert, /ELSE vehicle_overview_pair_profiles\.revision END/);
  assert.match(upsert, /ELSE vehicle_overview_pair_profiles\.updated_at END/);
  assert.equal(upsertParameters[4], "street");
  assert.equal(upsertParameters[5], null);
});

test("profile persistence canonicalizes case variants under a normalized primary lock", async () => {
  const statements = [];
  let upsertParameters = null;
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, parameters) {
      statements.push(sql);
      if (/SELECT id, source_camera_name, plate_camera_name, direction_label[\s\S]*FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: 43,
          source_camera_name: "Entry Overview",
          plate_camera_name: "Entry LPR 1",
          direction_label: "Entering",
        }] };
      }
      if (/INSERT INTO public\.vehicle_overview_pair_profiles/.test(sql)) {
        upsertParameters = parameters;
        return { rows: [{
          id: 43,
          source_camera_name: "Entry Overview",
          source_camera_short_name: "Cam143",
          plate_camera_name: "Entry LPR 1",
          direction_label: "Entering",
          source_role: "primary",
          overview_context: "entry",
          expected_delta_ms: 0,
          tolerance_ms: 1500,
          priority: 0,
          enabled: true,
          revision: 2,
        }] };
      }
      return { rows: [] };
    },
  });

  const saved = await repository.saveOverviewPairProfile({
    sourceCameraName: " entry overview ",
    sourceCameraShortName: "Cam143",
    plateCameraName: " entry lpr 1 ",
    directionLabel: " entering ",
    sourceRole: "primary",
    overviewContext: "entry",
    expectedDeltaMs: 0,
    toleranceMs: 1500,
    priority: 0,
    enabled: true,
  });
  assert.equal(saved.source_camera_name, "Entry Overview");
  assert.ok(statements.some((sql) => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(sql)));
  assert.equal(upsertParameters[0], "Entry Overview");
  assert.equal(upsertParameters[1], "Entry LPR 1");
  assert.equal(upsertParameters[2], "Entering");
  assert.equal(upsertParameters[4], "entry");
  assert.equal(upsertParameters[5], "Cam143");
});

test("camera alias indexing rejects duplicate display names while retaining unique short IDs", () => {
  const index = new Map();
  const first = { id: "Cam143", name: "Entry Overview" };
  const second = { id: "Cam144", name: "Entry Overview" };
  blueIrisVehicleFrameQueueInternals.addCameraAlias(index, first.id, first);
  blueIrisVehicleFrameQueueInternals.addCameraAlias(index, first.name, first);
  blueIrisVehicleFrameQueueInternals.addCameraAlias(index, second.id, second);
  blueIrisVehicleFrameQueueInternals.addCameraAlias(index, second.name, second);
  assert.equal(blueIrisVehicleFrameQueueInternals.uniqueCamera(index, "Entry Overview"), null);
  assert.equal(blueIrisVehicleFrameQueueInternals.uniqueCamera(index, "Cam143")?.id, "Cam143");
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
