import { vehicleReidV2EvaluationInternals } from "./vehicle-reid-v2-evaluation.mjs";
import { evaluatePlateIdentityMatch } from "./plate-matching.mjs";

const DEFAULT_QUEUE_LIMIT = 12;
const MAX_QUEUE_LIMIT = 24;
const MAX_SEED_SOURCES = 32;
const MAX_CHOICES_PER_SLOT = 8;
const DEFAULT_CAMPAIGN_QUEUE_LIMIT = 24;
const MAX_CAMPAIGN_SEED_SOURCES = 64;
const MAX_CAMPAIGN_CHOICES_PER_BUCKET = 48;

const {
  localPeriod,
  normalizedPair,
  scoreBandKey,
} = vehicleReidV2EvaluationInternals;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Math.min(maximum, Math.max(minimum, parsed || fallback));
}

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
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

function effectivePlates(row) {
  const values = [
    row?.plate_number,
    row?.plateNumber,
    ...(Array.isArray(row?.plate_numbers) ? row.plate_numbers : []),
    ...objectArray(row?.lpr_evidence).map((item) => item.plateNumber),
    ...objectArray(row?.companion_lpr_evidence).map((item) => item.plateNumber),
  ];
  return [...new Set(values.map(normalizedPlate).filter(Boolean))].sort();
}

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSource(row, timeZone) {
  const derivativeId = positiveId(row?.derivative_id ?? row?.derivativeId);
  if (!derivativeId) return null;
  const cameraName = String(row?.camera_name ?? row?.cameraName ?? "Unknown camera").trim()
    || "Unknown camera";
  const timestamp = row?.read_timestamp ?? row?.timestamp ?? null;
  const normalizedPlates = effectivePlates(row);
  return {
    derivativeId,
    embedding: row?.embedding,
    cameraName,
    overviewContext: String(
      row?.overview_context ?? row?.overviewContext ?? "unknown context"
    ).trim() || "unknown context",
    plateNumber: String(row?.plate_number ?? row?.plateNumber ?? "").trim() || null,
    normalizedPlate: normalizedPlate(row?.plate_number ?? row?.plateNumber),
    normalizedPlates,
    diversityKeys: normalizedPlates.length
      ? normalizedPlates.map((plate) => `plate:${plate}`)
      : [`crop:${derivativeId}`],
    timestamp,
    localPeriod: localPeriod(timestamp, timeZone),
  };
}

function pairIdentity(leftId, rightId) {
  return leftId < rightId ? `${leftId}:${rightId}` : `${rightId}:${leftId}`;
}

function reviewedPairIdentities(rows = []) {
  return new Set(rows.map((row) => {
    const low = positiveId(row?.derivative_id_low ?? row?.derivativeIdLow);
    const high = positiveId(row?.derivative_id_high ?? row?.derivativeIdHigh);
    return low && high && low !== high ? pairIdentity(low, high) : null;
  }).filter(Boolean));
}

function reviewedEvidence(rows = []) {
  const derivativeIds = new Set();
  const plates = new Set();
  for (const row of rows) {
    const low = positiveId(row?.derivative_id_low ?? row?.derivativeIdLow);
    const high = positiveId(row?.derivative_id_high ?? row?.derivativeIdHigh);
    if (low) derivativeIds.add(low);
    if (high) derivativeIds.add(high);
    for (const value of [row?.evidence_plate_low, row?.evidencePlateLow,
      row?.evidence_plate_high, row?.evidencePlateHigh]) {
      const plate = normalizedPlate(value);
      if (plate) plates.add(plate);
    }
  }
  return { derivativeIds, plates };
}

function platesAreClose(left, right) {
  return Boolean(left) && Boolean(right)
    && evaluatePlateIdentityMatch(left, right, "balanced").matched;
}

function hasClosePlate(plates, candidates) {
  return plates.some((plate) => [...candidates].some((candidate) => (
    platesAreClose(plate, candidate)
  )));
}

