import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "./vehicle-asset-embedding-contract.mjs";
import {
  canonicalVehicleReidV2ReviewPair,
  normalizeVehicleReidV2ReviewLabel,
  publicVehicleReidV2Review,
  summarizeVehicleReidV2Reviews,
  VehicleReidV2ReviewError,
} from "./vehicle-reid-v2-review.mjs";
import { evaluateVehicleReidV2Reviews } from "./vehicle-reid-v2-evaluation.mjs";
import {
  buildVehicleReidV2DiverseReviewQueue,
  buildVehicleReidV2TargetedReviewQueue,
  plateEvidenceResolution,
} from "./vehicle-reid-v2-targeted-review.mjs";
import { buildVehicleReidV2ProfileSuggestions } from "./vehicle-reid-v2-profile-suggestions.mjs";

const EMBEDDING_BYTES = 2048;
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 48;
const DEFAULT_RESULT_LIMIT = 12;
const MAX_RESULT_LIMIT = 24;
const MAX_SCAN_SOURCES = 10_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Math.min(maximum, Math.max(minimum, parsed || fallback));
}

function byteBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function cosineSimilarityFromBytes(leftValue, rightValue) {
  const left = byteBuffer(leftValue);
  const right = byteBuffer(rightValue);
  if (!left || !right || left.length !== EMBEDDING_BYTES || right.length !== EMBEDDING_BYTES) {
    return null;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let offset = 0; offset < EMBEDDING_BYTES; offset += 4) {
    const leftValueAtOffset = left.readFloatLE(offset);
    const rightValueAtOffset = right.readFloatLE(offset);
    if (!Number.isFinite(leftValueAtOffset) || !Number.isFinite(rightValueAtOffset)) return null;
    dot += leftValueAtOffset * rightValueAtOffset;
    leftMagnitude += leftValueAtOffset * leftValueAtOffset;
    rightMagnitude += rightValueAtOffset * rightValueAtOffset;
  }
  const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
  if (!Number.isFinite(denominator) || denominator <= Number.EPSILON) return null;
  return Math.max(-1, Math.min(1, dot / denominator));
}

function numberArray(value) {
  return Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0)
    : [];
}

