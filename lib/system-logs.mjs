import { sanitizeLogValue } from "../logging/sanitize.mjs";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DEFAULT_PAGE_SIZE = 50;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const ALLOWED_LEVELS = new Set(["ALL", "DEBUG", "INFO", "WARN", "ERROR"]);
const STANDARD_FIELDS = new Set(["timestamp", "level", "message"]);

function boundedFilter(value, maximum = 160) {
  return String(value ?? "").trim().slice(0, maximum);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedTimestamp(value) {
  const text = boundedFilter(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function normalizedLevel(value) {
  const level = boundedFilter(value, 20).toUpperCase();
  return level || "INFO";
}

function displayText(value, fallback = "") {
  if (value == null) return fallback;
  if (typeof value === "string") return value.replace(ANSI_PATTERN, "");
  return String(value);
}

function detailsFromParsed(parsed) {
  const details = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!STANDARD_FIELDS.has(key)) details[key] = value;
  }
  return details;
}

function firstDetail(details, ...keys) {
  for (const key of keys) {
    const value = details[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function readIdsFromDetails(details) {
  const values = [];
  const direct = firstDetail(details, "readId", "read_id");
  if (direct !== null) values.push(direct);
  const processed = firstDetail(details, "processedReadIds", "processed_read_ids");
  if (Array.isArray(processed)) values.push(...processed);
  const duplicateTargets = firstDetail(
    details,
    "duplicateTargetReadIds",
    "duplicate_target_read_ids",
  );
  if (Array.isArray(duplicateTargets)) values.push(...duplicateTargets);
  return [...new Set(values.map((value) => boundedFilter(value, 40)).filter(Boolean))];
}

/** Parse both the structured Winston JSON format and the retired text format. */
export function parseSystemLogLine(line, index = 0) {
  const source = displayText(line).trim();
  if (!source) return null;

  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("JSON object required");
    }
    const safe = sanitizeLogValue(parsed);
    const details = detailsFromParsed(safe);
    const timestamp = normalizedTimestamp(safe.timestamp);
    const requestId = boundedFilter(
      firstDetail(details, "requestId", "request_id"),
      160
    );
    const component = boundedFilter(details.component, 100);
    const cameraName = boundedFilter(
      firstDetail(details, "cameraName", "camera_name", "camera"),
      160
    );

    return {
      id: `${timestamp || "undated"}-${index}`,
      timestamp,
      level: normalizedLevel(safe.level),
      message: displayText(safe.message, "operational_event"),
      component,
      cameraName,
      requestId,
      readIds: readIdsFromDetails(details),
      details,
      format: "structured",
    };
  } catch {
    const legacy = source.match(/^(.*?)\s+\[([A-Za-z]+)\]\s+(.*)$/);
    const timestamp = normalizedTimestamp(legacy?.[1]);
    return {
      id: `${timestamp || "legacy"}-${index}`,
      timestamp,
      level: normalizedLevel(legacy?.[2]),
      message: displayText(sanitizeLogValue(legacy?.[3] || source)),
      component: "legacy",
      cameraName: "",
      requestId: "",
      readIds: [],
      details: { format: "legacy" },
      format: "legacy",
    };
  }
}

export function normalizeSystemLogQuery(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requestedLevel = boundedFilter(source.level, 20).toUpperCase() || "ALL";
  const requestedPageSize = positiveInteger(source.pageSize, DEFAULT_PAGE_SIZE);
  return {
    page: positiveInteger(source.page, 1),
    pageSize: ALLOWED_PAGE_SIZES.has(requestedPageSize)
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE,
    level: ALLOWED_LEVELS.has(requestedLevel) ? requestedLevel : "ALL",
    search: boundedFilter(source.search, 200),
    component: boundedFilter(source.component, 100),
    cameraName: boundedFilter(source.cameraName, 160),
    requestId: boundedFilter(source.requestId, 160),
    readId: boundedFilter(source.readId, 40),
    startAt: normalizedTimestamp(source.startAt),
    endAt: normalizedTimestamp(source.endAt),
  };
}

function searchableText(entry) {
  return [
    entry.timestamp,
    entry.level,
    entry.message,
    entry.component,
    entry.cameraName,
    entry.requestId,
    entry.readIds.join(" "),
    JSON.stringify(entry.details),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function uniqueFacet(entries, key) {
  return [...new Set(entries.map((entry) => entry[key]).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100);
}

function matchesQuery(entry, query) {
  if (query.level !== "ALL" && entry.level !== query.level) return false;
  if (query.component && entry.component !== query.component) return false;
  if (query.cameraName && entry.cameraName !== query.cameraName) return false;
  if (
    query.requestId &&
    !entry.requestId.toLowerCase().includes(query.requestId.toLowerCase())
  ) {
    return false;
  }
  if (query.readId && !entry.readIds.includes(query.readId)) return false;
  if (query.search && !searchableText(entry).includes(query.search.toLowerCase())) {
    return false;
  }

  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : null;
  if (query.startAt && (timestamp === null || timestamp < Date.parse(query.startAt))) {
    return false;
  }
  if (query.endAt && (timestamp === null || timestamp > Date.parse(query.endAt))) {
    return false;
  }
  return true;
}

/**
 * Build one bounded, sanitized incident snapshot from retained operational
 * log text. The caller may supply the active file or active plus rotations.
 */
export function querySystemLogIncident(content, input = {}, maximumEntries = 2_000) {
  const query = normalizeSystemLogQuery({ ...input, page: 1, pageSize: 100 });
  const maximum = Math.max(1, Math.min(2_000, positiveInteger(maximumEntries, 2_000)));
  const matched = String(content ?? "")
    .split(/\r?\n/)
    .map((line, index) => parseSystemLogLine(line, index))
    .filter(Boolean)
    .filter((entry) => matchesQuery(entry, query));
  const truncated = matched.length > maximum;
  return {
    entries: matched.slice(-maximum),
    matchedCount: matched.length,
    truncated,
  };
}

/**
 * Query one bounded active log file. Results are newest-first and paginated
 * before crossing the server-action boundary.
 */
export function querySystemLogText(content, input = {}, metadata = {}) {
  const query = normalizeSystemLogQuery(input);
  const entries = String(content ?? "")
    .split(/\r?\n/)
    .map((line, index) => parseSystemLogLine(line, index))
    .filter(Boolean)
    .reverse();
  const matched = entries.filter((entry) => matchesQuery(entry, query));
  const totalPages = matched.length ? Math.ceil(matched.length / query.pageSize) : 0;
  const page = totalPages ? Math.min(query.page, totalPages) : 1;
  const offset = (page - 1) * query.pageSize;
  const pageEntries = matched.slice(offset, offset + query.pageSize);
  const dated = entries.filter((entry) => entry.timestamp);

  return {
    entries: pageEntries,
    page,
    pageSize: query.pageSize,
    total: matched.length,
    totalPages,
    filters: { ...query, page },
    facets: {
      components: uniqueFacet(entries, "component"),
      cameras: uniqueFacet(entries, "cameraName"),
    },
    metadata: {
      availableRows: entries.length,
      structuredRows: entries.filter((entry) => entry.format === "structured").length,
      legacyRows: entries.filter((entry) => entry.format === "legacy").length,
      fileBytes: Number(metadata.fileBytes) || 0,
      maxFileBytes: Number(metadata.maxFileBytes) || 0,
      maxFiles: Number(metadata.maxFiles) || 0,
      newestTimestamp: dated[0]?.timestamp || null,
      oldestTimestamp: dated.at(-1)?.timestamp || null,
    },
  };
}
