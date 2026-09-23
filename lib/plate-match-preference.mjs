import { PLATE_MATCH_MODES } from "./plate-matching.mjs";

const STORAGE_PREFIX = "alpr.plateMatching.mode";
const COOKIE_PREFIX = "alpr_plate_matching_mode";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
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

export function plateMatchPreferenceCookieName(surface) {
  if (!SURFACES.has(surface)) {
    throw new Error(`Unsupported plate-matching preference surface: ${surface}`);
  }
  return `${COOKIE_PREFIX}_${surface.replaceAll("-", "_")}`;
}

export function readPlateMatchCookiePreference(
  surface,
  cookieStore,
  fallback = "balanced"
) {
  return normalizePlateMatchPreference(
    cookieStore?.get?.(plateMatchPreferenceCookieName(surface))?.value,
    fallback
  );
}

function writePreferenceCookie(name, value, documentRef) {
  try {
    if (!documentRef) return;
    documentRef.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    // Browser privacy settings can block cookies; local storage still works.
  }
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
  storage = globalThis?.localStorage,
  documentRef = globalThis?.document
) {
  const normalizedMode = normalizePlateMatchPreference(mode);
  try {
    storage?.setItem(plateMatchPreferenceKey(surface), normalizedMode);
  } catch {
    // Browsers can block storage; the current selection still remains usable.
  }
  writePreferenceCookie(
    plateMatchPreferenceCookieName(surface),
    normalizedMode,
    documentRef
  );
  return normalizedMode;
}
