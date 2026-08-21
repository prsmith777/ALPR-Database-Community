import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  cosineSimilarityFromBytes,
  VehicleReidV2ShadowService,
  vehicleReidV2ShadowInternals,
} from "../lib/vehicle-reid-v2-shadow.mjs";
import {
  VehicleReidV2ShadowRepository,
  vehicleReidV2ShadowRepositoryInternals,
} from "../lib/vehicle-reid-v2-shadow-repository.mjs";
import { parseVehicleReidV2SearchId } from "../lib/vehicle-reid-v2-search-input.mjs";
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
    embedding_sha256: String(derivativeId + 1_000).padStart(64, "0"),
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

test("shadow sources expose direct and conservative companion LPR evidence with conflicts", () => {
  const mapped = vehicleReidV2ShadowInternals.mapSource(row({
    lpr_evidence: [
      {
        readId: 301,
        plateNumber: "ABC123",
        observedPlate: "A8C123",
        imagePath: "images\\plate-301.jpg",
        thumbnailPath: "thumbnails/plate-301.jpg",
        cameraName: "Entry LPR 1",
        timestamp: "2026-08-15 12:00:00+00",
        directionLabel: "Entering",
        directionSource: "blue_iris",
        reviewStatus: "corrected",
        sourceKind: "entry_overview_primary",
        relationship: "primary",
      },
    ],
    companion_lpr_evidence: [
      {
        readId: 301,
        plateNumber: "ABC123",
        cameraName: "Entry LPR 1",
        relationship: "shadow_event_companion",
      },
      {
        readId: 302,
        plateNumber: "XYZ789",
        observedPlate: "XYZ789",
        thumbnailPath: "thumbnails/plate-302.jpg",
        cameraName: "Street LPR 2",
        timestamp: "2026-08-15 12:00:08+00",
        directionLabel: "Exiting",
        directionSource: "blue_iris",
        reviewStatus: "confirmed",
        sourceKind: "overview_primary",
        relationship: "shadow_event_companion",
        eventId: 77,
        correlationClass: "timed_pair",
      },
    ],
  }));
  assert.equal(mapped.lprEvidence.direct.length, 1);
  assert.equal(mapped.lprEvidence.direct[0].imageUrl, "/images/images/plate-301.jpg");
  assert.equal(mapped.lprEvidence.direct[0].observedPlate, "A8C123");
  assert.equal(mapped.lprEvidence.companions.length, 1);
  assert.equal(mapped.lprEvidence.companions[0].readId, 302);
  assert.equal(mapped.lprEvidence.companions[0].imageUrl, "/images/thumbnails/plate-302.jpg");
  assert.equal(mapped.lprEvidence.companions[0].eventId, 77);
  assert.equal(mapped.lprEvidence.conflicts.plate, true);
  assert.equal(mapped.lprEvidence.conflicts.direction, true);
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

test("primary browsing skips Stage 1 candidate, campaign, and calibration work", async () => {
  const calls = [];
  const current = row({ derivative_id: 1, fully_attributed: true });
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { calls.push("catalog"); return [current]; },
      async listPrimaryCurrentSourceDetails(ids) {
        calls.push(`details:${ids.join(",")}`);
        return [current];
      },
      async listCurrentSources() { calls.push("rich-shadow"); return [current]; },
      async listPairReviewCalibration() { calls.push("calibration"); return []; },
      async getLatestReviewCampaign() { calls.push("campaign"); return null; },
      async getProfileCandidateSnapshot() { calls.push("candidate"); return null; },
      async listPairReviewsForSource() { calls.push("reviews"); return []; },
    },
  });

  const overview = await service.getOverview({ primaryBrowse: true });
  assert.deepEqual(calls, ["catalog", "details:1"]);
  assert.equal(overview.profileCandidates, null);
  assert.equal(overview.reviewCampaign.campaign, null);
  assert.equal(overview.calibration.total, 0);
  assert.equal(overview.stats.fullyAttributed, 1);
});

