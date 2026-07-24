import assert from "node:assert/strict";
import test from "node:test";

import { CaptureAssetService } from "../lib/capture-asset-service.mjs";
import { CaptureAssetRepository } from "../lib/capture-asset-repository.mjs";
import {
  VehicleMatchFeedbackError,
  canonicalVehicleMatchPair,
  normalizeVehicleMatchFeedbackLabel,
  summarizeVehicleMatchFeedback,
} from "../lib/vehicle-match-calibration.mjs";
import {
  VEHICLE_REID_MODEL,
  encodeVehicleEmbedding,
} from "../lib/vehicle-reid.mjs";

function embedding(...entries) {
  const values = new Float32Array(512);
  entries.forEach(([index, value]) => { values[index] = value; });
  return encodeVehicleEmbedding(values);
}

test("vehicle feedback canonicalizes capture pairs and rejects invalid labels", () => {
  assert.deepEqual(canonicalVehicleMatchPair(20, 10), {
    sourceReadId: 20,
    candidateReadId: 10,
    readIdLow: 10,
    readIdHigh: 20,
  });
  assert.equal(normalizeVehicleMatchFeedbackLabel(" SAME_VEHICLE "), "same_vehicle");
  assert.throws(
    () => canonicalVehicleMatchPair(10, 10),
    (error) => error instanceof VehicleMatchFeedbackError
      && error.code === "INVALID_VEHICLE_MATCH_PAIR"
  );
  assert.throws(
    () => normalizeVehicleMatchFeedbackLabel("maybe"),
    (error) => error.code === "INVALID_VEHICLE_MATCH_LABEL"
  );
});

test("calibration recommends an explainable threshold only after both classes have samples", () => {
  const collecting = summarizeVehicleMatchFeedback([
    { label: "same_vehicle", similarity_score: 0.92 },
    { label: "different_vehicle", similarity_score: 0.4 },
  ]);
  assert.equal(collecting.sufficient, false);
  assert.equal(collecting.neededSameVehicle, 2);
  assert.equal(collecting.neededDifferentVehicle, 2);
  assert.equal(collecting.recommendation, null);

  const calibrated = summarizeVehicleMatchFeedback([
    { label: "same_vehicle", similarity_score: 0.92 },
    { label: "same_vehicle", similarity_score: 0.88 },
    { label: "same_vehicle", similarity_score: 0.85 },
    { label: "different_vehicle", similarity_score: 0.84 },
    { label: "different_vehicle", similarity_score: 0.6 },
    { label: "different_vehicle", similarity_score: 0.4 },
    { label: "ignored", similarity_score: 0.99 },
  ]);
  assert.equal(calibrated.total, 6);
  assert.equal(calibrated.sufficient, true);
  assert.equal(calibrated.recommendation.thresholdPercent, 85);
  assert.equal(calibrated.recommendation.balancedAccuracyPercent, 100);
  assert.equal(calibrated.recommendation.falsePositives, 0);
  assert.equal(calibrated.recommendation.falseNegatives, 0);
});

