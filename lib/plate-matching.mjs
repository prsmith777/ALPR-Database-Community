export const PLATE_MATCH_MODES = Object.freeze([
  "off",
  "strict",
  "balanced",
  "broad",
]);

export const DEFAULT_PLATE_MATCHING_SETTINGS = Object.freeze({
  minimumCharacters: 4,
  ocrGroups: Object.freeze(["0ODQ", "1I", "2Z", "5S", "8B", "6G"]),
  profiles: Object.freeze({
    strict: Object.freeze({
      ordinaryDifferences: 0,
      ocrDifferences: 1,
      allowInsertDelete: false,
      allowTransposition: false,
    }),
    balanced: Object.freeze({
      ordinaryDifferences: 1,
      ocrDifferences: 2,
      allowInsertDelete: true,
      allowTransposition: true,
    }),
    broad: Object.freeze({
      ordinaryDifferences: 2,
      ocrDifferences: 2,
      allowInsertDelete: true,
      allowTransposition: true,
    }),
  }),
});

const PROFILE_NAMES = ["strict", "balanced", "broad"];

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeOcrGroups(groups) {
  const source = Array.isArray(groups)
    ? groups
    : DEFAULT_PLATE_MATCHING_SETTINGS.ocrGroups;
  const used = new Set();
  const normalized = [];

  for (const group of source) {
    const unique = [];
    for (const character of String(group || "").toUpperCase()) {
      if (!/[A-Z0-9]/.test(character) || used.has(character)) continue;
      used.add(character);
      unique.push(character);
    }
    if (unique.length >= 2) normalized.push(unique.join(""));
  }

  return normalized.length
    ? normalized
    : [...DEFAULT_PLATE_MATCHING_SETTINGS.ocrGroups];
}

export function normalizePlateMatchingSettings(settings = {}) {
  const profiles = {};

  for (const name of PROFILE_NAMES) {
    const defaults = DEFAULT_PLATE_MATCHING_SETTINGS.profiles[name];
    const supplied = settings.profiles?.[name] || {};
    profiles[name] = {
      ordinaryDifferences: boundedInteger(
        supplied.ordinaryDifferences,
        defaults.ordinaryDifferences,
        0,
        2
      ),
      ocrDifferences: boundedInteger(
        supplied.ocrDifferences,
        defaults.ocrDifferences,
        0,
        2
      ),
      allowInsertDelete:
        typeof supplied.allowInsertDelete === "boolean"
          ? supplied.allowInsertDelete
          : defaults.allowInsertDelete,
      allowTransposition:
        typeof supplied.allowTransposition === "boolean"
          ? supplied.allowTransposition
          : defaults.allowTransposition,
    };
  }

  return {
    minimumCharacters: boundedInteger(
      settings.minimumCharacters,
      DEFAULT_PLATE_MATCHING_SETTINGS.minimumCharacters,
      3,
      8
    ),
    ocrGroups: normalizeOcrGroups(settings.ocrGroups),
    profiles,
  };
}

export function normalizePlateText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function resolvePlateMatchMode(requestedMode) {
  if (PLATE_MATCH_MODES.includes(requestedMode)) return requestedMode;
  // Legacy “default” URLs and settings resolve to Balanced without retaining
  // a configurable global default.
  return "balanced";
}

export function plateMatchModeLabel(mode) {
  const resolved = resolvePlateMatchMode(mode);
  return `${resolved[0].toUpperCase()}${resolved.slice(1)}`;
}

function canonicalMap(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const character of group) map.set(character, group[0]);
  }
  return map;
}

function canonicalize(value, groups) {
  const map = canonicalMap(groups);
  return [...value].map((character) => map.get(character) || character).join("");
}

function translationCharacters(groups) {
  let from = "";
  let to = "";
  for (const group of groups) {
    for (const character of group) {
      from += character;
      to += group[0];
    }
  }
  return { from, to };
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function adjacentTranspositions(value) {
  const variants = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] === value[index + 1]) continue;
    variants.push(
      `${value.slice(0, index)}${value[index + 1]}${value[index]}${value.slice(
        index + 2
      )}`
    );
  }
  return variants;
}

function ocrDifferences(left, right, groups) {
  if (left.length !== right.length) return null;
  const map = canonicalMap(groups);
  const differences = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    if ((map.get(left[index]) || left[index]) !== (map.get(right[index]) || right[index])) {
      return null;
    }
    differences.push(`${left[index]} → ${right[index]}`);
  }
  return differences;
}