test("primary browsing ranks the lean catalog before one bounded rich hydration", async () => {
  const catalog = [
    row({ derivative_id: 1, embedding: embedding([1, 0]), total_sources: "4" }),
    row({ derivative_id: 2, embedding: embedding([0.9, Math.sqrt(0.19)]), total_sources: "4" }),
    row({ derivative_id: 3, embedding: embedding([0.8, 0.6]), total_sources: "4" }),
    row({ derivative_id: 4, embedding: embedding([0.7, Math.sqrt(0.51)]), total_sources: "4" }),
  ];
  const calls = [];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog(options) {
        calls.push(["catalog", options]);
        return catalog;
      },
      async listPrimaryCurrentSourceDetails(ids) {
        calls.push(["details", ids]);
        return ids.map((id) => row({
          ...catalog.find((item) => Number(item.derivative_id) === id),
          derivative_id: id,
        }));
      },
    },
  });

  const overview = await service.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: 4,
    pageSize: 2,
    resultLimit: 2,
  });
  assert.deepEqual(calls, [
    ["catalog", { limit: 10_000 }],
    ["details", [1, 2, 4, 3]],
  ]);
  assert.deepEqual(overview.sources.map((item) => item.derivativeId), [1, 2]);
  assert.equal(overview.selected.derivativeId, 4);
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [3, 2]);
  assert.deepEqual(overview.matches.map((item) => item.rank), [1, 2]);
});

test("primary browsing never hydrates more than page plus source plus top matches", async () => {
  const catalog = Array.from({ length: 100 }, (_, index) => row({
    derivative_id: index + 1,
    embedding: embedding([1, (index + 1) / 1_000]),
    total_sources: "100",
  }));
  let hydratedIds = [];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return catalog; },
      async listPrimaryCurrentSourceDetails(ids) {
        hydratedIds = ids;
        return ids.map((id) => catalog.find((item) => Number(item.derivative_id) === id));
      },
    },
  });

  await service.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: 100,
    pageSize: 48,
    resultLimit: 24,
  });
  assert.equal(hydratedIds.length, 73);
  assert.equal(vehicleReidV2ShadowInternals.MAX_PRIMARY_HYDRATION_SOURCES, 73);
});

test("primary browsing fails closed instead of substituting an explicit stale source", async () => {
  let hydrationCalls = 0;
  const catalogMissingService = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return [row({ derivative_id: 1 })]; },
      async listPrimaryCurrentSourceDetails() { hydrationCalls += 1; return []; },
    },
  });
  await assert.rejects(
    catalogMissingService.getOverview({ primaryBrowse: true, sourceDerivativeId: 99 }),
    { code: "VEHICLE_REID_V2_SEARCH_SOURCE_CHANGED" }
  );
  assert.equal(hydrationCalls, 0);

  const detailMissingService = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() {
        return [row({ derivative_id: 1 }), row({ derivative_id: 2 })];
      },
      async listPrimaryCurrentSourceDetails() { return [row({ derivative_id: 2 })]; },
    },
  });
  await assert.rejects(
    detailMissingService.getOverview({ primaryBrowse: true, sourceDerivativeId: 1 }),
    { code: "VEHICLE_REID_V2_SEARCH_SOURCE_CHANGED" }
  );
});

test("primary browsing resolves an exact current source outside the newest catalog bound", async () => {
  const newest = row({ derivative_id: 1, total_sources: "10001" });
  const olderRequested = row({
    derivative_id: 10_001,
    embedding: embedding([0.8, 0.6]),
    total_sources: null,
  });
  const calls = [];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return [newest]; },
      async getPrimaryCurrentSourceCatalog(id) {
        calls.push(["exact", id]);
        return id === 10_001 ? olderRequested : null;
      },
      async listPrimaryCurrentSourceDetails(ids) {
        calls.push(["details", ids]);
        return ids.map((id) => id === 10_001 ? olderRequested : newest);
      },
    },
  });
  const overview = await service.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: 10_001,
    resultLimit: 1,
  });
  assert.deepEqual(calls, [
    ["exact", 10_001],
    ["details", [1, 10_001]],
  ]);
  assert.equal(overview.selected.derivativeId, 10_001);
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [1]);
  assert.equal(overview.stats.truncated, true);
});

