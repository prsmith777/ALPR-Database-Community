import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";
import { BlueIrisVehicleFrameService } from "../lib/blue-iris-vehicle-frame.mjs";
import { BlueIrisError } from "../lib/blue-iris.mjs";
import { FileStorage } from "../lib/fileStorage.js";

const CLAIM_TOKEN = "11111111-1111-4111-8111-111111111111";
const FRAME_TIMESTAMP = "2026-08-09T14:00:05.000Z";

function overviewRead(overrides = {}) {
  return {
    id: 901,
    plate_number: "BZGJ52",
    camera_name: "Street LPR 2",
    timestamp: new Date().toISOString(),
    bi_trigger_direction_label: "Eastbound",
    vehicle_image_claim_token: CLAIM_TOKEN,
    vehicle_image_attempt_count: 1,
    ...overrides,
  };
}

function overviewProfile(overrides = {}) {
  return {
    id: 42,
    source_camera_name: "Street Overview",
    expected_delta_ms: 4_500,
    tolerance_ms: 2_000,
    revision: 7,
    updated_at: "2026-08-09T13:59:00.000Z",
    ...overrides,
  };
}

function selectedOverview(buffer = Buffer.from("analysis-frame")) {
  return {
    best: {
      buffer,
      timestamp: FRAME_TIMESTAMP,
      offsetMs: 500,
      score: 0.91,
      quality: { sharpnessScore: 0.82 },
      scoreBreakdown: { completenessTier: 3 },
      detection: {
        confidence: 0.9,
        area: 0.32,
        left: 0.12,
        top: 0.15,
        right: 0.78,
        bottom: 0.72,
      },
      width: 1280,
      height: 720,
      trackSimilarity: 0.9,
      continuityScore: 0.92,
    },
    sampledCount: 61,
    detectedCount: 8,
    trackedCount: 5,
    anchorOffsetMs: 0,
    selectionReason: "overview_anchor_track",
    telemetry: {
      requestedSampleCount: 61,
      successfulSampleCount: 61,
      viableTrackCount: 1,
    },
  };
}

async function patternedFrame(width, height, { monochrome = false } = {}) {
  const background = monochrome
    ? { r: 80, g: 80, b: 80 }
    : { r: 18, g: 75, b: 150 };
  const foreground = monochrome
    ? { r: 180, g: 180, b: 180, alpha: 1 }
    : { r: 210, g: 45, b: 28, alpha: 1 };
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{
      input: {
        create: {
          width: Math.round(width * 0.55),
          height: Math.round(height * 0.5),
          channels: 4,
          background: foreground,
        },
      },
      left: Math.round(width * 0.12),
      top: Math.round(height * 0.15),
    }])
    .jpeg({ quality: 93 })
    .toBuffer();
}

test("fresh recording unavailability retries once, then becomes terminal", async () => {
  const failures = [];
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markFailed(id, failure) {
        failures.push({ id, failure });
        return { id };
      },
    },
    fileStorage: {
      async saveDerivedImageAtomic() { assert.fail("an unavailable recording must not write"); },
      async deleteImage() { assert.fail("an unavailable recording must not delete"); },
    },
  });
  service.selectBestFrame = async () => {
    throw new BlueIrisError("RECORDING_UNAVAILABLE", "Recording is still maturing.", {
      details: { requestedSampleCount: 61, unavailableSampleCount: 61 },
    });
  };

  const first = await service.processOverviewRead({
    read: overviewRead({ vehicle_image_attempt_count: 1 }),
    profile: overviewProfile(),
    camera: "Cam149",
    alreadyClaimed: true,
  });
  const second = await service.processOverviewRead({
    read: overviewRead({ id: 902, vehicle_image_attempt_count: 2 }),
    profile: overviewProfile(),
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(first.status, "retry_scheduled");
  assert.ok(Date.parse(first.nextAttemptAt) > Date.now());
  assert.equal(failures[0].failure.status, "failed");
  assert.equal(failures[0].failure.retryable, true);
  assert.equal(failures[0].failure.claimToken, CLAIM_TOKEN);
  assert.deepEqual(
    failures[0].failure.selectionMetadata.failure.telemetry,
    { requestedSampleCount: 61, unavailableSampleCount: 61 }
  );
  assert.equal(second.status, "unavailable");
  assert.equal(failures[1].failure.status, "unavailable");
  assert.equal(failures[1].failure.retryable, false);
  assert.equal(failures[1].failure.nextAttemptAt, null);
});

