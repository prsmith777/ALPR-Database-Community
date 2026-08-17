import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVehicleReidV2ConversionProjection,
  VEHICLE_REID_V2_CONVERSION_ALGORITHM,
} from "../lib/vehicle-reid-v2-conversion-preview.mjs";

const sha = (character) => character.repeat(64);

function source(id, plate = null, overrides = {}) {
  return {
    derivative_id: id,
    asset_id: id + 100,
    derivative_kind: "vehicle_crop",
    crop_algorithm_version: "canonical-overview-detection-box-v1",
    asset_source_sha256: sha(String((id + 1) % 10)),
    crop_content_sha256: sha(String((id + 2) % 10)),
    crop_storage_path: `derived/vehicle-crops/${id}.jpg`,
    embedding_id: id + 200,
    embedding_model: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    embedding_source_sha256: sha(String((id + 2) % 10)),
    embedding_sha256: sha(String((id + 3) % 10)),
    embedding_dimensions: 512,
    representative_read_id: id + 1_000,
    representative_source_kind: "overview_primary",
    representative_source_path: `derived/vehicle-assets/${id}.jpg`,
    representative_source_updated_at: "2026-08-16 12:00:00+00",
    representative_link_updated_at: "2026-08-16 12:00:01+00",
    effective_plate_evidence: plate ? [{
      plate,
      reviewStatus: "corrected",
      reviewRevision: 1,
      readId: id + 1_000,
    }] : [],
    overview_contexts: ["street"],
    ...overrides,
  };
}

function read(id, overrides = {}) {
  return {
    read_id: id,
    read_event_identity: `event-${id}`,
    read_timestamp: "2026-08-16 12:00:00+00",
    read_created_at: "2026-08-16 12:00:01+00",
    camera_name: "Street LPR",
    observed_plate: "ABC123",
    effective_plate: "ABC123",
    plate_review_status: "corrected",
    plate_review_revision: 1,
    last_plate_review_id: id + 5_000,
    canonical_link_state: "absent",
    daylight_status: "unknown",
    ...overrides,
  };
}

function currentRead(id, crop, overrides = {}) {
  return read(id, {
    canonical_link_state: "current",
    asset_id: crop.asset_id,
    derivative_id: crop.derivative_id,
    embedding_id: crop.embedding_id,
    identity_eligible: true,
    relationship: "primary",
    source_kind: "overview_primary",
    source_path_snapshot: crop.representative_source_path,
    source_updated_at: crop.representative_source_updated_at,
    link_updated_at: crop.representative_link_updated_at,
    overview_context: "street",
    daylight_status: "daytime",
    ...overrides,
  });
}

function review(id, left, right, label, overrides = {}) {
  return {
    id,
    revision: 1,
    derivative_id_low: Math.min(left.derivative_id, right.derivative_id),
    derivative_id_high: Math.max(left.derivative_id, right.derivative_id),
    source_sha256_low: left.crop_content_sha256,
    source_sha256_high: right.crop_content_sha256,
    embedding_id_low: left.embedding_id,
    embedding_id_high: right.embedding_id,
    embedding_model: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    similarity_score: 0.9,
    label,
    review_updated_at: "2026-08-16 12:05:00+00",
    ...overrides,
  };
}

function build(sourceRows, reviewRows = [], readRows = []) {
  return buildVehicleReidV2ConversionProjection({
    sourceRows,
    reviewRows,
    readRows,
    embeddingModel: "vehicle-reid-0001-ir-fp16-v1",
    embeddingAlgorithmVersion: "canonical-overview-crop-embedding-v1",
  });
}