test("primary browsing rejects selected contract drift and drops candidate contract drift", async () => {
  const catalog = [
    row({ derivative_id: 1, embedding: embedding([1, 0]) }),
    row({ derivative_id: 2, embedding: embedding([0.9, Math.sqrt(0.19)]) }),
    row({ derivative_id: 3, embedding: embedding([0.8, 0.6]) }),
  ];
  const changedSourceService = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return catalog; },
      async listPrimaryCurrentSourceDetails() {
        return [
          { ...catalog[0], content_sha256: "f".repeat(64) },
          catalog[1],
          catalog[2],
        ];
      },
    },
  });
  await assert.rejects(
    changedSourceService.getOverview({ primaryBrowse: true, sourceDerivativeId: 1 }),
    { code: "VEHICLE_REID_V2_SEARCH_SOURCE_CHANGED" }
  );

  const changedCandidateService = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return catalog; },
      async listPrimaryCurrentSourceDetails() {
        return [
          catalog[0],
          { ...catalog[1], embedding_id: 999_999 },
          catalog[2],
        ];
      },
    },
  });
  const overview = await changedCandidateService.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: 1,
    resultLimit: 2,
  });
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [3]);
  assert.deepEqual(overview.matches.map((item) => item.rank), [2]);
  assert.equal(overview.winnerMargin, null);
});

test("primary browsing displays only pair reviews bound to the hydrated crop contract", async () => {
  const catalog = [
    row({ derivative_id: 1, plate_numbers: [], lpr_evidence: [] }),
    row({ derivative_id: 2, plate_numbers: [], lpr_evidence: [] }),
  ];
  const matchingReview = {
    id: 7,
    candidate_derivative_id: 2,
    derivative_id_low: 1,
    derivative_id_high: 2,
    source_sha256_low: catalog[0].content_sha256,
    source_sha256_high: catalog[1].content_sha256,
    embedding_id_low: catalog[0].embedding_id,
    embedding_id_high: catalog[1].embedding_id,
    embedding_model: catalog[0].model_name,
    algorithm_version: catalog[0].embedding_algorithm_version,
    similarity_score: 1,
    label: "same_vehicle",
    revision: 1,
    updated_at: "2026-08-15 12:00:00+00",
    actor_username: "operator",
    actor_display_name: "Operator",
    campaign_id: null,
  };
  const overviewFor = async (review) => new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return catalog; },
      async listPrimaryCurrentSourceDetails() { return catalog; },
      async listPairReviewsForSource() { return [review]; },
    },
  }).getOverview({ primaryBrowse: true, sourceDerivativeId: 1 });

  const current = await overviewFor(matchingReview);
  assert.equal(current.matches[0].pairReview.label, "same_vehicle");
  const stale = await overviewFor({
    ...matchingReview,
    source_sha256_high: "f".repeat(64),
  });
  assert.equal(stale.matches[0].pairReview, null);
});

test("primary browsing suppresses a default source for invalid source or unresolved read", async () => {
  const current = row({ derivative_id: 1 });
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return [current]; },
      async listPrimaryCurrentSourceDetails(ids) {
        assert.deepEqual(ids, [1]);
        return [current];
      },
    },
  });
  const overview = await service.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: "abc",
  });
  assert.equal(overview.selected, null);
  assert.deepEqual(overview.matches, []);
  assert.deepEqual(overview.sources.map((item) => item.derivativeId), [1]);
  const unresolved = await service.getOverview({
    primaryBrowse: true,
    suppressDefaultSelection: true,
  });
  assert.equal(unresolved.selected, null);
});

