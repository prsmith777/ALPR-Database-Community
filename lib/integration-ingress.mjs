import { createHash } from "node:crypto";

const RECOGNIZED_PAYLOAD_KEYS = new Set([
  "ai_dump",
  "Image",
  "camera",
  "ALERT_PATH",
  "ALERT_CLIP",
  "timestamp",
  "trigger_type",
  "triggerType",
  "TYPE",
  "memo",
  "plate_number",
]);
const HEAVY_FIELDS = ["ai_dump", "Image", "ALERT_PATH", "ALERT_CLIP"];
const TRIGGER_FIELDS = ["trigger_type", "triggerType", "TYPE"];
const SAFE_TRIGGER_PATTERN = /^[A-Za-z0-9_!>,+<\-.: ]{1,128}$/;
export const INGRESS_RECEIPT_SCHEMA_VERSION = 2;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_ROWS = 25_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function boundedText(value, maximum = 128) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text.slice(0, maximum);
}

function summarizeHeavyValue(value) {
  if (value === null || value === undefined) return { present: false };
  if (typeof value === "string") {
    return {
      present: true,
      type: "string",
      bytes: Buffer.byteLength(value, "utf8"),
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { present: true, type: "bytes", bytes: value.byteLength };
  }
  if (Array.isArray(value)) {
    return { present: true, type: "array", items: value.length };
  }
  if (typeof value === "object") {
    return { present: true, type: "object", keys: Object.keys(value).length };
  }
  return { present: true, type: typeof value };
}

function normalizedTriggerAliasToken(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "blank";
  }
  if ((typeof value !== "string" && typeof value !== "number") ||
      !SAFE_TRIGGER_PATTERN.test(String(value).trim())) {
    const serialized = JSON.stringify(value) ?? String(value);
    return `invalid:${createHash("sha256").update(serialized).digest("hex")}`;
  }
  return `recorded:${String(value).trim().toUpperCase()}`;
}

function triggerEvidence(data) {
  const triggerAliasFields = TRIGGER_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
  const triggerAliasDistinctValueCount = new Set(
    triggerAliasFields.map((field) => normalizedTriggerAliasToken(data[field])),
  ).size;
  const triggerAliasConflict = triggerAliasFields.length > 1
    && triggerAliasDistinctValueCount > 1;
  const triggerField = TRIGGER_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(data, field),
  );
  if (!triggerField) {
    return {
      triggerField: null,
      triggerPresent: false,
      triggerValueState: "absent",
      triggerType: null,
      triggerAliasFields,
      triggerAliasConflict,
      triggerAliasDistinctValueCount,
    };
  }

  const rawValue = data[triggerField];
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === "") {
    return {
      triggerField,
      triggerPresent: true,
      triggerValueState: "blank",
      triggerType: null,
      triggerAliasFields,
      triggerAliasConflict,
      triggerAliasDistinctValueCount,
    };
  }

  if ((typeof rawValue !== "string" && typeof rawValue !== "number") ||
      !SAFE_TRIGGER_PATTERN.test(String(rawValue).trim())) {
    return {
      triggerField,
      triggerPresent: true,
      triggerValueState: "invalid",
      triggerType: null,
      triggerAliasFields,
      triggerAliasConflict,
      triggerAliasDistinctValueCount,
    };
  }

  return {
    triggerField,
    triggerPresent: true,
    triggerValueState: "recorded",
    triggerType: String(rawValue).trim(),
    triggerAliasFields,
    triggerAliasConflict,
    triggerAliasDistinctValueCount,
  };
}

export function summarizeIntegrationIngress({
  rawText = null,
  data = null,
  bodyBytes = null,
  contentType = null,
} = {}) {
  const payload = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const payloadKeys = Object.keys(payload);
  const recognizedKeys = payloadKeys
    .filter((key) => RECOGNIZED_PAYLOAD_KEYS.has(key))
    .sort();
  const heavyFields = Object.fromEntries(
    HEAVY_FIELDS.map((field) => [field, summarizeHeavyValue(payload[field])]),
  );
  const trigger = triggerEvidence(payload);
  const normalizedRawText = typeof rawText === "string" ? rawText : null;
  const hasMeasuredBodyBytes = bodyBytes !== null
    && bodyBytes !== undefined
    && bodyBytes !== ""
    && Number.isFinite(Number(bodyBytes));
  const measuredBodyBytes = hasMeasuredBodyBytes
    ? Math.max(0, Math.trunc(Number(bodyBytes)))
    : normalizedRawText === null
      ? null
      : Buffer.byteLength(normalizedRawText, "utf8");

  return {
    contentType: boundedText(contentType, 128),
    bodyBytes: measuredBodyBytes,
    bodySha256: normalizedRawText === null
      ? null
      : createHash("sha256").update(normalizedRawText).digest("hex"),
    payloadKeys: recognizedKeys,
    unknownPayloadKeyCount: Math.max(0, payloadKeys.length - recognizedKeys.length),
    cameraName: boundedText(payload.camera, 100),
    eventTimestampText: boundedText(payload.timestamp, 128),
    heavyFields,
    ...trigger,
  };
}

function normalizedReadIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isSafeInteger(item) && item > 0))]
    .slice(0, 100);
}