export function evaluatePlateIdentityMatch(
  observedValue,
  candidateValue,
  requestedMode = "balanced",
  settings = {}
) {
  const normalizedSettings = normalizePlateMatchingSettings(settings);
  const observed = normalizePlateText(observedValue);
  const candidate = normalizePlateText(candidateValue);
  const mode = resolvePlateMatchMode(requestedMode);

  if (!observed || !candidate) {
    return {
      matched: false,
      mode,
      method: "none",
      distance: null,
      reason: "Enter two plate values to test.",
    };
  }
  if (candidate === observed) {
    return {
      matched: true,
      mode,
      method: "exact",
      distance: 0,
      reason: "Normalized exact match.",
    };
  }
  if (mode === "off") {
    return {
      matched: false,
      mode,
      method: "none",
      distance: null,
      reason: "Fuzzy matching is off.",
    };
  }
  if (observed.length < normalizedSettings.minimumCharacters) {
    return {
      matched: false,
      mode,
      method: "none",
      distance: null,
      reason: `Fuzzy matching requires at least ${normalizedSettings.minimumCharacters} characters.`,
    };
  }

  const profile = normalizedSettings.profiles[mode];
  const ocr = ocrDifferences(
    observed,
    candidate,
    normalizedSettings.ocrGroups
  );
  if (ocr && ocr.length > 0 && ocr.length <= profile.ocrDifferences) {
    return {
      matched: true,
      mode,
      method: "ocr",
      distance: ocr.length,
      reason: `OCR-equivalent substitution${ocr.length === 1 ? "" : "s"}: ${ocr.join(
        ", "
      )}.`,
    };
  }
  if (
    profile.allowTransposition &&
    adjacentTranspositions(observed).includes(candidate)
  ) {
    return {
      matched: true,
      mode,
      method: "transposition",
      distance: 1,
      reason: "One adjacent transposition.",
    };
  }

  const distance = levenshtein(observed, candidate);
  const sameLength = observed.length === candidate.length;
  if (
    profile.ordinaryDifferences > 0 &&
    distance <= profile.ordinaryDifferences &&
    (profile.allowInsertDelete || sameLength)
  ) {
    return {
      matched: true,
      mode,
      method: "ordinary",
      distance,
      reason: `${distance} ordinary character difference${distance === 1 ? "" : "s"}.`,
    };
  }

  return {
    matched: false,
    mode,
    method: "none",
    distance,
    reason: "Outside this profile's matching limits.",
  };
}

export function evaluatePlateMatch(
  searchValue,
  candidateValue,
  requestedMode = "balanced",
  settings = {}
) {
  const search = normalizePlateText(searchValue);
  const candidate = normalizePlateText(candidateValue);
  const mode = resolvePlateMatchMode(requestedMode);

  if (!search || !candidate) {
    return { matched: false, mode, reason: "Enter two plate values to test." };
  }
  if (candidate.includes(search)) {
    return {
      matched: true,
      mode,
      method: candidate === search ? "exact" : "substring",
      distance: candidate === search ? 0 : null,
      reason:
        candidate === search
          ? "Normalized exact match."
          : "Standard substring match.",
    };
  }

  return evaluatePlateIdentityMatch(search, candidate, mode, settings);
}

export function buildFuzzyPlateSql({
  columnExpression,
  searchValue,
  requestedMode = "balanced",
  settings = {},
  addValue,
}) {
  const normalizedSettings = normalizePlateMatchingSettings(settings);
  const mode = resolvePlateMatchMode(requestedMode, normalizedSettings);
  const search = normalizePlateText(searchValue);
  if (
    mode === "off" ||
    search.length < normalizedSettings.minimumCharacters
  ) {
    return { condition: "", mode };
  }

  const profile = normalizedSettings.profiles[mode];
  const normalizedColumn = `REGEXP_REPLACE(UPPER(${columnExpression}), '[^A-Z0-9]', '', 'g')`;
  const searchParameter = addValue(search);
  const terms = [`${normalizedColumn} = ${searchParameter}`];

  if (profile.ocrDifferences > 0) {
    const { from, to } = translationCharacters(normalizedSettings.ocrGroups);
    const fromParameter = addValue(from);
    const toParameter = addValue(to);
    const canonicalParameter = addValue(
      canonicalize(search, normalizedSettings.ocrGroups)
    );
    const ocrLimitParameter = addValue(profile.ocrDifferences);
    terms.push(`(
      LENGTH(${normalizedColumn}) = LENGTH(${searchParameter})
      AND TRANSLATE(${normalizedColumn}, ${fromParameter}, ${toParameter}) = ${canonicalParameter}
      AND LEVENSHTEIN(${normalizedColumn}, ${searchParameter}) <= ${ocrLimitParameter}
    )`);
  }

  if (profile.ordinaryDifferences > 0) {
    const differenceParameter = addValue(profile.ordinaryDifferences);
    const lengthCondition = profile.allowInsertDelete
      ? ""
      : `LENGTH(${normalizedColumn}) = LENGTH(${searchParameter}) AND `;
    terms.push(`(
      ${lengthCondition}LEVENSHTEIN(${normalizedColumn}, ${searchParameter}) <= ${differenceParameter}
    )`);
  }

  if (profile.allowTransposition) {
    const variants = adjacentTranspositions(search);
    if (variants.length) {
      const transpositionParameter = addValue(variants);
      terms.push(`${normalizedColumn} = ANY(${transpositionParameter}::text[])`);
    }
  }

  return { condition: `(${terms.join(" OR ")})`, mode };
}
