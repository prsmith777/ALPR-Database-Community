import { createHash } from "node:crypto";

import { evaluatePlateIdentityMatch } from "./plate-matching.mjs";
export const VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM =
  "reid-v2-evidence-profile-candidate-v2";
export const VEHICLE_REID_V2_PROFILE_CANDIDATE_MAX_SOURCES = 10_000;

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedText(value) {
  return String(value || "").trim();
}

function normalizedPlate(value) {
  return normalizedText(value).toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function objectArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function plateEvidenceFromRow(row) {
  const structured = [
    ...objectArray(row?.lpr_evidence ?? row?.lprEvidence),
  ];
  if (structured.length) {
    return structured.map((item) => ({
      readId: positiveId(item.readId ?? item.read_id),
      plate: normalizedPlate(item.plateNumber ?? item.plate_number),
      reviewStatus: normalizedText((item.reviewStatus ?? item.review_status) || "unreviewed")
        .toLowerCase(),
      reviewRevision: Math.max(0, Number(item.reviewRevision ?? item.review_revision) || 0),
      appliedAliasId: positiveId(item.appliedAliasId ?? item.applied_alias_id),
    })).filter((item) => item.plate && item.reviewStatus !== "rejected")
      .sort((left, right) => (
        (left.readId || 0) - (right.readId || 0)
        || left.plate.localeCompare(right.plate)
        || left.reviewStatus.localeCompare(right.reviewStatus)
        || left.reviewRevision - right.reviewRevision
        || (left.appliedAliasId || 0) - (right.appliedAliasId || 0)
      ));
  }

  const reviewStatus = normalizedText((row?.review_status ?? row?.reviewStatus) || "unreviewed")
    .toLowerCase();
  if (reviewStatus === "rejected") return [];
  return uniqueSorted([
    row?.plate_number,
    row?.plateNumber,
    ...(Array.isArray(row?.plate_numbers) ? row.plate_numbers : []),
  ].map(normalizedPlate)).map((plate) => ({
    readId: positiveId(row?.read_id ?? row?.readId),
    plate,
    reviewStatus,
    reviewRevision: Math.max(0, Number(row?.review_revision ?? row?.reviewRevision) || 0),
    appliedAliasId: positiveId(row?.applied_alias_id ?? row?.appliedAliasId),
  }));
}

function pairIdentity(left, right) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function platesAreCompatible(left, right) {
  if (!left || !right) return true;
  if (left === right) return true;
  return evaluatePlateIdentityMatch(left, right, "balanced").matched;
}

function sourceFromRow(row) {
  const derivativeId = positiveId(row?.derivative_id ?? row?.derivativeId);
  const embeddingId = positiveId(row?.embedding_id ?? row?.embeddingId);
  const readId = positiveId(row?.read_id ?? row?.readId);
  const sourceSha256 = normalizedText(row?.content_sha256 ?? row?.sourceSha256).toLowerCase();
  if (!derivativeId || !embeddingId || !readId || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
    return null;
  }
  const plateEvidence = plateEvidenceFromRow(row);
  const plates = uniqueSorted(plateEvidence.map((item) => item.plate));
  return {
    derivativeId,
    embeddingId,
    readId,
    sourceSha256,
    plateEvidence,
    effectivePlates: plates,
    trustedPlate: plates.length === 1 ? plates[0] : null,
    cameraName: normalizedText(row?.camera_name ?? row?.cameraName) || null,
    overviewContext: normalizedText(
      row?.overview_context ?? row?.overviewContext
    ) || null,
  };
}

function reviewFromRow(row) {
  const rawLow = positiveId(row?.derivative_id_low ?? row?.derivativeIdLow);
  const rawHigh = positiveId(row?.derivative_id_high ?? row?.derivativeIdHigh);
  const label = normalizedText(row?.label);
  if (!rawLow || !rawHigh || rawLow === rawHigh || ![
    "same_vehicle",
    "different_vehicle",
    "unsure",
  ].includes(label)) return null;
  const swapped = rawLow > rawHigh;
  const low = Math.min(rawLow, rawHigh);
  const high = Math.max(rawLow, rawHigh);
  const rawSourceLow = normalizedText(
    row?.source_sha256_low ?? row?.sourceSha256Low
  ).toLowerCase();
  const rawSourceHigh = normalizedText(
    row?.source_sha256_high ?? row?.sourceSha256High
  ).toLowerCase();
  const rawEmbeddingLow = positiveId(row?.embedding_id_low ?? row?.embeddingIdLow);
  const rawEmbeddingHigh = positiveId(row?.embedding_id_high ?? row?.embeddingIdHigh);
  return {
    id: positiveId(row?.id) || null,
    derivativeIdLow: low,
    derivativeIdHigh: high,
    sourceSha256Low: swapped ? rawSourceHigh : rawSourceLow,
    sourceSha256High: swapped ? rawSourceLow : rawSourceHigh,
    embeddingIdLow: swapped ? rawEmbeddingHigh : rawEmbeddingLow,
    embeddingIdHigh: swapped ? rawEmbeddingLow : rawEmbeddingHigh,
    embeddingModel: normalizedText(row?.embedding_model ?? row?.embeddingModel),
    embeddingAlgorithmVersion: normalizedText(
      row?.algorithm_version ?? row?.embeddingAlgorithmVersion
    ),
    label,
    revision: Math.max(1, Number(row?.revision) || 1),
  };
}

function reviewIsExactCurrent(review, byId, embeddingModel, embeddingAlgorithmVersion) {
  const low = byId.get(review.derivativeIdLow);
  const high = byId.get(review.derivativeIdHigh);
  return Boolean(
    low && high
    && review.sourceSha256Low === low.sourceSha256
    && review.sourceSha256High === high.sourceSha256
    && review.embeddingIdLow === low.embeddingId
    && review.embeddingIdHigh === high.embeddingId
    && review.embeddingModel === normalizedText(embeddingModel)
    && review.embeddingAlgorithmVersion === normalizedText(embeddingAlgorithmVersion)
  );
}

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent == null) return null;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot == null || rightRoot == null || leftRoot === rightRoot) return;
    const low = Math.min(leftRoot, rightRoot);
    const high = Math.max(leftRoot, rightRoot);
    this.parent.set(high, low);
  }
}

