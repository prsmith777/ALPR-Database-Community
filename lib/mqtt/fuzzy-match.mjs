import { normalizePlate } from "./plate-normalize.mjs";

const OCR_CONFUSION_GROUPS = [
  new Set(["0", "O"]),
  new Set(["1", "I", "L"]),
  new Set(["2", "Z"]),
  new Set(["5", "S"]),
  new Set(["6", "G"]),
  new Set(["8", "B"]),
];

export function isCommonOcrConfusion(left, right) {
  if (left === right) return false;
  return OCR_CONFUSION_GROUPS.some(
    (group) => group.has(left) && group.has(right)
  );
}

/**
 * Optimal-string-alignment Damerau-Levenshtein distance.
 * This supports substitutions, insertions, deletions, and one adjacent
 * transposition, which are the OCR mistakes we need for license plates.
 */
export function damerauLevenshteinDistance(leftValue, rightValue) {
  const left = normalizePlate(leftValue);
  const right = normalizePlate(rightValue);

  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0)
  );

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) {
    matrix[0][column] = column;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost =
        left[row - 1] === right[column - 1] ? 0 : 1;

      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + 1
        );
      }
    }
  }

  return matrix[left.length][right.length];
}

function ocrTieBreakScore(observed, candidate, distance) {
  if (distance === 0) return 0;

  if (observed.length === candidate.length) {
    const differences = [];

    for (let index = 0; index < observed.length; index += 1) {
      if (observed[index] !== candidate[index]) differences.push(index);
    }

    if (differences.length === 1) {
      const index = differences[0];
      return isCommonOcrConfusion(observed[index], candidate[index]) ? 0.2 : 0.8;
    }

    if (differences.length === 2) {
      const [first, second] = differences;
      const isAdjacentTransposition =
        second === first + 1 &&
        observed[first] === candidate[second] &&
        observed[second] === candidate[first];

      if (isAdjacentTransposition) return 0.4;
    }
  }

  if (Math.abs(observed.length - candidate.length) === 1) return 0.6;

  return distance;
}

function normalizeCandidate(candidate) {
  if (typeof candidate === "string") {
    return {
      plateNumber: candidate,
      normalizedPlate: normalizePlate(candidate),
      source: candidate,
    };
  }

  const plateNumber = candidate?.plateNumber ?? candidate?.plate_number ?? "";

  return {
    ...candidate,
    plateNumber,
    normalizedPlate: normalizePlate(plateNumber),
    source: candidate,
  };
}

function noMatch(observedPlate, reason = "none") {
  return {
    status: "none",
    reason,
    observedPlate,
    matchedPlateNumber: "",
    distance: null,
    quality: "none",
    candidate: null,
    candidates: [],
  };
}

/**
 * Find the safest plate match among a controlled candidate set.
 *
 * Fuzzy distance never exceeds maxDistance. OCR-aware scoring only breaks
 * ties among candidates with the same integer edit distance; it never bypasses
 * the configured tolerance.
 */
export function findBestPlateMatch(
  observedValue,
  candidates,
  {
    fuzzyEnabled = true,
    maxDistance = 1,
    minimumPlateLength = 5,
    requireUnique = true,
    ocrAware = true,
  } = {}
) {
  const observedPlate = normalizePlate(observedValue);

  if (!observedPlate) return noMatch(observedPlate, "empty-observation");

  const uniqueCandidates = new Map();

  for (const rawCandidate of candidates ?? []) {
    const candidate = normalizeCandidate(rawCandidate);
    if (!candidate.normalizedPlate) continue;
    if (!uniqueCandidates.has(candidate.normalizedPlate)) {
      uniqueCandidates.set(candidate.normalizedPlate, candidate);
    }
  }

  const normalizedCandidates = [...uniqueCandidates.values()];
  const exactCandidate = normalizedCandidates.find(
    (candidate) => candidate.normalizedPlate === observedPlate
  );

  if (exactCandidate) {
    return {
      status: "exact",
      reason: "exact",
      observedPlate,
      matchedPlateNumber: exactCandidate.normalizedPlate,
      distance: 0,
      quality: "exact",
      candidate: exactCandidate.source,
      candidates: [exactCandidate.source],
    };
  }

  if (!fuzzyEnabled) return noMatch(observedPlate, "fuzzy-disabled");
  if (observedPlate.length < minimumPlateLength) {
    return noMatch(observedPlate, "observation-too-short");
  }

  const allowedDistance = Math.max(0, Math.min(2, Number(maxDistance) || 0));

  const ranked = normalizedCandidates
    .filter((candidate) => candidate.normalizedPlate.length >= minimumPlateLength)
    .map((candidate) => {
      const distance = damerauLevenshteinDistance(
        observedPlate,
        candidate.normalizedPlate
      );

      return {
        ...candidate,
        distance,
        tieBreakScore: ocrAware
          ? ocrTieBreakScore(
              observedPlate,
              candidate.normalizedPlate,
              distance
            )
          : 0,
      };
    })
    .filter((candidate) => candidate.distance <= allowedDistance)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.tieBreakScore - right.tieBreakScore ||
        left.normalizedPlate.localeCompare(right.normalizedPlate)
    );

  if (ranked.length === 0) return noMatch(observedPlate, "outside-tolerance");

  const best = ranked[0];
  const tiedBest = ranked.filter(
    (candidate) =>
      candidate.distance === best.distance &&
      Math.abs(candidate.tieBreakScore - best.tieBreakScore) < Number.EPSILON
  );

  if (requireUnique && tiedBest.length > 1) {
    return {
      status: "ambiguous",
      reason: "no-unique-best-match",
      observedPlate,
      matchedPlateNumber: "",
      distance: best.distance,
      quality: "ambiguous",
      candidate: null,
      candidates: tiedBest.map((candidate) => candidate.source),
    };
  }

  return {
    status: "fuzzy",
    reason: "fuzzy",
    observedPlate,
    matchedPlateNumber: best.normalizedPlate,
    distance: best.distance,
    quality: best.distance === 1 ? "strong" : "moderate",
    candidate: best.source,
    candidates: [best.source],
  };
}