test("primary browsing drops stale hydrated candidates without changing global ranks", async () => {
  const catalog = [
    row({ derivative_id: 1, embedding: embedding([1, 0]) }),
    row({ derivative_id: 2, embedding: embedding([0.9, Math.sqrt(0.19)]) }),
    row({ derivative_id: 3, embedding: embedding([0.8, 0.6]) }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listPrimaryCurrentSourceCatalog() { return catalog; },
      async listPrimaryCurrentSourceDetails(ids) {
        assert.deepEqual(ids, [1, 2, 3]);
        return [catalog[0], catalog[2]];
      },
    },
  });
  const overview = await service.getOverview({
    primaryBrowse: true,
    sourceDerivativeId: 1,
    pageSize: 1,
    resultLimit: 2,
  });
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [3]);
  assert.deepEqual(overview.matches.map((item) => item.rank), [2]);
  assert.equal(overview.winnerMargin, null);
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
    assert.match(call.text, /reads\.image_path/);
    assert.match(call.text, /reads\.thumbnail_path/);
    assert.match(call.text, /vehicle_event_reads/);
    assert.match(call.text, /events\.status = 'shadow'/);
    assert.match(call.text, /direct_event\.source_path_snapshot = direct_links\.source_path_snapshot/);
    assert.match(call.text, /companion_event\.source_path_snapshot = companion_links\.source_path_snapshot/);
    assert.match(call.text, /companion_links\.asset_id <> derivatives\.asset_id/);
    assert.doesNotMatch(call.text, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
  }
  assert.equal(vehicleReidV2ShadowRepositoryInternals.MAX_SCAN_SOURCES, 10_000);
});

test("primary repository uses an asset-gated lean catalog and ID-seeded bounded hydration", async () => {
  const calls = [];
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [{ authority_mode: "v2_primary" }] };
      },
    },
  });
  await repository.listPrimaryCurrentSourceCatalog({ limit: 99_999 });
  await repository.getPrimaryCurrentSourceCatalog(10_001);
  await repository.listPrimaryCurrentSourceDetails([3, 1, 3, 2]);
  assert.equal(calls.length, 3);

  const catalog = calls[0];
  assert.equal(catalog.values.at(-1), 10_000);
  assert.match(catalog.text, /JOIN public\.vehicle_image_assets assets/);
  assert.match(catalog.text, /derivatives\.source_sha256 = assets\.content_sha256/);
  assert.match(catalog.text, /embeddings\.source_sha256 = derivatives\.content_sha256/);
  assert.match(catalog.text, /identity_eligible = TRUE/);
  assert.match(catalog.text, /relationship <> 'display_fallback'/);
  assert.match(catalog.text, /reid_control\.mode = 'v2_primary'/);
  assert.doesNotMatch(catalog.text, /vehicle_reid_v2_current_profile_members/);
  assert.doesNotMatch(catalog.text, /vehicle_cluster_assignments/);
  assert.doesNotMatch(catalog.text, /vehicle_events/);
  assert.doesNotMatch(catalog.text, /vehicle_reid_v2_pair_reviews/);
  assert.doesNotMatch(catalog.text, /JSONB_(?:AGG|BUILD_OBJECT)/);

  const exact = calls[1];
  assert.equal(exact.values.at(-1), 10_001);
  assert.match(exact.text, /derivatives\.id = \$12/);
  assert.doesNotMatch(exact.text, /LIMIT \$12/);

  const hydration = calls[2];
  assert.deepEqual(hydration.values.at(-1), [3, 1, 2]);
  assert.match(hydration.text, /seeded_derivatives AS MATERIALIZED/);
  assert.match(hydration.text, /derivatives\.id = ANY\(\$12::bigint\[\]\)/);
  assert.match(hydration.text, /JOIN public\.vehicle_image_assets assets/);
  assert.match(hydration.text, /derivatives\.source_sha256 = assets\.content_sha256/);
  assert.match(hydration.text, /embeddings\.source_sha256 = derivatives\.content_sha256/);
  assert.match(hydration.text, /vehicle_image_path = links\.source_path_snapshot/);
  assert.ok(
    hydration.text.indexOf("seeded_derivatives AS MATERIALIZED")
      < hydration.text.indexOf("JOIN LATERAL")
  );
  assert.equal(
    vehicleReidV2ShadowRepositoryInternals.MAX_PRIMARY_HYDRATION_SOURCES,
    73
  );
  await assert.rejects(
    repository.listPrimaryCurrentSourceDetails(Array.from({ length: 74 }, (_, index) => index + 1)),
    { code: "VEHICLE_REID_V2_SEARCH_HYDRATION_LIMIT" }
  );
  assert.equal(calls.length, 3);
});