function profileBasis(hasPlateEvidence, hasHumanEvidence) {
  if (hasPlateEvidence && hasHumanEvidence) return "mixed";
  return hasHumanEvidence ? "human_same" : "exact_effective_plate";
}

function memberBasis(member, plateGroups, humanSameMembers) {
  const byPlate = Boolean(member.trustedPlate && (plateGroups.get(member.trustedPlate)?.length || 0) > 1);
  const byHuman = humanSameMembers.has(member.derivativeId);
  if (byPlate && byHuman) return "mixed";
  return byHuman ? "human_same" : "exact_effective_plate";
}

function conflictingPlates(members) {
  const plates = uniqueSorted(members.map((member) => member.trustedPlate));
  for (let left = 0; left < plates.length; left += 1) {
    for (let right = left + 1; right < plates.length; right += 1) {
      if (!platesAreCompatible(plates[left], plates[right])) {
        return { left: plates[left], right: plates[right] };
      }
    }
  }
  return null;
}

export function buildVehicleReidV2ProfileCandidateSnapshot({
  sourceRows = [],
  reviewRows = [],
  embeddingModel,
  embeddingAlgorithmVersion,
} = {}) {
  const sources = sourceRows.map(sourceFromRow).filter(Boolean)
    .sort((left, right) => left.derivativeId - right.derivativeId);
  const totalSources = Number(sourceRows[0]?.total_sources || sources.length);
  if (totalSources > sources.length) {
    const error = new Error(
      "The current crop inventory exceeds the bounded profile-candidate scan. No snapshot was created."
    );
    error.code = "VEHICLE_REID_V2_PROFILE_CANDIDATE_TRUNCATED";
    throw error;
  }
  const allReviews = reviewRows.map(reviewFromRow).filter(Boolean)
    .sort((left, right) => (
      left.derivativeIdLow - right.derivativeIdLow
      || left.derivativeIdHigh - right.derivativeIdHigh
      || left.label.localeCompare(right.label)
    ));
  const byId = new Map(sources.map((source) => [source.derivativeId, source]));
  // Only reviews whose exact immutable crops are still in the frozen current
  // inventory can influence this snapshot or its evidence counters.
  const relevantReviews = allReviews.filter((review) => (
    byId.has(review.derivativeIdLow) && byId.has(review.derivativeIdHigh)
  ));
  const reviews = relevantReviews.map((review) => ({
    ...review,
    exactCurrent: reviewIsExactCurrent(
      review,
      byId,
      embeddingModel,
      embeddingAlgorithmVersion
    ),
  }));
  const disjoint = new DisjointSet(sources.map((source) => source.derivativeId));
  const plateGroups = new Map();
  const humanSameMembers = new Set();
  const humanDifferentPairs = [];
  const preUnionConflicts = [];
  const preUnionConflictedIds = new Set();

  for (const source of sources) {
    if (source.effectivePlates.length > 1) {
      preUnionConflicts.push({
        reason: "ambiguous_effective_plates",
        derivativeIds: [source.derivativeId],
        plates: source.effectivePlates,
        reviewId: null,
      });
      preUnionConflictedIds.add(source.derivativeId);
      continue;
    }
    if (!source.trustedPlate) continue;
    const group = plateGroups.get(source.trustedPlate) || [];
    group.push(source.derivativeId);
    plateGroups.set(source.trustedPlate, group);
  }
  for (const ids of plateGroups.values()) {
    if (ids.length < 2) continue;
    ids.slice(1).forEach((id) => disjoint.union(ids[0], id));
  }

  for (const review of reviews) {
    if (!review.exactCurrent) {
      preUnionConflicts.push({
        reason: "stale_review_evidence",
        derivativeIds: [review.derivativeIdLow, review.derivativeIdHigh],
        plates: uniqueSorted([
          ...byId.get(review.derivativeIdLow).effectivePlates,
          ...byId.get(review.derivativeIdHigh).effectivePlates,
        ]),
        reviewId: review.id,
      });
      if (["different_vehicle", "unsure"].includes(review.label)) {
        preUnionConflictedIds.add(review.derivativeIdLow);
        preUnionConflictedIds.add(review.derivativeIdHigh);
      }
      continue;
    }
    if (["different_vehicle", "unsure"].includes(review.label)) {
      humanDifferentPairs.push(review);
      continue;
    }
    if (review.label !== "same_vehicle") continue;
    const low = byId.get(review.derivativeIdLow);
    const high = byId.get(review.derivativeIdHigh);
    if (!platesAreCompatible(low.trustedPlate, high.trustedPlate)) {
      preUnionConflicts.push({
        reason: "dissimilar_effective_plates",
        derivativeIds: [low.derivativeId, high.derivativeId],
        plates: uniqueSorted([low.trustedPlate, high.trustedPlate]),
        reviewId: review.id,
      });
      preUnionConflictedIds.add(low.derivativeId);
      preUnionConflictedIds.add(high.derivativeId);
      continue;
    }
    humanSameMembers.add(low.derivativeId);
    humanSameMembers.add(high.derivativeId);
    disjoint.union(low.derivativeId, high.derivativeId);
  }

  const components = new Map();
  for (const source of sources) {
    const root = disjoint.find(source.derivativeId);
    const members = components.get(root) || [];
    members.push(source);
    components.set(root, members);
  }

  const candidates = [];
  const conflicts = [...preUnionConflicts];
  const conflictedMemberIds = new Set(preUnionConflictedIds);

  for (const members of components.values()) {
    if (members.length < 2) continue;
    const memberIds = new Set(members.map((member) => member.derivativeId));
    const humanDifferent = humanDifferentPairs.find((review) => (
      memberIds.has(review.derivativeIdLow) && memberIds.has(review.derivativeIdHigh)
    ));
    const plateConflict = conflictingPlates(members);
    const blockedByDissimilarSame = members.some((member) => (
      preUnionConflictedIds.has(member.derivativeId)
    ));
    if (humanDifferent || plateConflict || blockedByDissimilarSame) {
      const reasons = [];
      if (humanDifferent) {
        reasons.push(humanDifferent.label === "unsure" ? "human_unsure" : "human_different");
      }
      if (plateConflict || blockedByDissimilarSame) {
        reasons.push("dissimilar_effective_plates");
      }
      conflicts.push({
        reason: reasons.length > 1 ? "mixed" : reasons[0],
        derivativeIds: [...memberIds].sort((left, right) => left - right),
        plates: uniqueSorted(members.map((member) => member.trustedPlate)),
        reviewId: humanDifferent?.id || null,
      });
      members.forEach((member) => conflictedMemberIds.add(member.derivativeId));
      continue;
    }
    const plateEvidence = members.some((member) => (
      member.trustedPlate && (plateGroups.get(member.trustedPlate)?.length || 0) > 1
    ));
    const humanEvidence = members.some((member) => humanSameMembers.has(member.derivativeId));
    const basis = profileBasis(plateEvidence, humanEvidence);
    const normalizedMembers = members.map((member) => ({
      ...member,
      evidenceBasis: memberBasis(member, plateGroups, humanSameMembers),
    }));
    const candidateKey = hashJson({
      algorithm: VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM,
      members: normalizedMembers.map((member) => ({
        derivativeId: member.derivativeId,
        embeddingId: member.embeddingId,
        sourceSha256: member.sourceSha256,
      })),
    });
    candidates.push({
      candidateKey,
      evidenceBasis: basis,
      representativeDerivativeId: Math.max(...members.map((member) => member.derivativeId)),
      anchorPlates: uniqueSorted(members.flatMap((member) => member.effectivePlates)),
      cameraNames: uniqueSorted(members.map((member) => member.cameraName)),
      overviewContexts: uniqueSorted(members.map((member) => member.overviewContext)),
      members: normalizedMembers,
    });
  }
  candidates.sort((left, right) => (
    right.members.length - left.members.length
    || right.representativeDerivativeId - left.representativeDerivativeId
  ));

  const candidateMembers = candidates.reduce((sum, candidate) => sum + candidate.members.length, 0);
  const conflictedMembers = conflictedMemberIds.size;
  const fingerprint = hashJson({
    algorithm: VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM,
    embeddingModel: normalizedText(embeddingModel),
    embeddingAlgorithmVersion: normalizedText(embeddingAlgorithmVersion),
    sources: sources.map((source) => ({
      derivativeId: source.derivativeId,
      embeddingId: source.embeddingId,
      readId: source.readId,
      sourceSha256: source.sourceSha256,
      effectivePlates: source.effectivePlates,
      plateEvidence: source.plateEvidence,
      cameraName: source.cameraName,
      overviewContext: source.overviewContext,
    })),
    reviews,
  });

  return {
    fingerprint,
    algorithmVersion: VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM,
    embeddingModel: normalizedText(embeddingModel),
    embeddingAlgorithmVersion: normalizedText(embeddingAlgorithmVersion),
    frozenMaxDerivativeId: Math.max(0, ...sources.map((source) => source.derivativeId)),
    totalSources: sources.length,
    exactPlateEligibleSources: sources.filter((source) => source.trustedPlate).length,
    humanSameReviews: reviews.filter((review) => (
      review.exactCurrent && review.label === "same_vehicle"
    )).length,
    humanDifferentReviews: reviews.filter((review) => (
      review.exactCurrent && review.label === "different_vehicle"
    )).length,
    candidateProfiles: candidates.length,
    candidateMembers,
    conflictedComponents: conflicts.length,
    conflictedMembers,
    ungroupedSources: Math.max(0, sources.length - candidateMembers - conflictedMembers),
    candidates,
    conflicts: conflicts.map((conflict) => ({
      ...conflict,
      conflictKey: hashJson({
        algorithm: VEHICLE_REID_V2_PROFILE_CANDIDATE_ALGORITHM,
        reason: conflict.reason,
        derivativeIds: conflict.derivativeIds,
        plates: conflict.plates,
        reviewId: conflict.reviewId,
      }),
    })),
  };
}

export const vehicleReidV2ProfileCandidateInternals = Object.freeze({
  normalizedPlate,
  pairIdentity,
  platesAreCompatible,
  reviewFromRow,
  sourceFromRow,
});
