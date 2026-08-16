import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  cosineSimilarityFromBytes,
  VehicleReidV2ShadowService,
} from "../lib/vehicle-reid-v2-shadow.mjs";
import {
  VehicleReidV2ShadowRepository,
  vehicleReidV2ShadowRepositoryInternals,
} from "../lib/vehicle-reid-v2-shadow-repository.mjs";
import {
  canonicalVehicleReidV2ReviewPair,
  normalizeVehicleReidV2ReviewLabel,
  summarizeVehicleReidV2Reviews,
} from "../lib/vehicle-reid-v2-review.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

function embedding(values) {
  const bytes = Buffer.alloc(512 * 4);
  for (let index = 0; index < Math.min(values.length, 512); index += 1) {
    bytes.writeFloatLE(values[index], index * 4);
  }
  return bytes;
}

function row(overrides = {}) {
  const derivativeId = Number(overrides.derivative_id || 1);
  return {
    derivative_id: derivativeId,
    asset_id: derivativeId + 100,
    storage_path: `derived/vehicle-crops/${derivativeId}.jpg`,
    content_sha256: String(derivativeId).padStart(64, "0"),
    image_width: 320,
    image_height: 180,
    derivative_created_at: "2026-08-15 12:00:00.123456+00",
    embedding_id: derivativeId + 200,
    embedding: embedding([1, 0]),
    model_name: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    read_id: derivativeId + 300,
    plate_number: `PLATE${derivativeId}`,
    observed_plate: `PLATE${derivativeId}`,
    camera_name: "Street LPR 1",
    read_timestamp: "2026-08-15 12:00:00.123456+00",
    overview_context: "street",
    source_kind: "overview_primary",
    plate_numbers: [`PLATE${derivativeId}`],
    camera_names: ["Street LPR 1"],
    cluster_ids: [derivativeId + 400],
    color_status: "ready",
    color_value: "red",
    color_confidence: 0.9,
    body_type_status: "ready",
    body_type_value: "car",
    body_type_confidence: 0.8,
    total_sources: "3",
    ...overrides,
  };
}

test("cosine comparison requires valid finite 512-value embeddings", () => {
  assert.ok(Math.abs(cosineSimilarityFromBytes(embedding([1, 0]), embedding([0.8, 0.6])) - 0.8) < 1e-6);
  assert.equal(cosineSimilarityFromBytes(Buffer.alloc(4), embedding([1, 0])), null);
  assert.equal(cosineSimilarityFromBytes(embedding([]), embedding([1, 0])), null);
  const invalid = embedding([1, 0]);
  invalid.writeFloatLE(Number.NaN, 0);
  assert.equal(cosineSimilarityFromBytes(invalid, embedding([1, 0])), null);
});

test("v2 pair reviews canonicalize crop pairs and summarize labels without recommending a threshold", () => {
  assert.deepEqual(canonicalVehicleReidV2ReviewPair(20, 10), {
    sourceDerivativeId: 20,
    candidateDerivativeId: 10,
    derivativeIdLow: 10,
    derivativeIdHigh: 20,
  });
  assert.equal(normalizeVehicleReidV2ReviewLabel(" UNSURE "), "unsure");
  assert.throws(() => normalizeVehicleReidV2ReviewLabel("automatic_match"), {
    code: "INVALID_VEHICLE_REID_V2_REVIEW_LABEL",
  });
  const summary = summarizeVehicleReidV2Reviews([
    { label: "same_vehicle", similarity_score: 0.86, evidence_context_low: "entry", evidence_context_high: "entry", evidence_camera_low: "Entry LPR 1", evidence_camera_high: "Entry LPR 2" },
    { label: "same_vehicle", similarity_score: 0.58, evidence_context_low: "street", evidence_context_high: "street", evidence_camera_low: "Street LPR 1", evidence_camera_high: "Street LPR 2" },
    { label: "different_vehicle", similarity_score: 0.92, evidence_context_low: "entry", evidence_context_high: "entry", evidence_camera_low: "Entry LPR 1", evidence_camera_high: "Entry LPR 1" },
    { label: "unsure", similarity_score: 0.91, evidence_context_low: "entry", evidence_context_high: "street", evidence_camera_low: "Entry LPR 1", evidence_camera_high: "Street LPR 1" },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.sameVehicle, 2);
  assert.deepEqual(summary.sameScores, { average: 72, median: 72, minimum: 58, maximum: 86 });
  assert.equal(summary.differentScores.maximum, 92);
  assert.equal(summary.unsure, 1);
  assert.equal(summary.thresholdApplied, false);
  assert.equal(summary.recommendation, null);
  assert.equal(summary.byContext[0].key, "entry ↔ entry");
});

test("shadow ranking uses only crop cosine similarity and leaves review evidence separate", async () => {
  const rows = [
    row({ derivative_id: 1, embedding: embedding([1, 0]), plate_numbers: ["SOURCE"], cluster_ids: [700] }),
    row({
      derivative_id: 2,
      embedding: embedding([0.9, Math.sqrt(0.19)]),
      plate_numbers: ["OTHER"],
      cluster_ids: [701],
      color_value: "blue",
      body_type_value: "truck",
    }),
    row({
      derivative_id: 3,
      embedding: embedding([0.8, 0.6]),
      plate_numbers: ["SOURCE"],
      cluster_ids: [700],
      color_value: "red",
      body_type_value: "car",
    }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async getCurrentSource() { return null; },
    },
  });

  const overview = await service.getOverview({ sourceDerivativeId: 1, resultLimit: 2 });
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [2, 3]);
  assert.equal(overview.matches[0].similarity, 0.9);
  assert.equal(overview.matches[1].similarity, 0.8);
  assert.equal(overview.winnerMargin, 0.1);
  assert.deepEqual(overview.matches[0].reviewEvidence, {
    plateAgreement: false,
    currentProfileAgreement: false,
    colorAgreement: "differs",
    bodyTypeAgreement: "differs",
  });
  assert.deepEqual(overview.matches[1].reviewEvidence, {
    plateAgreement: true,
    currentProfileAgreement: true,
    colorAgreement: "agrees",
    bodyTypeAgreement: "agrees",
  });
});