export function plateEvidenceResolution(leftValue, rightValue) {
  const left = Array.isArray(leftValue)
    ? [...new Set(leftValue.map(normalizedPlate).filter(Boolean))]
    : effectivePlates(leftValue);
  const right = Array.isArray(rightValue)
    ? [...new Set(rightValue.map(normalizedPlate).filter(Boolean))]
    : effectivePlates(rightValue);
  if (!left.length || !right.length) {
    return { outcome: "human_review", basis: "incomplete_effective_plate" };
  }
  if (left.some((plate) => right.includes(plate))) {
    return { outcome: "same_vehicle", basis: "exact_effective_plate" };
  }
  const close = left.some((leftPlate) => right.some((rightPlate) => (
    evaluatePlateIdentityMatch(leftPlate, rightPlate, "balanced").matched
  )));
  if (close) return { outcome: "human_review", basis: "close_effective_plate" };
  return { outcome: "different_vehicle", basis: "dissimilar_effective_plate" };
}

function gapNeedSlots(gaps = [], limit = DEFAULT_QUEUE_LIMIT) {
  const normalized = gaps.map((gap, index) => ({
    gapIndex: index,
    dimension: String(gap?.dimension || "").trim(),
    key: String(gap?.key || "").trim(),
    neededSameVehicle: Math.max(0, Number(gap?.neededSameVehicle || 0)),
    neededDifferentVehicle: Math.max(0, Number(gap?.neededDifferentVehicle || 0)),
  })).filter((gap) => gap.dimension && gap.key);
  const slots = [];
  const maximumNeed = Math.max(0, ...normalized.flatMap((gap) => [
    gap.neededSameVehicle,
    gap.neededDifferentVehicle,
  ]));
  for (let round = 0; round < maximumNeed && slots.length < limit; round += 1) {
    for (const gap of normalized) {
      if (gap.neededSameVehicle > round && slots.length < limit) {
        slots.push({ ...gap, coverageAim: "same_vehicle", round });
      }
      if (gap.neededDifferentVehicle > round && slots.length < limit) {
        slots.push({ ...gap, coverageAim: "different_vehicle", round });
      }
    }
  }
  return slots;
}

function pairDescription(left, right, similarity, timeZone) {
  const low = left.derivativeId < right.derivativeId ? left : right;
  const high = low === left ? right : left;
  const samePlate = Boolean(left.normalizedPlate)
    && left.normalizedPlate === right.normalizedPlate;
  const differentPlate = Boolean(left.normalizedPlate)
    && Boolean(right.normalizedPlate)
    && left.normalizedPlate !== right.normalizedPlate;
  return {
    pairIdentity: pairIdentity(left.derivativeId, right.derivativeId),
    sourceDerivativeId: left.derivativeId,
    candidateDerivativeId: right.derivativeId,
    derivativeIdLow: low.derivativeId,
    derivativeIdHigh: high.derivativeId,
    similarity: Number(Number(similarity).toFixed(6)),
    scoreBand: scoreBandKey(similarity),
    cameraPair: normalizedPair(left.cameraName, right.cameraName, "Unknown camera"),
    contextPair: normalizedPair(
      left.overviewContext,
      right.overviewContext,
      "unknown context"
    ),
    localPeriodPair: normalizedPair(
      localPeriod(left.timestamp, timeZone),
      localPeriod(right.timestamp, timeZone),
      "unknown local time"
    ),
    plateEvidence: samePlate
      ? "same effective plate"
      : differentPlate
        ? "different effective plates"
        : "incomplete effective-plate evidence",
    samePlate,
    differentPlate,
    sourceCameraName: left.cameraName,
    candidateCameraName: right.cameraName,
    sourcePlateNumber: left.plateNumber,
    candidatePlateNumber: right.plateNumber,
    sourceEffectivePlates: [...left.normalizedPlates],
    candidateEffectivePlates: [...right.normalizedPlates],
  };
}

function pairMatchesGap(pair, slot) {
  if (slot.dimension === "camera pair") return pair.cameraPair === slot.key;
  if (slot.dimension === "local capture period") return pair.localPeriodPair === slot.key;
  if (slot.dimension === "overlapping score band") return pair.scoreBand === slot.key;
  return false;
}

