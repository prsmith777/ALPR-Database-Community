import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildVehicleReidV2ProfileSuggestions,
  VEHICLE_REID_V2_PROFILE_SUGGESTION_LIMIT,
  VEHICLE_REID_V2_PROFILE_SUGGESTION_MAX_SOURCES,
} from "../lib/vehicle-reid-v2-profile-suggestions.mjs";
import { VehicleReidV2ShadowService } from "../lib/vehicle-reid-v2-shadow.mjs";
import { VehicleReidV2ShadowRepository } from "../lib/vehicle-reid-v2-shadow-repository.mjs";

function sha(id) {
  return Number(id).toString(16).padStart(64, "0");
}

function embedding(values) {
  const bytes = Buffer.alloc(512 * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

function source(id, overrides = {}) {
  return {
    derivative_id: id,
    asset_id: id + 100,
    storage_path: `derived/vehicle-crops/${id}.jpg`,
    content_sha256: sha(id),
    image_width: 320,
    image_height: 180,
    embedding_id: id + 1_000,
    embedding: `embedding:${id}`,
    model_name: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    read_id: id + 2_000,
    plate_number: null,
    observed_plate: null,
    plate_numbers: [],
    camera_name: "Street LPR 1",
    camera_names: ["Street LPR 1"],
    read_timestamp: "2026-08-16 12:00:00+00",
    overview_context: "street",
    source_kind: "overview_primary",
    lpr_evidence: [],
    companion_lpr_evidence: [],
    cluster_ids: [],
    ...overrides,
  };
}

function member(profileId, sourceRow, overrides = {}) {
  return {
    profile_candidate_id: profileId,
    derivative_id: sourceRow.derivative_id,
    embedding_id: sourceRow.embedding_id,
    source_sha256: sourceRow.content_sha256,
    candidate_key: sha(profileId + 100),
    profile_evidence_basis: "human_same",
    profile_member_count: 2,
    effective_plates: sourceRow.plate_numbers,
    read_id: sourceRow.read_id,
    camera_name: sourceRow.camera_name,
    overview_context: sourceRow.overview_context,
    anchor_plates: [],
    camera_names: ["Street LPR 1", "Street LPR 2"],
    overview_contexts: ["street"],
    ...overrides,
  };
}

function similarityTable(values) {
  return (left, right) => values[`${left}|${right}`] ?? values[`${right}|${left}`] ?? null;
}

test("multi-member aggregate selects one bounded profile instead of trusting one strong comparison", () => {
  const rows = [source(1), source(2), source(3), source(4), source(5)];
  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: rows,
    memberRows: [
      member(11, rows[0]), member(11, rows[1]),
      member(12, rows[2]), member(12, rows[3]),
    ],
    similarityFor: similarityTable({
      "embedding:5|embedding:1": 0.99,
      "embedding:5|embedding:2": 0.1,
      "embedding:5|embedding:3": 0.8,
      "embedding:5|embedding:4": 0.8,
    }),
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].profile.id, 12);
  assert.equal(result.suggestions[0].profileSimilarity, 0.8);
  assert.equal(result.suggestions[0].supportMembers, 2);
  assert.equal(result.stats.currentProfiles, 2);
  assert.equal(result.stats.ungroupedSources, 1);
});

test("plate and audited review evidence suppress or veto suggestions without affecting ranking", () => {
  const profileMembers = [
    source(1, { plate_number: "ABC123", plate_numbers: ["ABC123"] }),
    source(2, { plate_number: "ABC123", plate_numbers: ["ABC123"] }),
  ];
  const memberRows = profileMembers.map((row) => member(11, row, {
    profile_evidence_basis: "exact_effective_plate",
    anchor_plates: ["ABC123"],
  }));
  const exact = source(5, { plate_number: "ABC123", plate_numbers: ["ABC123"] });
  const dissimilar = source(6, { plate_number: "ZXQ987", plate_numbers: ["ZXQ987"] });
  const reviewedSame = source(7);
  const reviewedDifferent = source(8);
  const similarityFor = () => 0.9;

  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: [...profileMembers, exact, dissimilar, reviewedSame, reviewedDifferent],
    memberRows,
    reviewRows: [
      { derivative_id_low: 1, derivative_id_high: 7, label: "same_vehicle" },
      { derivative_id_low: 1, derivative_id_high: 8, label: "different_vehicle" },
    ],
    similarityFor,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.stats.exactPlatePendingSnapshot, 1);
  assert.equal(result.stats.humanSamePendingSnapshot, 1);
  assert.ok(result.stats.incompatiblePlateProfiles >= 1);
  assert.ok(result.stats.reviewedProfiles >= 1);
});

test("ambiguous, conflicted, stale, and single-member evidence fails closed", () => {
  const first = source(1);
  const second = source(2);
  const ambiguous = source(5, { plate_numbers: ["ABC123", "XYZ789"] });
  const conflicted = source(6);
  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: [first, second, ambiguous, conflicted],
    memberRows: [
      member(11, first),
      member(11, second, { embedding_id: 99_999 }),
    ],
    conflictRows: [{ derivative_ids: [6] }],
    similarityFor: () => 0.95,
  });

  assert.equal(result.stats.currentProfiles, 0);
  assert.equal(result.stats.ambiguousPlateEvidence, 1);
  assert.equal(result.stats.snapshotConflict, 1);
  assert.equal(result.suggestions.length, 0);
});

