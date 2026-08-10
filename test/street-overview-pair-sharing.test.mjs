import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildStreetOverviewPairDecisions,
  StreetOverviewPairSharingService,
} from "../lib/street-overview-pair-sharing.mjs";
import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

function metadata({ id, revision = 1, expectedDeltaMs, toleranceMs = 1_500 } = {}) {
  return {
    profileId: id,
    profileRevision: revision,
    sourceCameraName: "Street Overview",
    directionLabel: "Eastbound",
    expectedDeltaMs,
    toleranceMs,
  };
}

function readyRead(overrides = {}) {
  return {
    id: 101,
    plate_number: "ABC123",
    camera_name: "Street LPR 1",
    timestamp: "2026-08-10T16:00:04.000Z",
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    vehicle_image_status: "ready",
    vehicle_image_source_kind: "overview_primary",
    vehicle_image_path: "derived/source.jpg",
    vehicle_image_selection_metadata: metadata({ id: 11, expectedDeltaMs: 0 }),
    ...overrides,
  };
}

function failedRead(overrides = {}) {
  return {
    id: 102,
    plate_number: "ABC123",
    camera_name: "Street LPR 2",
    timestamp: "2026-08-10T16:00:00.000Z",
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    vehicle_image_status: "failed",
    vehicle_image_queue_kind: "overview",
    vehicle_image_retryable: false,
    vehicle_image_error_code: "VEHICLE_NOT_VISIBLE",
    vehicle_image_path: null,
    vehicle_image_claim_token: null,
    vehicle_image_selection_metadata: metadata({ id: 12, expectedDeltaMs: 4_000 }),
    ...overrides,
  };
}

test("Street pair sharing proposes one exact plate, direction, camera, and anchor match", () => {
  const decisions = buildStreetOverviewPairDecisions([readyRead(), failedRead()]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "proposed");
  assert.equal(decisions[0].reason, "UNIQUE_STREET_PAIR");
  assert.equal(decisions[0].sourceReadId, 101);
  assert.equal(decisions[0].targetReadId, 102);
  assert.equal(decisions[0].metadata.anchorDeltaMs, 0);
  assert.equal(decisions[0].metadata.actualReadDeltaMs, -4_000);
  assert.match(decisions[0].decisionIdentity, /^[0-9a-f]{64}$/);
});

test("Street pair sharing fails closed for identity, direction, camera, timing, and unsafe errors", () => {
  const variants = [
    failedRead({ plate_number: "XYZ987" }),
    failedRead({ bi_trigger_direction_label: "Westbound" }),
    failedRead({ camera_name: "Street LPR 1" }),
    failedRead({ timestamp: "2026-08-10T15:59:40.000Z" }),
    failedRead({ vehicle_image_error_code: "MULTIPLE_VEHICLES_VISIBLE" }),
    failedRead({ vehicle_image_error_code: "NIGHTTIME_UNAVAILABLE" }),
    failedRead({ vehicle_image_retryable: true }),
  ];
  for (const target of variants) {
    assert.deepEqual(buildStreetOverviewPairDecisions([readyRead(), target]), []);
  }
});

test("Street pair sharing rejects multiple eligible sources instead of choosing nearest", () => {
  const secondSource = readyRead({
    id: 103,
    timestamp: "2026-08-10T16:00:04.100Z",
    vehicle_image_path: "derived/second.jpg",
  });
  const decisions = buildStreetOverviewPairDecisions([readyRead(), secondSource, failedRead()]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "rejected");
  assert.equal(decisions[0].reason, "MULTIPLE_SOURCE_READS");
  assert.equal(decisions[0].sourceReadId, null);
  assert.deepEqual(decisions[0].metadata.candidateSourceReadIds, [101, 103]);
});

test("Street pair sharing rejects one source competing for multiple failed reads", () => {
  const secondTarget = failedRead({ id: 104, timestamp: "2026-08-10T16:00:00.100Z" });
  const decisions = buildStreetOverviewPairDecisions([readyRead(), failedRead(), secondTarget]);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((item) => item.status === "rejected"));
  assert.ok(decisions.every((item) => item.reason === "SOURCE_COMPETES_FOR_MULTIPLE_READS"));
});

