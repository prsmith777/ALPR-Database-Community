import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildEntryLprFallbackDecisions,
  EntryLprRouteFallbackService,
  entryLprRouteFallbackInternals,
} from "../lib/entry-lpr-route-fallback.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BASE = Date.parse("2026-08-10T18:00:00.000Z");

function target(overrides = {}) {
  return {
    id: 39380,
    plate_number: "BZGJ52",
    camera_name: "Street LPR 2",
    timestamp: new Date(BASE).toISOString(),
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Eastbound",
    vehicle_image_path: null,
    vehicle_image_status: "failed",
    vehicle_image_retryable: false,
    vehicle_image_queue_kind: "overview",
    vehicle_image_claim_token: null,
    vehicle_image_error_code: "VEHICLE_NOT_VISIBLE",
    route_profile_id: 11,
    route_name: "Street eastbound entering driveway",
    route_revision: 1,
    route_target_camera_name: "Street LPR 2",
    route_target_direction_label: "Eastbound",
    route_source_direction_label: "Entering",
    route_source_camera_names: ["Entry LPR 1", "Entry LPR 2"],
    route_expected_delta_ms: 10_600,
    route_tolerance_ms: 3_000,
    route_event_window_ms: 3_000,
    route_minimum_source_count: 2,
    route_priority: 0,
    ...overrides,
  };
}

function source(id, cameraName, offsetMs, plateNumber, overrides = {}) {
  return {
    id,
    plate_number: plateNumber,
    camera_name: cameraName,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    image_path: `images/${id}.jpg`,
    bi_trigger_direction_status: "ready",
    bi_trigger_direction_label: "Entering",
    crop_box: { left: 120, top: 90, width: 900, height: 550 },
    image_width: 1600,
    image_height: 900,
    detection_confidence: 0.82,
    color_evaluated: true,
    color_reason: null,
    ...overrides,
  };
}

test("BZGJ52 entering route uses two Entry cameras and permits one corroborating OCR error", () => {
  const currentTarget = target();
  const decisions = buildEntryLprFallbackDecisions({
    targets: [currentTarget],
    sourcesByTarget: new Map([[
      currentTarget.id,
      [
        source(39381, "Entry LPR 1", 9_854, "BZGJ52", { detection_confidence: 0.78 }),
        source(39382, "Entry LPR 2", 11_338, "8ZGJJ52", { detection_confidence: 0.94 }),
      ],
    ]]),
    now: BASE + 30_000,
  });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "proposed");
  assert.equal(decisions[0].reason, "UNIQUE_ENTRY_ROUTE_EVENT");
  assert.equal(decisions[0].sourceReadId, 39382, "image quality wins after identity is established");
  assert.deepEqual(decisions[0].corroboratingReadIds, [39381]);
  assert.equal(decisions[0].metadata.plateEvidenceClass, "exact_with_dual_camera_fuzzy_corroboration");
  assert.match(decisions[0].sourceEventKey, /^[0-9a-f]{64}$/);
});

test("approved exiting route supports an earlier dual-camera Entry event", () => {
  const currentTarget = target({
    id: 39387,
    plate_number: "BZG5J52",
    camera_name: "Street LPR 1",
    route_profile_id: 12,
    route_name: "Driveway exiting to Street eastbound",
    route_target_camera_name: "Street LPR 1",
    route_source_direction_label: "Exiting",
    route_expected_delta_ms: -10_600,
  });
  const sources = [
    source(39385, "Entry LPR 1", -11_379, "BZGJ52", { bi_trigger_direction_label: "Exiting" }),
    source(39386, "Entry LPR 2", -9_962, "BZGJ52", { bi_trigger_direction_label: "Exiting" }),
  ];
  const [decision] = buildEntryLprFallbackDecisions({
    targets: [currentTarget],
    sourcesByTarget: new Map([[currentTarget.id, sources]]),
    now: BASE + 20_000,
  });
  assert.equal(decision.status, "proposed");
  assert.equal(decision.metadata.plateEvidenceClass, "dual_camera_fuzzy");
  assert.equal(decision.metadata.sourceDirectionLabel, "Exiting");
});

test("one Entry camera, nighttime source, wrong direction, and unsupported target do not propose", () => {
  const cases = [
    [target({ id: 1 }), [source(10, "Entry LPR 1", 10_000, "BZGJ52")]],
    [target({ id: 2 }), [
      source(20, "Entry LPR 1", 10_000, "BZGJ52", { color_reason: "monochrome_capture" }),
      source(21, "Entry LPR 2", 11_000, "BZGJ52"),
    ]],
    [target({ id: 3 }), [
      source(30, "Entry LPR 1", 10_000, "BZGJ52", { bi_trigger_direction_label: "Exiting" }),
      source(31, "Entry LPR 2", 11_000, "BZGJ52", { bi_trigger_direction_label: "Exiting" }),
    ]],
    [target({ id: 4, camera_name: "Street LPR 2", bi_trigger_direction_label: "Westbound" }), [
      source(40, "Entry LPR 1", 10_000, "BZGJ52"),
      source(41, "Entry LPR 2", 11_000, "BZGJ52"),
    ]],
  ];
  for (const [currentTarget, sources] of cases) {
    const decisions = buildEntryLprFallbackDecisions({
      targets: [currentTarget],
      sourcesByTarget: new Map([[currentTarget.id, sources]]),
      now: BASE + 30_000,
    });
    if (currentTarget.id === 4) assert.equal(decisions.length, 0);
    else assert.equal(decisions[0].status, "rejected");
  }
});