test("a later plate or provenance change invalidates frozen profile membership", () => {
  const first = source(1, { plate_number: "ABC123", plate_numbers: ["ABC123"] });
  const second = source(2, { plate_number: "ABC123", plate_numbers: ["ABC123"] });
  const suggestionSource = source(5);
  const frozenFirst = member(11, first, { anchor_plates: ["ABC123"] });
  const frozenSecond = member(11, second, { anchor_plates: ["ABC123"] });
  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: [
      { ...first, plate_number: "CORRECTED", plate_numbers: ["CORRECTED"] },
      second,
      suggestionSource,
    ],
    memberRows: [frozenFirst, frozenSecond],
    similarityFor: () => 0.95,
  });
  assert.equal(result.stats.currentProfiles, 0);
  assert.equal(result.suggestions.length, 0);
});

test("source and output bounds are deterministic", () => {
  const grouped = [source(1), source(2)];
  const ungrouped = Array.from({ length: 80 }, (_, index) => source(index + 10));
  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: [...grouped, ...ungrouped].reverse(),
    memberRows: grouped.map((row) => member(11, row)),
    similarityFor: (left) => Number(left.split(":")[1]) / 100,
  });

  assert.equal(result.stats.consideredSources, VEHICLE_REID_V2_PROFILE_SUGGESTION_MAX_SOURCES);
  assert.equal(result.suggestions.length, VEHICLE_REID_V2_PROFILE_SUGGESTION_LIMIT);
  assert.equal(result.suggestions[0].sourceRow.derivative_id, 89);
});

test("a truncated current inventory fails closed without suggestions", () => {
  const first = source(1, { total_sources: "3" });
  const second = source(2, { total_sources: "3" });
  const result = buildVehicleReidV2ProfileSuggestions({
    sourceRows: [first, second],
    memberRows: [member(11, first), member(11, second)],
    similarityFor: () => 1,
  });
  assert.equal(result.stats.truncated, true);
  assert.equal(result.stats.currentSources, 3);
  assert.equal(result.suggestions.length, 0);
});

test("shadow overview maps suggestion evidence from the latest immutable snapshot", async () => {
  const rows = [
    source(1, { embedding: embedding([1, 0]), plate_number: "ABC123", plate_numbers: ["ABC123"] }),
    source(2, { embedding: embedding([0.9, 0.1]), plate_number: "ABC123", plate_numbers: ["ABC123"] }),
    source(3, { embedding: embedding([0.95, 0.05]) }),
  ].map((row) => ({ ...row, total_sources: "3" }));
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async listPairReviewCalibration() { return []; },
      async getLatestReviewCampaign() { return null; },
      async getProfileCandidateSnapshot() {
        return {
          id: 9,
          snapshot_fingerprint: sha(9),
          status: "ready",
          frozen_max_derivative_id: 3,
          total_sources: 3,
          candidate_profiles: 1,
          candidate_members: 2,
          ungrouped_sources: 1,
          profiles: [],
          conflicts: [],
        };
      },
      async getProfileCandidateSuggestionInputs(runId) {
        assert.equal(runId, 9);
        return {
          members: rows.slice(0, 2).map((row) => member(11, row, {
            profile_evidence_basis: "exact_effective_plate",
            anchor_plates: ["ABC123"],
          })),
          conflicts: [],
        };
      },
    },
  });

  const overview = await service.getOverview({ browseMode: true, sourceDerivativeId: 3 });
  assert.equal(overview.profileSuggestions.snapshotId, 9);
  assert.equal(overview.profileSuggestions.suggestions.length, 1);
  assert.equal(overview.profileSuggestions.suggestions[0].source.derivativeId, 3);
  assert.equal(overview.profileSuggestions.suggestions[0].representative.derivativeId, 1);
});

test("repository and UI keep suggestions read-only, current-revalidated, and threshold-free", async () => {
  const calls = [];
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    },
  });
  await repository.getProfileCandidateSuggestionInputs(7);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.values[0] === 7));
  assert.match(calls[0].text, /vehicle_reid_v2_profile_candidate_members/);
  assert.match(calls[0].text, /vehicle_reid_v2_profile_candidates/);
  assert.match(calls[0].text, /candidates\.status = 'shadow'/);
  assert.doesNotMatch(calls[0].text, /candidates\.status = 'candidate'/);
  assert.match(calls[1].text, /vehicle_reid_v2_profile_candidate_conflicts/);
  assert.match(calls[1].text, /ORDER BY conflict_key/);
  assert.doesNotMatch(calls[1].text, /ORDER BY id/);

  const [builder, service, panel] = await Promise.all([
    readFile(new URL("../lib/vehicle-reid-v2-profile-suggestions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/vehicle-reid-v2-shadow.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleReidV2Shadow.jsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${builder}\n${service}`, /INSERT INTO public\.(vehicle_clusters|vehicle_cluster_assignments)/);
  assert.doesNotMatch(`${builder}\n${service}`, /UPDATE public\.(vehicle_clusters|vehicle_cluster_assignments)/);
  assert.doesNotMatch(`${builder}\n${service}`, /match_threshold|assignment_threshold/i);
  assert.match(panel, /Ungrouped-to-profile shadow suggestions/);
  assert.match(panel, /Nothing here assigns a vehicle or creates a threshold/);
  assert.match(panel, /VehicleReidV2PairReviewControls/);
});
