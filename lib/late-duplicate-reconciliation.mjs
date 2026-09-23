const REQUEUEABLE_OVERVIEW_ERRORS = new Set([
  "DAYLIGHT_UNVERIFIED",
  "OVERVIEW_DIRECTION_UNAVAILABLE",
]);

const DIRECTION_FIELDS = Object.freeze([
  "bi_trigger_type",
  "bi_trigger_direction_status",
  "bi_trigger_direction_label",
  "bi_trigger_direction_profile_version",
  "bi_trigger_direction_algorithm",
  "bi_trigger_direction_error_code",
]);

const RECOGNITION_FIELDS = Object.freeze([
  "confidence",
  "crop_coordinates",
  "ocr_annotation",
  "plate_annotation",
]);

function present(value) {
  return value !== null && value !== undefined;
}

function comparable(value) {
  if (!present(value)) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function incomingMatchesEstablished(current, incoming) {
  return !present(current)
    || (present(incoming) && comparable(current) === comparable(incoming));
}

function completeDirectionBundle(direction = {}) {
  const status = direction.bi_trigger_direction_status;
  const algorithm = String(direction.bi_trigger_direction_algorithm || "").trim();
  if (status === "ready") {
    const profileVersion = Number(direction.bi_trigger_direction_profile_version);
    return Boolean(
      String(direction.bi_trigger_direction_label || "").trim()
      && Number.isSafeInteger(profileVersion)
      && profileVersion > 0
      && algorithm
      && !present(direction.bi_trigger_direction_error_code)
    );
  }
  return status === "unknown"
    && !present(direction.bi_trigger_direction_label)
    && !present(direction.bi_trigger_direction_profile_version)
    && Boolean(algorithm)
    && Boolean(String(direction.bi_trigger_direction_error_code || "").trim());
}

function alertPlan(current, incoming = {}) {
  const fields = ["bi_path", "bi_alert_clip", "bi_alert_path", "bi_alert_offset_ms"];
  const hasAttachment = fields.some(
    (field) => !present(current[field]) && present(incoming[field]),
  );
  const compatible = fields.every(
    (field) => incomingMatchesEstablished(current[field], incoming[field]),
  );
  if (!hasAttachment || !compatible) return { attached: false, values: {} };
  const values = Object.fromEntries(fields.map((field) => [
    field,
    !present(current[field]) && present(incoming[field]) ? incoming[field] : current[field],
  ]));
  return {
    attached: true,
    values,
  };
}

function directionPlan(current, incoming = {}) {
  if (!completeDirectionBundle(incoming)) return { attached: false, values: {} };
  if (!DIRECTION_FIELDS.every(
    (field) => incomingMatchesEstablished(current[field], incoming[field]),
  )) {
    return { attached: false, values: {} };
  }
  const values = Object.fromEntries(DIRECTION_FIELDS.map((field) => [
    field,
    !present(current[field]) && present(incoming[field]) ? incoming[field] : current[field],
  ]));
  return {
    attached: DIRECTION_FIELDS.some(
      (field) => !present(current[field]) && present(incoming[field]),
    ),
    values,
  };
}

function recognitionPlan(current, incoming = {}) {
  const values = Object.fromEntries(RECOGNITION_FIELDS.map((field) => [
    field,
    !present(current[field]) && present(incoming[field]) ? incoming[field] : current[field],
  ]));
  return {
    attached: RECOGNITION_FIELDS.some(
      (field) => !present(current[field]) && present(incoming[field]),
    ),
    values,
  };
}

function overviewCanQueue(current, next, vehicleOverview = {}) {
  const incomingIsPending = vehicleOverview.status === "pending"
    && vehicleOverview.queueKind === "overview"
    && vehicleOverview.retryable === true;
  if (!incomingIsPending || next.bi_trigger_direction_status !== "ready" || !next.image_path) {
    return false;
  }
  if (
    current.vehicle_image_path
    || present(current.vehicle_image_queue_kind)
    || current.vehicle_image_claim_token
    || current.vehicle_image_next_attempt_at
    || current.vehicle_image_heartbeat_at
    || current.vehicle_image_processing_deadline_at
    || current.vehicle_image_hard_deadline_at
    || current.vehicle_image_backfill_job_id
    || Number(current.vehicle_image_attempt_count || 0) !== 0
  ) return false;
  if (!present(current.vehicle_image_status)) {
    return !present(current.vehicle_image_error_code);
  }
  return current.vehicle_image_status === "unavailable"
    && current.vehicle_image_retryable === false
    && REQUEUEABLE_OVERVIEW_ERRORS.has(current.vehicle_image_error_code);
}

export function buildLateDuplicateReconciliationPlan(current = {}, incoming = {}) {
  const imageAttached = !present(current.image_path)
    && !present(current.thumbnail_path)
    && present(incoming.imagePath)
    && present(incoming.thumbnailPath);
  const alert = alertPlan(current, incoming.alert);
  const direction = directionPlan(current, incoming.direction);
  const recognition = recognitionPlan(current, incoming.recognition);
  const next = {
    ...current,
    image_path: imageAttached ? incoming.imagePath : current.image_path,
    thumbnail_path: imageAttached ? incoming.thumbnailPath : current.thumbnail_path,
    ...alert.values,
    ...direction.values,
    ...recognition.values,
  };
  const overviewQueued = overviewCanQueue(current, next, incoming.vehicleOverview);
  if (overviewQueued) {
    next.vehicle_image_status = "pending";
    next.vehicle_image_queue_kind = "overview";
    next.vehicle_image_retryable = true;
    next.vehicle_image_error_code = "WAITING_FOR_DAYTIME_OVERVIEW";
  }
  return {
    changed: imageAttached
      || alert.attached
      || direction.attached
      || recognition.attached
      || overviewQueued,
    imageAttached,
    alertPointerAttached: alert.attached,
    directionAttached: direction.attached,
    recognitionAttached: recognition.attached,
    overviewQueued,
    next,
  };
}

const TARGET_FIELDS = `
  id, plate_number, observed_plate, camera_name, timestamp,
  image_path, thumbnail_path,
  bi_path, bi_alert_clip, bi_alert_path, bi_alert_offset_ms,
  confidence, crop_coordinates, ocr_annotation, plate_annotation,
  bi_trigger_type, bi_trigger_direction_status, bi_trigger_direction_label,
  bi_trigger_direction_profile_version, bi_trigger_direction_algorithm,
  bi_trigger_direction_error_code,
  vehicle_image_status, vehicle_image_path, vehicle_image_queue_kind,
  vehicle_image_attempt_count, vehicle_image_retryable, vehicle_image_error_code,
  vehicle_image_claim_token, vehicle_image_next_attempt_at,
  vehicle_image_heartbeat_at, vehicle_image_processing_deadline_at,
  vehicle_image_hard_deadline_at, vehicle_image_backfill_job_id,
  vehicle_image_updated_at`;

export async function reconcileLateDuplicateRead(query, input = {}) {
  if (typeof query !== "function") {
    throw new TypeError("Late duplicate reconciliation requires a query function");
  }
  const readId = Number(input.readId);
  if (!Number.isSafeInteger(readId) || readId < 1) {
    throw new TypeError("Late duplicate reconciliation requires a positive read ID");
  }
  const currentResult = await query(
    `SELECT ${TARGET_FIELDS}
     FROM public.plate_reads
     WHERE id = $1::integer
     FOR UPDATE`,
    [readId],
  );
  const current = currentResult.rows?.[0] || null;
  if (!current) return { found: false, changed: false, readId };

  const plan = buildLateDuplicateReconciliationPlan(current, input);
  if (!plan.changed) return { found: true, ...plan, readId, read: current };

  const updated = await query(
    `UPDATE public.plate_reads
     SET image_path = CASE WHEN $2::boolean THEN $3::text ELSE image_path END,
         thumbnail_path = CASE WHEN $2::boolean THEN $4::text ELSE thumbnail_path END,
         bi_path = CASE WHEN $5::boolean THEN $6::text ELSE bi_path END,
         bi_alert_clip = CASE WHEN $5::boolean THEN $7::text ELSE bi_alert_clip END,
         bi_alert_path = CASE WHEN $5::boolean THEN $8::text ELSE bi_alert_path END,
         bi_alert_offset_ms = CASE WHEN $5::boolean THEN $9::bigint ELSE bi_alert_offset_ms END,
         confidence = CASE WHEN $10::boolean THEN $11::decimal ELSE confidence END,
         crop_coordinates = CASE WHEN $12::boolean THEN $13::integer[] ELSE crop_coordinates END,
         ocr_annotation = CASE WHEN $14::boolean THEN $15::jsonb ELSE ocr_annotation END,
         plate_annotation = CASE WHEN $16::boolean THEN $17::varchar ELSE plate_annotation END,
         bi_trigger_type = CASE WHEN $18::boolean THEN $19::varchar ELSE bi_trigger_type END,
         bi_trigger_direction_status = CASE WHEN $18::boolean THEN $20::varchar ELSE bi_trigger_direction_status END,
         bi_trigger_direction_label = CASE WHEN $18::boolean THEN $21::varchar ELSE bi_trigger_direction_label END,
         bi_trigger_direction_profile_version = CASE WHEN $18::boolean THEN $22::integer ELSE bi_trigger_direction_profile_version END,
         bi_trigger_direction_algorithm = CASE WHEN $18::boolean THEN $23::varchar ELSE bi_trigger_direction_algorithm END,
         bi_trigger_direction_error_code = CASE WHEN $18::boolean THEN $24::varchar ELSE bi_trigger_direction_error_code END,
         vehicle_image_status = CASE WHEN $25::boolean THEN 'pending' ELSE vehicle_image_status END,
         vehicle_image_queue_kind = CASE WHEN $25::boolean THEN 'overview' ELSE vehicle_image_queue_kind END,
         vehicle_image_retryable = CASE WHEN $25::boolean THEN TRUE ELSE vehicle_image_retryable END,
         vehicle_image_error_code = CASE WHEN $25::boolean THEN 'WAITING_FOR_DAYTIME_OVERVIEW' ELSE vehicle_image_error_code END,
         vehicle_image_updated_at = CASE WHEN $25::boolean THEN CURRENT_TIMESTAMP ELSE vehicle_image_updated_at END
     WHERE id = $1::integer
     RETURNING ${TARGET_FIELDS}`,
    [
      readId,
      plan.imageAttached,
      plan.next.image_path,
      plan.next.thumbnail_path,
      plan.alertPointerAttached,
      plan.next.bi_path,
      plan.next.bi_alert_clip,
      plan.next.bi_alert_path,
      plan.next.bi_alert_offset_ms,
      !present(current.confidence) && present(plan.next.confidence),
      plan.next.confidence,
      !present(current.crop_coordinates) && present(plan.next.crop_coordinates),
      plan.next.crop_coordinates,
      !present(current.ocr_annotation) && present(plan.next.ocr_annotation),
      present(plan.next.ocr_annotation) ? JSON.stringify(plan.next.ocr_annotation) : null,
      !present(current.plate_annotation) && present(plan.next.plate_annotation),
      plan.next.plate_annotation,
      plan.directionAttached,
      plan.next.bi_trigger_type,
      plan.next.bi_trigger_direction_status,
      plan.next.bi_trigger_direction_label,
      plan.next.bi_trigger_direction_profile_version,
      plan.next.bi_trigger_direction_algorithm,
      plan.next.bi_trigger_direction_error_code,
      plan.overviewQueued,
    ],
  );
  const read = updated.rows?.[0];
  if (!read) throw new Error("Late duplicate reconciliation lost its locked read");
  return { found: true, ...plan, readId, read };
}

export const lateDuplicateReconciliationInternals = Object.freeze({
  alertPlan,
  completeDirectionBundle,
  directionPlan,
  overviewCanQueue,
  present,
  recognitionPlan,
  incomingMatchesEstablished,
});