function stringArray(value, fallback = []) {
  const values = Array.isArray(value) ? value : fallback;
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function attribute(status, value, confidence) {
  const normalizedStatus = ["ready", "unknown"].includes(status) ? status : "missing";
  return {
    status: normalizedStatus,
    value: normalizedStatus === "ready" ? String(value || "").trim() || null : null,
    confidence: confidence == null ? null : Number(confidence),
  };
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

function storedImageUrl(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  return path ? `/images/${path}` : null;
}

function mapLprEvidenceItem(value, evidenceType) {
  const readId = Number(value?.readId);
  if (!Number.isSafeInteger(readId) || readId <= 0) return null;
  const imagePath = String(value?.imagePath || "").trim() || null;
  const thumbnailPath = String(value?.thumbnailPath || "").trim() || null;
  return {
    readId,
    evidenceType,
    plateNumber: String(value?.plateNumber || "").trim() || null,
    observedPlate: String(value?.observedPlate || "").trim() || null,
    imageUrl: storedImageUrl(imagePath || thumbnailPath),
    imagePath,
    thumbnailPath,
    cameraName: String(value?.cameraName || "").trim() || null,
    timestamp: value?.timestamp || null,
    directionLabel: String(value?.directionLabel || "").trim() || null,
    directionSource: String(value?.directionSource || "").trim() || null,
    reviewStatus: String(value?.reviewStatus || "").trim() || null,
    sourceKind: String(value?.sourceKind || "").trim() || null,
    relationship: String(value?.relationship || "").trim() || null,
    eventId: Number.isSafeInteger(Number(value?.eventId)) && Number(value.eventId) > 0
      ? Number(value.eventId)
      : null,
    correlationClass: String(value?.correlationClass || "").trim() || null,
  };
}

function evidenceValues(items, key) {
  return [...new Set(items
    .map((item) => String(item?.[key] || "").trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase()))];
}

function mapLprEvidence(row) {
  const direct = objectArray(row?.lpr_evidence)
    .map((item) => mapLprEvidenceItem(item, "direct"))
    .filter(Boolean);
  const directReadIds = new Set(direct.map((item) => item.readId));
  const companions = objectArray(row?.companion_lpr_evidence)
    .map((item) => mapLprEvidenceItem(item, "shadow_event_companion"))
    .filter((item) => item && !directReadIds.has(item.readId));
  const timestampMs = (value) => {
    const parsed = new Date(value || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const byNewest = (left, right) => (
    timestampMs(right.timestamp) - timestampMs(left.timestamp)
    || right.readId - left.readId
  );
  direct.sort(byNewest);
  companions.sort(byNewest);
  const all = [...direct, ...companions];
  const effectivePlates = evidenceValues(all, "plateNumber");
  const directions = evidenceValues(all, "directionLabel");
  return {
    direct,
    companions,
    conflicts: {
      plate: effectivePlates.length > 1,
      direction: directions.length > 1,
      effectivePlates,
      directions,
    },
  };
}

function mapSource(row) {
  if (!row) return null;
  const plateNumbers = stringArray(row.plate_numbers, [row.plate_number]);
  const cameraNames = stringArray(row.camera_names, [row.camera_name]);
  return {
    derivativeId: Number(row.derivative_id),
    assetId: Number(row.asset_id),
    readId: Number(row.read_id),
    imageUrl: `/images/${String(row.storage_path || "").replaceAll("\\", "/")}`,
    width: Number(row.image_width || 0),
    height: Number(row.image_height || 0),
    plateNumber: row.plate_number || null,
    observedPlate: row.observed_plate || null,
    plateNumbers,
    cameraName: row.camera_name || null,
    cameraNames,
    timestamp: row.read_timestamp || null,
    overviewContext: row.overview_context || null,
    sourceKind: row.source_kind || null,
    currentProfileIds: numberArray(row.cluster_ids),
    identityMode: row.identity_mode || "v1_primary",
    lprEvidence: mapLprEvidence(row),
    attributes: {
      color: attribute(row.color_status, row.color_value, row.color_confidence),
      bodyType: attribute(row.body_type_status, row.body_type_value, row.body_type_confidence),
    },
  };
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function sourceEffectivePlates(source) {
  return [...new Set([
    ...(source?.plateNumbers || []),
    ...(source?.lprEvidence?.direct || []).map((item) => item.plateNumber),
    ...(source?.lprEvidence?.companions || []).map((item) => item.plateNumber),
  ].map(normalizedPlate).filter(Boolean))].sort();
}

function automaticPlateReview(source, candidate, similarity) {
  const resolution = plateEvidenceResolution(
    sourceEffectivePlates(source),
    sourceEffectivePlates(candidate)
  );
  if (resolution.outcome === "human_review") return null;
  return {
    id: null,
    candidateDerivativeId: candidate.derivativeId,
    derivativeIdLow: Math.min(source.derivativeId, candidate.derivativeId),
    derivativeIdHigh: Math.max(source.derivativeId, candidate.derivativeId),
    label: resolution.outcome,
    similarity,
    modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
    algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
    revision: 1,
    reviewedAt: null,
    reviewer: null,
    automatic: true,
    reviewBasis: resolution.basis,
  };
}

function publicCampaign(row) {
  if (!row) return null;
  const target = Number(row.target_human_reviews || 500);
  const completed = Number(row.human_reviews || 0);
  return {
    id: Number(row.id),
    status: row.status,
    targetHumanReviews: target,
    humanReviews: completed,
    remainingHumanReviews: Math.max(0, target - completed),
    frozenMaxDerivativeId: Number(row.frozen_max_derivative_id),
    modelName: row.embedding_model,
    algorithmVersion: row.algorithm_version,
    startedAt: row.created_at || null,
    completedAt: row.completed_at || null,
    operator: {
      username: row.actor_username || null,
      displayName: row.actor_display_name || null,
    },
  };
}

function publicProfileCandidateSnapshot(row) {
  if (!row) return null;
  const arrayValue = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: Number(row.id),
    fingerprint: row.snapshot_fingerprint,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    embeddingModel: row.embedding_model,
    embeddingAlgorithmVersion: row.embedding_algorithm_version,
    frozenMaxDerivativeId: Number(row.frozen_max_derivative_id || 0),
    totalSources: Number(row.total_sources || 0),
    exactPlateEligibleSources: Number(row.exact_plate_eligible_sources || 0),
    humanSameReviews: Number(row.human_same_reviews || 0),
    humanDifferentReviews: Number(row.human_different_reviews || 0),
    candidateProfiles: Number(row.candidate_profiles || 0),
    candidateMembers: Number(row.candidate_members || 0),
    conflictedComponents: Number(row.conflicted_components || 0),
    conflictedMembers: Number(row.conflicted_members || 0),
    ungroupedSources: Number(row.ungrouped_sources || 0),
    actorUsername: row.actor_username || null,
    actorDisplayName: row.actor_display_name || null,
    createdAt: row.created_at || null,
    reused: row.reused === true,
    profiles: (row.profiles || []).map((profile) => ({
      id: Number(profile.id),
      candidateKey: profile.candidate_key,
      status: profile.status,
      evidenceBasis: profile.evidence_basis,
      representativeDerivativeId: Number(profile.representative_derivative_id),
      memberCount: Number(profile.member_count || 0),
      anchorPlates: arrayValue(profile.anchor_plates),
      cameraNames: arrayValue(profile.camera_names),
      overviewContexts: arrayValue(profile.overview_contexts),
      createdAt: profile.created_at || null,
    })),
    conflicts: (row.conflicts || []).map((conflict) => ({
      conflictKey: conflict.conflict_key,
      reason: conflict.reason,
      derivativeIds: arrayValue(conflict.derivative_ids).map(Number).filter(Number.isFinite),
      effectivePlates: arrayValue(conflict.effective_plates),
      reviewId: Number(conflict.review_id) || null,
      createdAt: conflict.created_at || null,
    })),
  };
}

function publicProfileSuggestions(result, snapshotId) {
  if (!result) return null;
  return {
    snapshotId: Number(snapshotId),
    stats: result.stats,
    suggestions: result.suggestions.map((suggestion) => ({
      source: mapSource(suggestion.sourceRow),
      representative: mapSource(suggestion.representativeRow),
      profile: suggestion.profile,
      profileSimilarity: suggestion.profileSimilarity,
      bestSimilarity: suggestion.bestSimilarity,
      weakestSupportSimilarity: suggestion.weakestSupportSimilarity,
      supportMembers: suggestion.supportMembers,
    })),
  };
}

function attributeAgreement(left, right) {
  if (left?.status !== "ready" || right?.status !== "ready") return "unavailable";
  return String(left.value).toLowerCase() === String(right.value).toLowerCase()
    ? "agrees"
    : "differs";
}

function matchesSearch(source, search) {
  if (!search) return true;
  const haystack = [
    source.derivativeId,
    source.assetId,
    source.readId,
    ...source.plateNumbers,
    ...source.cameraNames,
  ].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export class VehicleReidV2ShadowService {
  constructor({ repository } = {}) {
    if (!repository) throw new Error("ReID v2 shadow repository is required");
    this.repository = repository;
  }

  async getOverview(input = {}) {
    const pageSize = boundedInteger(input.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const requestedPage = boundedInteger(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const resultLimit = boundedInteger(
      input.resultLimit,
      DEFAULT_RESULT_LIMIT,
      1,
      MAX_RESULT_LIMIT
    );
    const search = String(input.search || "").trim().slice(0, 80);
    const rows = await this.repository.listCurrentSources({ limit: MAX_SCAN_SOURCES });
    const totalSources = Number(rows[0]?.total_sources || rows.length);
    const sources = rows.map(mapSource);
    const filtered = sources.filter((source) => matchesSearch(source, search));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const pageSources = filtered.slice((page - 1) * pageSize, page * pageSize);
    const primaryBrowse = input.primaryBrowse === true;

    const [reviewRows, campaignRow, profileCandidateRow] = await Promise.all([
      !primaryBrowse && typeof this.repository.listPairReviewCalibration === "function"
        ? this.repository.listPairReviewCalibration({
          modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
          algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
        })
        : [],
      !primaryBrowse && typeof this.repository.getLatestReviewCampaign === "function"
        ? this.repository.getLatestReviewCampaign()
        : null,
      !primaryBrowse && typeof this.repository.getProfileCandidateSnapshot === "function"
        ? this.repository.getProfileCandidateSnapshot()
        : null,
    ]);
    const reviewSummaries = this.summarizeReviewRows(reviewRows);
    const campaign = publicCampaign(campaignRow);
    const browseMode = input.browseMode === true;
    // An active campaign owns the default route. Ordinary neighborhood browsing is
    // still available, but only after the operator explicitly enters browse mode.
    const campaignActive = campaign?.status === "active" && !browseMode;
    let profileSuggestionResult = null;
    if (
      !campaignActive
      && profileCandidateRow
      && typeof this.repository.getProfileCandidateSuggestionInputs === "function"
    ) {
      const inputs = await this.repository.getProfileCandidateSuggestionInputs(
        Number(profileCandidateRow.id)
      );
      profileSuggestionResult = buildVehicleReidV2ProfileSuggestions({
        sourceRows: rows,
        memberRows: inputs.members,
        conflictRows: inputs.conflicts,
        reviewRows,
        similarityFor: cosineSimilarityFromBytes,
      });
    }
    const campaignResult = campaignActive
      ? buildVehicleReidV2DiverseReviewQueue({
        sourceRows: rows,
        reviewRows,
        similarityFor: cosineSimilarityFromBytes,
        timeZone: reviewSummaries.evaluation.timeZone,
        maximumDerivativeId: campaign.frozenMaxDerivativeId,
      })
      : { queue: [], inventoryLimited: false, eligibleSources: 0 };
    const targetedActive = input.targetedReview === true && !campaignActive;
    const targetedQueue = targetedActive
      ? buildVehicleReidV2TargetedReviewQueue({
        sourceRows: rows,
        reviewRows,
        evaluation: reviewSummaries.evaluation,
        similarityFor: cosineSimilarityFromBytes,
      })
      : [];
    const activeQueue = campaignActive ? campaignResult.queue : targetedQueue;

    const requestedSourceId = Number(input.sourceDerivativeId);
    const requestedCandidateId = Number(input.candidateDerivativeId);
    const requestedTargetIndex = activeQueue.findIndex((item) => (
      Number.isSafeInteger(requestedSourceId)
      && Number.isSafeInteger(requestedCandidateId)
      && item.sourceDerivativeId === requestedSourceId
      && item.candidateDerivativeId === requestedCandidateId
    ));
    // Campaign review always presents the first current unresolved pair. It does
    // not honor old source/candidate URLs or allow ordinary neighbor navigation.
    const targetedIndex = campaignActive ? 0 : requestedTargetIndex >= 0 ? requestedTargetIndex : 0;
    const targetedCurrent = activeQueue[targetedIndex] || null;
    const effectiveSourceId = targetedCurrent?.sourceDerivativeId || requestedSourceId;
    let selectedRow = Number.isSafeInteger(effectiveSourceId) && effectiveSourceId > 0
      ? rows.find((row) => Number(row.derivative_id) === effectiveSourceId)
      : null;
    if (!selectedRow && Number.isSafeInteger(effectiveSourceId) && effectiveSourceId > 0) {
      selectedRow = await this.repository.getCurrentSource(effectiveSourceId);
    }
    if (!selectedRow && !campaignActive && pageSources[0]) {
      selectedRow = rows.find((row) => Number(row.derivative_id) === pageSources[0].derivativeId);
    }

    const selected = mapSource(selectedRow);
    const allScored = selectedRow ? rows
      .filter((row) => Number(row.derivative_id) !== Number(selectedRow.derivative_id))
      .map((row) => ({
        row,
        similarity: cosineSimilarityFromBytes(selectedRow.embedding, row.embedding),
      }))
      .filter((item) => Number.isFinite(item.similarity))
      .sort((left, right) => (
        right.similarity - left.similarity
        || Number(right.row.derivative_id) - Number(left.row.derivative_id)
      ))
      : [];
    const ranked = allScored.map((item, index) => ({
      ...item,
      rank: index + 1,
      nextSimilarity: allScored[index + 1]?.similarity,
    }));
    let scored = ranked.slice(0, resultLimit);
    if (campaignActive) {
      const campaignMatch = targetedCurrent ? ranked.find((item) => (
        Number(item.row.derivative_id) === targetedCurrent.candidateDerivativeId
      )) : null;
      scored = campaignMatch ? [campaignMatch] : [];
    } else if (targetedCurrent) {
      const targetedMatch = ranked.find((item) => (
        Number(item.row.derivative_id) === targetedCurrent.candidateDerivativeId
      ));
      if (targetedMatch) {
        scored = [targetedMatch, ...scored.filter((item) => (
          Number(item.row.derivative_id) !== targetedCurrent.candidateDerivativeId
        ))].slice(0, resultLimit);
      }
    }

    const unreviewedMatches = scored.map((item) => {
      const candidate = mapSource(item.row);
      return {
        ...candidate,
        rank: item.rank,
        similarity: Number(item.similarity.toFixed(6)),
        marginToNext: Number.isFinite(item.nextSimilarity)
          ? Number((item.similarity - item.nextSimilarity).toFixed(6))
          : null,
        reviewEvidence: {
          plateAgreement: selected && intersects(selected.plateNumbers, candidate.plateNumbers),
          currentProfileAgreement: selected
            && intersects(selected.currentProfileIds, candidate.currentProfileIds),
          colorAgreement: attributeAgreement(
            selected?.attributes.color,
            candidate.attributes.color
          ),
          bodyTypeAgreement: attributeAgreement(
            selected?.attributes.bodyType,
            candidate.attributes.bodyType
          ),
        },
      };
    });

    const pairReviews = selected && unreviewedMatches.length
      && typeof this.repository.listPairReviewsForSource === "function"
      ? await this.repository.listPairReviewsForSource({
        sourceDerivativeId: selected.derivativeId,
        candidateDerivativeIds: unreviewedMatches.map((match) => match.derivativeId),
        modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
        algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      })
      : [];
    const reviewsByCandidate = new Map(pairReviews.map((row) => [
      Number(row.candidate_derivative_id),
      publicVehicleReidV2Review(row, row.candidate_derivative_id),
    ]));
    const matches = unreviewedMatches.map((match) => ({
      ...match,
      pairReview: automaticPlateReview(selected, match, match.similarity)
        || reviewsByCandidate.get(match.derivativeId)
        || null,
    }));

    const fullyAttributed = sources.filter((source) => (
      source.attributes.color.status !== "missing"
      && source.attributes.bodyType.status !== "missing"
    )).length;

    return {
      mode: "shadow",
      modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
      algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      stats: {
        totalSources,
        scannedSources: rows.length,
        fullyAttributed,
        truncated: totalSources > rows.length,
      },
      filters: { search },
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        pageCount,
      },
      sources: campaignActive ? [] : pageSources,
      selected,
      matches,
      winnerMargin: ranked[0]?.nextSimilarity == null
        ? null
        : Number((ranked[0].similarity - ranked[0].nextSimilarity).toFixed(6)),
      calibration: reviewSummaries.calibration,
      evaluation: reviewSummaries.evaluation,
      profileCandidates: publicProfileCandidateSnapshot(profileCandidateRow),
      profileSuggestions: publicProfileSuggestions(
        profileSuggestionResult,
        profileCandidateRow?.id
      ),
      targetedReview: {
        active: targetedActive,
        available: targetedQueue.length,
        current: targetedActive ? targetedCurrent : null,
        next: targetedActive ? targetedQueue[targetedIndex + 1] || null : null,
      },
      reviewCampaign: {
        campaign,
        active: campaignActive,
        browseMode,
        available: campaignResult.queue.length,
        current: campaignActive ? targetedCurrent : null,
        next: campaignActive ? campaignResult.queue[targetedIndex + 1] || null : null,
        inventoryLimited: Boolean(campaignActive && campaignResult.inventoryLimited),
        eligibleSources: Number(campaignResult.eligibleSources || 0),
        automaticallyResolvedInScan: {
          sameVehicle: Number(campaignResult.automaticSame || 0),
          differentVehicle: Number(campaignResult.automaticDifferent || 0),
        },
      },
    };
  }

  summarizeReviewRows(rows = []) {
    return {
      calibration: summarizeVehicleReidV2Reviews(rows),
      evaluation: evaluateVehicleReidV2Reviews(rows),
    };
  }

  async getReviewSummaries() {
    const rows = typeof this.repository.listPairReviewCalibration === "function"
      ? await this.repository.listPairReviewCalibration({
        modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
        algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      })
      : [];
    return this.summarizeReviewRows(rows);
  }

  async getCalibrationSummary() {
    return (await this.getReviewSummaries()).calibration;
  }

  async recordPairReview({
    sourceDerivativeId,
    candidateDerivativeId,
    label,
    actor,
    campaignId = null,
  } = {}) {
    if (typeof this.repository.savePairReview !== "function") {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_UNAVAILABLE",
        "ReID v2 pair review storage is unavailable."
      );
    }
    const pair = canonicalVehicleReidV2ReviewPair(sourceDerivativeId, candidateDerivativeId);
    const normalizedLabel = normalizeVehicleReidV2ReviewLabel(label);
    const normalizedCampaignId = Number.isSafeInteger(Number(campaignId))
      && Number(campaignId) > 0 ? Number(campaignId) : null;
    if (normalizedCampaignId) {
      const [campaignRow, rows, reviewRows] = await Promise.all([
        this.repository.getLatestReviewCampaign(),
        this.repository.listCurrentSources({ limit: MAX_SCAN_SOURCES }),
        this.repository.listPairReviewCalibration({
          modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
          algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
        }),
      ]);
      const campaign = publicCampaign(campaignRow);
      const campaignQueue = campaign?.id === normalizedCampaignId
        && campaign.status === "active"
        ? buildVehicleReidV2DiverseReviewQueue({
          sourceRows: rows,
          reviewRows,
          similarityFor: cosineSimilarityFromBytes,
          timeZone: evaluateVehicleReidV2Reviews(reviewRows).timeZone,
          maximumDerivativeId: campaign.frozenMaxDerivativeId,
        }).queue
        : [];
      const requestedIdentity = `${Math.min(pair.derivativeIdLow, pair.derivativeIdHigh)}:${Math.max(pair.derivativeIdLow, pair.derivativeIdHigh)}`;
      const currentPair = campaignQueue[0] || null;
      if (currentPair?.pairIdentity !== requestedIdentity) {
        throw new VehicleReidV2ReviewError(
          "VEHICLE_REID_V2_REVIEW_CAMPAIGN_CHANGED",
          "This pair is no longer the current unresolved campaign recommendation. Refresh before continuing."
        );
      }
    }
    const [source, candidate] = await Promise.all([
      this.repository.getCurrentSource(pair.sourceDerivativeId),
      this.repository.getCurrentSource(pair.candidateDerivativeId),
    ]);
    if (!source || !candidate) {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_SOURCE_CHANGED",
        "Both canonical crops must still be current before they can be reviewed."
      );
    }
    const sameContract = [source, candidate].every((row) => (
      row.model_name === VEHICLE_ASSET_EMBEDDING_MODEL
      && row.embedding_algorithm_version === VEHICLE_ASSET_EMBEDDING_ALGORITHM
    ));
    if (!sameContract) {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_MODEL_MISMATCH",
        "Both canonical crops must use the current ReID v2 embedding contract."
      );
    }
    const similarity = cosineSimilarityFromBytes(source.embedding, candidate.embedding);
    if (!Number.isFinite(similarity)) {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_EMBEDDING_INVALID",
        "The stored canonical embeddings cannot be compared."
      );
    }
    const sourceLow = Number(source.derivative_id) === pair.derivativeIdLow ? source : candidate;
    const sourceHigh = Number(source.derivative_id) === pair.derivativeIdHigh ? source : candidate;
    const saved = await this.repository.savePairReview({
      derivativeIdLow: pair.derivativeIdLow,
      derivativeIdHigh: pair.derivativeIdHigh,
      sourceLow,
      sourceHigh,
      similarityScore: similarity,
      label: normalizedLabel,
      actor,
      campaignId: normalizedCampaignId,
    });
    const reviewSummaries = await this.getReviewSummaries();
    return {
      review: publicVehicleReidV2Review(saved, pair.candidateDerivativeId),
      calibration: reviewSummaries.calibration,
      evaluation: reviewSummaries.evaluation,
    };
  }

  async startReviewCampaign({ actor, targetHumanReviews = 500 } = {}) {
    if (typeof this.repository.createReviewCampaign !== "function") {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_CAMPAIGN_UNAVAILABLE",
        "ReID v2 review campaign storage is unavailable."
      );
    }
    const rows = await this.repository.listCurrentSources({ limit: MAX_SCAN_SOURCES });
    const frozenMaxDerivativeId = Math.max(
      0,
      ...rows.map((row) => Number(row.derivative_id) || 0)
    );
    const saved = await this.repository.createReviewCampaign({
      frozenMaxDerivativeId,
      targetHumanReviews,
      actor,
    });
    return publicCampaign(saved);
  }

  async createProfileCandidateSnapshot({ actor } = {}) {
    if (typeof this.repository.createProfileCandidateSnapshot !== "function") {
      throw new Error("ReID v2 profile candidate snapshot storage is unavailable.");
    }
    return publicProfileCandidateSnapshot(
      await this.repository.createProfileCandidateSnapshot({ actor })
    );
  }
}

export const vehicleReidV2ShadowInternals = Object.freeze({
  DEFAULT_PAGE_SIZE,
  DEFAULT_RESULT_LIMIT,
  EMBEDDING_BYTES,
  MAX_PAGE_SIZE,
  MAX_RESULT_LIMIT,
  MAX_SCAN_SOURCES,
  attributeAgreement,
  boundedInteger,
  mapLprEvidence,
  mapSource,
  matchesSearch,
  automaticPlateReview,
  publicCampaign,
  publicProfileCandidateSnapshot,
  publicProfileSuggestions,
  sourceEffectivePlates,
});
