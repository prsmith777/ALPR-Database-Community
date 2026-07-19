export const PLATE_MATCH_MODES = Object.freeze([
  "default",
  "off",
  "strict",
  "balanced",
  "broad",
]);

export const DEFAULT_PLATE_MATCHING_SETTINGS = Object.freeze({
  defaultMode: "balanced",
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
  const defaultMode = ["off", ...PROFILE_NAMES].includes(settings.defaultMode)
    ? settings.defaultMode
    : DEFAULT_PLATE_MATCHING_SETTINGS.defaultMode;
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
    defaultMode,
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

export function resolvePlateMatchMode(requestedMode, settings = {}) {
  const normalizedSettings = normalizePlateMatchingSettings(settings);
  if (requestedMode === "default" || !PLATE_MATCH_MODES.includes(requestedMode)) {
    return normalizedSettings.defaultMode;
  }
  return requestedMode;
}

export function plateMatchModeLabel(mode, settings = {}) {
  if (mode === "default") {
    const resolved = resolvePlateMatchMode(mode, settings);
    return `Use default — ${resolved[0].toUpperCase()}${resolved.slice(1)}`;
  }
  if (mode === "off") return "Off — standard search only";
  return `${mode[0].toUpperCase()}${mode.slice(1)}`;
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

export function evaluatePlateMatch(
  searchValue,
  candidateValue,
  requestedMode = "default",
  settings = {}
) {
  const normalizedSettings = normalizePlateMatchingSettings(settings);
  const search = normalizePlateText(searchValue);
  const candidate = normalizePlateText(candidateValue);
  const mode = resolvePlateMatchMode(requestedMode, normalizedSettings);

  if (!search || !candidate) {
    return { matched: false, mode, reason: "Enter two plate values to test." };
  }
  if (candidate.includes(search)) {
    return {
      matched: true,
      mode,
      reason: candidate === search ? "Normalized exact match." : "Standard substring match.",
    };
  }
  if (mode === "off") {
    return { matched: false, mode, reason: "Fuzzy matching is off." };
  }
  if (search.length < normalizedSettings.minimumCharacters) {
    return {
      matched: false,
      mode,
      reason: `Fuzzy matching requires at least ${normalizedSettings.minimumCharacters} characters.`,
    };
  }

  const profile = normalizedSettings.profiles[mode];
  const ocr = ocrDifferences(search, candidate, normalizedSettings.ocrGroups);
  if (ocr && ocr.length > 0 && ocr.length <= profile.ocrDifferences) {
    return {
      matched: true,
      mode,
      reason: `OCR-equivalent substitution${ocr.length === 1 ? "" : "s"}: ${ocr.join(
        ", "
      )}.`,
    };
  }
  if (
    profile.allowTransposition &&
    adjacentTranspositions(search).includes(candidate)
  ) {
    return { matched: true, mode, reason: "One adjacent transposition." };
  }

  const distance = levenshtein(search, candidate);
  const sameLength = search.length === candidate.length;
  if (
    profile.ordinaryDifferences > 0 &&
    distance <= profile.ordinaryDifferences &&
    (profile.allowInsertDelete || sameLength)
  ) {
    return {
      matched: true,
      mode,
      reason: `${distance} ordinary character difference${distance === 1 ? "" : "s"}.`,
    };
  }

  return { matched: false, mode, reason: "Outside this profile's matching limits." };
}

export function buildFuzzyPlateSql({
  columnExpression,
  searchValue,
  requestedMode = "default",
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