test("feedback service recomputes similarity from stored descriptors and returns calibration", async () => {
  const assets = new Map([
    [10, {
      read_id: 10,
      embedding_model: VEHICLE_REID_MODEL,
      vehicle_embedding: embedding([0, 1]),
    }],
    [20, {
      read_id: 20,
      embedding_model: VEHICLE_REID_MODEL,
      vehicle_embedding: embedding([0, 0.8], [1, 0.6]),
    }],
  ]);
  let savedInput = null;
  const feedbackRows = [];
  const repository = {
    getAsset: async (readId) => assets.get(Number(readId)) || null,
    saveVehicleMatchFeedback: async (input) => {
      savedInput = input;
      const row = {
        id: 7,
        read_id_low: input.readIdLow,
        read_id_high: input.readIdHigh,
        embedding_model: input.embeddingModel,
        similarity_score: input.similarityScore,
        label: input.label,
        revision: 1,
        updated_at: "2026-07-24T05:00:00.000Z",
        actor_username: input.actor.username,
        actor_display_name: input.actor.displayName,
      };
      feedbackRows.push(row);
      return row;
    },
    listVehicleMatchFeedback: async () => feedbackRows,
  };
  const service = new CaptureAssetService({ repository, fileStorage: {} });
  const result = await service.recordMatchFeedback({
    sourceReadId: 20,
    candidateReadId: 10,
    label: "different_vehicle",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });

  assert.equal(savedInput.readIdLow, 10);
  assert.equal(savedInput.readIdHigh, 20);
  assert.equal(savedInput.similarityScore, 0.8);
  assert.equal(savedInput.embeddingModel, VEHICLE_REID_MODEL);
  assert.equal(result.feedback.candidateReadId, 10);
  assert.equal(result.feedback.label, "different_vehicle");
  assert.equal(result.calibration.differentVehicle, 1);
});

test("stored feedback is returned with the corresponding search candidate", async () => {
  const source = {
    read_id: 1,
    derived_path: "derived/source.jpg",
    source_sha256: "a".repeat(64),
    vehicle_embedding: embedding([0, 1]),
    embedding_model: VEHICLE_REID_MODEL,
    plate_number: "SOURCE",
    camera_name: "Street",
    timestamp: "2026-07-24T05:00:00.000Z",
  };
  const candidate = {
    ...source,
    read_id: 2,
    derived_path: "derived/candidate.jpg",
    source_sha256: "b".repeat(64),
    plate_number: "OTHER",
  };
  const service = new CaptureAssetService({
    repository: {
      getAsset: async () => source,
      listSearchCandidates: async () => [candidate],
      listMatchFeedbackForSource: async () => [{
        id: 9,
        candidate_read_id: 2,
        label: "same_vehicle",
        similarity_score: 1,
        embedding_model: VEHICLE_REID_MODEL,
        revision: 2,
        updated_at: "2026-07-24T05:00:00.000Z",
        actor_username: "operator",
        actor_display_name: "Operator",
      }],
    },
    fileStorage: {},
  });
  const result = await service.search({ readId: 1 });
  assert.equal(result.matches[0].feedback.label, "same_vehicle");
  assert.equal(result.matches[0].feedback.revision, 2);
});

test("feedback persistence updates the canonical row and appends an audit event", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("SELECT id, label, similarity_score, revision")) {
          return { rows: [{ id: 5, label: "same_vehicle", similarity_score: 0.91, revision: 1 }] };
        }
        if (sql.includes("INSERT INTO public.vehicle_match_feedback")) {
          return { rows: [{
            id: 5,
            read_id_low: 10,
            read_id_high: 20,
            embedding_model: VEHICLE_REID_MODEL,
            similarity_score: 0.8,
            label: "different_vehicle",
            revision: 2,
            updated_at: "2026-07-24T05:00:00.000Z",
            actor_username: "operator",
            actor_display_name: "Operator",
          }] };
        }
        return { rows: [] };
      },
    },
  });

  await repository.saveVehicleMatchFeedback({
    readIdLow: 10,
    readIdHigh: 20,
    embeddingModel: VEHICLE_REID_MODEL,
    similarityScore: 0.8,
    label: "different_vehicle",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });

  const audit = calls.find((call) => call.sql.includes("INSERT INTO public.audit_events"));
  assert.ok(audit);
  assert.match(audit.sql, /\$1::bigint/);
  assert.equal(audit.values[0], 4);
  assert.deepEqual(JSON.parse(audit.values[2]), {
    readIdLow: 10,
    readIdHigh: 20,
    embeddingModel: VEHICLE_REID_MODEL,
    similarityScore: 0.8,
    previousLabel: "same_vehicle",
    label: "different_vehicle",
    revision: 2,
  });
});