test("monochrome Street Overview samples fail before detection, refetch, or save", async () => {
  const monochrome = await patternedFrame(320, 180, { monochrome: true });
  let fetchCount = 0;
  let failed = null;
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg({ timestamp, width, height }) {
        assert.equal(width, undefined);
        assert.equal(height, undefined);
        fetchCount += 1;
        return { buffer: monochrome, timestamp: new Date(timestamp).toISOString() };
      },
    },
    detector: {
      async detectAll() { assert.fail("monochrome source frames must not reach detection"); },
    },
    repository: {
      async markFailed(id, failure) {
        failed = { id, failure };
        return { id };
      },
    },
    fileStorage: {
      async saveDerivedImageAtomic() { assert.fail("monochrome source frames must not be saved"); },
      async deleteImage() { assert.fail("monochrome source frames must not be deleted"); },
    },
  });

  const result = await service.processOverviewRead({
    read: overviewRead(),
    profile: overviewProfile({ tolerance_ms: 250 }),
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(fetchCount, 61);
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "NIGHTTIME_UNAVAILABLE");
  assert.equal(failed.failure.retryable, false);
  assert.equal(failed.failure.selectionMetadata.failure.telemetry.monochromeSampleCount, 61);
  assert.equal(failed.failure.selectionMetadata.failure.telemetry.rawDetectionCount, 0);
});

test("confirmed monochrome source remains terminal when other samples are not yet recorded", async () => {
  const monochrome = await patternedFrame(320, 180, { monochrome: true });
  let fetchCount = 0;
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg({ timestamp }) {
        fetchCount += 1;
        if (fetchCount === 1) {
          return { buffer: monochrome, timestamp: new Date(timestamp).toISOString() };
        }
        throw new BlueIrisError("RECORDING_UNAVAILABLE", "Sample is not finalized.");
      },
    },
    detector: {
      async detectAll() { assert.fail("confirmed monochrome samples must not reach detection"); },
    },
    repository: {},
    fileStorage: {},
  });

  await assert.rejects(
    service.selectBestFrame({
      camera: "Cam149",
      timestamp: new Date(),
      selectionMode: "overview_anchor",
      anchorToleranceMs: 250,
      sampleOffsetsMs: [0, 100],
      requireColor: true,
    }),
    (error) => {
      assert.equal(error.code, "NIGHTTIME_UNAVAILABLE");
      assert.equal(error.details.monochromeSampleCount, 1);
      assert.equal(error.details.unavailableSampleCount, 1);
      return true;
    }
  );
});

test("maximum-resolution refetch uses the exact selected timestamp and preserves Blue Iris JPEG bytes", async () => {
  const analysis = await patternedFrame(1280, 720);
  const maximum = await patternedFrame(3840, 2160);
  const detection = selectedOverview(analysis).best.detection;
  let request = null;
  const service = new BlueIrisVehicleFrameService({
    client: {
      async fetchTimelineJpeg(input) {
        request = input;
        return { buffer: maximum, timestamp: input.timestamp };
      },
    },
    detector: { async detectAll() { return [{ ...detection }]; } },
    repository: {},
    fileStorage: {},
  });

  const result = await service.refetchOverviewFrame({
    camera: "Cam149",
    selected: selectedOverview(analysis).best,
  });

  assert.deepEqual(request, {
    camera: "Cam149",
    timestamp: FRAME_TIMESTAMP,
    width: 3840,
    height: 2160,
  });
  assert.equal(result.buffer, maximum);
  assert.deepEqual([result.width, result.height, result.mode], [3840, 2160, "maximum_resolution"]);
  assert.ok(result.identitySimilarity >= 0.82);
  assert.ok(result.detectionOverlap >= 0.4);
});

