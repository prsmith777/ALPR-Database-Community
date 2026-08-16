import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  evaluateVehicleReidV2Reviews,
  vehicleReidV2EvaluationInternals,
} from "../lib/vehicle-reid-v2-evaluation.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

function review(overrides = {}) {
  return {
    label: "different_vehicle",
    similarity_score: 0.82,
    evidence_context_low: "street",
    evidence_context_high: "street",
    evidence_camera_low: "Street LPR 1",
    evidence_camera_high: "Street LPR 2",
    evidence_plate_low: "ABC123",
    evidence_plate_high: "XYZ789",
    evidence_timestamp_low: "2026-08-15T18:00:00.000Z",
    evidence_timestamp_high: "2026-08-15T18:00:03.000Z",
    evaluation_time_zone: "America/Denver",
    ...overrides,
  };
}

test("stratified evaluation exposes overlap and never recommends or applies a cutoff", () => {
  const rows = [
    review({ label: "same_vehicle", similarity_score: 0.584, evidence_plate_high: "ABC123" }),
    review({ label: "same_vehicle", similarity_score: 0.91, evidence_plate_high: "ABC123" }),
    review({ label: "different_vehicle", similarity_score: 0.335 }),
    review({ label: "different_vehicle", similarity_score: 0.861 }),
    review({ label: "unsure", similarity_score: 0.8, evidence_plate_high: null }),
  ];
  const result = evaluateVehicleReidV2Reviews(rows);
  assert.equal(result.total, 5);
  assert.equal(result.decisive, 4);
  assert.equal(result.separation.perfectGlobalSeparation, false);
  assert.equal(result.separation.overlapMinimum, 58.4);
  assert.equal(result.separation.overlapMaximum, 86.1);
  assert.equal(result.separation.sameInOverlap, 1);
  assert.equal(result.separation.differentInOverlap, 1);
  assert.equal(result.separation.unsureInOverlap, 1);
  assert.equal(result.thresholdApplied, false);
  assert.equal(result.recommendation, null);
  assert.equal(result.profileWritten, false);
  assert.equal(result.assignmentWritten, false);
});

test("evaluation stratifies score, camera, context, plate, and local capture periods", () => {
  const result = evaluateVehicleReidV2Reviews([
    review({ label: "same_vehicle", similarity_score: 0.92, evidence_plate_high: "ABC-123" }),
    review({
      label: "different_vehicle",
      similarity_score: 0.68,
      evidence_context_low: "entry",
      evidence_context_high: "entry",
      evidence_camera_low: "Entry LPR 2",
      evidence_camera_high: "Entry LPR 1",
      evidence_plate_low: null,
      evidence_timestamp_low: "2026-08-15T04:00:00.000Z",
      evidence_timestamp_high: "2026-08-15T04:00:02.000Z",
    }),
  ]);
  assert.equal(result.byScoreBand.find((group) => group.key === "90–100%").sameVehicle, 1);
  assert.equal(result.byScoreBand.find((group) => group.key === "60–69.9%").differentVehicle, 1);
  assert.equal(result.byCameraPair[0].key, "Entry LPR 1 ↔ Entry LPR 2");
  assert.ok(result.byContext.some((group) => group.key === "entry ↔ entry"));
  assert.ok(result.byPlateEvidence.some((group) => group.key === "same effective plate"));
  assert.ok(result.byPlateEvidence.some((group) => (
    group.key === "incomplete effective-plate evidence"
  )));
  assert.ok(result.byLocalPeriod.some((group) => (
    group.key === "daytime hours (06:00–19:59) ↔ daytime hours (06:00–19:59)"
  )));
  assert.ok(result.byLocalPeriod.some((group) => (
    group.key === "overnight hours (20:00–05:59) ↔ overnight hours (20:00–05:59)"
  )));
});

test("targeted gaps are bounded descriptive coverage requests rather than broad review", () => {
  const rows = [
    review({ label: "same_vehicle", similarity_score: 0.82 }),
    review({ label: "different_vehicle", similarity_score: 0.83 }),
    review({ label: "different_vehicle", similarity_score: 0.84 }),
  ];
  const result = evaluateVehicleReidV2Reviews(rows);
  assert.ok(result.targetedGaps.length > 0);
  assert.ok(result.targetedGaps.length <= 8);
  assert.equal(result.targetedCoverageFloor, 3);
  assert.equal(result.targetedOverlapBandFloor, 5);
  assert.ok(result.targetedGaps.some((gap) => gap.dimension === "overlapping score band"));
  assert.ok(result.targetedGaps.every((gap) => (
    gap.neededSameVehicle > 0 || gap.neededDifferentVehicle > 0
  )));
});

test("invalid labels and scores are excluded and invalid timezones fail closed", () => {
  const result = evaluateVehicleReidV2Reviews([
    review({ label: "automatic_match" }),
    review({ similarity_score: 2 }),
    review({ label: "same_vehicle", evaluation_time_zone: "not/a-zone" }),
  ]);
  assert.equal(result.total, 1);
  assert.equal(result.timeZone, "America/Denver");
  assert.equal(vehicleReidV2EvaluationInternals.validTimeZone("not/a-zone"), "America/Denver");
  assert.equal(
    vehicleReidV2EvaluationInternals.localPeriod(null, "America/Denver"),
    "unknown local time"
  );
});

test("repository evaluation evidence is bounded, read-only, and retains review snapshots", async () => {
  const calls = [];
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    },
  });
  await repository.listPairReviewCalibration();
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /reviews\.evidence_plate_low/);
  assert.match(calls[0].text, /low_reads\.timestamp::text AS evidence_timestamp_low/);
  assert.match(calls[0].text, /high_reads\.timestamp::text AS evidence_timestamp_high/);
  assert.match(calls[0].text, /COALESCE\(settings\.local_timezone, 'America\/Denver'\)/);
  assert.match(calls[0].text, /LEFT JOIN public\.plate_reads/);
  assert.doesNotMatch(calls[0].text, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
});

test("ReID v2 UI labels evaluation as offline, stratified, and assignment-safe", async () => {
  const [component, service, evaluation] = await Promise.all([
    source("components/VehicleReidV2Shadow.jsx"),
    source("lib/vehicle-reid-v2-shadow.mjs"),
    source("lib/vehicle-reid-v2-evaluation.mjs"),
  ]);
  assert.match(component, /Stratified offline evaluation/);
  assert.match(component, /applies no threshold and writes no profile, cluster, or assignment/);
  assert.match(component, /not a request to review every remaining pair/);
  assert.match(component, /Effective-plate evidence/);
  assert.match(service, /evaluateVehicleReidV2Reviews/);
  assert.doesNotMatch(evaluation, /plate recognizer|plates?recognizer\.com/i);
  assert.doesNotMatch(evaluation, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
});