test("two plausible Entry events fail closed and one event cannot serve two Street targets", () => {
  const currentTarget = target();
  const sources = [
    source(101, "Entry LPR 1", 9_500, "BZGJ52"),
    source(102, "Entry LPR 2", 10_000, "BZGJ52"),
    source(103, "Entry LPR 1", 11_800, "BZGJ52"),
    source(104, "Entry LPR 2", 12_200, "BZGJ52"),
  ];
  const [ambiguous] = buildEntryLprFallbackDecisions({
    targets: [currentTarget],
    sourcesByTarget: new Map([[currentTarget.id, sources]]),
    now: BASE + 30_000,
  });
  assert.equal(ambiguous.status, "rejected");
  assert.equal(ambiguous.reason, "ENTRY_FALLBACK_AMBIGUOUS");

  const secondTarget = target({ id: 39390, timestamp: new Date(BASE + 100).toISOString() });
  const sharedSources = [source(111, "Entry LPR 1", 10_000, "BZGJ52"), source(112, "Entry LPR 2", 11_000, "BZGJ52")];
  const competing = buildEntryLprFallbackDecisions({
    targets: [currentTarget, secondTarget],
    sourcesByTarget: new Map([[currentTarget.id, sharedSources], [secondTarget.id, sharedSources]]),
    now: BASE + 30_000,
  });
  assert.equal(competing.length, 2);
  assert.ok(competing.every((decision) => decision.reason === "ENTRY_EVENT_COMPETES_FOR_MULTIPLE_STREET_READS"));
});

test("active service copies a read-owned full image to a unique target path", async () => {
  const writes = [];
  const repository = {
    async getEntryFallbackSettings() { return { mode: "active", observation_started_at: new Date(BASE) }; },
    async listEntryFallbackTargets() { return []; },
    async listEntryFallbackSourceReads() { return []; },
    async recordEntryFallbackDecisions() { return 0; },
    async claimNextEntryFallback() {
      return {
        id: 8,
        claim_token: "5ee6970f-1679-4d04-81d9-913e850b6d84",
        target_read_id: 99,
        source_read_id: 88,
        source_image_path_snapshot: "images/88.jpg",
        target_read_timestamp: new Date(BASE).toISOString(),
      };
    },
    async withDerivedStorageWriterLock(operation) { return operation(this); },
    async applyEntryFallback(id, token, targetPath) {
      writes.push({ id, token, targetPath });
      return { id, target_read_id: 99, source_read_id: 88 };
    },
    async markEntryFallbackFailed() { throw new Error("should not fail"); },
  };
  const fileStorage = {
    async getImage() { return Buffer.from("full-entry-image"); },
    async saveDerivedImageAtomic(targetPath, buffer) { writes.push({ targetPath, buffer: buffer.toString() }); },
    async deleteImage() {},
  };
  const result = await new EntryLprRouteFallbackService({ repository, fileStorage }).processNext();
  assert.equal(result.status, "shared");
  assert.equal(result.sourceReadId, 88);
  assert.equal(result.targetReadId, 99);
  assert.match(result.framePath, /entry_lpr_vehicle_99_5ee6970f16794d0481d9913e850b6d84\.jpg$/);
  assert.equal(writes[0].buffer, "full-entry-image");
});

test("OCR helper allows one normalized edit but not broad fuzzy matching", () => {
  assert.equal(entryLprRouteFallbackInternals.editDistanceAtMostOne("BZGJ52", "8ZGJJ52"), true);
  assert.equal(entryLprRouteFallbackInternals.editDistanceAtMostOne("BZGJ52", "ABC123"), false);
});

test("Entry fallback migration is additive, shadow-first, and read-to-read only", () => {
  const migration = fs.readFileSync(path.join(ROOT, "migrations.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_entry_fallback_settings/);
  assert.match(migration, /mode VARCHAR\(12\) NOT NULL DEFAULT 'shadow'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_entry_route_profiles/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_entry_fallback_decisions/);
  assert.match(migration, /'overview_pair_share','entry_lpr_fallback'/);
  assert.match(migration, /target_read_id INTEGER NOT NULL REFERENCES public\.plate_reads/);
  assert.match(migration, /source_read_id INTEGER REFERENCES public\.plate_reads/);
  assert.doesNotMatch(migration.slice(migration.indexOf("2026081004_entry_lpr_route_fallback") - 5_000), /vehicle_overview_candidates/);
});
