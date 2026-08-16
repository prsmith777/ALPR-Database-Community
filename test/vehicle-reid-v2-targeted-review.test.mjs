import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  cosineSimilarityFromBytes,
  VehicleReidV2ShadowService,
} from "../lib/vehicle-reid-v2-shadow.mjs";
import {
  buildVehicleReidV2TargetedReviewQueue,
  vehicleReidV2TargetedReviewInternals,
} from "../lib/vehicle-reid-v2-targeted-review.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

function embedding(cosine) {
  const bytes = Buffer.alloc(512 * 4);
  bytes.writeFloatLE(cosine, 0);
  bytes.writeFloatLE(Math.sqrt(Math.max(0, 1 - (cosine * cosine))), 4);
  return bytes;
}

function row(id, cosine, overrides = {}) {
  return {
    derivative_id: id,
    asset_id: id + 100,
    storage_path: `derived/vehicle-crops/${id}.jpg`,
    content_sha256: String(id).padStart(64, "0"),
    image_width: 320,
    image_height: 180,
    derivative_created_at: "2026-08-16 12:00:00.123456+00",
    embedding_id: id + 200,
    embedding: embedding(cosine),
    model_name: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    read_id: id + 300,
    plate_number: `PLATE${id}`,
    observed_plate: `PLATE${id}`,
    camera_name: "Street LPR 1",
    read_timestamp: `2026-08-16 1${id}:00:00.123456+00`,
    overview_context: "street",
    source_kind: "overview_primary",
    plate_numbers: [`PLATE${id}`],
    camera_names: ["Street LPR 1"],
    cluster_ids: [],
    lpr_evidence: [],
    companion_lpr_evidence: [],
    color_status: "ready",
    color_value: "red",
    color_confidence: 0.9,
    body_type_status: "ready",
    body_type_value: "car",
    body_type_confidence: 0.8,
    total_sources: "4",
    ...overrides,
  };
}

function evaluation(targetedGaps) {
  return {
    timeZone: "America/Denver",
    separation: { overlapMinimum: 58, overlapMaximum: 86 },
    targetedGaps,
  };
}

test("targeted sampler is deterministic, bounded, and excludes reviewed crop pairs", () => {
  const rows = [
    row(1, 1, { plate_number: "SAME", camera_name: "Street LPR 1" }),
    row(2, 0.65, { plate_number: "SAME", camera_name: "Street LPR 2" }),
    row(3, 0.66, { plate_number: "OTHER", camera_name: "Street LPR 2" }),
    row(4, 0.9, { plate_number: "THIRD", camera_name: "Entry LPR 1", overview_context: "entry" }),
  ];
  const options = {
    sourceRows: rows,
    reviewRows: [{ derivative_id_low: 1, derivative_id_high: 2 }],
    evaluation: evaluation([{
      dimension: "overlapping score band",
      key: "60–69.9%",
      neededSameVehicle: 1,
      neededDifferentVehicle: 1,
    }]),
    similarityFor: cosineSimilarityFromBytes,
    limit: 2,
  };
  const first = buildVehicleReidV2TargetedReviewQueue(options);
  const second = buildVehicleReidV2TargetedReviewQueue(options);
  assert.deepEqual(first, second);
  assert.ok(first.length <= 2);
  assert.ok(first.length > 0);
  assert.ok(first.every((item) => item.scoreBand === "60–69.9%"));
  assert.ok(first.every((item) => item.pairIdentity !== "1:2"));
  assert.ok(first.every((item) => ["same_vehicle", "different_vehicle"].includes(
    item.coverageAim
  )));
  assert.ok(first.every((item) => !("label" in item) && !("prediction" in item)));
});