test("shadow overview bounds browsing, searches current evidence, and skips invalid candidates", async () => {
  const rows = [
    row({ derivative_id: 1, camera_names: ["Street LPR 1"], total_sources: "12" }),
    row({ derivative_id: 2, camera_names: ["Entry LPR 2"], embedding: Buffer.alloc(12), total_sources: "12" }),
    row({ derivative_id: 3, camera_names: ["Street LPR 2"], total_sources: "12" }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources(options) {
        assert.deepEqual(options, { limit: 10_000 });
        return rows;
      },
      async getCurrentSource() { return null; },
    },
  });
  const overview = await service.getOverview({
    search: "entry lpr 2",
    page: 100,
    pageSize: 1,
    sourceDerivativeId: 1,
  });
  assert.equal(overview.stats.totalSources, 12);
  assert.equal(overview.stats.scannedSources, 3);
  assert.equal(overview.stats.truncated, true);
  assert.equal(overview.pagination.page, 1);
  assert.deepEqual(overview.sources.map((item) => item.derivativeId), [2]);
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [3]);
});

test("pair review recomputes immutable-crop similarity and returns calibration", async () => {
  const first = row({ derivative_id: 10, embedding: embedding([1, 0]) });
  const second = row({ derivative_id: 20, embedding: embedding([0.8, 0.6]) });
  let savedInput = null;
  const reviewRows = [];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async getCurrentSource(id) { return Number(id) === 10 ? first : Number(id) === 20 ? second : null; },
      async savePairReview(input) {
        savedInput = input;
        const saved = {
          id: 7,
          derivative_id_low: input.derivativeIdLow,
          derivative_id_high: input.derivativeIdHigh,
          similarity_score: Number(input.similarityScore.toFixed(6)),
          embedding_model: "vehicle-reid-0001-ir-fp16-v1",
          algorithm_version: "canonical-overview-crop-embedding-v1",
          label: input.label,
          revision: 1,
          updated_at: "2026-08-15 12:00:00+00",
          actor_username: input.actor.username,
          actor_display_name: input.actor.displayName,
          evidence_context_low: "street",
          evidence_context_high: "street",
          evidence_camera_low: "Street LPR 1",
          evidence_camera_high: "Street LPR 2",
        };
        reviewRows.push(saved);
        return saved;
      },
      async listPairReviewCalibration() { return reviewRows; },
    },
  });
  const result = await service.recordPairReview({
    sourceDerivativeId: 20,
    candidateDerivativeId: 10,
    label: "same_vehicle",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });
  assert.equal(savedInput.derivativeIdLow, 10);
  assert.equal(savedInput.derivativeIdHigh, 20);
  assert.ok(Math.abs(savedInput.similarityScore - 0.8) < 1e-6);
  assert.equal(savedInput.sourceLow.derivative_id, 10);
  assert.equal(result.review.candidateDerivativeId, 10);
  assert.equal(result.calibration.sameVehicle, 1);
});