function choicePriority(pair, slot, separation = {}) {
  const wantsSame = slot.coverageAim === "same_vehicle";
  const platePriority = wantsSame
    ? pair.samePlate ? 0 : pair.differentPlate ? 2 : 1
    : pair.differentPlate ? 0 : pair.samePlate ? 2 : 1;
  const overlapMinimum = Number(separation?.overlapMinimum) / 100;
  const overlapMaximum = Number(separation?.overlapMaximum) / 100;
  const hasOverlap = Number.isFinite(overlapMinimum) && Number.isFinite(overlapMaximum);
  const overlapMidpoint = hasOverlap ? (overlapMinimum + overlapMaximum) / 2 : 0.75;
  const outsideOverlap = hasOverlap
    && (pair.similarity < overlapMinimum || pair.similarity > overlapMaximum)
    ? 1
    : 0;
  return [
    platePriority,
    slot.dimension === "overlapping score band" ? 0 : outsideOverlap,
    Math.abs(pair.similarity - overlapMidpoint),
    -Math.max(pair.sourceDerivativeId, pair.candidateDerivativeId),
    pair.pairIdentity,
  ];
}

function comparePriority(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) continue;
    if (typeof leftValue === "string" || typeof rightValue === "string") {
      return String(leftValue).localeCompare(String(rightValue));
    }
    return Number(leftValue) - Number(rightValue);
  }
  return 0;
}

function addChoice(choices, choice) {
  choices.push(choice);
  choices.sort((left, right) => comparePriority(left.priority, right.priority));
  if (choices.length > MAX_CHOICES_PER_SLOT) choices.length = MAX_CHOICES_PER_SLOT;
}

function seedSources(sources, slots, maximum) {
  const selected = new Map();
  const add = (source) => {
    if (source && selected.size < maximum) selected.set(source.derivativeId, source);
  };
  const cameraNames = new Set(slots
    .filter((slot) => slot.dimension === "camera pair")
    .flatMap((slot) => slot.key.split(" ↔ ")));
  const periods = new Set(slots
    .filter((slot) => slot.dimension === "local capture period")
    .flatMap((slot) => slot.key.split(" ↔ ")));
  for (const cameraName of cameraNames) {
    sources.filter((source) => source.cameraName === cameraName).slice(0, 8).forEach(add);
  }
  for (const period of periods) {
    sources.filter((source) => source.localPeriod === period).slice(0, 8).forEach(add);
  }
  const repeatedPlates = new Set();
  const plateCounts = new Map();
  for (const source of sources) {
    if (!source.normalizedPlate) continue;
    const count = (plateCounts.get(source.normalizedPlate) || 0) + 1;
    plateCounts.set(source.normalizedPlate, count);
    if (count > 1) repeatedPlates.add(source.normalizedPlate);
  }
  for (const source of sources) {
    if (repeatedPlates.has(source.normalizedPlate)) add(source);
    if (selected.size >= maximum) break;
  }
  for (const source of sources) {
    add(source);
    if (selected.size >= maximum) break;
  }
  return [...selected.values()];
}

