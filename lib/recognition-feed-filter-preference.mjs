const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const MAX_LIST_ITEMS = 24;
const MAX_LIST_ITEM_LENGTH = 100;
const MAX_SEARCH_LENGTH = 100;

const ALLOWED_REVIEW_STATUSES = new Set([
  "unreviewed",
  "confirmed",
  "corrected",
  "alias_resolved",
]);
const ALLOWED_SORT_FIELDS = new Set([
  "plate_number",
  "confidence",
  "occurrence_count",
  "tags",
  "camera_name",
  "direction",
  "speed",
  "timestamp",
]);

export const RECOGNITION_FEED_FILTER_PREFERENCE_STORAGE_KEY =
  "alpr.recognitionFeed.filters.v1";
export const RECOGNITION_FEED_FILTER_PREFERENCE_COOKIE_NAME =
  "alpr_recognition_feed_filters_v1";

export const DEFAULT_RECOGNITION_FEED_FILTER_PREFERENCE = Object.freeze({
  search: "",
  tags: Object.freeze([]),
  dateFrom: "",
  dateTo: "",
  hourFrom: "",
  hourTo: "",
  cameras: Object.freeze([]),
  reviewStatuses: Object.freeze([]),
  directions: Object.freeze([]),
  minimumSpeed: "",
  maximumSpeed: "",
  sortField: "timestamp",
  sortDirection: "desc",
});

export const RECOGNITION_FEED_PERSISTED_QUERY_KEYS = Object.freeze([
  "search",
  "tag",
  "dateFrom",
  "dateTo",
  "hourFrom",
  "hourTo",
  "camera",
  "reviewStatus",
  "direction",
  "minimumSpeed",
  "maximumSpeed",
  "sortField",
  "sortDirection",
]);

const RECOGNITION_FEED_EXPLICIT_QUERY_KEYS = Object.freeze([
  ...RECOGNITION_FEED_PERSISTED_QUERY_KEYS,
  "readId",
  "timestampFrom",
  "timestampTo",
  "timeZone",
  "timeFrame",
  "dashboardMetric",
  "matchMode",
  "fuzzySearch",
]);

function boundedString(value, maximumLength) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function normalizedList(value) {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(
    new Set(
      input
        .map((item) => boundedString(item, MAX_LIST_ITEM_LENGTH))
        .filter((item) => item && item !== "all")
    )
  ).slice(0, MAX_LIST_ITEMS);
}