test("the third exact-timestamp refetch can succeed without changing frame ownership", async () => {
  const saved = [];
  let readyFrame = null;
  let refetchCount = 0;
  const selected = selectedOverview(Buffer.from("exact-low-resolution-frame"));
  const maximum = Buffer.from("third-attempt-maximum-resolution-jpeg");
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markReady(id, frame) {
        readyFrame = frame;
        return { id };
      },
      async markFailed() { assert.fail("a successful third refetch must not fail the read"); },
    },
    fileStorage: {
      async saveDerivedImageAtomic(framePath, buffer) { saved.push({ framePath, buffer }); },
      async deleteImage() {},
    },
  });
  service.selectBestFrame = async () => selected;
  service.refetchOverviewFrame = async ({ camera, selected: selectedFrame }) => {
    refetchCount += 1;
    assert.equal(camera, "Cam149");
    assert.equal(selectedFrame.timestamp, FRAME_TIMESTAMP);
    if (refetchCount === 1) {
      throw new BlueIrisError("FINAL_FRAME_UNAVAILABLE", "Blue Iris is still finalizing the frame.");
    }
    if (refetchCount === 2) {
      throw new BlueIrisError("FINAL_FRAME_IDENTITY_MISMATCH", "Validation was not stable yet.", {
        details: { identitySimilarity: 0.74, detectionOverlap: 0.22, ignored: "not persisted" },
      });
    }
    return {
      buffer: maximum,
      timestamp: FRAME_TIMESTAMP,
      width: 3840,
      height: 2160,
      identitySimilarity: 0.99,
      detectionOverlap: 0.95,
      detectionContinuity: 0.97,
      mode: "maximum_resolution",
    };
  };

  const result = await service.processOverviewRead({
    read: overviewRead(),
    profile: overviewProfile(),
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.finalImageMode, "maximum_resolution");
  assert.equal(refetchCount, 3);
  assert.equal(saved[0].buffer, maximum);
  assert.equal(readyFrame.frameTimestamp, FRAME_TIMESTAMP);
  assert.equal(readyFrame.selectionMetadata.finalImage.attemptCount, 3);
  assert.deepEqual(
    readyFrame.selectionMetadata.finalImage.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.errorCode || null]),
    [[1, "failed", "FINAL_FRAME_UNAVAILABLE"], [2, "failed", "FINAL_FRAME_IDENTITY_MISMATCH"], [3, "ready", null]]
  );
  assert.deepEqual(readyFrame.selectionMetadata.finalImage.attempts[1].details, {
    identitySimilarity: 0.74,
    detectionOverlap: 0.22,
  });
  assert.equal(readyFrame.selectionMetadata.finalImage.fallbackErrorCode, null);
});

