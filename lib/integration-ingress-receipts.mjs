const DEFAULT_PAGE_SIZE = 50;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);

function boundedText(value, maximum = 160) {
  return String(value ?? "").trim().slice(0, maximum);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedTimestamp(value) {
  const text = boundedText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function normalizedReadId(value) {
  const text = boundedText(value, 40);
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
}

export function normalizeIngressReceiptQuery(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const requestedPageSize = positiveInteger(source.pageSize, DEFAULT_PAGE_SIZE);
  const errorCode = boundedText(source.errorCode, 128);
  return {
    page: positiveInteger(source.page, 1),
    pageSize: ALLOWED_PAGE_SIZES.has(requestedPageSize)
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE,
    requestId: boundedText(source.requestId, 128),
    readId: normalizedReadId(source.readId),
    cameraName: boundedText(source.cameraName, 100),
    outcome: boundedText(source.outcome, 64),
    errorCode: errorCode === "__any__" ? errorCode : boundedText(errorCode, 128),
    startAt: normalizedTimestamp(source.startAt),
    endAt: normalizedTimestamp(source.endAt),
  };
}

function buildWhere(query) {
  const values = [];
  const conditions = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.requestId) {
    conditions.push(
      `POSITION(LOWER(${addValue(query.requestId)}::text) IN LOWER(request_id)) > 0`
    );
  }
  if (query.readId) {
    const readParameter = addValue(query.readId);
    conditions.push(
      `(${readParameter}::bigint = ANY(processed_read_ids) OR `
      + `${readParameter}::bigint = ANY(duplicate_target_read_ids))`
    );
  }
  if (query.cameraName) {
    conditions.push(`camera_name = ${addValue(query.cameraName)}::text`);
  }
  if (query.outcome) {
    conditions.push(`outcome = ${addValue(query.outcome)}::text`);
  }
  if (query.errorCode === "__any__") {
    conditions.push("error_code IS NOT NULL");
  } else if (query.errorCode) {
    conditions.push(`error_code = ${addValue(query.errorCode)}::text`);
  }
  if (query.startAt) {
    conditions.push(`received_at >= ${addValue(query.startAt)}::timestamptz`);
  }
  if (query.endAt) {
    conditions.push(`received_at <= ${addValue(query.endAt)}::timestamptz`);
  }

  return {
    values,
    sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
  };
}

function isoTimestamp(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function safeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizedTextArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function mapReceipt(row) {
  return {
    id: String(row.id),
    requestId: row.request_id || "",
    integration: row.integration || "",
    routeName: row.route_name || "",
    method: row.method || "",
    contentType: row.content_type || "",
    bodyBytes: Number(row.body_bytes) || 0,
    bodySha256: row.body_sha256 || "",
    payloadKeys: normalizedTextArray(row.payload_keys),
    unknownPayloadKeyCount: Number(row.unknown_payload_key_count) || 0,
    cameraName: row.camera_name || "",
    eventTimestampText: row.event_timestamp_text || "",
    triggerField: row.trigger_field || "",
    triggerPresent: Boolean(row.trigger_present),
    triggerValueState: row.trigger_value_state || "",
    triggerType: row.trigger_type || "",
    receiptSchemaVersion: Number(row.receipt_schema_version) || 1,
    triggerAliasFields: normalizedTextArray(row.trigger_alias_fields),
    triggerAliasConflict: Boolean(row.trigger_alias_conflict),
    triggerAliasDistinctValueCount:
      Number(row.trigger_alias_distinct_value_count) || 0,
    heavyFields: safeJsonObject(row.heavy_fields),
    state: row.state || "",
    receivedAt: isoTimestamp(row.received_at),
    completedAt: isoTimestamp(row.completed_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    outcome: row.outcome || "",
    errorCode: row.error_code || "",
    processedReadIds: normalizedTextArray(row.processed_read_ids),
    processedCount: Number(row.processed_count) || 0,
    duplicateCount: Number(row.duplicate_count) || 0,
    duplicateTargetReadIds: normalizedTextArray(row.duplicate_target_read_ids),
    ignoredCount: Number(row.ignored_count) || 0,
    overviewWorkQueued: Boolean(row.overview_work_queued),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

/**
 * Query bounded, metadata-only ingress receipts. The caller supplies a pg-style
 * query function so authentication and connection ownership remain outside the
 * query module.
 */
export async function queryIntegrationIngressReceipts(queryDatabase, input = {}) {
  if (typeof queryDatabase !== "function") {
    throw new TypeError("queryIntegrationIngressReceipts requires a query function");
  }

  const query = normalizeIngressReceiptQuery(input);
  const where = buildWhere(query);
  const [countResult, metadataResult] = await Promise.all([
    queryDatabase(
      `SELECT COUNT(*)::bigint AS total
       FROM public.integration_ingress_receipts
       ${where.sql}`,
      where.values
    ),
    queryDatabase(
      `SELECT
         COUNT(*)::bigint AS available_rows,
         MIN(received_at) AS oldest_received_at,
         MAX(received_at) AS newest_received_at,
         ARRAY(
           SELECT DISTINCT camera_name
           FROM public.integration_ingress_receipts
           WHERE camera_name IS NOT NULL AND BTRIM(camera_name) <> ''
           ORDER BY camera_name
           LIMIT 100
         ) AS cameras,
         ARRAY(
           SELECT DISTINCT outcome
           FROM public.integration_ingress_receipts
           WHERE outcome IS NOT NULL AND BTRIM(outcome) <> ''
           ORDER BY outcome
           LIMIT 100
         ) AS outcomes,
         ARRAY(
           SELECT DISTINCT error_code
           FROM public.integration_ingress_receipts
           WHERE error_code IS NOT NULL AND BTRIM(error_code) <> ''
           ORDER BY error_code
           LIMIT 100
         ) AS error_codes
       FROM public.integration_ingress_receipts`,
      []
    ),
  ]);

  const total = Number(countResult.rows?.[0]?.total) || 0;
  const totalPages = total ? Math.ceil(total / query.pageSize) : 0;
  const page = totalPages ? Math.min(query.page, totalPages) : 1;
  const offset = (page - 1) * query.pageSize;
  const rowValues = [...where.values, query.pageSize, offset];
  const limitParameter = `$${where.values.length + 1}`;
  const offsetParameter = `$${where.values.length + 2}`;
  const rowResult = await queryDatabase(
    `SELECT
       id, request_id, integration, route_name, method, content_type,
       body_bytes, body_sha256, payload_keys, unknown_payload_key_count,
       camera_name, event_timestamp_text, trigger_field, trigger_present,
       trigger_value_state, trigger_type, receipt_schema_version,
       trigger_alias_fields, trigger_alias_conflict,
       trigger_alias_distinct_value_count, heavy_fields, state, received_at,
       completed_at, duration_ms, http_status, outcome, error_code,
       processed_read_ids, processed_count, duplicate_count,
       duplicate_target_read_ids, ignored_count, overview_work_queued, updated_at
     FROM public.integration_ingress_receipts
     ${where.sql}
     ORDER BY received_at DESC, id DESC
     LIMIT ${limitParameter}::integer
     OFFSET ${offsetParameter}::integer`,
    rowValues
  );

  const metadata = metadataResult.rows?.[0] || {};
  return {
    receipts: (rowResult.rows || []).map(mapReceipt),
    page,
    pageSize: query.pageSize,
    total,
    totalPages,
    filters: { ...query, page },
    facets: {
      cameras: normalizedTextArray(metadata.cameras),
      outcomes: normalizedTextArray(metadata.outcomes),
      errorCodes: normalizedTextArray(metadata.error_codes),
    },
    metadata: {
      availableRows: Number(metadata.available_rows) || 0,
      oldestReceivedAt: isoTimestamp(metadata.oldest_received_at),
      newestReceivedAt: isoTimestamp(metadata.newest_received_at),
    },
  };
}
