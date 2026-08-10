const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export const DASHBOARD_TIME_FRAME_LABELS = Object.freeze({
  "24h": "Last 24 Hours",
  "3d": "Last 3 Days",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All Time",
});

export const DASHBOARD_FEED_METRIC_LABELS = Object.freeze({
  totalReads: "Total Reads",
  uniqueVehicles: "Unique Vehicles",
  newVehicles: "New Vehicles",
});

const DASHBOARD_TIME_FRAME_DAYS = Object.freeze({
  "24h": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
});

export function normalizeDashboardTimeZone(value, fallback = "UTC") {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 100) return fallback;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

export function normalizeDashboardCameraNames(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [value])
        .map((camera) => String(camera || "").trim())
        .filter(
          (camera) => camera && camera !== "all" && camera.length <= 200
        )
    ),
  ].slice(0, 100);
}

export function getDashboardTimeWindow(timeFrame, now = new Date()) {
  const endDate = new Date(now);
  if (Number.isNaN(endDate.getTime())) {
    throw new TypeError("Dashboard time windows require a valid end date.");
  }

  if (timeFrame === "all") {
    return {
      startDate: new Date(0),
      endDate,
    };
  }

  const days = DASHBOARD_TIME_FRAME_DAYS[timeFrame] || 1;
  return {
    startDate: new Date(endDate.getTime() - days * DAY_IN_MILLISECONDS),
    endDate,
  };
}

export function buildDashboardFeedHref({
  search,
  tags = [],
  metric,
  timeFrame,
  startDate,
  endDate,
  timeZone,
  cameras = [],
}) {
  const from = new Date(startDate);
  const to = new Date(endDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new TypeError("Time-distribution links require a valid time window.");
  }

  const params = new URLSearchParams({
    page: "1",
    timestampFrom: from.toISOString(),
    timestampTo: to.toISOString(),
    timeZone: String(timeZone || "UTC"),
    timeFrame: DASHBOARD_TIME_FRAME_LABELS[timeFrame] ? timeFrame : "24h",
  });

  const plateSearch = String(search || "").trim();
  if (plateSearch) {
    params.set("search", plateSearch);
    params.set("matchMode", "off");
  }

  [...new Set((Array.isArray(tags) ? tags : [tags])
    .map((tag) => String(tag || "").trim())
    .filter((tag) => tag && tag.length <= 100))]
    .slice(0, 100)
    .forEach((tag) => params.append("tag", tag));

  if (DASHBOARD_FEED_METRIC_LABELS[metric]) {
    params.set("dashboardMetric", metric);
  }

  normalizeDashboardCameraNames(cameras).forEach((camera) =>
    params.append("camera", camera)
  );

  return `/live_feed?${params.toString()}`;
}

export function buildTimeDistributionHref({ hour, ...dashboardFilters }) {
  const localHour = Number(hour);
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) {
    throw new RangeError("Time-distribution links require an hour from 0 to 23.");
  }

  const href = new URL(
    buildDashboardFeedHref(dashboardFilters),
    "http://alpr.local"
  );
  href.searchParams.set("hourFrom", String(localHour));
  href.searchParams.set("hourTo", String(localHour));
  return `${href.pathname}?${href.searchParams.toString()}`;
}
