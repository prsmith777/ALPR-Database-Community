const MAX_EVENTS_PER_APPEND = 20;
const MAX_EVENTS_PER_READ = 100;

const ALLOWED_STAGES = new Set([
  "ingress",
  "direction",
  "notifications",
  "vehicle-view",
]);
const ALLOWED_STATUSES = new Set([
  "accepted",
  "succeeded",
  "queued",
  "skipped",
  "partial",
  "failed",
  "completed",
]);
const BOOLEAN_DETAIL_KEYS = new Set([
  "aliasApplied",
  "imageStored",
  "thumbnailStored",
  "alertPointerPresent",
  "vehicleOverviewRetryable",
  "legacyPushoverMatched",
  "legacyPushoverSent",
]);
const INTEGER_DETAIL_KEYS = new Set([
  "directionProfileVersion",
  "mqttPlanned",
  "mqttQueued",
  "mqttDuplicates",
  "notificationPlanned",
  "notificationQueued",
  "notificationDuplicates",
  "directionNotificationPlanned",
  "directionNotificationQueued",
  "directionNotificationDuplicates",
]);
const TEXT_DETAIL_LIMITS = new Map([
  ["directionStatus", 40],
  ["directionLabel", 80],
  ["directionErrorCode", 128],
  ["directionAlgorithm", 128],
  ["mqttStatus", 32],
  ["notificationStatus", 32],
  ["directionNotificationStatus", 32],
  ["vehicleOverviewStatus", 40],
  ["vehicleOverviewQueueKind", 40],
  ["vehicleOverviewErrorCode", 128],
  ["legacyPushoverStatus", 32],
]);

function boundedText(value, maximum) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text.slice(0, maximum);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonnegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function sanitizeReadPipelineDetails(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : {};
  const details = {};
  for (const [key, value] of Object.entries(source)) {
    if (BOOLEAN_DETAIL_KEYS.has(key)) {
      if (typeof value === "boolean") details[key] = value;
      continue;
    }
    if (INTEGER_DETAIL_KEYS.has(key)) {
      const integer = Number(value);
      if (Number.isSafeInteger(integer) && integer >= 0) details[key] = integer;
      continue;
    }
    const maximum = TEXT_DETAIL_LIMITS.get(key);
    if (maximum) {
      const text = boundedText(value, maximum);
      if (text) details[key] = text;
    }
  }
  return details;
}

function eventStatus(status, fallback = "completed") {
  const normalized = boundedText(status, 32);
  return normalized && ALLOWED_STATUSES.has(normalized) ? normalized : fallback;
}

function resultStatus(results = []) {
  const statuses = results
    .filter(Boolean)
    .map((result) => String(result.status || "").trim().toLowerCase());
  if (statuses.some((status) => status === "error")) return "failed";
  if (statuses.some((status) => status === "partial")) return "partial";
  if (statuses.some((status) => ["queued", "planned"].includes(status))) return "queued";
  return "skipped";
}

function normalizedEvent(input = {}) {
  const readId = positiveInteger(input.readId);
  const eventType = boundedText(input.eventType, 96);
  const stage = boundedText(input.stage, 32);
  const component = boundedText(input.component, 64);
  if (!readId || !eventType || !/^[a-z0-9][a-z0-9_.-]*$/.test(eventType)) {
    throw new TypeError("Read pipeline events require a positive read ID and safe event type");
  }
  if (!stage || !ALLOWED_STAGES.has(stage)) {
    throw new TypeError("Read pipeline events require a supported stage");
  }
  if (!component) throw new TypeError("Read pipeline events require a component");

  const occurredAt = new Date(input.occurredAt || Date.now());
  if (Number.isNaN(occurredAt.getTime())) {
    throw new TypeError("Read pipeline events require a valid occurrence time");
  }

  return {
    readId,
    requestId: boundedText(input.requestId, 128),
    ingressReceiptId: positiveInteger(input.ingressReceiptId),
    stage,
    eventType,
    status: eventStatus(input.status),
    component,
    details: sanitizeReadPipelineDetails(input.details),
    occurredAt: occurredAt.toISOString(),
  };
}

export function buildAcceptedReadPipelineEvents({
  readId,
  requestId,
  ingressReceiptId,
  aliasApplied = false,
  imageStored = false,
  thumbnailStored = false,
  alertPointerPresent = false,
  direction = {},
  mqttResult = null,
  notificationResult = null,
  directionNotificationResult = null,
  vehicleOverview = {},
} = {}) {
  const common = {
    readId,
    requestId,
    ingressReceiptId,
    component: "plate-read-ingress",
  };
  const directionStatus = String(direction.bi_trigger_direction_status || "").trim();
  const directionErrorCode = String(direction.bi_trigger_direction_error_code || "").trim();
  const vehicleStatus = String(vehicleOverview.status || "").trim();
  return [
    normalizedEvent({
      ...common,
      stage: "ingress",
      eventType: "read.persisted",
      status: "accepted",
      details: {
        aliasApplied,
        imageStored,
        thumbnailStored,
        alertPointerPresent,
      },
    }),
    normalizedEvent({
      ...common,
      stage: "direction",
      eventType: "direction.resolved",
      status: directionStatus === "ready" ? "succeeded" : "skipped",
      details: {
        directionStatus,
        directionLabel: direction.bi_trigger_direction_label,
        directionErrorCode,
        directionProfileVersion: direction.bi_trigger_direction_profile_version,
        directionAlgorithm: direction.bi_trigger_direction_algorithm,
      },
    }),
    normalizedEvent({
      ...common,
      stage: "notifications",
      eventType: "notification.outboxes_prepared",
      status: resultStatus([
        mqttResult,
        notificationResult,
        directionNotificationResult,
      ]),
      details: {
        mqttStatus: mqttResult?.status,
        mqttPlanned: mqttResult?.planned,
        mqttQueued: mqttResult?.queued,
        mqttDuplicates: mqttResult?.duplicates,
        notificationStatus: notificationResult?.status,
        notificationPlanned: notificationResult?.planned,
        notificationQueued: notificationResult?.queued,
        notificationDuplicates: notificationResult?.duplicates,
        directionNotificationStatus: directionNotificationResult?.status,
        directionNotificationPlanned: directionNotificationResult?.planned,
        directionNotificationQueued: directionNotificationResult?.queued,
        directionNotificationDuplicates: directionNotificationResult?.duplicates,
      },
    }),
    normalizedEvent({
      ...common,
      stage: "vehicle-view",
      eventType: "vehicle_view.planned",
      status: vehicleOverview.queueKind === "overview"
        ? "queued"
        : vehicleStatus === "failed"
          ? "failed"
          : "skipped",
      details: {
        vehicleOverviewStatus: vehicleStatus,
        vehicleOverviewQueueKind: vehicleOverview.queueKind,
        vehicleOverviewRetryable: vehicleOverview.retryable,
        vehicleOverviewErrorCode: vehicleOverview.errorCode,
      },
    }),
  ];
}