export function buildVehicleReidV2TargetedReviewQueue({
  sourceRows = [],
  reviewRows = [],
  evaluation = null,
  similarityFor,
  limit = DEFAULT_QUEUE_LIMIT,
} = {}) {
  if (typeof similarityFor !== "function" || !evaluation?.targetedGaps?.length) return [];
  const boundedLimit = boundedInteger(limit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT);
  const slots = gapNeedSlots(evaluation.targetedGaps, boundedLimit);
  if (!slots.length) return [];
  const sources = sourceRows
    .map((row) => normalizeSource(row, evaluation.timeZone))
    .filter((source) => source?.embedding);
  if (sources.length < 2) return [];
  const reviewed = reviewedPairIdentities(reviewRows);
  const seeds = seedSources(sources, slots, Math.min(MAX_SEED_SOURCES, sources.length));
  const choicesBySlot = slots.map(() => []);
  const compared = new Set();

  for (const seed of seeds) {
    for (const candidate of sources) {
      if (seed.derivativeId === candidate.derivativeId) continue;
      const identity = pairIdentity(seed.derivativeId, candidate.derivativeId);
      if (reviewed.has(identity) || compared.has(identity)) continue;
      compared.add(identity);
      const similarity = similarityFor(seed.embedding, candidate.embedding);
      if (!Number.isFinite(similarity)) continue;
      const pair = pairDescription(seed, candidate, similarity, evaluation.timeZone);
      slots.forEach((slot, slotIndex) => {
        if (!pairMatchesGap(pair, slot)) return;
        addChoice(choicesBySlot[slotIndex], {
          ...pair,
          dimension: slot.dimension,
          gapKey: slot.key,
          coverageAim: slot.coverageAim,
          priority: choicePriority(pair, slot, evaluation.separation),
        });
      });
    }
  }

  const usedPairs = new Set();
  const queue = [];
  choicesBySlot.forEach((choices) => {
    const choice = choices.find((item) => !usedPairs.has(item.pairIdentity));
    if (!choice || queue.length >= boundedLimit) return;
    usedPairs.add(choice.pairIdentity);
    const { priority, ...publicChoice } = choice;
    queue.push(publicChoice);
  });
  return queue;
}

function diverseSeedSources(sources, maximum) {
  const selected = [];
  const used = new Set();
  const add = (source) => {
    if (!source || selected.length >= maximum) return;
    if (source.diversityKeys.some((key) => used.has(key))) return;
    selected.push(source);
    source.diversityKeys.forEach((key) => used.add(key));
  };
  const contexts = ["entry", "street"];
  let progress = true;
  let offset = 0;
  while (selected.length < maximum && progress) {
    progress = false;
    for (const context of contexts) {
      const candidates = sources.filter((source) => source.overviewContext === context);
      if (candidates[offset]) {
        add(candidates[offset]);
        progress = true;
      }
    }
    offset += 1;
  }
  for (const source of sources) add(source);
  return selected;
}

function bucketKey(pair) {
  return `${pair.contextPair}|${pair.scoreBand}`;
}

function campaignBucketOrder() {
  const contexts = ["entry ↔ entry", "entry ↔ street", "street ↔ street"];
  const scoreBands = ["90–100%", "80–89.9%", "70–79.9%", "60–69.9%", "below 60%"];
  return scoreBands.flatMap((scoreBand) => contexts.map((context) => `${context}|${scoreBand}`));
}

function campaignChoicePriority(pair) {
  const band = vehicleReidV2EvaluationInternals.SCORE_BANDS
    .find((item) => item.key === pair.scoreBand);
  const midpoint = band ? (Math.max(0, band.minimum) + band.maximum) / 2 : 0.75;
  return [
    Math.abs(pair.similarity - midpoint),
    -Math.max(pair.sourceDerivativeId, pair.candidateDerivativeId),
    pair.pairIdentity,
  ];
}

