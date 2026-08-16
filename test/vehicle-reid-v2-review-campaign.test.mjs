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

function activeCampaign(overrides = {}) {
  return {
    id: 1,
    status: "active",
    target_human_reviews: 500,
    human_reviews: "0",
    frozen_max_derivative_id: 100,
    embedding_model: "vehicle-reid-0001-ir-fp16-v1",
    algorithm_version: "canonical-overview-crop-embedding-v1",
    created_at: "2026-08-16T20:00:00Z",
    ...overrides,
  };
}

function unresolvedRows(count = 6) {
  return Array.from({ length: count }, (_, index) => row(index + 1, 1 - (index * 0.07), {
    plate_number: null,
    observed_plate: null,
    plate_numbers: [],
    camera_name: index % 2 ? "Street LPR 1" : "Entry LPR 1",
    camera_names: [index % 2 ? "Street LPR 1" : "Entry LPR 1"],
    overview_context: index % 2 ? "street" : "entry",
    lpr_evidence: index % 2 === 0 ? [{
      readId: 900 + index,
      plateNumber: `ENTRY${index}`,
      cameraName: "Entry LPR 1",
    }] : [],
    companion_lpr_evidence: index % 2 === 0 ? [{
      readId: 950 + index,
      plateNumber: `ENTRY${index}A`,
      cameraName: "Street LPR 2",
    }] : [],
  }));
}

test("an active campaign owns the default route and returns exactly one review pair", async () => {
  const rows = unresolvedRows();
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async getCurrentSource(id) {
        return rows.find((item) => Number(item.derivative_id) === Number(id)) || null;
      },
      async listPairReviewCalibration() { return []; },
      async listPairReviewsForSource() { return []; },
      async getLatestReviewCampaign() { return activeCampaign(); },
    },
  });

  const defaultView = await service.getOverview({ resultLimit: 12 });
  assert.equal(defaultView.reviewCampaign.active, true);
  assert.equal(defaultView.sources.length, 0, "campaign data must not expose the old source chooser");
  assert.equal(defaultView.matches.length, 1, "campaign data must expose one candidate only");
  assert.equal(defaultView.selected.derivativeId,
    defaultView.reviewCampaign.current.sourceDerivativeId);
  assert.equal(defaultView.matches[0].derivativeId,
    defaultView.reviewCampaign.current.candidateDerivativeId);
  assert.ok(defaultView.selected.lprEvidence.direct.length > 0
    || defaultView.matches[0].lprEvidence.direct.length > 0
    || defaultView.selected.lprEvidence.companions.length > 0
    || defaultView.matches[0].lprEvidence.companions.length > 0,
  "Entry campaign evidence must retain its direct or companion LPR context");

  const staleIds = await service.getOverview({
    sourceDerivativeId: 5,
    candidateDerivativeId: 6,
    campaignReview: true,
  });
  assert.equal(staleIds.reviewCampaign.current.pairIdentity,
    defaultView.reviewCampaign.current.pairIdentity,
  "old source/candidate URLs must not select a different campaign pair");

  const browseView = await service.getOverview({ browseMode: true, resultLimit: 3 });
  assert.equal(browseView.reviewCampaign.active, false);
  assert.equal(browseView.reviewCampaign.browseMode, true);
  assert.ok(browseView.sources.length > 0);
  assert.equal(browseView.matches.length, 3);
});