export function buildLegacyPushoverPipelineEvent({
  readId,
  requestId,
  ingressReceiptId,
  result,
} = {}) {
  const pushover = result?.pushover || {};
  return normalizedEvent({
    readId,
    requestId,
    ingressReceiptId,
    stage: "notifications",
    eventType: "legacy_pushover.completed",
    status: pushover.status === "sent"
      ? "succeeded"
      : ["failed", "error"].includes(pushover.status)
        ? "failed"
        : "skipped",
    component: "plate-read-ingress",
    details: {
      legacyPushoverStatus: pushover.status,
      legacyPushoverMatched: pushover.matched,
      legacyPushoverSent: pushover.sent,
    },
  });
}

export async function appendReadPipelineEvents(queryDatabase, inputs = []) {
  if (typeof queryDatabase !== "function") {
    throw new TypeError("appendReadPipelineEvents requires a query function");
  }
  const events = (Array.isArray(inputs) ? inputs : [inputs])
    .slice(0, MAX_EVENTS_PER_APPEND)
    .map(normalizedEvent);
  if (!events.length) return 0;

  const result = await queryDatabase(
    `INSERT INTO public.plate_read_pipeline_events (
       read_id, request_id, ingress_receipt_id, stage, event_type,
       status, component, details, occurred_at
     )
     SELECT
       (item.value->>'readId')::integer,
       NULLIF(item.value->>'requestId', ''),
       NULLIF(item.value->>'ingressReceiptId', '')::bigint,
       item.value->>'stage',
       item.value->>'eventType',
       item.value->>'status',
       item.value->>'component',
       COALESCE(item.value->'details', '{}'::jsonb),
       (item.value->>'occurredAt')::timestamptz
     FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS item(value, ordinal)
     ORDER BY item.ordinal`,
    [JSON.stringify(events)],
  );
  const rowCount = Number(result.rowCount);
  return Number.isSafeInteger(rowCount) && rowCount >= 0 ? rowCount : events.length;
}

function isoTimestamp(value) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export async function queryReadPipelineTimeline(queryDatabase, readId, { limit } = {}) {
  if (typeof queryDatabase !== "function") {
    throw new TypeError("queryReadPipelineTimeline requires a query function");
  }
  const normalizedReadId = positiveInteger(readId);
  if (!normalizedReadId) throw new TypeError("Read pipeline timeline requires a positive read ID");
  const boundedLimit = Math.min(
    MAX_EVENTS_PER_READ,
    Math.max(1, nonnegativeInteger(limit) || MAX_EVENTS_PER_READ),
  );
  const [readResult, eventResult] = await Promise.all([
    queryDatabase(
      `SELECT EXISTS (
         SELECT 1 FROM public.plate_reads WHERE id = $1::integer
       ) AS read_exists`,
      [normalizedReadId],
    ),
    queryDatabase(
      `SELECT * FROM (
         SELECT id, read_id, request_id, ingress_receipt_id, stage,
                event_type, status, component, details, occurred_at,
                (COUNT(*) OVER ())::integer AS total_count
         FROM public.plate_read_pipeline_events
         WHERE read_id = $1::integer
         ORDER BY occurred_at DESC, id DESC
         LIMIT $2::integer
       ) recent
       ORDER BY occurred_at, id`,
      [normalizedReadId, boundedLimit],
    ),
  ]);
  const rows = eventResult.rows || [];
  const total = Number(rows[0]?.total_count) || 0;
  return {
    readId: normalizedReadId,
    readExists: Boolean(readResult.rows?.[0]?.read_exists),
    total,
    truncated: total > rows.length,
    events: rows.map((row) => ({
      id: String(row.id),
      readId: Number(row.read_id),
      requestId: row.request_id || "",
      ingressReceiptId: row.ingress_receipt_id == null
        ? null
        : String(row.ingress_receipt_id),
      stage: row.stage || "",
      eventType: row.event_type || "",
      status: row.status || "",
      component: row.component || "",
      details: sanitizeReadPipelineDetails(row.details),
      occurredAt: isoTimestamp(row.occurred_at),
    })),
  };
}

export const readPipelineTimelineInternals = Object.freeze({
  normalizedEvent,
  resultStatus,
});