test("targeted sampler matches camera gaps and uses plate evidence only for review priority", () => {
  const rows = [
    row(1, 1, { plate_number: "ABC123", camera_name: "Entry LPR 1", overview_context: "entry" }),
    row(2, 0.85, { plate_number: "ABC123", camera_name: "Street LPR 2" }),
    row(3, 0.8, { plate_number: "XYZ789", camera_name: "Street LPR 2" }),
  ];
  const queue = buildVehicleReidV2TargetedReviewQueue({
    sourceRows: rows,
    reviewRows: [],
    evaluation: evaluation([{
      dimension: "camera pair",
      key: "Entry LPR 1 ↔ Street LPR 2",
      neededSameVehicle: 1,
      neededDifferentVehicle: 1,
    }]),
    similarityFor: cosineSimilarityFromBytes,
    limit: 2,
  });
  assert.equal(queue.length, 2);
  assert.ok(queue.every((item) => item.cameraPair === "Entry LPR 1 ↔ Street LPR 2"));
  assert.equal(queue.find((item) => item.coverageAim === "same_vehicle").plateEvidence,
    "same effective plate");
  assert.equal(queue.find((item) => item.coverageAim === "different_vehicle").plateEvidence,
    "different effective plates");
});

test("targeted mode includes the exact recommendation even outside the ordinary result limit", async () => {
  const rows = [
    row(1, 1, { plate_number: "SAME" }),
    row(2, 0.9, { plate_number: "OTHER" }),
    row(3, 0.59, { plate_number: "SAME" }),
  ];
  const reviewRows = [
    {
      derivative_id_low: 10,
      derivative_id_high: 11,
      label: "same_vehicle",
      similarity_score: 0.58,
      evidence_context_low: "street",
      evidence_context_high: "street",
      evidence_camera_low: "Street LPR 1",
      evidence_camera_high: "Street LPR 1",
      evidence_plate_low: "OLD",
      evidence_plate_high: "OLD",
      evidence_timestamp_low: "2026-08-15T18:00:00Z",
      evidence_timestamp_high: "2026-08-15T18:00:01Z",
      evaluation_time_zone: "America/Denver",
    },
    {
      derivative_id_low: 12,
      derivative_id_high: 13,
      label: "different_vehicle",
      similarity_score: 0.59,
      evidence_context_low: "street",
      evidence_context_high: "street",
      evidence_camera_low: "Street LPR 1",
      evidence_camera_high: "Street LPR 1",
      evidence_plate_low: "OLD",
      evidence_plate_high: "OTHER",
      evidence_timestamp_low: "2026-08-15T18:00:00Z",
      evidence_timestamp_high: "2026-08-15T18:00:01Z",
      evaluation_time_zone: "America/Denver",
    },
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async getCurrentSource() { return null; },
      async listPairReviewCalibration() { return reviewRows; },
      async listPairReviewsForSource() { return []; },
    },
  });
  const overview = await service.getOverview({ targetedReview: true, resultLimit: 1 });
  assert.equal(overview.targetedReview.active, true);
  assert.ok(overview.targetedReview.current);
  assert.equal(overview.matches.length, 1);
  assert.equal(overview.matches[0].derivativeId,
    overview.targetedReview.current.candidateDerivativeId);
  assert.ok(overview.matches[0].rank > 1);
  assert.ok(overview.winnerMargin > 0);
});

test("targeted UI advances after labels and remains profile and assignment safe", async () => {
  const [page, component, controls, sampler, repository] = await Promise.all([
    source("app/visual_search/reid-v2/page.jsx"),
    source("components/VehicleReidV2Shadow.jsx"),
    source("components/VehicleReidV2PairReviewControls.jsx"),
    source("lib/vehicle-reid-v2-targeted-review.mjs"),
    source("lib/vehicle-reid-v2-shadow-repository.mjs"),
  ]);
  assert.match(page, /targetedReview: parameters\?\.targeted === "1"/);
  assert.match(page, /candidateDerivativeId/);
  assert.match(component, /Review targeted pairs/);
  assert.match(component, /coverage aim is not a predicted label/i);
  assert.match(controls, /Saving one label records one pair decision and advances/);
  assert.match(controls, /router\.push\(nextHref\)/);
  assert.match(repository, /reviews\.derivative_id_low, reviews\.derivative_id_high/);
  assert.doesNotMatch(sampler, /plate recognizer|plates?recognizer\.com/i);
  assert.doesNotMatch(sampler, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
  assert.equal(vehicleReidV2TargetedReviewInternals.MAX_SEED_SOURCES, 32);
  assert.equal(vehicleReidV2TargetedReviewInternals.MAX_QUEUE_LIMIT, 24);
});