test("primary repository fails closed when authority mode is not v2 primary", async () => {
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query() { return { rows: [{ authority_mode: "v1_rollback" }] }; },
    },
  });
  await assert.rejects(
    repository.listPrimaryCurrentSourceCatalog(),
    { code: "VEHICLE_REID_V2_SEARCH_MODE_CHANGED" }
  );
  await assert.rejects(
    repository.listPrimaryCurrentSourceDetails([1]),
    { code: "VEHICLE_REID_V2_SEARCH_MODE_CHANGED" }
  );
});

test("primary pair-review lookup returns immutable crop and embedding gates", async () => {
  let query = "";
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text) { query = text; return { rows: [] }; },
    },
  });
  await repository.listPairReviewsForSource({
    sourceDerivativeId: 1,
    candidateDerivativeIds: [2],
  });
  assert.match(query, /source_sha256_low, source_sha256_high/);
  assert.match(query, /embedding_id_low, embedding_id_high/);
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
  assert.equal((component.match(/\bunoptimized\b/g) || []).length, 3);
  assert.match(component, /Associated LPR evidence — review only/);
  assert.match(component, /Directly linked LPR read/);
  assert.match(component, /Correlated companion LPR read/);
  assert.match(component, /Use Unsure unless the images resolve it/);
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

test("primary Vehicle Search route fails closed and never substitutes invalid read or source input", async () => {
  const [page, actions] = await Promise.all([
    source("app/visual_search/page.jsx"),
    source("app/actions.js"),
  ]);
  assert.match(page, /!modeResult\?\.success \|\| !\["v1_primary", "v1_rollback", "v2_primary"\]\.includes\(mode\)/);
  assert.doesNotMatch(page, /modeResult\?\.success \? modeResult\.data\.control\?\.mode : "v1_primary"/);
  assert.match(page, /parseVehicleReidV2SearchId\(parameters\?\.source\)/);
  assert.match(page, /requestedSource\.present && !requestedSource\.valid/);
  assert.match(page, /parseVehicleReidV2SearchId\(parameters\?\.readId\)/);
  assert.match(page, /requestedRead\.present[\s\S]*?sourceDerivativeId = null/);
  assert.match(page, /requestedRead\.valid[\s\S]*?resolveVehicleReidRead\(requestedRead\.value\)/);
  assert.match(page, /suppressDefaultSelection = true;[\s\S]*?Find Similar is unavailable/);
  assert.match(page, /primaryBrowse: true,[\s\S]*?suppressDefaultSelection/);
  assert.match(actions, /"VEHICLE_REID_V2_SEARCH_MODE_CHANGED"/);
  assert.match(actions, /"VEHICLE_REID_V2_SEARCH_SOURCE_CHANGED"/);
});

test("Vehicle Search query identifiers reject malformed explicit read and source values", () => {
  assert.deepEqual(parseVehicleReidV2SearchId(undefined), {
    present: false,
    valid: true,
    value: null,
  });
  assert.deepEqual(parseVehicleReidV2SearchId(""), {
    present: false,
    valid: true,
    value: null,
  });
  for (const invalid of [
    "abc", "12junk", "0", "-1", "1.5", "12.0", "1e3", "0x10", "0b10", "NaN",
  ]) {
    assert.deepEqual(parseVehicleReidV2SearchId(invalid), {
      present: true,
      valid: false,
      value: null,
    });
  }
  assert.deepEqual(parseVehicleReidV2SearchId(" 12 "), {
    present: true,
    valid: true,
    value: 12,
  });
});
