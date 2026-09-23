import {
  DASHBOARD_TIME_FRAME_LABELS,
  normalizeDashboardCameraNames,
} from "./dashboard-time-distribution.mjs";

export const DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY =
  "alpr.dashboard.filters.v1";

export const DEFAULT_DASHBOARD_FILTER_PREFERENCE = Object.freeze({
  cameras: Object.freeze([]),
  timeFrame: "24h",
});

function normalizedPreference(value = {}) {
  const timeFrame = DASHBOARD_TIME_FRAME_LABELS[value?.timeFrame]
    ? value.timeFrame
    : DEFAULT_DASHBOARD_FILTER_PREFERENCE.timeFrame;

  return {
    cameras: normalizeDashboardCameraNames(value?.cameras || []),
    timeFrame,
  };
}

function browserStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readDashboardFilterPreference(storage) {
  try {
    const storedValue = browserStorage(storage)?.getItem(
      DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY
    );
    return storedValue
      ? normalizedPreference(JSON.parse(storedValue))
      : normalizedPreference();
  } catch {
    return normalizedPreference();
  }
}

export function writeDashboardFilterPreference(value, storage) {
  const preference = normalizedPreference(value);
  try {
    browserStorage(storage)?.setItem(
      DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY,
      JSON.stringify(preference)
    );
  } catch {
    // Browsers can disable storage; the dashboard still works for this session.
  }
  return preference;
}
