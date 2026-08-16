import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  cosineSimilarityFromBytes,
  VehicleReidV2ShadowService,
} from "../lib/vehicle-reid-v2-shadow.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";
import {
  buildVehicleReidV2DiverseReviewQueue,
  plateEvidenceResolution,
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
  const plate = overrides.plate_number === undefined ? `PLATE${id}` : overrides.plate_number;
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
    plate_number: plate,
    observed_plate: plate,
    camera_name: "Street LPR 1",
    read_timestamp: `2026-08-16T${String((id % 20) + 1).padStart(2, "0")}:00:00Z`,
    overview_context: "street",
    source_kind: "overview_primary",
    plate_numbers: plate ? [plate] : [],
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
    total_sources: "8",
    ...overrides,
  };
}

test("plate evidence automatically resolves exact corrected matches and clearly dissimilar plates", () => {
  assert.deepEqual(plateEvidenceResolution(["ABC123"], ["ABC-123"]), {
    outcome: "same_vehicle",
    basis: "exact_effective_plate",
  });
  assert.deepEqual(plateEvidenceResolution(["ABC123"], ["ABC12B"]), {
    outcome: "human_review",
    basis: "close_effective_plate",
  });
  assert.deepEqual(plateEvidenceResolution(["ABC123"], ["XYZ789"]), {
    outcome: "different_vehicle",
    basis: "dissimilar_effective_plate",
  });
  assert.deepEqual(plateEvidenceResolution([], ["XYZ789"]), {
    outcome: "human_review",
    basis: "incomplete_effective_plate",
  });
});

test("diverse campaign queue excludes familiar plates, automatic decisions, and repeated vehicle groups", () => {
  const rows = [
    row(1, 1, { plate_number: "OLD111" }),
    row(2, 0.91, { plate_number: "ABC123", camera_name: "Entry LPR 1", overview_context: "entry" }),
    row(3, 0.88, { plate_number: "ABC12B", camera_name: "Street LPR 2" }),
    row(4, 0.86, { plate_number: "ABC123", camera_name: "Entry LPR 2", overview_context: "entry" }),
    row(5, 0.75, { plate_number: null, camera_name: "Entry LPR 2", overview_context: "entry" }),
    row(6, 0.74, { plate_number: "MISS22", camera_name: "Street LPR 1" }),
    row(7, 0.4, { plate_number: "FAR777" }),
    row(8, 0.3, { plate_number: "OTHER8" }),
    row(9, 0.7, { plate_number: "OLD11I", camera_name: "Entry LPR 1", overview_context: "entry" }),
  ];
  const reviews = [{
    derivative_id_low: 90,
    derivative_id_high: 91,
    evidence_plate_low: "OLD111",
    evidence_plate_high: "PAST22",
  }];
  const first = buildVehicleReidV2DiverseReviewQueue({
    sourceRows: rows,
    reviewRows: reviews,
    similarityFor: cosineSimilarityFromBytes,
    maximumDerivativeId: 9,
    limit: 8,
  });
  const second = buildVehicleReidV2DiverseReviewQueue({
    sourceRows: rows,
    reviewRows: reviews,
    similarityFor: cosineSimilarityFromBytes,
    maximumDerivativeId: 9,
    limit: 8,
  });
  assert.deepEqual(first, second);
  assert.ok(first.queue.length > 0);
  assert.ok(first.queue.every((pair) => pair.reviewReason !== "exact_effective_plate"));
  assert.ok(first.queue.every((pair) => pair.reviewReason !== "dissimilar_effective_plate"));
  assert.ok(first.queue.some((pair) => pair.contextPair.includes("entry")));
  assert.ok(first.queue.every((pair) => ![pair.sourcePlateNumber, pair.candidatePlateNumber]
    .includes("OLD111")));
  assert.ok(first.queue.every((pair) => ![pair.sourcePlateNumber, pair.candidatePlateNumber]
    .includes("OLD11I")));
  const used = new Set();
  for (const pair of first.queue) {
    for (const value of [pair.sourcePlateNumber, pair.candidatePlateNumber].filter(Boolean)) {
      assert.equal(used.has(value), false, `plate ${value} was recycled in one queue`);
      used.add(value);
    }
  }
  assert.ok(first.automaticSame > 0);
  assert.ok(first.automaticDifferent > 0);
});