test("campaign submission accepts only the displayed pair and advances after one decision", async () => {
  const rows = unresolvedRows(8).map((item) => ({
    ...item,
    lpr_evidence: [],
    companion_lpr_evidence: [],
  }));
  const reviews = [];
  let saveCalls = 0;
  const repository = {
    async listCurrentSources() { return rows; },
    async getCurrentSource(id) {
      return rows.find((item) => Number(item.derivative_id) === Number(id)) || null;
    },
    async listPairReviewCalibration() { return reviews; },
    async listPairReviewsForSource() { return []; },
    async getLatestReviewCampaign() {
      return activeCampaign({ human_reviews: String(reviews.length) });
    },
    async savePairReview(input) {
      saveCalls += 1;
      const low = rows.find((item) => item.derivative_id === input.derivativeIdLow);
      const high = rows.find((item) => item.derivative_id === input.derivativeIdHigh);
      const saved = {
        id: reviews.length + 1,
        derivative_id_low: input.derivativeIdLow,
        derivative_id_high: input.derivativeIdHigh,
        label: input.label,
        similarity_score: input.similarityScore,
        embedding_model: "vehicle-reid-0001-ir-fp16-v1",
        algorithm_version: "canonical-overview-crop-embedding-v1",
        revision: 1,
        campaign_id: input.campaignId,
        evidence_context_low: low.overview_context,
        evidence_context_high: high.overview_context,
        evidence_camera_low: low.camera_name,
        evidence_camera_high: high.camera_name,
        evidence_plate_low: low.plate_number,
        evidence_plate_high: high.plate_number,
        evidence_timestamp_low: low.read_timestamp,
        evidence_timestamp_high: high.read_timestamp,
        evaluation_time_zone: "America/Denver",
      };
      reviews.push(saved);
      return saved;
    },
  };
  const service = new VehicleReidV2ShadowService({ repository });
  const before = await service.getOverview();
  assert.ok(before.reviewCampaign.next, "fixture must contain more than one campaign pair");

  await assert.rejects(service.recordPairReview({
    sourceDerivativeId: before.reviewCampaign.next.sourceDerivativeId,
    candidateDerivativeId: before.reviewCampaign.next.candidateDerivativeId,
    label: "unsure",
    campaignId: 1,
    actor: { id: 4, username: "operator" },
  }), /no longer the current unresolved campaign recommendation/i);
  assert.equal(saveCalls, 0, "a non-displayed queued pair must fail server revalidation");

  const current = before.reviewCampaign.current;
  await service.recordPairReview({
    sourceDerivativeId: current.sourceDerivativeId,
    candidateDerivativeId: current.candidateDerivativeId,
    label: "unsure",
    campaignId: 1,
    actor: { id: 4, username: "operator" },
  });
  assert.equal(saveCalls, 1);
  assert.equal(reviews.length, 1, "one decision must create exactly one campaign review");

  const after = await service.getOverview();
  assert.equal(after.reviewCampaign.campaign.humanReviews, 1);
  assert.notEqual(after.reviewCampaign.current.pairIdentity, current.pairIdentity);
  assert.equal([
    after.reviewCampaign.current.sourceDerivativeId,
    after.reviewCampaign.current.candidateDerivativeId,
  ].some((id) => [current.sourceDerivativeId, current.candidateDerivativeId].includes(id)), false,
  "the next pair must not recycle either just-reviewed crop");

  await assert.rejects(service.recordPairReview({
    sourceDerivativeId: current.sourceDerivativeId,
    candidateDerivativeId: current.candidateDerivativeId,
    label: "unsure",
    campaignId: 1,
    actor: { id: 4, username: "operator" },
  }), /no longer the current unresolved campaign recommendation/i);
  assert.equal(saveCalls, 1, "the old pair cannot be counted twice");
});

test("campaign migration, actions, and UI keep one frozen 500-pair-decision run", async () => {
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
  assert.match(page, /browseMode: parameters\?\.browse === "1"/);
  assert.match(component, /One 500-pair-decision diversity campaign/);
  assert.match(component, /Exact effective\/corrected plate matches are automatically Same/);
  assert.match(component, /clearly dissimilar plates are automatically Different/);
  assert.match(component, /The .* target counts pair decisions, not vehicles/);
  assert.match(component, /if \(data\.reviewCampaign\?\.active\) \{[\s\S]*return <CampaignReviewFlow data=\{data\} \/>/);
  const campaignFlow = component.slice(
    component.indexOf("function CampaignReviewFlow"),
    component.indexOf("export default function VehicleReidV2Shadow")
  );
  assert.match(campaignFlow, /One pair at a time/);
  assert.match(campaignFlow, /<ShadowNeighborhood data=\{data\} \/>/);
  assert.doesNotMatch(campaignFlow, /SourcePicker|StratifiedEvaluation|Choose a source crop/);
  assert.match(controls, /Start one 500-pair-decision campaign/);
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
