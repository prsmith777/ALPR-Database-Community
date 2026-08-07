export const LIVE_FEED_PERFORMANCE_BUFFER = "__ALPR_LIVE_FEED_PERFORMANCE__";
export const LIVE_FEED_PERFORMANCE_LIMIT = 100;

function roundedDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0
    ? Number(duration.toFixed(1))
    : null;
}

export function recordLiveFeedPerformance(metric = {}, {
  target = globalThis,
  logger = null,
  recordedAt = new Date().toISOString(),
} = {}) {
  const entry = {
    ...metric,
    durationMs: roundedDuration(metric.durationMs),
    recordedAt,
  };
  const previous = Array.isArray(target?.[LIVE_FEED_PERFORMANCE_BUFFER])
    ? target[LIVE_FEED_PERFORMANCE_BUFFER]
    : [];
  if (target) {
    target[LIVE_FEED_PERFORMANCE_BUFFER] = [
      ...previous,
      entry,
    ].slice(-LIVE_FEED_PERFORMANCE_LIMIT);
  }
  logger?.info?.("[ALPR live-feed performance]", entry);
  return entry;
}

export function elapsedMilliseconds(startedAt, endedAt) {
  const start = Number(startedAt);
  const end = Number(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Number((end - start).toFixed(1));
}
