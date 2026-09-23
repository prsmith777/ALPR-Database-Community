import { createHash } from "node:crypto";

import { evaluatePlateIdentityMatch } from "./plate-matching.mjs";

export const VEHICLE_REID_V2_CONVERSION_ALGORITHM =
  "reid-v2-authoritative-conversion-preview-v1";

const TRUSTED_PLATE_STATUSES = new Set(["confirmed", "corrected", "alias_resolved"]);

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function lowerHash(value) {
  const normalized = text(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function normalizedPlate(value) {
  return text(value).toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function pairKey(left, right) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function reviewedPlateEntries(row) {
  const explicit = arrayValue(
    row?.effective_plate_evidence ?? row?.effectivePlateEvidence ?? row?.plateEvidence
  );
  if (explicit.length) {
    return explicit.map((item) => ({
      plate: normalizedPlate(item?.plate ?? item?.effectivePlate ?? item?.plate_number),
      reviewStatus: text(item?.reviewStatus ?? item?.review_status ?? "unreviewed").toLowerCase(),
      reviewRevision: Math.max(0, Number(item?.reviewRevision ?? item?.review_revision) || 0),
      readId: positiveId(item?.readId ?? item?.read_id),
    })).filter((item) => item.plate);
  }
  const plates = arrayValue(row?.effective_plates ?? row?.effectivePlates)
    .map(normalizedPlate).filter(Boolean);
  const fallbackPlate = normalizedPlate(row?.plate_number ?? row?.plateNumber);
  const reviewStatus = text(row?.review_status ?? row?.reviewStatus ?? "unreviewed").toLowerCase();
  const reviewRevision = Math.max(0, Number(row?.review_revision ?? row?.reviewRevision) || 0);
  const readId = positiveId(row?.read_id ?? row?.readId);
  return uniqueSorted([...plates, fallbackPlate]).map((plate) => ({
    plate, reviewStatus, reviewRevision, readId,
  }));
}

function sourceFromRow(row) {
  const derivativeId = positiveId(row?.derivative_id ?? row?.derivativeId);
  const assetId = positiveId(row?.asset_id ?? row?.assetId);
  const embeddingId = positiveId(row?.embedding_id ?? row?.embeddingId);
  const cropContentSha256 = lowerHash(
    row?.crop_content_sha256 ?? row?.content_sha256 ?? row?.cropContentSha256
  );
  const assetSourceSha256 = lowerHash(
    row?.asset_source_sha256 ?? row?.source_sha256 ?? row?.assetSourceSha256
  );
  const embeddingSourceSha256 = lowerHash(
    row?.embedding_source_sha256 ?? row?.embeddingSourceSha256 ?? cropContentSha256
  );
  const embeddingSha256 = lowerHash(row?.embedding_sha256 ?? row?.embeddingSha256);
  if (!derivativeId || !assetId || !embeddingId || !cropContentSha256) return null;
  const plateEvidence = reviewedPlateEntries(row);
  return {
    derivativeId,
    assetId,
    embeddingId,
    cropKind: text(row?.derivative_kind ?? row?.cropKind ?? "vehicle_crop"),
    cropAlgorithmVersion: text(row?.crop_algorithm_version ?? row?.algorithm_version
      ?? row?.cropAlgorithmVersion),
    assetSourceSha256,
    cropContentSha256,
    cropStoragePath: text(row?.crop_storage_path ?? row?.storage_path ?? row?.cropStoragePath),
    embeddingModel: text(row?.embedding_model ?? row?.model_name ?? row?.embeddingModel),
    embeddingAlgorithmVersion: text(
      row?.embedding_algorithm_version ?? row?.embeddingAlgorithmVersion
    ),
    embeddingSourceSha256,
    embeddingSha256,
    embeddingDimensions: Number(row?.embedding_dimensions ?? row?.embeddingDimensions ?? 512),
    representativeReadId: positiveId(
      row?.representative_read_id ?? row?.read_id ?? row?.representativeReadId ?? row?.readId
    ),
    representativeSourceKind: text(
      row?.representative_source_kind ?? row?.source_kind ?? row?.representativeSourceKind
    ),
    representativeSourcePath: text(
      row?.representative_source_path ?? row?.source_path_snapshot
        ?? row?.representativeSourcePath
    ),
    representativeSourceUpdatedAt: row?.representative_source_updated_at
      ?? row?.source_updated_at ?? row?.representativeSourceUpdatedAt ?? null,
    representativeLinkUpdatedAt: row?.representative_link_updated_at
      ?? row?.link_updated_at ?? row?.representativeLinkUpdatedAt ?? null,
    effectivePlates: uniqueSorted(plateEvidence.map((item) => item.plate)),
    identityPlates: uniqueSorted(plateEvidence
      .filter((item) => item.reviewStatus !== "rejected")
      .map((item) => item.plate)),
    trustedPlates: uniqueSorted(plateEvidence
      .filter((item) => TRUSTED_PLATE_STATUSES.has(item.reviewStatus))
      .map((item) => item.plate)),
    plateEvidence,
    overviewContexts: uniqueSorted(arrayValue(
      row?.overview_contexts ?? row?.overviewContexts
    ).map(text)),
  };
}

function reviewFromRow(row, sourcesById) {
  const low = positiveId(row?.derivative_id_low ?? row?.derivativeIdLow);
  const high = positiveId(row?.derivative_id_high ?? row?.derivativeIdHigh);
  const label = text(row?.label).toLowerCase();
  if (!low || !high || low === high
      || !["same_vehicle", "different_vehicle", "unsure"].includes(label)) return null;
  const derivativeIdLow = Math.min(low, high);
  const derivativeIdHigh = Math.max(low, high);
  const lowSource = sourcesById.get(derivativeIdLow);
  const highSource = sourcesById.get(derivativeIdHigh);
  const sourceShaLow = lowerHash(row?.source_sha256_low ?? row?.sourceSha256Low);
  const sourceShaHigh = lowerHash(row?.source_sha256_high ?? row?.sourceSha256High);
  const embeddingIdLow = positiveId(row?.embedding_id_low ?? row?.embeddingIdLow);
  const embeddingIdHigh = positiveId(row?.embedding_id_high ?? row?.embeddingIdHigh);
  const exactCurrent = Boolean(
    lowSource && highSource
      && (!sourceShaLow || sourceShaLow === lowSource.cropContentSha256)
      && (!sourceShaHigh || sourceShaHigh === highSource.cropContentSha256)
      && (!embeddingIdLow || embeddingIdLow === lowSource.embeddingId)
      && (!embeddingIdHigh || embeddingIdHigh === highSource.embeddingId)
  );
  return {
    id: positiveId(row?.review_id ?? row?.id ?? row?.reviewId),
    revision: Math.max(1, Number(row?.revision) || 1),
    derivativeIdLow,
    derivativeIdHigh,
    sourceShaLow,
    sourceShaHigh,
    embeddingIdLow,
    embeddingIdHigh,
    embeddingModel: text(row?.embedding_model ?? row?.embeddingModel),
    embeddingAlgorithmVersion: text(
      row?.embedding_algorithm_version ?? row?.algorithm_version
        ?? row?.embeddingAlgorithmVersion
    ),
    similarityScore: Number.isFinite(Number(row?.similarity_score ?? row?.similarityScore))
      ? Number(row?.similarity_score ?? row?.similarityScore) : null,
    label,
    exactCurrent,
    evidencePlateLow: normalizedPlate(row?.evidence_plate_low ?? row?.evidencePlateLow) || null,
    evidencePlateHigh: normalizedPlate(row?.evidence_plate_high ?? row?.evidencePlateHigh) || null,
    campaignId: positiveId(row?.campaign_id ?? row?.campaignId),
    updatedAt: row?.review_updated_at ?? row?.updated_at ?? row?.updatedAt ?? null,
  };
}

function readFromRow(row) {
  const readId = positiveId(row?.read_id ?? row?.id ?? row?.readId);
  if (!readId) return null;
  const effectivePlate = normalizedPlate(
    row?.normalized_effective_plate ?? row?.effective_plate
      ?? row?.plate_number ?? row?.effectivePlate
  );
  const reviewStatus = text(row?.plate_review_status ?? row?.review_status
    ?? row?.reviewStatus ?? "unreviewed").toLowerCase();
  const canonicalLinkState = text(row?.canonical_link_state ?? row?.canonicalLinkState
    ?? "absent").toLowerCase();
  const daylightStatus = text(row?.daylight_status ?? row?.daylightStatus ?? "unknown")
    .toLowerCase();
  const v1ClusterId = positiveId(row?.v1_cluster_id ?? row?.cluster_id ?? row?.v1ClusterId);
  return {
    readId,
    readEventIdentity: text(row?.read_event_identity ?? row?.readEventIdentity) || null,
    readTimestamp: row?.read_timestamp ?? row?.readTimestamp ?? null,
    readCreatedAt: row?.read_created_at ?? row?.readCreatedAt ?? null,
    cameraName: text(row?.camera_name ?? row?.cameraName) || null,
    observedPlate: normalizedPlate(row?.observed_plate ?? row?.observedPlate) || null,
    effectivePlate,
    reviewStatus,
    reviewRevision: Math.max(0, Number(row?.plate_review_revision
      ?? row?.review_revision ?? row?.reviewRevision) || 0),
    lastPlateReviewId: positiveId(row?.last_plate_review_id ?? row?.lastPlateReviewId),
    appliedAliasId: positiveId(row?.applied_alias_id ?? row?.appliedAliasId),
    vehicleImageStatus: text(row?.vehicle_image_status ?? row?.vehicleImageStatus) || null,
    vehicleImageQueueKind: text(
      row?.vehicle_image_queue_kind ?? row?.vehicleImageQueueKind
    ) || null,
    vehicleImageErrorCode: text(
      row?.vehicle_image_error_code ?? row?.vehicleImageErrorCode
    ) || null,
    vehicleImagePath: text(row?.vehicle_image_path ?? row?.vehicleImagePath) || null,
    vehicleImageSourceKind: text(
      row?.vehicle_image_source_kind ?? row?.vehicleImageSourceKind
    ) || null,
    vehicleImageUpdatedAt: row?.vehicle_image_updated_at ?? row?.vehicleImageUpdatedAt ?? null,
    canonicalLinkState,
    assetId: positiveId(row?.asset_id ?? row?.assetId),
    derivativeId: positiveId(row?.derivative_id ?? row?.derivativeId),
    embeddingId: positiveId(row?.embedding_id ?? row?.embeddingId),
    sourceReadId: positiveId(row?.source_read_id ?? row?.sourceReadId),
    relationship: text(row?.relationship).toLowerCase() || null,
    sourceKind: text(row?.source_kind ?? row?.sourceKind) || null,
    identityEligible: row?.identity_eligible ?? row?.identityEligible ?? null,
    sourcePathSnapshot: text(row?.source_path_snapshot ?? row?.sourcePathSnapshot) || null,
    sourceUpdatedAt: row?.source_updated_at ?? row?.sourceUpdatedAt ?? null,
    linkUpdatedAt: row?.link_updated_at ?? row?.linkUpdatedAt ?? null,
    overviewContext: text(row?.overview_context ?? row?.overviewContext) || null,
    daylightStatus,
    historical: Boolean(row?.historical)
      || ["historical", "overview_backfill", "overview_history"].includes(
        text(row?.vehicle_image_queue_kind ?? row?.vehicleImageQueueKind).toLowerCase()
      ),
    v1ClusterId,
    v1AssignmentStatus: text(row?.v1_assignment_status ?? row?.v1AssignmentStatus) || null,
    v1AssignmentRevision: positiveId(
      row?.v1_assignment_revision ?? row?.v1AssignmentRevision
    ),
  };
}

class DisjointSet {
  constructor(ids) {
    this.parents = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parents.get(id);
    if (parent == null) return null;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parents.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot == null || rightRoot == null || leftRoot === rightRoot) return;
    this.parents.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  }
}

function platesCompatible(leftSource, rightSource) {
  if (leftSource.identityPlates.length > 1 || rightSource.identityPlates.length > 1) {
    return false;
  }
  const [left] = leftSource.identityPlates;
  const [right] = rightSource.identityPlates;
  if (!left || !right || left === right) return true;
  return evaluatePlateIdentityMatch(left, right, "balanced").matched;
}

function resolvedAssetReadCounts(reads, suppliedCounts) {
  const counts = new Map();
  if (suppliedCounts !== null && suppliedCounts !== undefined) {
    const entries = suppliedCounts instanceof Map
      ? [...suppliedCounts.entries()]
      : Array.isArray(suppliedCounts)
        ? suppliedCounts.map((row) => [row?.asset_id ?? row?.assetId, row?.read_count ?? row?.count])
        : Object.entries(suppliedCounts);
    for (const [assetIdValue, countValue] of entries) {
      const assetId = positiveId(assetIdValue);
      const count = Math.max(0, Number(countValue) || 0);
      if (assetId) counts.set(assetId, count);
    }
    return counts;
  }
  for (const read of reads) {
    if (read.canonicalLinkState !== "current" || !read.assetId) continue;
    counts.set(read.assetId, (counts.get(read.assetId) || 0) + 1);
  }
  return counts;
}

function evidenceBasis({ size, exactMembers, humanMembers }) {
  if (size === 1) return "provisional_singleton";
  const exact = exactMembers > 0;
  const human = humanMembers > 0;
  if (exact && human) return "mixed";
  return human ? "human_same" : "exact_effective_plate";
}

function assignmentReasonForMissing(read) {
  if (read.reviewStatus === "rejected") return "rejected_plate";
  if (read.canonicalLinkState === "display_only") return "display_only_fallback";
  if (read.canonicalLinkState === "incomplete") return "incomplete_canonical_evidence";
  if (read.canonicalLinkState === "stale") return "stale_source_link";
  return read.effectivePlate ? "untrusted_or_unmatched_plate" : "missing_identity_evidence";
}

function choose2(value) {
  const count = Number(value) || 0;
  return count > 1 ? count * (count - 1) / 2 : 0;
}

function comparisonMetrics(reads, dispositions) {
  const dispositionByRead = new Map(dispositions.map((item) => [item.readId, item]));
  let bothAssigned = 0;
  let v1Only = 0;
  let v2Only = 0;
  let neither = 0;
  const v1Groups = new Map();
  const v2Groups = new Map();
  const v1ComparableGroups = new Map();
  const v2ComparableGroups = new Map();
  const intersections = new Map();

  for (const read of reads) {
    const v1 = read.v1ClusterId;
    const v2 = dispositionByRead.get(read.readId)?.profileKey || null;
    if (v1 && v2) bothAssigned += 1;
    else if (v1) v1Only += 1;
    else if (v2) v2Only += 1;
    else neither += 1;
    if (v1) {
      const ids = v1Groups.get(v1) || new Set();
      ids.add(read.readId);
      v1Groups.set(v1, ids);
    }
    if (v2) {
      const ids = v2Groups.get(v2) || new Set();
      ids.add(read.readId);
      v2Groups.set(v2, ids);
    }
    if (v1 && v2) {
      const v1Comparable = v1ComparableGroups.get(v1) || new Set();
      v1Comparable.add(read.readId);
      v1ComparableGroups.set(v1, v1Comparable);
      const v2Comparable = v2ComparableGroups.get(v2) || new Set();
      v2Comparable.add(read.readId);
      v2ComparableGroups.set(v2, v2Comparable);
      const key = `${v1}:${v2}`;
      intersections.set(key, (intersections.get(key) || 0) + 1);
    }
  }

  const v1ToV2 = new Map();
  const v2ToV1 = new Map();
  for (const read of reads) {
    const v1 = read.v1ClusterId;
    const v2 = dispositionByRead.get(read.readId)?.profileKey || null;
    if (!v1 || !v2) continue;
    const v2Set = v1ToV2.get(v1) || new Set();
    v2Set.add(v2);
    v1ToV2.set(v1, v2Set);
    const v1Set = v2ToV1.get(v2) || new Set();
    v1Set.add(v1);
    v2ToV1.set(v2, v1Set);
  }
  const sameBothPairs = [...intersections.values()].reduce((sum, size) => sum + choose2(size), 0);
  const v1SameComparablePairs = [...v1ComparableGroups.values()]
    .reduce((sum, ids) => sum + choose2(ids.size), 0);
  const v2SameComparablePairs = [...v2ComparableGroups.values()]
    .reduce((sum, ids) => sum + choose2(ids.size), 0);
  let exactPartitionMatches = 0;
  for (const [v1, v2Set] of v1ToV2.entries()) {
    if (v2Set.size !== 1) continue;
    const [v2] = v2Set;
    const v1Set = v2ToV1.get(v2);
    if (v1Set?.size !== 1 || !v1Set.has(v1)) continue;
    const left = v1Groups.get(v1);
    const right = v2Groups.get(v2);
    if (left.size === right.size && [...left].every((id) => right.has(id))) {
      exactPartitionMatches += 1;
    }
  }
  return {
    v1AssignedReads: bothAssigned + v1Only,
    bothAssignedReads: bothAssigned,
    v1OnlyReads: v1Only,
    v2OnlyReads: v2Only,
    neitherAssignedReads: neither,
    exactPartitionMatches,
    v1ClusterSplits: [...v1ToV2.values()].filter((items) => items.size > 1).length,
    projectedV2Merges: [...v2ToV1.values()].filter((items) => items.size > 1).length,
    sameInBothPairs: sameBothPairs,
    v1SameV2DifferentPairs: Math.max(0, v1SameComparablePairs - sameBothPairs),
    v2SameV1DifferentPairs: Math.max(0, v2SameComparablePairs - sameBothPairs),
  };
}

export function buildVehicleReidV2ConversionProjection({
  sourceRows = [],
  reviewRows = [],
  readRows = [],
  assetReadCounts = null,
  embeddingModel = "",
  embeddingAlgorithmVersion = "",
} = {}) {
  const sources = sourceRows.map(sourceFromRow).filter(Boolean)
    .sort((left, right) => left.derivativeId - right.derivativeId);
  const sourcesById = new Map(sources.map((source) => [source.derivativeId, source]));
  const reviews = reviewRows.map((row) => reviewFromRow(row, sourcesById)).filter(Boolean)
    .sort((left, right) => (
      left.derivativeIdLow - right.derivativeIdLow
      || left.derivativeIdHigh - right.derivativeIdHigh
      || left.label.localeCompare(right.label)
      || (left.id || 0) - (right.id || 0)
    ));
  const reads = readRows.map(readFromRow).filter(Boolean)
    .sort((left, right) => left.readId - right.readId);
  const disjoint = new DisjointSet(sources.map((source) => source.derivativeId));
  const exactPlateGroups = new Map();
  const humanSameMembers = new Set();
  const preconflicted = new Set();
  const reviewConflicts = [];

  for (const source of sources) {
    if (source.identityPlates.length > 1) {
      preconflicted.add(source.derivativeId);
      reviewConflicts.push({
        reason: "ambiguous_effective_plates",
        derivativeIds: [source.derivativeId],
        readIds: source.plateEvidence.map((item) => item.readId).filter(Boolean),
        effectivePlates: source.identityPlates,
        details: { multipleEffectivePlatesOnOneCanonicalAsset: true },
      });
      continue;
    }
    for (const plate of source.identityPlates) {
      const ids = exactPlateGroups.get(plate) || [];
      ids.push(source.derivativeId);
      exactPlateGroups.set(plate, ids);
    }
  }
  for (const ids of exactPlateGroups.values()) {
    ids.slice(1).forEach((id) => disjoint.union(ids[0], id));
  }
  for (const review of reviews) {
    if (!review.exactCurrent) {
      if (["different_vehicle", "unsure"].includes(review.label)) {
        if (sourcesById.has(review.derivativeIdLow)) {
          preconflicted.add(review.derivativeIdLow);
        }
        if (sourcesById.has(review.derivativeIdHigh)) {
          preconflicted.add(review.derivativeIdHigh);
        }
      }
      reviewConflicts.push({
        reason: "missing_evidence",
        derivativeIds: [review.derivativeIdLow, review.derivativeIdHigh],
        reviewIds: review.id ? [review.id] : [],
        details: { staleReviewContract: true, label: review.label },
      });
      continue;
    }
    if (review.label !== "same_vehicle") continue;
    const low = sourcesById.get(review.derivativeIdLow);
    const high = sourcesById.get(review.derivativeIdHigh);
    if (!platesCompatible(low, high)) {
      preconflicted.add(low.derivativeId);
      preconflicted.add(high.derivativeId);
      reviewConflicts.push({
        reason: "dissimilar_effective_plates",
        derivativeIds: [low.derivativeId, high.derivativeId],
        reviewIds: review.id ? [review.id] : [],
        effectivePlates: uniqueSorted([...low.effectivePlates, ...high.effectivePlates]),
        details: { label: review.label },
      });
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

  const conflicts = [...reviewConflicts];
  const conflictedDerivativeIds = new Set(preconflicted);
  const profiles = [];
  for (const members of components.values()) {
    const ids = new Set(members.map((member) => member.derivativeId));
    const vetoReviews = reviews.filter((review) => (
      review.exactCurrent
      && ids.has(review.derivativeIdLow) && ids.has(review.derivativeIdHigh)
      && ["different_vehicle", "unsure"].includes(review.label)
    ));
    let dissimilar = null;
    for (let left = 0; left < members.length && !dissimilar; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        if (!platesCompatible(members[left], members[right])) {
          dissimilar = [members[left], members[right]];
          break;
        }
      }
    }
    const preblocked = members.some((member) => preconflicted.has(member.derivativeId));
    if (members.length === 1 && preblocked && !vetoReviews.length && !dissimilar) {
      conflictedDerivativeIds.add(members[0].derivativeId);
      continue;
    }
    if (vetoReviews.length || dissimilar || preblocked) {
      let reason = "mixed";
      const labels = new Set(vetoReviews.map((review) => review.label));
      if (labels.size === 1 && !dissimilar && !preblocked) {
        reason = labels.has("different_vehicle") ? "human_different" : "human_unsure";
      } else if (!vetoReviews.length && (dissimilar || preblocked)) {
        reason = "dissimilar_effective_plates";
      }
      members.forEach((member) => conflictedDerivativeIds.add(member.derivativeId));
      conflicts.push({
        reason,
        derivativeIds: [...ids].sort((left, right) => left - right),
        reviewIds: vetoReviews.map((review) => review.id).filter(Boolean).sort((a, b) => a - b),
        effectivePlates: uniqueSorted(members.flatMap((member) => member.effectivePlates)),
        details: { labels: uniqueSorted(vetoReviews.map((review) => review.label)) },
      });
      continue;
    }
    const memberRows = members.map((member) => {
      const exact = member.effectivePlates.some((plate) => (
        (exactPlateGroups.get(plate)?.length || 0) > 1
      ));
      const human = humanSameMembers.has(member.derivativeId);
      return {
        ...member,
        membershipBasis: evidenceBasis({
          size: members.length,
          exactMembers: exact ? 1 : 0,
          humanMembers: human ? 1 : 0,
        }),
      };
    });
    const basis = evidenceBasis({
      size: members.length,
      exactMembers: memberRows.filter((member) => (
        ["exact_effective_plate", "mixed"].includes(member.membershipBasis)
      )).length,
      humanMembers: memberRows.filter((member) => (
        ["human_same", "mixed"].includes(member.membershipBasis)
      )).length,
    });
    const profileKey = hashJson({
      algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
      members: memberRows.map((member) => ({
        derivativeId: member.derivativeId,
        assetId: member.assetId,
        embeddingId: member.embeddingId,
        cropContentSha256: member.cropContentSha256,
        embeddingSha256: member.embeddingSha256,
      })),
    });
    const representative = [...memberRows].sort((left, right) => (
      right.derivativeId - left.derivativeId
    ))[0];
    profiles.push({
      profileKey,
      evidenceBasis: basis,
      representativeDerivativeId: representative.derivativeId,
      representativeAssetId: representative.assetId,
      representativeEmbeddingId: representative.embeddingId,
      representativeSourceSha256: representative.cropContentSha256,
      memberCount: memberRows.length,
      anchorPlates: uniqueSorted(memberRows.flatMap((member) => member.trustedPlates)),
      observedEffectivePlates: uniqueSorted(memberRows.flatMap((member) => member.effectivePlates)),
      provisional: memberRows.length === 1,
      members: memberRows,
    });
  }
  profiles.sort((left, right) => (
    right.memberCount - left.memberCount
    || right.representativeDerivativeId - left.representativeDerivativeId
  ));

  const profileByDerivative = new Map();
  const profileByTrustedPlate = new Map();
  for (const profile of profiles) {
    profile.members.forEach((member) => profileByDerivative.set(member.derivativeId, profile));
    for (const plate of profile.anchorPlates) {
      const matches = profileByTrustedPlate.get(plate) || [];
      matches.push(profile);
      profileByTrustedPlate.set(plate, matches);
    }
  }
  const resolvedReadCounts = resolvedAssetReadCounts(reads, assetReadCounts);

  const dispositions = [];
  for (const read of reads) {
    let disposition = "unassigned";
    let reasonCode = assignmentReasonForMissing(read);
    let profile = null;
    let assignmentBasis = null;
    if (read.reviewStatus === "rejected") {
      reasonCode = "rejected_plate";
    } else if (read.canonicalLinkState === "current") {
      profile = read.derivativeId ? profileByDerivative.get(read.derivativeId) : null;
      if (profile) {
        disposition = "assigned";
        const shared = read.relationship === "shared"
          || (read.assetId && (resolvedReadCounts.get(read.assetId) || 0) > 1);
        assignmentBasis = shared ? "shared_asset" : "canonical_image";
        reasonCode = shared ? "current_shared_asset" : "current_canonical_crop";
      } else if (read.derivativeId && conflictedDerivativeIds.has(read.derivativeId)) {
        disposition = "conflict";
        reasonCode = "conflicted_component";
      } else {
        disposition = "unavailable";
        reasonCode = read.derivativeId ? "missing_current_profile" : "missing_current_crop";
      }
    } else if (read.canonicalLinkState === "stale") {
      disposition = "stale";
      reasonCode = "stale_source_link";
    } else if (read.canonicalLinkState === "incomplete") {
      disposition = "unavailable";
      reasonCode = read.derivativeId ? "missing_current_embedding" : "missing_current_crop";
    } else if (read.canonicalLinkState === "display_only") {
      reasonCode = "display_only_fallback";
    } else if (read.effectivePlate && TRUSTED_PLATE_STATUSES.has(read.reviewStatus)) {
      const matches = profileByTrustedPlate.get(read.effectivePlate) || [];
      if (matches.length === 1) {
        [profile] = matches;
        disposition = "assigned";
        assignmentBasis = "exact_effective_plate";
        reasonCode = "trusted_exact_plate_only";
      } else if (matches.length > 1) {
        disposition = "conflict";
        reasonCode = "ambiguous_effective_plate";
      } else {
        reasonCode = "trusted_plate_without_profile";
      }
    }
    dispositions.push({
      readId: read.readId,
      disposition,
      reasonCode,
      profileKey: profile?.profileKey || null,
      assignmentBasis,
      profileEvidenceBasis: profile?.evidenceBasis || null,
      assetId: assignmentBasis && assignmentBasis !== "exact_effective_plate" ? read.assetId : null,
      derivativeId: assignmentBasis && assignmentBasis !== "exact_effective_plate"
        ? read.derivativeId : null,
      embeddingId: assignmentBasis && assignmentBasis !== "exact_effective_plate"
        ? read.embeddingId : null,
      normalizedEffectivePlate: read.effectivePlate || null,
      historical: read.historical || read.canonicalLinkState === "absent",
      nighttime: read.daylightStatus === "nighttime",
    });
  }

  const normalizedConflicts = conflicts.map((conflict) => ({
    ...conflict,
    derivativeIds: uniqueSorted((conflict.derivativeIds || []).map(Number)),
    readIds: uniqueSorted((conflict.readIds || []).map(Number)),
    reviewIds: uniqueSorted((conflict.reviewIds || []).map(Number)),
    effectivePlates: uniqueSorted(conflict.effectivePlates || []),
    conflictKey: hashJson({
      algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
      reason: conflict.reason,
      derivativeIds: uniqueSorted((conflict.derivativeIds || []).map(Number)),
      readIds: uniqueSorted((conflict.readIds || []).map(Number)),
      reviewIds: uniqueSorted((conflict.reviewIds || []).map(Number)),
      effectivePlates: uniqueSorted(conflict.effectivePlates || []),
      details: conflict.details || {},
    }),
  })).sort((left, right) => left.conflictKey.localeCompare(right.conflictKey));

  const identityEvidenceFingerprint = hashJson({
    algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
    embeddingModel: text(embeddingModel),
    embeddingAlgorithmVersion: text(embeddingAlgorithmVersion),
    sources: sources.map((source) => ({
      derivativeId: source.derivativeId,
      assetId: source.assetId,
      embeddingId: source.embeddingId,
      cropKind: source.cropKind,
      cropAlgorithmVersion: source.cropAlgorithmVersion,
      assetSourceSha256: source.assetSourceSha256,
      cropContentSha256: source.cropContentSha256,
      embeddingSourceSha256: source.embeddingSourceSha256,
      embeddingSha256: source.embeddingSha256,
      representativeReadId: source.representativeReadId,
      representativeSourceKind: source.representativeSourceKind,
      representativeSourcePath: source.representativeSourcePath,
      representativeSourceUpdatedAt: source.representativeSourceUpdatedAt,
      representativeLinkUpdatedAt: source.representativeLinkUpdatedAt,
      plateEvidence: source.plateEvidence,
    })),
    reviews,
    reads: reads.map((read) => ({
      readId: read.readId,
      readEventIdentity: read.readEventIdentity,
      readTimestamp: read.readTimestamp,
      readCreatedAt: read.readCreatedAt,
      cameraName: read.cameraName,
      observedPlate: read.observedPlate,
      effectivePlate: read.effectivePlate,
      reviewStatus: read.reviewStatus,
      reviewRevision: read.reviewRevision,
      lastPlateReviewId: read.lastPlateReviewId,
      appliedAliasId: read.appliedAliasId,
      vehicleImageStatus: read.vehicleImageStatus,
      vehicleImageQueueKind: read.vehicleImageQueueKind,
      vehicleImageErrorCode: read.vehicleImageErrorCode,
      vehicleImagePath: read.vehicleImagePath,
      vehicleImageSourceKind: read.vehicleImageSourceKind,
      vehicleImageUpdatedAt: read.vehicleImageUpdatedAt,
      canonicalLinkState: read.canonicalLinkState,
      assetId: read.assetId,
      derivativeId: read.derivativeId,
      embeddingId: read.embeddingId,
      sourceReadId: read.sourceReadId,
      relationship: read.relationship,
      sourceKind: read.sourceKind,
      identityEligible: read.identityEligible,
      sourcePathSnapshot: read.sourcePathSnapshot,
      sourceUpdatedAt: read.sourceUpdatedAt,
      linkUpdatedAt: read.linkUpdatedAt,
      overviewContext: read.overviewContext,
      daylightStatus: read.daylightStatus,
    })),
  });
  const previewFingerprint = hashJson({
    algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
    identityEvidenceFingerprint,
    profiles: profiles.map((profile) => ({
      profileKey: profile.profileKey,
      evidenceBasis: profile.evidenceBasis,
      representativeDerivativeId: profile.representativeDerivativeId,
      anchorPlates: profile.anchorPlates,
      members: profile.members.map((member) => ({
        derivativeId: member.derivativeId,
        assetId: member.assetId,
        embeddingId: member.embeddingId,
        membershipBasis: member.membershipBasis,
      })),
    })),
    dispositions,
    conflicts: normalizedConflicts.map((conflict) => ({
      conflictKey: conflict.conflictKey,
      reason: conflict.reason,
    })),
  });
  const assigned = dispositions.filter((item) => item.disposition === "assigned");
  const metrics = {
    eligibleCrops: sources.length,
    exactCurrentEmbeddings: sources.length,
    projectedProfiles: profiles.length,
    projectedMultiMemberProfiles: profiles.filter((profile) => profile.memberCount > 1).length,
    projectedSingletonProfiles: profiles.filter((profile) => profile.memberCount === 1).length,
    projectedMembers: profiles.reduce((sum, profile) => sum + profile.memberCount, 0),
    assignedReads: assigned.length,
    canonicalImageAssignments: assigned.filter((item) => (
      item.assignmentBasis === "canonical_image"
    )).length,
    sharedAssetAssignments: assigned.filter((item) => (
      item.assignmentBasis === "shared_asset"
    )).length,
    exactPlateOnlyAssignments: assigned.filter((item) => (
      item.assignmentBasis === "exact_effective_plate"
    )).length,
    historicalExactPlateAssignments: assigned.filter((item) => (
      item.assignmentBasis === "exact_effective_plate" && item.historical
    )).length,
    nighttimeExactPlateAssignments: assigned.filter((item) => (
      item.assignmentBasis === "exact_effective_plate" && item.nighttime
    )).length,
    conflictedComponents: normalizedConflicts.length,
    conflictedReads: dispositions.filter((item) => item.disposition === "conflict").length,
    unassignedReads: dispositions.filter((item) => item.disposition !== "assigned").length,
    staleEvidenceReads: dispositions.filter((item) => item.disposition === "stale").length,
    dispositionCounts: Object.fromEntries([...new Set(dispositions.map((item) => item.reasonCode))]
      .sort().map((reason) => [reason, dispositions.filter((item) => item.reasonCode === reason).length])),
    ...comparisonMetrics(reads, dispositions),
  };
  return {
    algorithmVersion: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
    identityEvidenceFingerprint,
    previewFingerprint,
    sources,
    reviews,
    reads,
    profiles,
    conflicts: normalizedConflicts,
    dispositions,
    metrics,
  };
}

export const vehicleReidV2ConversionPreviewInternals = Object.freeze({
  hashJson,
  normalizedPlate,
  readFromRow,
  reviewFromRow,
  sourceFromRow,
});