export function createIntegrationIngressRecorder({
  query,
  logger = null,
  retentionDays = boundedInteger(
    process.env.ALPR_INGRESS_RECEIPT_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
    365,
  ),
  maxRows = boundedInteger(
    process.env.ALPR_INGRESS_RECEIPT_MAX_ROWS,
    DEFAULT_MAX_ROWS,
    1_000,
    1_000_000,
  ),
  now = () => Date.now(),
} = {}) {
  if (typeof query !== "function") {
    throw new TypeError("createIntegrationIngressRecorder requires a query function");
  }

  let lastCleanupAt = 0;

  async function cleanupIfDue() {
    const currentTime = now();
    if (currentTime - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = currentTime;
    // Retention is deliberately separated from request ingestion. The values
    // remain accepted here for compatibility and health reporting, but source
    // rows change only through the actor-bound preview/confirmation workflow.
    void retentionDays;
    void maxRows;
  }

  return {
    async start({
      requestId,
      integration,
      routeName,
      method,
      rawText,
      data,
      bodyBytes,
      contentType,
    }) {
      const summary = summarizeIntegrationIngress({ rawText, data, bodyBytes, contentType });
      const result = await query(
        `INSERT INTO public.integration_ingress_receipts (
           request_id,
           integration,
           route_name,
           method,
           content_type,
           body_bytes,
           body_sha256,
           payload_keys,
           unknown_payload_key_count,
           camera_name,
           event_timestamp_text,
           trigger_field,
           trigger_present,
           trigger_value_state,
           trigger_type,
           heavy_fields,
           receipt_schema_version,
           trigger_alias_fields,
           trigger_alias_conflict,
           trigger_alias_distinct_value_count
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12, $13, $14, $15, $16::jsonb,
           $17, $18::text[], $19, $20
         )
         RETURNING id`,
        [
          boundedText(requestId, 128),
          boundedText(integration, 64) || "unknown",
          boundedText(routeName, 128) || "unknown",
          boundedText(method, 12),
          summary.contentType,
          summary.bodyBytes,
          summary.bodySha256,
          summary.payloadKeys,
          summary.unknownPayloadKeyCount,
          summary.cameraName,
          summary.eventTimestampText,
          summary.triggerField,
          summary.triggerPresent,
          summary.triggerValueState,
          summary.triggerType,
          JSON.stringify(summary.heavyFields),
          INGRESS_RECEIPT_SCHEMA_VERSION,
          summary.triggerAliasFields,
          summary.triggerAliasConflict,
          summary.triggerAliasDistinctValueCount,
        ],
      );

      try {
        await cleanupIfDue();
      } catch (error) {
        logger?.warn?.("integration_ingress_cleanup_failed", {
          errorCode: error?.code || "CLEANUP_FAILED",
        });
      }
      const receiptId = result.rows?.[0]?.id ?? null;
      return receiptId == null
        ? null
        : {
            receiptId,
            logSummary: {
              contentType: summary.contentType,
              bodyBytes: summary.bodyBytes,
              cameraName: summary.cameraName,
              eventTimestamp: summary.eventTimestampText,
              payloadKeys: summary.payloadKeys,
              unknownPayloadKeyCount: summary.unknownPayloadKeyCount,
              triggerField: summary.triggerField,
              triggerPresent: summary.triggerPresent,
              triggerValueState: summary.triggerValueState,
              triggerType: summary.triggerType,
              receiptSchemaVersion: INGRESS_RECEIPT_SCHEMA_VERSION,
              triggerAliasFields: summary.triggerAliasFields,
              triggerAliasConflict: summary.triggerAliasConflict,
              triggerAliasDistinctValueCount: summary.triggerAliasDistinctValueCount,
              fieldSummaries: {
                aiDumpField: summary.heavyFields.ai_dump,
                imageField: summary.heavyFields.Image,
                alertPathField: summary.heavyFields.ALERT_PATH,
                alertClipField: summary.heavyFields.ALERT_CLIP,
              },
            },
          };
    },

    async complete({
      receiptId,
      durationMs,
      httpStatus,
      outcome,
      errorCode,
      processedReadIds,
      processedCount,
      duplicateCount,
      duplicateTargetReadIds,
      ignoredCount,
      overviewWorkQueued,
    }) {
      const normalizedReceiptId = Number.parseInt(receiptId, 10);
      if (!Number.isInteger(normalizedReceiptId) || normalizedReceiptId <= 0) return;

      const ids = normalizedReadIds(processedReadIds);
      const duplicateIds = normalizedReadIds(duplicateTargetReadIds);
      await query(
        `UPDATE public.integration_ingress_receipts
         SET state = 'completed',
             completed_at = CURRENT_TIMESTAMP,
             duration_ms = $2,
             http_status = $3,
             outcome = $4,
             error_code = $5,
             processed_read_ids = $6::bigint[],
             processed_count = $7,
             duplicate_count = $8,
             ignored_count = $9,
             overview_work_queued = $10,
             duplicate_target_read_ids = $11::bigint[],
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::bigint`,
        [
          normalizedReceiptId,
          Math.max(0, Math.trunc(Number(durationMs) || 0)),
          Number.isInteger(Number(httpStatus)) ? Number(httpStatus) : null,
          boundedText(outcome, 64),
          boundedText(errorCode, 128),
          ids,
          Math.max(0, Math.trunc(Number(processedCount) || ids.length)),
          Math.max(0, Math.trunc(Number(duplicateCount) || 0)),
          Math.max(0, Math.trunc(Number(ignoredCount) || 0)),
          Boolean(overviewWorkQueued),
          duplicateIds,
        ],
      );
    },
  };
}