test("three failed exact-timestamp validations fall back only to the selected analysis frame", async () => {
  const saved = [];
  let readyFrame = null;
  let refetchCount = 0;
  const selected = selectedOverview(Buffer.from("exact-low-resolution-frame"));
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markReady(id, frame) {
        readyFrame = frame;
        return { id };
      },
      async markFailed() { assert.fail("validated fallback must not fail the read"); },
    },
    fileStorage: {
      async saveDerivedImageAtomic(framePath, buffer) { saved.push({ framePath, buffer }); },
      async deleteImage() {},
    },
  });
  service.selectBestFrame = async () => selected;
  service.refetchOverviewFrame = async () => {
    refetchCount += 1;
    throw new BlueIrisError(
      refetchCount === 3 ? "FINAL_FRAME_IDENTITY_MISMATCH" : "FINAL_FRAME_UNAVAILABLE",
      "Refetch validation failed.",
      { details: refetchCount === 3 ? { identitySimilarity: 0.71, detectionContinuity: 0.4 } : null }
    );
  };

  const result = await service.processOverviewRead({
    read: overviewRead(),
    profile: overviewProfile(),
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.finalImageMode, "validated_analysis_fallback");
  assert.equal(refetchCount, 3);
  assert.equal(saved[0].buffer, selected.best.buffer);
  assert.equal(readyFrame.frameTimestamp, FRAME_TIMESTAMP);
  assert.equal(readyFrame.selectionMetadata.finalImage.fallbackErrorCode, "FINAL_FRAME_IDENTITY_MISMATCH");
  assert.equal(readyFrame.selectionMetadata.finalImage.attemptCount, 3);
  assert.deepEqual(
    readyFrame.selectionMetadata.finalImage.attempts.map((attempt) => attempt.errorCode),
    ["FINAL_FRAME_UNAVAILABLE", "FINAL_FRAME_UNAVAILABLE", "FINAL_FRAME_IDENTITY_MISMATCH"]
  );
  assert.deepEqual(readyFrame.selectionMetadata.finalImage.attempts[2].details, {
    identitySimilarity: 0.71,
    detectionContinuity: 0.4,
  });
});

test("a stale claim cannot publish and deletes only its attempt-specific derived file", async () => {
  const saved = [];
  const deleted = [];
  const released = [];
  const oldPath = "derived/2026/08/09/winner.jpg";
  const service = new BlueIrisVehicleFrameService({
    client: {},
    repository: {
      async markReady() { return null; },
      async releaseOverviewReadClaim(id, claimToken) { released.push({ id, claimToken }); },
      async markFailed() { assert.fail("a CAS loss is not a frame-selection failure"); },
    },
    fileStorage: {
      async saveDerivedImageAtomic(framePath) { saved.push(framePath); },
      async deleteImage(framePath) { deleted.push(framePath); },
    },
  });
  service.selectBestFrame = async () => selectedOverview();
  service.refetchOverviewFrame = async ({ selected }) => ({
    buffer: Buffer.from("maximum"),
    timestamp: selected.timestamp,
    width: 3840,
    height: 2160,
    identitySimilarity: 0.99,
    detectionOverlap: 0.99,
    detectionContinuity: 0.99,
    mode: "maximum_resolution",
  });

  const result = await service.processOverviewRead({
    read: overviewRead({ vehicle_image_path: oldPath }),
    profile: overviewProfile(),
    camera: "Cam149",
    alreadyClaimed: true,
  });

  assert.equal(result.status, "superseded");
  assert.equal(saved.length, 1);
  assert.match(saved[0], /11111111111141118111111111111111\.jpg$/);
  assert.deepEqual(deleted, [saved[0]]);
  assert.notEqual(deleted[0], oldPath);
  assert.deepEqual(released, []);
});

test("a deadline crossed during atomic save deletes only its attempt file and fails terminally", async () => {
  const originalDateNow = Date.now;
  const saved = [];
  const deleted = [];
  const failures = [];
  let now = 1_000;
  Date.now = () => now;
  try {
    const service = new BlueIrisVehicleFrameService({
      client: {},
      repository: {
        async markReady() { assert.fail("an expired worker must not attempt the READY commit"); },
        async markFailed(id, failure) {
          failures.push({ id, failure });
          return { id };
        },
        async releaseOverviewReadClaim() {
          assert.fail("deadline expiry must not requeue through claim release");
        },
      },
      fileStorage: {
        async saveDerivedImageAtomic(framePath) {
          saved.push(framePath);
          now = 3_000;
        },
        async deleteImage(framePath) { deleted.push(framePath); },
      },
    });
    service.selectBestFrame = async () => selectedOverview();
    service.refetchOverviewFrame = async ({ selected }) => ({
      buffer: Buffer.from("maximum"),
      timestamp: selected.timestamp,
      width: 3840,
      height: 2160,
      identitySimilarity: 0.99,
      detectionOverlap: 0.99,
      detectionContinuity: 0.99,
      mode: "maximum_resolution",
    });

    const result = await service.processOverviewRead({
      read: overviewRead({
        vehicle_image_attempt_count: 2,
        vehicle_image_hard_deadline_at: new Date(2_000).toISOString(),
      }),
      profile: overviewProfile(),
      camera: "Cam149",
      alreadyClaimed: true,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "OVERVIEW_PROCESSING_DEADLINE");
    assert.equal(saved.length, 1);
    assert.deepEqual(deleted, saved);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failure.retryable, false);
    assert.equal(failures[0].failure.errorCode, "OVERVIEW_PROCESSING_DEADLINE");
  } finally {
    Date.now = originalDateNow;
  }
});