export function buildVehicleReidV2DiverseReviewQueue({
  sourceRows = [],
  reviewRows = [],
  similarityFor,
  timeZone = "America/Denver",
  maximumDerivativeId = Number.MAX_SAFE_INTEGER,
  limit = DEFAULT_CAMPAIGN_QUEUE_LIMIT,
} = {}) {
  const boundedLimit = boundedInteger(limit, DEFAULT_CAMPAIGN_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT);
  if (typeof similarityFor !== "function") {
    return { queue: [], inventoryLimited: true, eligibleSources: 0 };
  }
  const reviewedPairs = reviewedPairIdentities(reviewRows);
  const reviewed = reviewedEvidence(reviewRows);
  const sources = sourceRows
    .map((row) => normalizeSource(row, timeZone))
    .filter((source) => (
      source?.embedding
      && source.derivativeId <= Number(maximumDerivativeId)
      && !reviewed.derivativeIds.has(source.derivativeId)
      && !hasClosePlate(source.normalizedPlates, reviewed.plates)
    ))
    .sort((left, right) => right.derivativeId - left.derivativeId);
  if (sources.length < 2) {
    return { queue: [], inventoryLimited: true, eligibleSources: sources.length };
  }
  const seeds = diverseSeedSources(
    sources,
    Math.min(MAX_CAMPAIGN_SEED_SOURCES, sources.length)
  );
  const buckets = new Map();
  const compared = new Set();
  let automaticSame = 0;
  let automaticDifferent = 0;

  for (const seed of seeds) {
    for (const candidate of sources) {
      if (seed.derivativeId === candidate.derivativeId) continue;
      const identity = pairIdentity(seed.derivativeId, candidate.derivativeId);
      if (reviewedPairs.has(identity) || compared.has(identity)) continue;
      compared.add(identity);
      const resolution = plateEvidenceResolution(
        seed.normalizedPlates,
        candidate.normalizedPlates
      );
      if (resolution.outcome === "same_vehicle") {
        automaticSame += 1;
        continue;
      }
      if (resolution.outcome === "different_vehicle") {
        automaticDifferent += 1;
        continue;
      }
      const similarity = similarityFor(seed.embedding, candidate.embedding);
      if (!Number.isFinite(similarity)) continue;
      const pair = {
        ...pairDescription(seed, candidate, similarity, timeZone),
        reviewReason: resolution.basis,
        diversityKeys: [...new Set([
          ...seed.diversityKeys,
          ...candidate.diversityKeys,
        ])],
      };
      const key = bucketKey(pair);
      const choices = buckets.get(key) || [];
      choices.push({ ...pair, priority: campaignChoicePriority(pair) });
      choices.sort((left, right) => comparePriority(left.priority, right.priority));
      if (choices.length > MAX_CAMPAIGN_CHOICES_PER_BUCKET) {
        choices.length = MAX_CAMPAIGN_CHOICES_PER_BUCKET;
      }
      buckets.set(key, choices);
    }
  }

  const usedPairs = new Set();
  const usedDiversity = new Set();
  const usedPlates = new Set();
  const queue = [];
  const order = campaignBucketOrder();
  let progress = true;
  while (queue.length < boundedLimit && progress) {
    progress = false;
    for (const key of order) {
      const choices = buckets.get(key) || [];
      const choice = choices.find((item) => (
        !usedPairs.has(item.pairIdentity)
        && !item.diversityKeys.some((diversityKey) => usedDiversity.has(diversityKey))
        && !hasClosePlate(
          [...item.sourceEffectivePlates, ...item.candidateEffectivePlates],
          usedPlates
        )
      ));
      if (!choice || queue.length >= boundedLimit) continue;
      progress = true;
      usedPairs.add(choice.pairIdentity);
      choice.diversityKeys.forEach((diversityKey) => usedDiversity.add(diversityKey));
      [...choice.sourceEffectivePlates, ...choice.candidateEffectivePlates]
        .forEach((plate) => usedPlates.add(plate));
      const { priority, diversityKeys, ...publicChoice } = choice;
      queue.push(publicChoice);
    }
  }
  return {
    queue,
    inventoryLimited: queue.length < boundedLimit,
    eligibleSources: sources.length,
    automaticSame,
    automaticDifferent,
  };
}

export const vehicleReidV2TargetedReviewInternals = Object.freeze({
  DEFAULT_CAMPAIGN_QUEUE_LIMIT,
  DEFAULT_QUEUE_LIMIT,
  MAX_CHOICES_PER_SLOT,
  MAX_QUEUE_LIMIT,
  MAX_SEED_SOURCES,
  MAX_CAMPAIGN_SEED_SOURCES,
  choicePriority,
  gapNeedSlots,
  normalizeSource,
  pairDescription,
  pairIdentity,
  pairMatchesGap,
  reviewedPairIdentities,
  reviewedEvidence,
  hasClosePlate,
  platesAreClose,
  seedSources,
  effectivePlates,
  diverseSeedSources,
  campaignBucketOrder,
});