test("exact corrected plates project a stable multi-member profile and safe plate-only history", () => {
  const first = source(1, "ABC123");
  const second = source(2, "ABC123");
  const result = build([first, second], [], [
    currentRead(1_001, first),
    currentRead(1_002, second),
    read(50, { historical: true }),
    read(51, { historical: true, daylight_status: "nighttime" }),
  ]);

  assert.equal(result.algorithmVersion, VEHICLE_REID_V2_CONVERSION_ALGORITHM);
  assert.equal(result.metrics.projectedProfiles, 1);
  assert.equal(result.metrics.projectedMultiMemberProfiles, 1);
  assert.equal(result.metrics.assignedReads, 4);
  assert.equal(result.metrics.exactPlateOnlyAssignments, 2);
  assert.equal(result.metrics.historicalExactPlateAssignments, 2);
  assert.equal(result.metrics.nighttimeExactPlateAssignments, 1);
  assert.equal(result.profiles[0].evidenceBasis, "exact_effective_plate");
});

test("audited Same joins plate-less crops while Different and Unsure veto proposed joins", () => {
  const first = source(1);
  const second = source(2);
  const joined = build([first, second], [review(1, first, second, "same_vehicle")]);
  assert.equal(joined.profiles.length, 1);
  assert.equal(joined.profiles[0].evidenceBasis, "human_same");

  const plateFirst = source(3, "JOIN123");
  const plateSecond = source(4, "JOIN123");
  for (const label of ["different_vehicle", "unsure"]) {
    const blocked = build([plateFirst, plateSecond], [review(2, plateFirst, plateSecond, label)]);
    assert.equal(blocked.profiles.length, 0);
    assert.equal(blocked.conflicts.length, 1);
    assert.equal(blocked.conflicts[0].reason,
      label === "different_vehicle" ? "human_different" : "human_unsure");
  }
});

test("stale Different and Unsure reviews quarantine both current endpoints", () => {
  const first = source(1, "VETO123");
  const second = source(2, "VETO123");
  for (const label of ["different_vehicle", "unsure"]) {
    const result = build(
      [first, second],
      [review(7, first, second, label, { source_sha256_low: sha("9") })],
      [currentRead(1_001, first), currentRead(1_002, second)]
    );
    assert.equal(result.profiles.length, 0);
    assert.equal(result.metrics.projectedMembers, 0);
    assert.ok(result.conflicts.some((item) => item.reason === "missing_evidence"));
    assert.deepEqual(result.dispositions.map((item) => item.disposition), [
      "conflict", "conflict",
    ]);
  }
});

test("clearly different plates fail closed even with a Same review", () => {
  const first = source(1, "ABC123");
  const second = source(2, "ZXQ987");
  const result = build([first, second], [review(9, first, second, "same_vehicle")]);
  assert.equal(result.profiles.length, 0);
  assert.ok(result.conflicts.some((item) => item.reason === "dissimilar_effective_plates"));
});

test("close OCR variants do not join without an audited Same decision", () => {
  const first = source(1, "ABC123");
  const second = source(2, "ABC128");
  const result = build([first, second]);
  assert.equal(result.metrics.projectedProfiles, 2);
  assert.equal(result.metrics.projectedSingletonProfiles, 2);
});

test("shared canonical assets reuse one crop and assign every linked read to one profile", () => {
  const crop = source(1, "ABC123");
  const result = build([crop], [], [
    currentRead(1_001, crop),
    currentRead(1_002, crop, { relationship: "shared", source_kind: "overview_pair_share" }),
  ]);
  assert.equal(result.metrics.projectedSingletonProfiles, 1);
  assert.equal(result.metrics.sharedAssetAssignments, 2);
  assert.equal(new Set(result.dispositions.map((item) => item.profileKey)).size, 1);
});

test("a shared asset with multiple non-rejected effective plates is quarantined", () => {
  const crop = source(1, null, {
    effective_plate_evidence: [
      { plate: "ABC123", reviewStatus: "corrected", reviewRevision: 1, readId: 1_001 },
      { plate: "ZXQ987", reviewStatus: "confirmed", reviewRevision: 2, readId: 1_002 },
    ],
  });
  const result = build([crop], [], [
    currentRead(1_001, crop, { effective_plate: "ABC123" }),
    currentRead(1_002, crop, { effective_plate: "ZXQ987", relationship: "shared" }),
  ]);

  assert.equal(result.profiles.length, 0);
  assert.equal(result.metrics.assignedReads, 0);
  assert.ok(result.conflicts.some((item) => item.reason === "ambiguous_effective_plates"));
  assert.deepEqual(result.dispositions.map((item) => item.disposition), ["conflict", "conflict"]);
});