test("shadow results mark exact and far effective plates as automatic reviews", async () => {
  const rows = [
    row(1, 1, { plate_number: "ABC123", plate_numbers: ["ABC123"] }),
    row(2, 0.95, { plate_number: "ABC123", plate_numbers: ["ABC123"] }),
    row(3, 0.9, { plate_number: "XYZ789", plate_numbers: ["XYZ789"] }),
    row(4, 0.85, { plate_number: "ABC12B", plate_numbers: ["ABC12B"] }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async getCurrentSource() { return null; },
      async listPairReviewCalibration() { return []; },
      async listPairReviewsForSource() { return []; },
      async getLatestReviewCampaign() { return null; },
    },
  });
  const overview = await service.getOverview({ sourceDerivativeId: 1, resultLimit: 3 });
  const exact = overview.matches.find((item) => item.derivativeId === 2);
  const far = overview.matches.find((item) => item.derivativeId === 3);
  const close = overview.matches.find((item) => item.derivativeId === 4);
  assert.equal(exact.pairReview.label, "same_vehicle");
  assert.equal(exact.pairReview.reviewBasis, "exact_effective_plate");
  assert.equal(exact.pairReview.automatic, true);
  assert.equal(far.pairReview.label, "different_vehicle");
  assert.equal(far.pairReview.reviewBasis, "dissimilar_effective_plate");
  assert.equal(close.pairReview, null);
});

test("campaign migration, actions, and UI keep one frozen 500-review run", async () => {
  const [migration, actions, page, component, controls, repository] = await Promise.all([
    source("migrations.sql"),
    source("app/actions.js"),
    source("app/visual_search/reid-v2/page.jsx"),
    source("components/VehicleReidV2Shadow.jsx"),
    source("components/VehicleReidV2ReviewCampaignControls.jsx"),
    source("lib/vehicle-reid-v2-shadow-repository.mjs"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_review_campaigns/);
  assert.match(migration, /target_human_reviews BETWEEN 1 AND 500/);
  assert.match(migration, /WHERE status = 'active'/);
  assert.match(migration, /2026081601_vehicle_reid_v2_diverse_review_campaign/);
  assert.match(actions, /startVehicleReidV2ReviewCampaign[\s\S]*requirePermission\("plate\.review"\)/);
  assert.match(actions, /targetHumanReviews: 500/);
  assert.match(page, /campaignReview: parameters\?\.campaign === "1"/);
  assert.match(component, /One 500-review diversity campaign/);
  assert.match(component, /Exact effective\/corrected plate matches are automatically Same/);
  assert.match(component, /clearly dissimilar plates are automatically Different/);
  assert.match(controls, /Start one 500-review campaign/);
  assert.match(repository, /frozen_max_derivative_id/);
  assert.match(repository, /campaign_id = EXCLUDED\.campaign_id/);
  assert.doesNotMatch(`${component}\n${repository}`, /plate recognizer|plates?recognizer\.com/i);
});

test("repository creates one audited campaign and reports campaign-bound progress", async () => {
  const calls = [];
  let inserted = false;
  const executor = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (/WHERE status = 'active' ORDER BY id DESC/.test(text)) return { rows: [] };
      if (/INSERT INTO public\.vehicle_reid_v2_review_campaigns/.test(text)) {
        inserted = true;
        return { rows: [{ id: 7 }] };
      }
      if (/COUNT\(reviews\.id\)::bigint AS human_reviews/.test(text)) {
        return { rows: inserted ? [{
          id: 7,
          status: "active",
          target_human_reviews: 500,
          frozen_max_derivative_id: 2397,
          embedding_model: "vehicle-reid-0001-ir-fp16-v1",
          algorithm_version: "canonical-overview-crop-embedding-v1",
          actor_username: "operator",
          actor_display_name: "Operator",
          created_at: "2026-08-16T20:00:00Z",
          human_reviews: "0",
        }] : [] };
      }
      return { rows: [] };
    },
  };
  const repository = new VehicleReidV2ShadowRepository({ executor });
  const result = await repository.createReviewCampaign({
    frozenMaxDerivativeId: 2397,
    targetHumanReviews: 500,
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });
  assert.equal(Number(result.id), 7);
  const insert = calls.find((call) => /INSERT INTO public\.vehicle_reid_v2_review_campaigns/.test(call.text));
  assert.deepEqual(insert.values.slice(0, 4), [
    500,
    2397,
    "vehicle-reid-0001-ir-fp16-v1",
    "canonical-overview-crop-embedding-v1",
  ]);
  const audit = calls.find((call) => /vehicle\.reid_v2_review_campaign_started/.test(call.text));
  assert.ok(audit);
  assert.match(audit.text, /'browser'/);
  assert.match(audit.text, /'succeeded'/);
});
