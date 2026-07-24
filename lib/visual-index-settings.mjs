export const DEFAULT_VISUAL_INDEX_SETTINGS = Object.freeze({
  enabled: true,
  paused: false,
  batchSize: 20,
  intervalSeconds: 30,
  minimumFreeDiskGb: 5,
  maximumLoadPercent: 90,
});

const PACE_SETTINGS = Object.freeze({
  gentle: Object.freeze({ batchSize: 5, intervalSeconds: 60 }),
  balanced: Object.freeze({ batchSize: 20, intervalSeconds: 30 }),
  fast: Object.freeze({ batchSize: 40, intervalSeconds: 15 }),
});

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function integerValue(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeVisualIndexSettings(input = {}) {
  return {
    enabled: booleanValue(input.enabled, DEFAULT_VISUAL_INDEX_SETTINGS.enabled),
    paused: booleanValue(input.paused, DEFAULT_VISUAL_INDEX_SETTINGS.paused),
    batchSize: integerValue(input.batchSize, DEFAULT_VISUAL_INDEX_SETTINGS.batchSize, 1, 50),
    intervalSeconds: integerValue(
      input.intervalSeconds,
      DEFAULT_VISUAL_INDEX_SETTINGS.intervalSeconds,
      5,
      3600
    ),
    minimumFreeDiskGb: integerValue(
      input.minimumFreeDiskGb,
      DEFAULT_VISUAL_INDEX_SETTINGS.minimumFreeDiskGb,
      1,
      1000
    ),
    maximumLoadPercent: integerValue(
      input.maximumLoadPercent,
      DEFAULT_VISUAL_INDEX_SETTINGS.maximumLoadPercent,
      25,
      100
    ),
  };
}

export function visualIndexPace(settings = {}) {
  const normalized = normalizeVisualIndexSettings(settings);
  const match = Object.entries(PACE_SETTINGS).find(([, pace]) =>
    pace.batchSize === normalized.batchSize && pace.intervalSeconds === normalized.intervalSeconds
  );
  return match?.[0] || "balanced";
}

export function applyVisualIndexPace(settings = {}, pace = "balanced") {
  const normalized = normalizeVisualIndexSettings(settings);
  const selected = PACE_SETTINGS[pace] || PACE_SETTINGS.balanced;
  return normalizeVisualIndexSettings({ ...normalized, ...selected });
}

export const visualIndexSettingsInternals = Object.freeze({
  PACE_SETTINGS,
  booleanValue,
  integerValue,
});