test("active sharing copies source bytes to a unique target path and commits through the writer lock", async () => {
  const operations = [];
  const claim = {
    id: 91,
    claim_token: "59d89571-1788-48f5-a3fd-739cad8f0212",
    source_read_id: 101,
    target_read_id: 102,
    source_image_path_snapshot: "derived/source.jpg",
    target_read_timestamp: "2026-08-10T16:00:00.000Z",
  };
  const repository = {
    async getStreetPairSharingSettings() {
      return { mode: "active", observation_started_at: "2026-08-10T15:00:00Z" };
    },
    async listStreetPairSharingReads() { return []; },
    async recordStreetPairSharingDecisions() { return 0; },
    async claimNextStreetPairShare() { return claim; },
    async withDerivedStorageWriterLock(operation) {
      operations.push("lock");
      return operation(this);
    },
    async applyStreetPairShare(id, token, targetPath) {
      operations.push(["apply", id, token, targetPath]);
      return { id, source_read_id: 101, target_read_id: 102 };
    },
  };
  const fileStorage = {
    async getImage(sourcePath) {
      operations.push(["read", sourcePath]);
      return Buffer.from("primary-image");
    },
    async saveDerivedImageAtomic(targetPath, buffer) {
      operations.push(["save", targetPath, buffer.toString()]);
      return targetPath;
    },
    async deleteImage(targetPath) { operations.push(["delete", targetPath]); },
  };
  const result = await new StreetOverviewPairSharingService({ repository, fileStorage }).processNext();
  assert.equal(result.status, "shared");
  assert.equal(result.sourceReadId, 101);
  assert.equal(result.targetReadId, 102);
  assert.match(result.framePath, /^derived\/2026\/08\/10\/blue_iris_vehicle_pair_102_[0-9a-f]+\.jpg$/);
  assert.deepEqual(operations.map((item) => Array.isArray(item) ? item[0] : item), [
    "read", "lock", "save", "apply",
  ]);
  assert.equal(operations.find((item) => Array.isArray(item) && item[0] === "save")[2], "primary-image");
});

test("a lost target CAS deletes only the new attempt file", async () => {
  const deleted = [];
  const repository = {
    async getStreetPairSharingSettings() { return { mode: "active", observation_started_at: new Date() }; },
    async listStreetPairSharingReads() { return []; },
    async recordStreetPairSharingDecisions() { return 0; },
    async claimNextStreetPairShare() {
      return {
        id: 92,
        claim_token: "a7bbf6aa-d73f-4633-9767-58b129663f52",
        source_read_id: 201,
        target_read_id: 202,
        source_image_path_snapshot: "derived/source.jpg",
        target_read_timestamp: "2026-08-10T16:00:00Z",
      };
    },
    async withDerivedStorageWriterLock(operation) { return operation(this); },
    async applyStreetPairShare() { return null; },
  };
  const fileStorage = {
    async getImage() { return Buffer.from("image"); },
    async saveDerivedImageAtomic(targetPath) { return targetPath; },
    async deleteImage(targetPath) { deleted.push(targetPath); },
  };
  const result = await new StreetOverviewPairSharingService({ repository, fileStorage }).processNext();
  assert.equal(result.status, "superseded");
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /blue_iris_vehicle_pair_202_/);
});

test("pair-sharing migration is additive, shadow-first, and preserves independent provenance", async () => {
  const sql = await fs.readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  assert.match(sql, /2026081002_street_overview_pair_sharing/);
  assert.match(sql, /vehicle_overview_pair_sharing_settings[\s\S]+DEFAULT 'shadow'/);
  assert.match(sql, /vehicle_overview_read_shares/);
  assert.match(sql, /vehicle_image_source_read_id/);
  assert.match(sql, /overview_pair_share/);
  assert.match(sql, /target_read_id INTEGER NOT NULL UNIQUE/);
  assert.match(sql, /idx_vehicle_overview_read_shares_unique_live_source/);
});

test("repository discovery and commit SQL keep pair sharing fail-closed", async () => {
  const statements = [];
  const repository = new BlueIrisVehicleFrameRepository({
    async query(sql) {
      statements.push(sql);
      if (/WITH targets AS/.test(sql)) return { rows: [] };
      return { rows: [{ id: 44, source_read_id: 101, target_read_id: 102 }] };
    },
  });
  await repository.listStreetPairSharingReads({ startedAt: "2026-08-10T16:00:00Z" });
  await repository.applyStreetPairShare(
    44,
    "59d89571-1788-48f5-a3fd-739cad8f0212",
    "derived/target.jpg"
  );
  assert.match(statements[0], /"timestamp" >= COALESCE\(\$1::timestamptz/);
  assert.match(statements[0], /vehicle_image_error_code IN \('VEHICLE_NOT_VISIBLE','RECORDING_UNAVAILABLE'\)/);
  assert.match(statements[0], /vehicle_image_retryable = FALSE/);
  assert.match(statements[0], /vehicle_image_source_kind = 'overview_primary'/);
  assert.match(statements[1], /vehicle_image_source_kind = 'overview_pair_share'/);
  assert.match(statements[1], /vehicle_image_source_read_id = source\.id/);
  assert.match(statements[1], /target\.vehicle_image_path IS NULL/);
  assert.match(statements[1], /sharing\.claim_token = \$2::uuid/);
  assert.match(statements[1], /source\.vehicle_image_path = sharing\.source_image_path_snapshot/);
  assert.doesNotMatch(statements[1], /MULTIPLE_VEHICLES_VISIBLE|NIGHTTIME_UNAVAILABLE/);
});
