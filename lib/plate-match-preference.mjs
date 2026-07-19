import { PLATE_MATCH_MODES } from "./plate-matching.mjs";

const STORAGE_PREFIX = "alpr.plateMatching.mode";
const SURFACES = new Set(["recognition-feed", "plate-database", "downloads"]);

export function normalizePlateMatchPreference(value, fallback = "balanced") {
  if (PLATE_MATCH_MODES.includes(value)) return value;
  return PLATE_MATCH_MODES.includes(fallback) ? fallback : "balanced";
}

export function plateMatchPreferenceKey(surface) {
  if (!SURFACES.has(surface)) {
    throw new Error(`Unsupported plate-matching preference surface: ${surface}`);
  }
  return `${STORAGE_PREFIX}.${surface}`;
}

export function readPlateMatchPreference(
  surface,
  fallback = "balanced",
  storage = globalThis?.localStorage
) {
  const normalizedFallback = normalizePlateMatchPreference(fallback);
  try {
    return normalizePlateMatchPreference(
      storage?.getItem(plateMatchPreferenceKey(surface)),
      normalizedFallback
    );
  } catch {
    return normalizedFallback;
  }
}

export function writePlateMatchPreference(
  surface,
  mode,
  storage = globalThis?.localStorage
) {
  const normalizedMode = normalizePlateMatchPreference(mode);
  try {
    storage?.setItem(plateMatchPreferenceKey(surface), normalizedMode);
  } catch {
    // Browsers can block storage; the current selection still remains usable.
  }
  return normalizedMode;
}