test("repository scans only exact current identity links and performs no writes", async () => {
  const calls = [];
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    },
  });
  await repository.listCurrentSources({ limit: 99_999 });
  await repository.getCurrentSource(44);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values.at(-1), 10_000);
  assert.equal(calls[1].values.at(-1), 44);
  for (const call of calls) {
    assert.match(call.text, /identity_eligible = TRUE/);
    assert.match(call.text, /vehicle_image_status = 'ready'/);
    assert.match(call.text, /vehicle_image_path = links\.source_path_snapshot/);
    assert.match(call.text, /vehicle_image_source_kind = links\.source_kind/);
    assert.match(call.text, /vehicle_image_updated_at IS NOT DISTINCT FROM links\.source_updated_at/);
    assert.match(call.text, /vehicle_asset_embeddings/);
    assert.match(call.text, /vehicle_asset_attribute_observations/);
    assert.match(call.text, /embeddings\.source_sha256 = derivatives\.content_sha256/);
    assert.match(call.text, /color\.source_sha256 = derivatives\.content_sha256/);
    assert.match(call.text, /body\.source_sha256 = derivatives\.content_sha256/);
    assert.doesNotMatch(call.text, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
  }
  assert.equal(vehicleReidV2ShadowRepositoryInternals.MAX_SCAN_SOURCES, 10_000);
});

test("repository revalidates current crop evidence, updates one pair row, and appends audit", async () => {
  const calls = [];
  const low = row({ derivative_id: 10, embedding_id: 210, total_sources: "2" });
  const high = row({ derivative_id: 20, embedding_id: 220, total_sources: "2" });
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values = []) {
        calls.push({ text, values });
        if (/FROM current_sources\s+WHERE derivative_id = ANY/.test(text)) {
          return { rows: [low, high] };
        }
        if (/SELECT id, label, revision/.test(text)) return { rows: [] };
        if (/INSERT INTO public\.vehicle_reid_v2_pair_reviews/.test(text)) {
          return { rows: [{
            id: 9,
            derivative_id_low: 10,
            derivative_id_high: 20,
            similarity_score: 0.8,
            embedding_model: "vehicle-reid-0001-ir-fp16-v1",
            algorithm_version: "canonical-overview-crop-embedding-v1",
            label: "same_vehicle",
            revision: 1,
            updated_at: "2026-08-15 12:00:00+00",
            actor_username: "operator",
            actor_display_name: "Operator",
          }] };
        }
        return { rows: [] };
      },
    },
  });
  await repository.savePairReview({
    derivativeIdLow: 10,
    derivativeIdHigh: 20,
    sourceLow: low,
    sourceHigh: high,
    similarityScore: 0.8,
    label: "same_vehicle",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });
  const write = calls.find((call) => /INSERT INTO public\.vehicle_reid_v2_pair_reviews/.test(call.text));
  assert.ok(write);
  assert.equal(write.values[6], "vehicle-reid-0001-ir-fp16-v1");
  assert.equal(write.values[9], "same_vehicle");
  const audit = calls.find((call) => /vehicle\.reid_v2_pair_review/.test(call.text));
  assert.ok(audit);
  assert.match(audit.text, /'browser'/);
  assert.match(audit.text, /'succeeded'/);
  assert.equal(JSON.parse(audit.values[2]).previousLabel, null);
});

test("shadow review surface keeps assignments unchanged, gates pair labels, and is provider-neutral", async () => {
  const [actions, page, component, controls, navigation, service, repository, migration] = await Promise.all([
    source("app/actions.js"),
    source("app/visual_search/reid-v2/page.jsx"),
    source("components/VehicleReidV2Shadow.jsx"),
    source("components/VehicleReidV2PairReviewControls.jsx"),
    source("lib/vehicle-intelligence-navigation.mjs"),
    source("lib/vehicle-reid-v2-shadow.mjs"),
    source("lib/vehicle-reid-v2-shadow-repository.mjs"),
    source("migrations.sql"),
  ]);
  assert.match(actions, /export async function getVehicleReidV2Shadow/);
  assert.match(actions, /getVehicleReidV2Shadow[\s\S]*?requirePermission\("plate\.read"\)/);
  assert.match(actions, /submitVehicleReidV2PairReview[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(page, /requirePagePermission\("plate\.read"\)/);
  assert.match(navigation, /ReID v2 Shadow/);
  assert.match(component, /Assignment-safe review/);
  assert.equal((component.match(/\bunoptimized\b/g) || []).length, 2);
  assert.match(component, /never alter the score or order/);
  assert.match(component, /does not create or change a vehicle profile, assignment, threshold, notification/);
  assert.match(controls, /Same vehicle/);
  assert.match(controls, /Different vehicle/);
  assert.match(controls, /Unsure/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_pair_reviews/);
  assert.match(migration, /2026081507_vehicle_reid_v2_pair_reviews/);
  assert.doesNotMatch(migration.slice(migration.indexOf("2026081507_vehicle_reid_v2_pair_reviews")), /INSERT INTO public\.vehicle_clusters/);
  assert.doesNotMatch(`${service}\n${repository}`, /plate recognizer|plates?recognizer\.com/i);
  assert.doesNotMatch(`${service}\n${repository}`, /openvino-node/);
});