test("repository completion and failure updates are guarded by the current claim token", async () => {
  const statements = [];
  const values = [];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql, parameters) {
      statements.push(sql);
      values.push(parameters);
      return { rows: [] };
    },
  });

  const ready = await repository.markReady(901, {
    framePath: "derived/attempt.jpg",
    frameTimestamp: FRAME_TIMESTAMP,
    frameScore: 0.9,
    detectionConfidence: 0.9,
    detectionBox: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 },
    imageWidth: 3840,
    imageHeight: 2160,
    sampledCount: 61,
    selectionMetadata: {},
    sourceKind: "overview_primary",
  }, {
    claimToken: CLAIM_TOKEN,
    exportToken: "22222222-2222-4222-8222-222222222222",
    profileSnapshot: { id: 42, revision: 7 },
  });
  const failed = await repository.markFailed(901, {
    status: "failed",
    errorCode: "RECORDING_UNAVAILABLE",
    retryable: true,
    claimToken: CLAIM_TOKEN,
    nextAttemptAt: new Date().toISOString(),
    selectionMetadata: { failure: { code: "RECORDING_UNAVAILABLE" } },
    profileSnapshot: { id: 42, revision: 7 },
  });
  const released = await repository.releaseOverviewReadClaim(901, CLAIM_TOKEN);

  assert.equal(ready, null);
  assert.equal(failed, null);
  assert.equal(released, null);
  assert.match(statements[0], /vehicle_image_claim_token = \$12::uuid/);
  assert.match(statements[0], /\$12::uuid IS NULL OR vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP/);
  assert.match(statements[0], /exports\.export_token = \$13::uuid/);
  assert.match(statements[0], /exports\.pair_profile_id IS NOT DISTINCT FROM \$14::bigint/);
  assert.match(statements[0], /exports\.profile_revision IS NOT DISTINCT FROM \$15::bigint/);
  assert.match(statements[1], /vehicle_image_claim_token = \$7::uuid/);
  assert.doesNotMatch(statements[0], /profile\.updated_at/);
  assert.doesNotMatch(statements[1], /profile\.updated_at/);
  assert.equal(values[0][11], CLAIM_TOKEN);
  assert.equal(values[1][6], CLAIM_TOKEN);
  assert.deepEqual(values[0].slice(12), [
    "22222222-2222-4222-8222-222222222222",
    42,
    7,
  ]);
  assert.equal(values[1].length, 7);
  assert.match(statements[2], /vehicle_image_claim_token = \$2::uuid/);
  assert.match(statements[2], /vehicle_image_hard_deadline_at > CURRENT_TIMESTAMP/);
});

