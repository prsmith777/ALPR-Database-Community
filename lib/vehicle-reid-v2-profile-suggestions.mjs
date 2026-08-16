import { plateEvidenceResolution, vehicleReidV2TargetedReviewInternals } from "./vehicle-reid-v2-targeted-review.mjs";

export const VEHICLE_REID_V2_PROFILE_SUGGESTION_MAX_SOURCES = 48;
export const VEHICLE_REID_V2_PROFILE_SUGGESTION_LIMIT = 12;

const { effectivePlates } = vehicleReidV2TargetedReviewInternals;

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function uniquePlates(values) {
  return [...new Set(values.map(normalizedPlate).filter(Boolean))].sort();
}

function pairKey(leftValue, rightValue) {
  const left = positiveId(leftValue);
  const right = positiveId(rightValue);
  if (!left || !right || left === right) return null;
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function currentSource(row) {
  const derivativeId = positiveId(row?.derivative_id ?? row?.derivativeId);
  const embeddingId = positiveId(row?.embedding_id ?? row?.embeddingId);
  const sourceSha256 = String(
    row?.content_sha256 ?? row?.source_sha256 ?? row?.sourceSha256 ?? ""
  ).trim().toLowerCase();
  if (!derivativeId || !embeddingId || !/^[0-9a-f]{64}$/.test(sourceSha256)) return null;
  const plates = uniquePlates(effectivePlates(row));
  return {
    derivativeId,
    embeddingId,
    sourceSha256,
    readId: positiveId(row?.read_id ?? row?.readId),
    cameraName: String(row?.camera_name ?? row?.cameraName ?? "").trim() || null,
    overviewContext: String(
      row?.overview_context ?? row?.overviewContext ?? ""
    ).trim() || null,
    plates,
    ambiguousPlateEvidence: plates.length > 1,
    row,
  };
}

function memberSnapshot(row) {
  const profileCandidateId = positiveId(
    row?.profile_candidate_id ?? row?.profileCandidateId
  );
  const derivativeId = positiveId(row?.derivative_id ?? row?.derivativeId);
  const embeddingId = positiveId(row?.embedding_id ?? row?.embeddingId);
  const sourceSha256 = String(
    row?.source_sha256 ?? row?.sourceSha256 ?? ""
  ).trim().toLowerCase();
  if (!profileCandidateId || !derivativeId || !embeddingId
    || !/^[0-9a-f]{64}$/.test(sourceSha256)) return null;
  return {
    profileCandidateId,
    derivativeId,
    embeddingId,
    sourceSha256,
    profileCandidateKey: String(
      row?.candidate_key ?? row?.profileCandidateKey ?? ""
    ).trim(),
    profileEvidenceBasis: String(
      row?.profile_evidence_basis ?? row?.profileEvidenceBasis ?? ""
    ).trim(),
    profileMemberCount: Number(
      row?.profile_member_count ?? row?.profileMemberCount ?? 0
    ),
    effectivePlates: uniquePlates(arrayValue(
      row?.effective_plates ?? row?.effectivePlates
    )),
    readId: positiveId(row?.read_id ?? row?.readId),
    cameraName: String(row?.camera_name ?? row?.cameraName ?? "").trim() || null,
    overviewContext: String(
      row?.overview_context ?? row?.overviewContext ?? ""
    ).trim() || null,
    anchorPlates: uniquePlates(arrayValue(
      row?.anchor_plates ?? row?.anchorPlates
    )),
    cameraNames: arrayValue(row?.camera_names ?? row?.cameraNames)
      .map((value) => String(value || "").trim()).filter(Boolean),
    overviewContexts: arrayValue(row?.overview_contexts ?? row?.overviewContexts)
      .map((value) => String(value || "").trim()).filter(Boolean),
  };
}

function reviewMap(rows = []) {
  const result = new Map();
  for (const row of rows) {
    const key = pairKey(
      row?.derivative_id_low ?? row?.derivativeIdLow,
      row?.derivative_id_high ?? row?.derivativeIdHigh
    );
    const label = String(row?.label || "").trim();
    if (key && ["same_vehicle", "different_vehicle", "unsure"].includes(label)) {
      result.set(key, label);
    }
  }
  return result;
}

function conflictIds(rows = []) {
  return new Set(rows.flatMap((row) => arrayValue(
    row?.derivative_ids ?? row?.derivativeIds
  )).map(positiveId).filter(Boolean));
}

function exactCurrentMember(snapshot, currentById) {
  const current = currentById.get(snapshot.derivativeId);
  return current
    && current.embeddingId === snapshot.embeddingId
    && current.sourceSha256 === snapshot.sourceSha256
    && current.readId === snapshot.readId
    && current.cameraName === snapshot.cameraName
    && current.overviewContext === snapshot.overviewContext
    && JSON.stringify(current.plates) === JSON.stringify(snapshot.effectivePlates)
    ? current
    : null;
}

function rounded(value) {
  return Number(Number(value).toFixed(6));
}

export function buildVehicleReidV2ProfileSuggestions({
  sourceRows = [],
  memberRows = [],
  conflictRows = [],
  reviewRows = [],
  similarityFor,
  sourceLimit = VEHICLE_REID_V2_PROFILE_SUGGESTION_MAX_SOURCES,
  suggestionLimit = VEHICLE_REID_V2_PROFILE_SUGGESTION_LIMIT,
} = {}) {
  if (typeof similarityFor !== "function") {
    throw new Error("ReID v2 profile suggestions require an embedding similarity function");
  }
  const current = sourceRows.map(currentSource).filter(Boolean);
  const totalCurrentSources = Number(sourceRows[0]?.total_sources || current.length);
  if (totalCurrentSources > current.length) {
    return {
      stats: {
        currentSources: totalCurrentSources,
        scannedSources: current.length,
        truncated: true,
        frozenMembers: 0,
        currentProfileMembers: 0,
        currentProfiles: 0,
        ungroupedSources: 0,
        consideredSources: 0,
        sourceLimit: Math.max(1, Number(sourceLimit) || 1),
        suggestionLimit: Math.max(1, Number(suggestionLimit) || 1),
        suggestionsAvailable: 0,
        ambiguousPlateEvidence: 0,
        snapshotConflict: 0,
        exactPlatePendingSnapshot: 0,
        humanSamePendingSnapshot: 0,
        incompatiblePlateProfiles: 0,
        reviewedProfiles: 0,
        withoutComparableProfile: 0,
      },
      suggestions: [],
    };
  }
  const currentById = new Map(current.map((source) => [source.derivativeId, source]));
  const conflicts = conflictIds(conflictRows);
  const reviews = reviewMap(reviewRows);
  const frozenMemberIds = new Set();
  const profilesById = new Map();

  for (const row of memberRows) {
    const snapshot = memberSnapshot(row);
    if (!snapshot) continue;
    frozenMemberIds.add(snapshot.derivativeId);
    const member = exactCurrentMember(snapshot, currentById);
    if (!member) continue;
    const profile = profilesById.get(snapshot.profileCandidateId) || {
      id: snapshot.profileCandidateId,
      candidateKey: snapshot.profileCandidateKey,
      evidenceBasis: snapshot.profileEvidenceBasis,
      frozenMemberCount: snapshot.profileMemberCount,
      anchorPlates: snapshot.anchorPlates,
      cameraNames: snapshot.cameraNames,
      overviewContexts: snapshot.overviewContexts,
      members: [],
    };
    profile.members.push(member);
    profilesById.set(profile.id, profile);
  }

  const profiles = [...profilesById.values()]
    .filter((profile) => profile.members.length >= 2)
    .sort((left, right) => left.id - right.id);
  const ungrouped = current
    .filter((source) => !frozenMemberIds.has(source.derivativeId))
    .sort((left, right) => right.derivativeId - left.derivativeId);
  const boundedSources = ungrouped.slice(0, Math.max(1, Number(sourceLimit) || 1));
  const counters = {
    ambiguousPlateEvidence: 0,
    snapshotConflict: 0,
    exactPlatePendingSnapshot: 0,
    humanSamePendingSnapshot: 0,
    incompatiblePlateProfiles: 0,
    reviewedProfiles: 0,
    withoutComparableProfile: 0,
  };
  const suggestions = [];

  for (const source of boundedSources) {
    if (conflicts.has(source.derivativeId)) {
      counters.snapshotConflict += 1;
      continue;
    }
    if (source.ambiguousPlateEvidence) {
      counters.ambiguousPlateEvidence += 1;
      continue;
    }

    const hasSameReview = profiles.some((profile) => profile.members.some((member) => (
      reviews.get(pairKey(source.derivativeId, member.derivativeId)) === "same_vehicle"
    )));
    if (hasSameReview) {
      counters.humanSamePendingSnapshot += 1;
      continue;
    }
    const hasExactPlateProfile = source.plates.length > 0 && profiles.some((profile) => (
      profile.anchorPlates.some((plate) => source.plates.includes(plate))
    ));
    if (hasExactPlateProfile) {
      counters.exactPlatePendingSnapshot += 1;
      continue;
    }

    const rankedProfiles = [];
    for (const profile of profiles) {
      const plateResolution = plateEvidenceResolution(source.plates, profile.anchorPlates);
      if (plateResolution.outcome === "different_vehicle") {
        counters.incompatiblePlateProfiles += 1;
        continue;
      }
      const labels = profile.members.map((member) => (
        reviews.get(pairKey(source.derivativeId, member.derivativeId))
      )).filter(Boolean);
      if (labels.some((label) => label === "different_vehicle" || label === "unsure")) {
        counters.reviewedProfiles += 1;
        continue;
      }
      const memberScores = profile.members.map((member) => ({
        member,
        similarity: similarityFor(source.row.embedding, member.row.embedding),
      })).filter((item) => Number.isFinite(item.similarity))
        .sort((left, right) => (
          right.similarity - left.similarity
          || right.member.derivativeId - left.member.derivativeId
        ));
      if (memberScores.length < 2) continue;
      const support = memberScores.slice(0, 3);
      const profileSimilarity = support.reduce((sum, item) => sum + item.similarity, 0)
        / support.length;
      rankedProfiles.push({
        profile,
        representative: memberScores[0].member,
        profileSimilarity,
        bestSimilarity: memberScores[0].similarity,
        weakestSupportSimilarity: support.at(-1).similarity,
        supportMembers: support.length,
      });
    }
    rankedProfiles.sort((left, right) => (
      right.profileSimilarity - left.profileSimilarity
      || right.bestSimilarity - left.bestSimilarity
      || left.profile.id - right.profile.id
    ));
    const best = rankedProfiles[0];
    if (!best) {
      counters.withoutComparableProfile += 1;
      continue;
    }
    suggestions.push({
      sourceRow: source.row,
      representativeRow: best.representative.row,
      profile: {
        id: best.profile.id,
        candidateKey: best.profile.candidateKey,
        evidenceBasis: best.profile.evidenceBasis,
        frozenMemberCount: best.profile.frozenMemberCount,
        currentMemberCount: best.profile.members.length,
        anchorPlates: best.profile.anchorPlates,
        cameraNames: best.profile.cameraNames,
        overviewContexts: best.profile.overviewContexts,
      },
      profileSimilarity: rounded(best.profileSimilarity),
      bestSimilarity: rounded(best.bestSimilarity),
      weakestSupportSimilarity: rounded(best.weakestSupportSimilarity),
      supportMembers: best.supportMembers,
    });
  }
  suggestions.sort((left, right) => (
    right.profileSimilarity - left.profileSimilarity
    || right.bestSimilarity - left.bestSimilarity
    || Number(right.sourceRow.derivative_id) - Number(left.sourceRow.derivative_id)
  ));

  return {
    stats: {
      currentSources: totalCurrentSources,
      scannedSources: current.length,
      truncated: false,
      frozenMembers: frozenMemberIds.size,
      currentProfileMembers: profiles.reduce((sum, profile) => sum + profile.members.length, 0),
      currentProfiles: profiles.length,
      ungroupedSources: ungrouped.length,
      consideredSources: boundedSources.length,
      sourceLimit: Math.max(1, Number(sourceLimit) || 1),
      suggestionLimit: Math.max(1, Number(suggestionLimit) || 1),
      suggestionsAvailable: suggestions.length,
      ...counters,
    },
    suggestions: suggestions.slice(0, Math.max(1, Number(suggestionLimit) || 1)),
  };
}

export const vehicleReidV2ProfileSuggestionInternals = Object.freeze({
  currentSource,
  memberSnapshot,
  pairKey,
});