function normalizedDate(value) {
  const input = boundedString(value, 64);
  if (!input) return "";
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function normalizedHour(value) {
  if (value === null || value === undefined || value === "") return "";
  const hour = Number.parseInt(String(value), 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 47
    ? String(hour)
    : "";
}

function normalizedSpeed(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }
  const speed = Number(value);
  return Number.isFinite(speed) && speed >= 0 && speed <= 200
    ? String(speed)
    : "";
}

export function normalizeRecognitionFeedFilterPreference(value = {}) {
  let dateFrom = normalizedDate(value?.dateFrom);
  let dateTo = normalizedDate(value?.dateTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    dateFrom = "";
    dateTo = "";
  }

  let hourFrom = normalizedHour(value?.hourFrom);
  let hourTo = normalizedHour(value?.hourTo);
  if (!hourFrom || !hourTo) {
    hourFrom = "";
    hourTo = "";
  }

  const sortField = ALLOWED_SORT_FIELDS.has(value?.sortField)
    ? value.sortField
    : DEFAULT_RECOGNITION_FEED_FILTER_PREFERENCE.sortField;
  const sortDirection = value?.sortDirection === "asc" ? "asc" : "desc";

  return {
    search: boundedString(value?.search, MAX_SEARCH_LENGTH),
    tags: normalizedList(value?.tags),
    dateFrom,
    dateTo,
    hourFrom,
    hourTo,
    cameras: normalizedList(value?.cameras),
    reviewStatuses: normalizedList(value?.reviewStatuses).filter((status) =>
      ALLOWED_REVIEW_STATUSES.has(status)
    ),
    directions: normalizedList(value?.directions),
    minimumSpeed: normalizedSpeed(value?.minimumSpeed),
    maximumSpeed: normalizedSpeed(value?.maximumSpeed),
    sortField,
    sortDirection,
  };
}

function parameterValue(params, name) {
  if (typeof params?.get === "function") return params.get(name) || "";
  const value = params?.[name];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function parameterList(params, name) {
  if (typeof params?.getAll === "function") return params.getAll(name);
  const value = params?.[name];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function hasParameter(params, name) {
  if (typeof params?.has === "function") return params.has(name);
  return Object.prototype.hasOwnProperty.call(params || {}, name);
}

export function recognitionFeedFilterPreferenceFromSearchParams(params) {
  return normalizeRecognitionFeedFilterPreference({
    search: parameterValue(params, "search"),
    tags: parameterList(params, "tag"),
    dateFrom: parameterValue(params, "dateFrom"),
    dateTo: parameterValue(params, "dateTo"),
    hourFrom: parameterValue(params, "hourFrom"),
    hourTo: parameterValue(params, "hourTo"),
    cameras: parameterList(params, "camera"),
    reviewStatuses: parameterList(params, "reviewStatus"),
    directions: parameterList(params, "direction"),
    minimumSpeed: parameterValue(params, "minimumSpeed"),
    maximumSpeed: parameterValue(params, "maximumSpeed"),
    sortField: parameterValue(params, "sortField"),
    sortDirection: parameterValue(params, "sortDirection"),
  });
}

export function recognitionFeedFilterPreferenceToSearchParams(value) {
  const preference = normalizeRecognitionFeedFilterPreference(value);
  const params = new URLSearchParams();
  const set = (name, item) => {
    if (item) params.set(name, item);
  };
  const append = (name, items) => {
    items.forEach((item) => params.append(name, item));
  };

  set("search", preference.search);
  append("tag", preference.tags);
  set("dateFrom", preference.dateFrom);
  set("dateTo", preference.dateTo);
  set("hourFrom", preference.hourFrom);
  set("hourTo", preference.hourTo);
  append("camera", preference.cameras);
  append("reviewStatus", preference.reviewStatuses);
  append("direction", preference.directions);
  set("minimumSpeed", preference.minimumSpeed);
  set("maximumSpeed", preference.maximumSpeed);
  if (
    preference.sortField !== "timestamp" ||
    preference.sortDirection !== "desc"
  ) {
    params.set("sortField", preference.sortField);
  }
  if (preference.sortDirection !== "desc") {
    params.set("sortDirection", preference.sortDirection);
  }
  return params;
}

export function hasExplicitRecognitionFeedFilterState(params) {
  return RECOGNITION_FEED_EXPLICIT_QUERY_KEYS.some((key) =>
    hasParameter(params, key)
  );
}

export function hasRecognitionFeedFilterPreference(value) {
  return recognitionFeedFilterPreferenceToSearchParams(value).size > 0;
}

function browserStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function parsedPreference(value) {
  if (!value) return normalizeRecognitionFeedFilterPreference();
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {
    // The raw value may still be valid JSON.
  }
  for (const candidate of candidates) {
    try {
      return normalizeRecognitionFeedFilterPreference(JSON.parse(candidate));
    } catch {
      // Try the next representation before using defaults.
    }
  }
  return normalizeRecognitionFeedFilterPreference();
}

export function readRecognitionFeedFilterPreference(storage) {
  try {
    return parsedPreference(
      browserStorage(storage)?.getItem(
        RECOGNITION_FEED_FILTER_PREFERENCE_STORAGE_KEY
      )
    );
  } catch {
    return normalizeRecognitionFeedFilterPreference();
  }
}

export function readRecognitionFeedFilterCookiePreference(cookieStore) {
  return parsedPreference(
    cookieStore?.get?.(RECOGNITION_FEED_FILTER_PREFERENCE_COOKIE_NAME)?.value
  );
}

export function writeRecognitionFeedFilterPreference(
  value,
  storage,
  documentRef = globalThis?.document
) {
  const preference = normalizeRecognitionFeedFilterPreference(value);
  const serialized = JSON.stringify(preference);
  try {
    browserStorage(storage)?.setItem(
      RECOGNITION_FEED_FILTER_PREFERENCE_STORAGE_KEY,
      serialized
    );
  } catch {
    // Browsers can block storage; the server-readable cookie can still work.
  }
  try {
    if (documentRef) {
      documentRef.cookie = `${RECOGNITION_FEED_FILTER_PREFERENCE_COOKIE_NAME}=${encodeURIComponent(serialized)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    }
  } catch {
    // Browser privacy settings can block cookies; local storage still works.
  }
  return preference;
}