test("atomic derived writes leave a complete final file and no temporary attempt", async () => {
  const temporaryRoot = path.join(os.tmpdir(), `alpr-overview-${crypto.randomUUID()}`);
  const storage = new FileStorage({ baseDir: temporaryRoot });
  try {
    await storage.initialize();
    const relativePath = "derived/2026/08/09/attempt.jpg";
    const content = Buffer.from("complete-jpeg-bytes");
    await storage.saveDerivedImageAtomic(relativePath, content);
    assert.deepEqual(await fs.readFile(path.join(temporaryRoot, ...relativePath.split("/"))), content);
    const files = await fs.readdir(path.join(temporaryRoot, "derived", "2026", "08", "09"));
    assert.deepEqual(files, ["attempt.jpg"]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the additive migration enforces primary tolerance and claim safety", async () => {
  const migrations = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  assert.match(migrations, /vehicle_image_claim_token UUID/);
  assert.match(migrations, /vehicle_image_next_attempt_at TIMESTAMPTZ/);
  assert.match(migrations, /vehicle_overview_primary_tolerance_ms_check/);
  assert.match(migrations, /source_role <> 'primary' OR tolerance_ms <= 3000/);
  assert.match(migrations, /vehicle_overview_distinct_camera_check/);
  assert.match(migrations, /vehicle_overview_primary_tolerance_ms_check[\s\S]*?\) NOT VALID;/);
  assert.match(migrations, /vehicle_overview_distinct_camera_check[\s\S]*?\) NOT VALID;/);
  assert.match(migrations, /2026080901_overview_primary_claim_safety/);

  const statusConstraints = [...migrations.matchAll(
    /ADD CONSTRAINT plate_reads_vehicle_image_status_check\s+CHECK \(vehicle_image_status IS NULL OR vehicle_image_status IN \(([^)]+)\)\)/g
  )];
  assert.ok(statusConstraints.length >= 2);
  assert.ok(statusConstraints.every((match) => match[1].includes("'processing'")));

  const queueConstraints = [...migrations.matchAll(
    /ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check\s+CHECK \(vehicle_image_queue_kind IS NULL OR vehicle_image_queue_kind IN \(([^)]+)\)\)/g
  )];
  assert.ok(queueConstraints.length >= 2);
  assert.ok(queueConstraints.every((match) => match[1].includes("'overview'")));
});

test("timeline export migration is read-owned, bounded, and leaves Clipboard retention to Blue Iris", async () => {
  const migrations = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  const section = migrations.slice(migrations.indexOf("-- Timeline exports replace"));
  assert.match(section, /blue_iris_timeline_exports/);
  assert.match(section, /REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/);
  assert.match(section, /vehicle_image_hard_deadline_at TIMESTAMPTZ/);
  assert.match(section, /remote_utc_ms BIGINT/);
  assert.match(section, /remote_duration_ms INTEGER/);
  assert.match(section, /next_delete_attempt_at TIMESTAMPTZ/);
  assert.match(section, /hard_deadline_at TIMESTAMPTZ NOT NULL/);
  assert.match(section, /2026080902_blue_iris_timeline_exports/);
  assert.match(section, /2026080903_blue_iris_clipboard_retention/);
  assert.match(section, /2026081001_overview_export_idempotency/);
  assert.match(section, /revision BIGINT NOT NULL DEFAULT 1/);
  assert.match(section, /export_key CHAR\(64\)/);
  assert.match(section, /automatic_start_count SMALLINT NOT NULL DEFAULT 0/);
  assert.match(section, /ON public\.blue_iris_timeline_exports \(export_key\)[\s\S]*?WHERE export_key IS NOT NULL/);
  assert.match(section, /legacy_imported BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(section, /legacy_imported = TRUE/);
  assert.match(section, /WHERE status IN \('delete_pending', 'deleting'\)/);
  assert.match(section, /SET status = CASE WHEN downloaded_at IS NOT NULL THEN 'downloaded' ELSE 'failed' END/);
  assert.doesNotMatch(section, /ON DELETE RESTRICT/);
});

test("compose database startup fails closed on any migration error", async () => {
  const composeFiles = await Promise.all([
    fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    fs.readFile(new URL("../docker-compose-dbonly.yml", import.meta.url), "utf8"),
  ]);
  for (const compose of composeFiles) {
    assert.match(compose, /set -e;/);
    assert.match(compose, /psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f \/migrations\.sql/);
  }
});
