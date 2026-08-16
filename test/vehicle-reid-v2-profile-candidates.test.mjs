import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildVehicleReidV2ProfileCandidateSnapshot,
  VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM,
} from "../lib/vehicle-reid-v2-profile-candidates.mjs";

const sha = (character) => character.repeat(64);

function source(id, plate = null, overrides = {}) {
  return {
    derivative_id: id,
    embedding_id: id + 100,
    read_id: id + 1_000,
    content_sha256: sha(String(id % 10)),
    plate_number: plate,
    plate_numbers: plate ? [plate] : [],
    lpr_evidence: [],
    companion_lpr_evidence: [],
    camera_name: id % 2 ? "Street LPR 1" : "Street LPR 2",
    overview_context: "street",
    total_sources: 4,
    ...overrides,
  };
}

function build(sourceRows, reviewRows = []) {
  return buildVehicleReidV2ProfileCandidateSnapshot({
    sourceRows: sourceRows.map((row) => ({ ...row, total_sources: sourceRows.length })),
    reviewRows,
    embeddingModel: "vehicle-reid-0001-ir-fp16-v1",
    embeddingAlgorithmVersion: "canonical-overview-crop-embedding-v1",
  });
}

test("exact corrected plates and human Same labels form evidence-only candidates", () => {
  const result = build([
    source(1, "ABC123"),
    source(2, "ABC123"),
    source(3, null),
    source(4, null),
  ], [{
    id: 9,
    derivative_id_low: 3,
    derivative_id_high: 4,
    label: "same_vehicle",
    revision: 2,
  }]);

  assert.equal(result.algorithmVersion, VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM);
  assert.equal(result.candidateProfiles, 2);
  assert.equal(result.candidateMembers, 4);
  assert.equal(result.conflictedComponents, 0);
  assert.equal(result.ungroupedSources, 0);
  assert.deepEqual(result.candidates.map((candidate) => candidate.evidenceBasis).sort(), [
    "exact_effective_plate",
    "human_same",
  ]);
});

test("human Different evidence vetoes an exact-plate component", () => {
  const result = build([
    source(1, "ABC123"),
    source(2, "ABC123"),
  ], [{
    id: 10,
    derivative_id_low: 1,
    derivative_id_high: 2,
    label: "different_vehicle",
  }]);

  assert.equal(result.candidateProfiles, 0);
  assert.equal(result.conflictedComponents, 1);
  assert.equal(result.conflictedMembers, 2);
  assert.equal(result.conflicts[0].reason, "human_different");
});

test("dissimilar effective plates fail closed instead of trusting a Same label", () => {
  const result = build([
    source(1, "ABC123"),
    source(2, "ZXQ987"),
  ], [{
    id: 11,
    derivative_id_low: 1,
    derivative_id_high: 2,
    label: "same_vehicle",
  }]);

  assert.equal(result.candidateProfiles, 0);
  assert.equal(result.conflictedComponents, 1);
  assert.equal(result.conflicts[0].reason, "dissimilar_effective_plates");
  assert.deepEqual(result.conflicts[0].plates, ["ABC123", "ZXQ987"]);
});

test("a dissimilar Same conflict removes its connected exact-plate component", () => {
  const result = build([
    source(1, "ABC123"),
    source(2, "ABC123"),
    source(3, "ZXQ987"),
  ], [{
    id: 13,
    derivative_id_low: 1,
    derivative_id_high: 3,
    label: "same_vehicle",
  }]);

  assert.equal(result.candidateProfiles, 0);
  assert.equal(result.candidateMembers, 0);
  assert.equal(result.conflictedMembers, 3);
  assert.equal(result.ungroupedSources, 0);
});

test("multi-plate source evidence cannot bridge two automatic plate groups", () => {
  const result = build([
    source(1, "ABC123"),
    source(2, "XYZ789"),
    source(3, null, { plate_numbers: ["ABC123", "XYZ789"] }),
  ]);

  assert.equal(result.candidateProfiles, 0);
  assert.equal(result.ungroupedSources, 3);
});

test("snapshot fingerprint is deterministic and changes with review or current provenance", () => {
  const sources = [source(1, "ABC123"), source(2, "ABC123")];
  const first = build(sources, []);
  const repeated = build([...sources].reverse(), []);
  const changed = build(sources, [{
    id: 12,
    derivative_id_low: 1,
    derivative_id_high: 2,
    label: "same_vehicle",
    revision: 2,
  }]);
  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.notEqual(first.fingerprint, build([
    sources[0],
    { ...sources[1], camera_name: "Entry LPR 1", overview_context: "entry" },
  ]).fingerprint);
});

test("reviews outside the frozen current inventory do not affect counters or fingerprint", () => {
  const sources = [source(1, "ABC123"), source(2, "ABC123")];
  const baseline = build(sources);
  const withHistoricalOnlyReview = build(sources, [{
    id: 99,
    derivative_id_low: 77,
    derivative_id_high: 78,
    label: "same_vehicle",
    revision: 3,
  }]);

  assert.equal(withHistoricalOnlyReview.fingerprint, baseline.fingerprint);
  assert.equal(withHistoricalOnlyReview.humanSameReviews, 0);
});

test("bounded snapshot rejects a truncated current inventory", () => {
  assert.throws(() => buildVehicleReidV2ProfileCandidateSnapshot({
    sourceRows: [{ ...source(1, "ABC123"), total_sources: 2 }],
    reviewRows: [],
    embeddingModel: "vehicle-reid-0001-ir-fp16-v1",
    embeddingAlgorithmVersion: "canonical-overview-crop-embedding-v1",
  }), (error) => error?.code === "VEHICLE_REID_V2_PROFILE_CANDIDATE_TRUNCATED");
});

test("migration, UI, and disposable PostgreSQL gate keep profile candidates immutable and assignment-safe", async () => {
  const [migration, repository, service, panel, controls, actions, postgresGate] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/vehicle-reid-v2-shadow-repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/vehicle-reid-v2-shadow.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleReidV2Shadow.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleReidV2ProfileCandidateControls.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/test-vehicle-image-crop-postgres.mjs", import.meta.url), "utf8"),
  ]);
  const marker = migration.indexOf("2026081602_vehicle_reid_v2_profile_candidates");
  assert.ok(marker > 0);
  const slice = migration.slice(migration.lastIndexOf("-- ReID v2 profile candidates", marker));
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_profile_candidate_runs/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_profile_candidates/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_profile_candidate_members/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_reid_v2_profile_candidate_conflicts/);
  assert.match(slice, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(slice, /INSERT INTO public\.(vehicle_clusters|vehicle_cluster_assignments)/);
  assert.doesNotMatch(`${repository}\n${service}`, /INSERT INTO public\.(vehicle_clusters|vehicle_cluster_assignments)/);
  assert.match(repository, /BEGIN ISOLATION LEVEL REPEATABLE READ/);
  assert.match(repository, /snapshot_fingerprint/);
  assert.match(panel, /Evidence-backed shadow profile candidates/);
  assert.match(panel, /Cosine scores never add a member/);
  assert.match(controls, /Create shadow profile snapshot/);
  assert.match(actions, /createVehicleReidV2ProfileCandidateSnapshot/);
  assert.match(postgresGate, /runReidV2ProfileCandidates/);
  assert.match(postgresGate, /assert\.equal\(created\.candidateProfiles, 1\)/);
  assert.match(postgresGate, /assert\.equal\(reused\.reused, true\)/);
  assert.match(postgresGate, /UPDATE public\.vehicle_reid_v2_profile_candidate_runs/);
  assert.match(postgresGate, /codex_integration_test_guard/);
});