test("subset batches use the full frozen asset count for stable shared assignments", () => {
  const crop = source(1, "ABC123");
  const first = currentRead(1_001, crop);
  const second = currentRead(1_002, crop, { relationship: "primary" });
  const full = build([crop], [], [first, second]);
  const partial = buildVehicleReidV2ConversionProjection({
    sourceRows: [crop],
    readRows: [first],
    assetReadCounts: new Map([[crop.asset_id, 2]]),
    embeddingModel: "vehicle-reid-0001-ir-fp16-v1",
    embeddingAlgorithmVersion: "canonical-overview-crop-embedding-v1",
  });

  assert.equal(full.dispositions[0].assignmentBasis, "shared_asset");
  assert.equal(partial.dispositions[0].assignmentBasis, "shared_asset");
  assert.equal(partial.dispositions[0].reasonCode, full.dispositions[0].reasonCode);
});

test("identical unreviewed effective plates may group crops but cannot anchor plate-only reads", () => {
  const unreviewed = (id) => source(id, null, {
    effective_plate_evidence: [{
      plate: "RAW123", reviewStatus: "unreviewed", reviewRevision: 0, readId: id + 1_000,
    }],
  });
  const first = unreviewed(1);
  const second = unreviewed(2);
  const result = build([first, second], [], [
    currentRead(1_001, first, { plate_review_status: "unreviewed" }),
    currentRead(1_002, second, { plate_review_status: "unreviewed" }),
    read(50, { effective_plate: "RAW123", plate_review_status: "unreviewed" }),
  ]);

  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].memberCount, 2);
  assert.equal(
    result.dispositions.find((item) => item.readId === 50)?.disposition,
    "unassigned"
  );
});

test("multi-plate quarantine ignores rejected noise but cannot bridge through one shared plate", () => {
  const rejectedNoise = source(1, null, {
    effective_plate_evidence: [
      { plate: "ABC123", reviewStatus: "corrected", reviewRevision: 1, readId: 1_001 },
      { plate: "ZXQ987", reviewStatus: "rejected", reviewRevision: 2, readId: 1_002 },
    ],
  });
  const safe = build([rejectedNoise]);
  assert.equal(safe.profiles.length, 1);
  assert.equal(safe.conflicts.length, 0);

  const ambiguous = source(2, null, {
    effective_plate_evidence: [
      { plate: "ABC123", reviewStatus: "corrected", reviewRevision: 1, readId: 1_003 },
      { plate: "XYZ999", reviewStatus: "confirmed", reviewRevision: 1, readId: 1_004 },
    ],
  });
  const separate = source(3, "ABC123");
  const blocked = build([ambiguous, separate], [], [
    currentRead(1_003, ambiguous, { effective_plate: "ABC123" }),
    currentRead(1_004, ambiguous, { effective_plate: "XYZ999", relationship: "shared" }),
    currentRead(1_005, separate, { effective_plate: "ABC123" }),
  ]);
  assert.equal(blocked.profiles.length, 1);
  assert.deepEqual(blocked.profiles[0].members.map((item) => item.derivativeId), [3]);
  assert.ok(blocked.conflicts.some((item) => (
    item.reason === "ambiguous_effective_plates"
      && item.derivativeIds.includes(ambiguous.derivative_id)
  )));
});

test("display-only, stale, incomplete, rejected, and untrusted plate evidence remain unassigned", () => {
  const crop = source(1, "ABC123");
  const result = build([crop], [], [
    read(1, { canonical_link_state: "display_only", relationship: "display_fallback" }),
    read(2, { canonical_link_state: "stale" }),
    read(3, { canonical_link_state: "incomplete", asset_id: crop.asset_id }),
    read(4, { plate_review_status: "rejected" }),
    read(5, { plate_review_status: "unreviewed" }),
  ]);
  assert.equal(result.metrics.assignedReads, 0);
  assert.deepEqual(result.dispositions.map((item) => item.disposition), [
    "unassigned", "stale", "unavailable", "unassigned", "unassigned",
  ]);
  assert.ok(result.dispositions.some((item) => item.reasonCode === "display_only_fallback"));
  assert.ok(result.dispositions.some((item) => item.reasonCode === "missing_current_crop"));
});

test("eligible ungrouped crops become provisional singletons without forcing unsupported reads", () => {
  const first = source(1);
  const second = source(2);
  const result = build([first, second], [], [read(10, {
    effective_plate: "",
    observed_plate: "",
    plate_review_status: "unreviewed",
  })]);
  assert.equal(result.metrics.projectedSingletonProfiles, 2);
  assert.equal(result.metrics.assignedReads, 0);
  assert.equal(result.metrics.unassignedReads, 1);
});

test("source replacements, review changes, and plate corrections change frozen fingerprints", () => {
  const crop = source(1, "ABC123");
  const baseRead = currentRead(1_001, crop);
  const baseline = build([crop], [], [baseRead]);
  const replaced = build([{ ...crop, crop_content_sha256: sha("9"),
    embedding_source_sha256: sha("9") }], [], [baseRead]);
  const corrected = build([crop], [], [{ ...baseRead, effective_plate: "XYZ789",
    plate_review_revision: 2, last_plate_review_id: 9_999 }]);
  const withReview = build([crop], [review(8, crop, source(2), "unsure")], [baseRead]);
  assert.notEqual(replaced.identityEvidenceFingerprint, baseline.identityEvidenceFingerprint);
  assert.notEqual(corrected.identityEvidenceFingerprint, baseline.identityEvidenceFingerprint);
  assert.notEqual(withReview.identityEvidenceFingerprint, baseline.identityEvidenceFingerprint);
});

test("v1 membership changes observation metrics but never v2 evidence or projection fingerprints", () => {
  const crop = source(1, "ABC123");
  const withoutV1 = build([crop], [], [currentRead(1_001, crop)]);
  const withV1 = build([crop], [], [currentRead(1_001, crop, {
    v1_cluster_id: 44,
    v1_assignment_status: "confirmed",
    v1_assignment_revision: 2,
  })]);
  assert.equal(withV1.identityEvidenceFingerprint, withoutV1.identityEvidenceFingerprint);
  assert.equal(withV1.previewFingerprint, withoutV1.previewFingerprint);
  assert.equal(withV1.metrics.v1AssignedReads, 1);
  assert.equal(withoutV1.metrics.v1AssignedReads, 0);
});

test("unassigned coverage is not counted as a v1/v2 pairwise disagreement", () => {
  const crop = source(1, "ABC123");
  const v1OnlyPeer = build([crop], [], [
    currentRead(1_001, crop, { v1_cluster_id: 44 }),
    read(1_002, {
      effective_plate: "NOPE",
      plate_review_status: "unreviewed",
      v1_cluster_id: 44,
    }),
  ]);
  assert.equal(v1OnlyPeer.metrics.v1OnlyReads, 1);
  assert.equal(v1OnlyPeer.metrics.v1SameV2DifferentPairs, 0);

  const v2OnlyPeer = build([crop], [], [
    currentRead(1_001, crop, { v1_cluster_id: 44 }),
    currentRead(1_002, crop, { relationship: "shared", v1_cluster_id: null }),
  ]);
  assert.equal(v2OnlyPeer.metrics.v2OnlyReads, 1);
  assert.equal(v2OnlyPeer.metrics.v2SameV1DifferentPairs, 0);
});

test("projection is deterministic across source, review, and read ordering", () => {
  const first = source(1, "ABC123");
  const second = source(2, "ABC123");
  const reviews = [review(1, first, second, "same_vehicle")];
  const reads = [currentRead(1_001, first), currentRead(1_002, second)];
  const forward = build([first, second], reviews, reads);
  const reversed = build([second, first], [...reviews].reverse(), [...reads].reverse());
  assert.equal(forward.identityEvidenceFingerprint, reversed.identityEvidenceFingerprint);
  assert.equal(forward.previewFingerprint, reversed.previewFingerprint);
});
