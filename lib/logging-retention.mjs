import { createHash, randomBytes } from "node:crypto";

export const LOGGING_RETENTION_CONFIRMATION = "ARCHIVE LOG EVIDENCE";
export const LOGGING_RETENTION_PREVIEW_TTL_MS = 15 * 60 * 1000;
export const LOGGING_RETENTION_BATCH_PER_CATEGORY = 500;
export const LOGGING_INCIDENT_MAX_ENTRIES_PER_CATEGORY = 2_000;
export const LOGGING_INCIDENT_MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedText(value, maximum) {
  return String(value ?? "").trim().slice(0, maximum);
}

function positiveId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function count(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function actorId(actor) {
  const id = positiveId(actor?.id);
  if (!id) throw new TypeError("An authenticated actor is required");
  return id;
}

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableSnapshotHash(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function sameIds(actual, expected) {
  const left = [...actual].map(Number).sort((a, b) => a - b);
  const right = [...expected].map(Number).sort((a, b) => a - b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeLoggingRetentionPolicy(env = process.env) {
  return {
    receiptRetentionDays: boundedInteger(
      env.ALPR_INGRESS_RECEIPT_RETENTION_DAYS,
      14,
      1,
      365,
    ),
    receiptMaximumRows: boundedInteger(
      env.ALPR_INGRESS_RECEIPT_MAX_ROWS,
      25_000,
      1_000,
      1_000_000,
    ),
    auditHotRetentionDays: boundedInteger(
      env.ALPR_AUDIT_HOT_RETENTION_DAYS,
      90,
      30,
      3_650,
    ),
    scheduledExecutionEnabled: false,
    batchPerCategory: LOGGING_RETENTION_BATCH_PER_CATEGORY,
  };
}

export function normalizeLoggingIncidentInput(input = {}, now = new Date()) {
  const name = boundedText(input.name, 120);
  if (!name) throw new TypeError("Incident name is required");

  const description = boundedText(input.description, 1_000) || null;
  const scopeType = boundedText(input.scopeType, 16).toLowerCase();
  const protectionDays = boundedInteger(input.protectionDays, 30, 1, 3_650);
  const protectedUntil = new Date(now.getTime() + protectionDays * 86_400_000);

  if (scopeType === "request") {
    const requestId = boundedText(input.requestId, 128);
    if (!requestId) throw new TypeError("Request ID is required for request incidents");
    return {
      name,
      description,
      scopeType,
      requestId,
      readId: null,
      windowStart: null,
      windowEnd: null,
      protectionDays,
      protectedUntil: protectedUntil.toISOString(),
    };
  }

  if (scopeType === "read") {
    const readId = positiveId(input.readId);
    if (!readId) throw new TypeError("A positive read ID is required for read incidents");
    return {
      name,
      description,
      scopeType,
      requestId: null,
      readId,
      windowStart: null,
      windowEnd: null,
      protectionDays,
      protectedUntil: protectedUntil.toISOString(),
    };
  }

  if (scopeType === "window") {
    const windowStart = isoDate(input.windowStart);
    const windowEnd = isoDate(input.windowEnd);
    if (!windowStart || !windowEnd || new Date(windowStart) >= new Date(windowEnd)) {
      throw new TypeError("A valid incident time window is required");
    }
    if (new Date(windowEnd).getTime() - new Date(windowStart).getTime() > 7 * 86_400_000) {
      throw new TypeError("Incident time windows cannot exceed seven days");
    }
    return {
      name,
      description,
      scopeType,
      requestId: null,
      readId: null,
      windowStart,
      windowEnd,
      protectionDays,
      protectedUntil: protectedUntil.toISOString(),
    };
  }

  throw new TypeError("Incident scope must be request, read, or window");
}

export function operationalFiltersForIncident(scope) {
  if (scope.scopeType === "request") return { requestId: scope.requestId };
  if (scope.scopeType === "read") return { readId: String(scope.readId) };
  return { startAt: scope.windowStart, endAt: scope.windowEnd };
}

function incidentWhere(scope, table) {
  if (scope.scopeType === "request") {
    return { clause: "request_id = $1::text", values: [scope.requestId] };
  }
  if (scope.scopeType === "read") {
    if (table === "receipts") {
      return {
        clause: "($1::bigint = ANY(processed_read_ids) OR $1::bigint = ANY(duplicate_target_read_ids))",
        values: [scope.readId],
      };
    }
    if (table === "pipeline") {
      return { clause: "read_id = $1::integer", values: [scope.readId] };
    }
    return {
      clause: "((resource_type IN ('plate_read','read') AND resource_id = $1::text) OR metadata->>'readId' = $1::text)",
      values: [String(scope.readId)],
    };
  }
  const column = table === "receipts" ? "received_at" : "occurred_at";
  return {
    clause: `${column} >= $1::timestamptz AND ${column} <= $2::timestamptz`,
    values: [scope.windowStart, scope.windowEnd],
  };
}

async function snapshotRows(query, scope, table) {
  const where = incidentWhere(scope, table);
  const limitParameter = where.values.length + 1;
  if (table === "receipts") {
    const result = await query(
      `SELECT id, request_id, integration, route_name, method, content_type,
              body_bytes, body_sha256, payload_keys, unknown_payload_key_count,
              camera_name, event_timestamp_text, trigger_field, trigger_present,
              trigger_value_state, trigger_type, receipt_schema_version,
              trigger_alias_fields, trigger_alias_conflict,
              trigger_alias_distinct_value_count, heavy_fields, state,
              received_at, completed_at, duration_ms, http_status, outcome,
              error_code, processed_read_ids, duplicate_target_read_ids,
              processed_count, duplicate_count, ignored_count,
              overview_work_queued, COUNT(*) OVER()::bigint AS incident_match_count
       FROM public.integration_ingress_receipts
       WHERE ${where.clause}
       ORDER BY received_at, id
       LIMIT $${limitParameter}::integer`,
      [...where.values, LOGGING_INCIDENT_MAX_ENTRIES_PER_CATEGORY],
    );
    return normalizeSnapshotResult(result);
  }
  if (table === "pipeline") {
    const result = await query(
      `SELECT id, read_id, request_id, ingress_receipt_id, stage, event_type,
              status, component, details, occurred_at,
              COUNT(*) OVER()::bigint AS incident_match_count
       FROM public.plate_read_pipeline_events
       WHERE ${where.clause}
       ORDER BY occurred_at, id
       LIMIT $${limitParameter}::integer`,
      [...where.values, LOGGING_INCIDENT_MAX_ENTRIES_PER_CATEGORY],
    );
    return normalizeSnapshotResult(result);
  }
  const archived = table === "auditArchive";
  const result = await query(
    `SELECT ${archived ? "source_event_id" : "id"}, actor_user_id,
            actor_api_credential_id, source, event_type, resource_type,
            resource_id, outcome, reason, request_id, metadata, occurred_at,
            COUNT(*) OVER()::bigint AS incident_match_count
     FROM public.${archived ? "audit_event_archive" : "audit_events"}
     WHERE ${where.clause}
     ORDER BY occurred_at, ${archived ? "source_event_id" : "id"}
     LIMIT $${limitParameter}::integer`,
    [...where.values, LOGGING_INCIDENT_MAX_ENTRIES_PER_CATEGORY],
  );
  return normalizeSnapshotResult(result);
}

function normalizeSnapshotResult(result) {
  const resultRows = result.rows || [];
  const matchedCount = count(resultRows[0]?.incident_match_count);
  return {
    matchedCount,
    rows: resultRows.map(({ incident_match_count: _matchedCount, ...row }) => row),
  };
}

function boundedIncidentEvidence(groups, matchedCounts) {
  const names = Object.keys(groups);
  const retained = Object.fromEntries(names.map((name) => [name, []]));
  const indexes = Object.fromEntries(names.map((name) => [name, 0]));
  let bytes = Buffer.byteLength(JSON.stringify(retained));

  while (true) {
    let added = false;
    for (const name of names) {
      const row = groups[name][indexes[name]];
      if (row === undefined) continue;
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + rowBytes > LOGGING_INCIDENT_MAX_SNAPSHOT_BYTES) continue;
      retained[name].push(row);
      indexes[name] += 1;
      bytes += rowBytes;
      added = true;
    }
    if (!added) break;
  }

  return {
    retained,
    truncatedCounts: Object.fromEntries(
      names.map((name) => [
        name,
        Math.max(0, count(matchedCounts[name]) - retained[name].length),
      ]),
    ),
  };
}

export async function createLoggingIncident({
  executor,
  actor,
  input,
  operationalEntries = [],
  now = new Date(),
} = {}) {
  if (!executor || typeof executor.connect !== "function") {
    throw new TypeError("Logging incident creation requires a transactional executor");
  }
  const normalized = normalizeLoggingIncidentInput(input, now);
  const client = await executor.connect();
  try {
    await client.query("BEGIN");
    const [receiptSnapshot, pipelineSnapshot, auditSnapshot, archivedAuditSnapshot] = await Promise.all([
      snapshotRows((text, values) => client.query(text, values), normalized, "receipts"),
      snapshotRows((text, values) => client.query(text, values), normalized, "pipeline"),
      snapshotRows((text, values) => client.query(text, values), normalized, "audit"),
      snapshotRows((text, values) => client.query(text, values), normalized, "auditArchive"),
    ]);
    const safeOperationalEntries = Array.isArray(operationalEntries)
      ? operationalEntries.slice(0, LOGGING_INCIDENT_MAX_ENTRIES_PER_CATEGORY)
      : [];
    const evidenceGroups = {
      operationalEntries: safeOperationalEntries,
      ingressReceipts: receiptSnapshot.rows,
      pipelineEvents: pipelineSnapshot.rows,
      auditEvents: auditSnapshot.rows,
      archivedAuditEvents: archivedAuditSnapshot.rows,
    };
    const evidence = boundedIncidentEvidence(evidenceGroups, {
      operationalEntries: safeOperationalEntries.length,
      ingressReceipts: receiptSnapshot.matchedCount,
      pipelineEvents: pipelineSnapshot.matchedCount,
      auditEvents: auditSnapshot.matchedCount,
      archivedAuditEvents: archivedAuditSnapshot.matchedCount,
    });
    const snapshot = {
      schemaVersion: 1,
      createdAt: now.toISOString(),
      scope: {
        type: normalized.scopeType,
        requestId: normalized.requestId,
        readId: normalized.readId,
        windowStart: normalized.windowStart,
        windowEnd: normalized.windowEnd,
      },
      ...evidence.retained,
      truncatedCounts: evidence.truncatedCounts,
    };
    const evidenceCounts = Object.fromEntries(
      Object.entries(evidence.retained).map(([name, rows]) => [name, rows.length]),
    );
    const digest = stableSnapshotHash(snapshot);
    const inserted = await client.query(
      `INSERT INTO public.logging_incidents (
         name, description, scope_type, request_id, read_id, window_start,
         window_end, protected_until, snapshot, snapshot_sha256,
         evidence_counts, created_by_user_id, created_at
       ) VALUES (
         $1::text, $2::text, $3::text, $4::text, $5::integer, $6::timestamptz,
         $7::timestamptz, $8::timestamptz, $9::jsonb, $10::text,
         $11::jsonb, $12::bigint, $13::timestamptz
       ) RETURNING id, created_at`,
      [
        normalized.name,
        normalized.description,
        normalized.scopeType,
        normalized.requestId,
        normalized.readId,
        normalized.windowStart,
        normalized.windowEnd,
        normalized.protectedUntil,
        JSON.stringify(snapshot),
        digest,
        JSON.stringify(evidenceCounts),
        actorId(actor),
        now,
      ],
    );
    const incidentId = Number(inserted.rows[0].id);
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata, occurred_at
       ) VALUES (
         $1::bigint, 'browser', 'logging.incident_created', 'logging_incident',
         $2::text, 'succeeded', $3::jsonb, $4::timestamptz
       )`,
      [
        actorId(actor),
        String(incidentId),
        JSON.stringify({
          scopeType: normalized.scopeType,
          protectedUntil: normalized.protectedUntil,
          evidenceCounts,
          snapshotSha256: digest,
        }),
        now,
      ],
    );
    await client.query("COMMIT");
    return {
      id: incidentId,
      createdAt: isoDate(inserted.rows[0].created_at),
      protectedUntil: normalized.protectedUntil,
      snapshotSha256: digest,
      evidenceCounts,
      truncatedCounts: evidence.truncatedCounts,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const ACTIVE_RECEIPT_PROTECTION_SQL = `NOT EXISTS (
  SELECT 1 FROM public.logging_incidents incident
  WHERE incident.protected_until > $4::timestamptz
    AND (
      (incident.scope_type = 'request' AND incident.request_id = receipt.request_id)
      OR (incident.scope_type = 'read' AND (
        incident.read_id = ANY(receipt.processed_read_ids)
        OR incident.read_id = ANY(receipt.duplicate_target_read_ids)
      ))
      OR (incident.scope_type = 'window'
        AND receipt.received_at BETWEEN incident.window_start AND incident.window_end)
    )
)`;

const ACTIVE_AUDIT_PROTECTION_SQL = `NOT EXISTS (
  SELECT 1 FROM public.logging_incidents incident
  WHERE incident.protected_until > $4::timestamptz
    AND (
      (incident.scope_type = 'request' AND incident.request_id = audit.request_id)
      OR (incident.scope_type = 'read' AND (
        (audit.resource_type IN ('plate_read','read') AND audit.resource_id = incident.read_id::text)
        OR audit.metadata->>'readId' = incident.read_id::text
      ))
      OR (incident.scope_type = 'window'
        AND audit.occurred_at BETWEEN incident.window_start AND incident.window_end)
    )
)`;

export const LOGGING_RETENTION_OVERVIEW_SQL = `
WITH receipt_ranked AS (
  SELECT receipt.*,
         row_number() OVER (ORDER BY receipt.received_at DESC, receipt.id DESC) AS retention_rank
  FROM public.integration_ingress_receipts receipt
), receipt_candidates AS (
  SELECT receipt.id
  FROM receipt_ranked receipt
  WHERE (receipt.received_at < $1::timestamptz OR receipt.retention_rank > $3::integer)
    AND ${ACTIVE_RECEIPT_PROTECTION_SQL}
), audit_candidates AS (
  SELECT audit.id
  FROM public.audit_events audit
  WHERE audit.occurred_at < $2::timestamptz
    AND ${ACTIVE_AUDIT_PROTECTION_SQL}
)
SELECT
  (SELECT COUNT(*)::bigint FROM public.integration_ingress_receipts) AS receipt_count,
  (SELECT MIN(received_at) FROM public.integration_ingress_receipts) AS receipt_oldest,
  (SELECT MAX(received_at) FROM public.integration_ingress_receipts) AS receipt_newest,
  pg_total_relation_size('public.integration_ingress_receipts')::bigint AS receipt_bytes,
  (SELECT COUNT(*)::bigint FROM receipt_candidates) AS receipt_candidate_count,
  (SELECT COUNT(*)::bigint FROM public.plate_read_pipeline_events) AS pipeline_count,
  (SELECT MIN(occurred_at) FROM public.plate_read_pipeline_events) AS pipeline_oldest,
  (SELECT MAX(occurred_at) FROM public.plate_read_pipeline_events) AS pipeline_newest,
  pg_total_relation_size('public.plate_read_pipeline_events')::bigint AS pipeline_bytes,
  (SELECT COUNT(*)::bigint FROM public.audit_events) AS audit_hot_count,
  (SELECT MIN(occurred_at) FROM public.audit_events) AS audit_hot_oldest,
  (SELECT MAX(occurred_at) FROM public.audit_events) AS audit_hot_newest,
  pg_total_relation_size('public.audit_events')::bigint AS audit_hot_bytes,
  (SELECT COUNT(*)::bigint FROM audit_candidates) AS audit_candidate_count,
  (SELECT COUNT(*)::bigint FROM public.audit_event_archive) AS audit_archive_count,
  pg_total_relation_size('public.audit_event_archive')::bigint AS audit_archive_bytes,
  (SELECT COUNT(*)::bigint FROM public.logging_incidents) AS incident_count,
  (SELECT COUNT(*)::bigint FROM public.logging_incidents
    WHERE protected_until > $4::timestamptz) AS active_incident_count`;

function incidentFromRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || "",
    scopeType: row.scope_type,
    requestId: row.request_id || "",
    readId: row.read_id == null ? null : Number(row.read_id),
    windowStart: isoDate(row.window_start),
    windowEnd: isoDate(row.window_end),
    protectedUntil: isoDate(row.protected_until),
    snapshotSha256: row.snapshot_sha256,
    evidenceCounts: row.evidence_counts || {},
    truncatedCounts: row.truncated_counts || row.snapshot?.truncatedCounts || {},
    createdAt: isoDate(row.created_at),
  };
}

export async function getLoggingRetentionOverview({
  query,
  env = process.env,
  logMetadata = {},
  now = new Date(),
} = {}) {
  if (typeof query !== "function") {
    throw new TypeError("Logging retention overview requires a query function");
  }
  const policy = normalizeLoggingRetentionPolicy(env);
  const receiptCutoff = new Date(now.getTime() - policy.receiptRetentionDays * 86_400_000);
  const auditCutoff = new Date(now.getTime() - policy.auditHotRetentionDays * 86_400_000);
  const [summaryResult, incidentsResult, previewsResult] = await Promise.all([
    query(LOGGING_RETENTION_OVERVIEW_SQL, [
      receiptCutoff,
      auditCutoff,
      policy.receiptMaximumRows,
      now,
    ]),
    query(
      `SELECT id, name, description, scope_type, request_id, read_id,
              window_start, window_end, protected_until, snapshot_sha256,
              evidence_counts, snapshot->'truncatedCounts' AS truncated_counts,
              created_at
       FROM public.logging_incidents
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
    ),
    query(
      `SELECT id, status, policy, candidate_count, candidate_bytes,
              expires_at, created_at, executed_at, result
       FROM public.logging_retention_previews
       ORDER BY created_at DESC, id DESC
       LIMIT 10`,
    ),
  ]);
  const row = summaryResult.rows?.[0] || {};
  return {
    measuredAt: now.toISOString(),
    policy,
    operationalLog: {
      activeBytes: count(logMetadata.activeBytes),
      activeMaximumBytes: count(logMetadata.activeMaximumBytes),
      maximumFiles: count(logMetadata.maximumFiles),
      configuredMaximumBytes:
        count(logMetadata.activeMaximumBytes) * count(logMetadata.maximumFiles),
      oldestTimestamp: isoDate(logMetadata.oldestTimestamp),
      newestTimestamp: isoDate(logMetadata.newestTimestamp),
    },
    receipts: {
      count: count(row.receipt_count),
      bytes: count(row.receipt_bytes),
      oldest: isoDate(row.receipt_oldest),
      newest: isoDate(row.receipt_newest),
      candidateCount: count(row.receipt_candidate_count),
    },
    pipeline: {
      count: count(row.pipeline_count),
      bytes: count(row.pipeline_bytes),
      oldest: isoDate(row.pipeline_oldest),
      newest: isoDate(row.pipeline_newest),
      retention: "parent-read lifecycle",
    },
    audit: {
      hotCount: count(row.audit_hot_count),
      hotBytes: count(row.audit_hot_bytes),
      hotOldest: isoDate(row.audit_hot_oldest),
      hotNewest: isoDate(row.audit_hot_newest),
      candidateCount: count(row.audit_candidate_count),
      archiveCount: count(row.audit_archive_count),
      archiveBytes: count(row.audit_archive_bytes),
    },
    incidents: (incidentsResult.rows || []).map(incidentFromRow),
    incidentCount: count(row.incident_count),
    activeIncidentCount: count(row.active_incident_count),
    previews: (previewsResult.rows || []).map((preview) => ({
      id: Number(preview.id),
      status: preview.status,
      policy: preview.policy || {},
      candidateCount: count(preview.candidate_count),
      candidateBytes: count(preview.candidate_bytes),
      expiresAt: isoDate(preview.expires_at),
      createdAt: isoDate(preview.created_at),
      executedAt: isoDate(preview.executed_at),
      result: preview.result || null,
    })),
  };
}

export const RECEIPT_PREVIEW_SQL = `
WITH ranked AS (
  SELECT receipt.*,
         row_number() OVER (ORDER BY receipt.received_at DESC, receipt.id DESC) AS retention_rank
  FROM public.integration_ingress_receipts receipt
)
SELECT receipt.id, pg_column_size(receipt)::bigint AS row_bytes
FROM ranked receipt
WHERE (receipt.received_at < $1::timestamptz OR receipt.retention_rank > $3::integer)
  AND ${ACTIVE_RECEIPT_PROTECTION_SQL}
ORDER BY receipt.received_at, receipt.id
LIMIT $5::integer`;

export const AUDIT_PREVIEW_SQL = `
SELECT audit.id, pg_column_size(audit)::bigint AS row_bytes
FROM public.audit_events audit
WHERE audit.occurred_at < $2::timestamptz
  AND ${ACTIVE_AUDIT_PROTECTION_SQL}
ORDER BY audit.occurred_at, audit.id
LIMIT $5::integer`;

export async function createLoggingRetentionPreview({
  query,
  actor,
  env = process.env,
  now = new Date(),
} = {}) {
  if (typeof query !== "function") {
    throw new TypeError("Logging retention preview requires a query function");
  }
  const policy = normalizeLoggingRetentionPolicy(env);
  const receiptCutoff = new Date(now.getTime() - policy.receiptRetentionDays * 86_400_000);
  const auditCutoff = new Date(now.getTime() - policy.auditHotRetentionDays * 86_400_000);
  const parameters = [
    receiptCutoff,
    auditCutoff,
    policy.receiptMaximumRows,
    now,
    LOGGING_RETENTION_BATCH_PER_CATEGORY,
  ];
  const [receiptsResult, auditsResult] = await Promise.all([
    query(RECEIPT_PREVIEW_SQL, parameters),
    query(AUDIT_PREVIEW_SQL, parameters),
  ]);
  const receiptIds = (receiptsResult.rows || []).map((row) => Number(row.id));
  const auditEventIds = (auditsResult.rows || []).map((row) => Number(row.id));
  const candidateBytes = [...(receiptsResult.rows || []), ...(auditsResult.rows || [])]
    .reduce((sum, row) => sum + count(row.row_bytes), 0);
  const candidateCount = receiptIds.length + auditEventIds.length;
  const previewToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + LOGGING_RETENTION_PREVIEW_TTL_MS);
  const policySnapshot = {
    ...policy,
    receiptCutoff: receiptCutoff.toISOString(),
    auditCutoff: auditCutoff.toISOString(),
  };
  const inserted = await query(
    `INSERT INTO public.logging_retention_previews (
       token_hash, actor_user_id, policy, receipt_ids, audit_event_ids,
       candidate_count, candidate_bytes, expires_at, created_at
     ) VALUES (
       $1::text, $2::bigint, $3::jsonb, $4::bigint[], $5::bigint[],
       $6::integer, $7::bigint, $8::timestamptz, $9::timestamptz
     ) RETURNING id`,
    [
      tokenHash(previewToken),
      actorId(actor),
      JSON.stringify(policySnapshot),
      receiptIds,
      auditEventIds,
      candidateCount,
      candidateBytes,
      expiresAt,
      now,
    ],
  );
  const previewId = Number(inserted.rows[0].id);
  await query(
    `INSERT INTO public.audit_events (
       actor_user_id, source, event_type, resource_type, resource_id,
       outcome, metadata, occurred_at
     ) VALUES (
       $1::bigint, 'browser', 'logging.retention_previewed',
       'logging_retention_preview', $2::text, 'succeeded', $3::jsonb,
       $4::timestamptz
     )`,
    [
      actorId(actor),
      String(previewId),
      JSON.stringify({ candidateCount, candidateBytes, policy: policySnapshot }),
      now,
    ],
  );
  return {
    id: previewId,
    previewToken,
    confirmationPhrase: LOGGING_RETENTION_CONFIRMATION,
    expiresAt: expiresAt.toISOString(),
    candidateCount,
    candidateBytes,
    receiptCount: receiptIds.length,
    auditEventCount: auditEventIds.length,
    receiptIds,
    auditEventIds,
    policy: policySnapshot,
  };
}

async function invalidatePreview(client, preview, now, reason) {
  await client.query(
    `UPDATE public.logging_retention_previews
     SET status = 'invalidated', executed_at = $2::timestamptz,
         result = $3::jsonb
     WHERE id = $1::bigint AND status = 'previewed'`,
    [preview.id, now, JSON.stringify({ reason })],
  );
}

export async function executeLoggingRetentionPreview({
  executor,
  actor,
  previewToken,
  confirmation,
  now = new Date(),
} = {}) {
  if (confirmation !== LOGGING_RETENTION_CONFIRMATION) {
    throw new TypeError(`Type ${LOGGING_RETENTION_CONFIRMATION} to archive log evidence`);
  }
  if (!executor || typeof executor.connect !== "function") {
    throw new TypeError("Logging retention execution requires a transactional executor");
  }
  const client = await executor.connect();
  let staleReason = "";
  try {
    await client.query("BEGIN");
    const previewResult = await client.query(
      `SELECT * FROM public.logging_retention_previews
       WHERE token_hash = $1::text AND actor_user_id = $2::bigint
       FOR UPDATE`,
      [tokenHash(previewToken), actorId(actor)],
    );
    const preview = previewResult.rows?.[0];
    if (!preview || preview.status !== "previewed") {
      throw new TypeError("Logging retention preview is invalid or has already been used");
    }
    if (new Date(preview.expires_at) <= now) {
      await invalidatePreview(client, preview, now, "expired");
      staleReason = "Logging retention preview has expired";
    }

    const policy = preview.policy || {};
    const parameters = [
      policy.receiptCutoff,
      policy.auditCutoff,
      policy.receiptMaximumRows,
      now,
      LOGGING_RETENTION_BATCH_PER_CATEGORY,
    ];
    if (!staleReason) {
      const [receiptCheck, auditCheck] = await Promise.all([
        client.query(RECEIPT_PREVIEW_SQL, parameters),
        client.query(AUDIT_PREVIEW_SQL, parameters),
      ]);
      const currentReceiptIds = (receiptCheck.rows || []).map((row) => Number(row.id));
      const currentAuditIds = (auditCheck.rows || []).map((row) => Number(row.id));
      if (!sameIds(currentReceiptIds, preview.receipt_ids || [])
          || !sameIds(currentAuditIds, preview.audit_event_ids || [])) {
        await invalidatePreview(client, preview, now, "candidate-set-changed");
        staleReason = "Logging retention candidates changed; create a new preview";
      }
    }

    if (staleReason) {
      await client.query("COMMIT");
      throw Object.assign(new TypeError(staleReason), { committed: true });
    }

    const auditIds = (preview.audit_event_ids || []).map(Number);
    const receiptIds = (preview.receipt_ids || []).map(Number);
    if (auditIds.length) {
      const lockedAudits = await client.query(
        `SELECT id FROM public.audit_events
         WHERE id = ANY($1::bigint[])
         ORDER BY id
         FOR UPDATE`,
        [auditIds],
      );
      if ((lockedAudits.rowCount || 0) !== auditIds.length) {
        throw new Error("Audit candidate locking verification failed");
      }
    }
    if (receiptIds.length) {
      const lockedReceipts = await client.query(
        `SELECT id FROM public.integration_ingress_receipts
         WHERE id = ANY($1::bigint[])
         ORDER BY id
         FOR UPDATE`,
        [receiptIds],
      );
      if ((lockedReceipts.rowCount || 0) !== receiptIds.length) {
        throw new Error("Ingress receipt candidate locking verification failed");
      }
    }
    let archivedAuditCount = 0;
    if (auditIds.length) {
      const archived = await client.query(
        `INSERT INTO public.audit_event_archive (
           source_event_id, actor_user_id, actor_api_credential_id, source,
           event_type, resource_type, resource_id, outcome, reason, request_id,
           metadata, occurred_at, archived_at, retention_preview_id
         )
         SELECT id, actor_user_id, actor_api_credential_id, source, event_type,
                resource_type, resource_id, outcome, reason, request_id,
                metadata, occurred_at, $2::timestamptz, $3::bigint
         FROM public.audit_events
         WHERE id = ANY($1::bigint[])
         ON CONFLICT (source_event_id, occurred_at) DO NOTHING
         RETURNING source_event_id`,
        [auditIds, now, preview.id],
      );
      archivedAuditCount = archived.rowCount || 0;
      const archivedCheck = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM public.audit_event_archive
         WHERE source_event_id = ANY($1::bigint[])`,
        [auditIds],
      );
      if (count(archivedCheck.rows?.[0]?.count) !== auditIds.length) {
        throw new Error("Audit archive verification failed");
      }
      const deletedAudit = await client.query(
        `DELETE FROM public.audit_events WHERE id = ANY($1::bigint[])
         RETURNING id`,
        [auditIds],
      );
      if ((deletedAudit.rowCount || 0) !== auditIds.length) {
        throw new Error("Audit hot-table release verification failed");
      }
    }

    let deletedReceiptCount = 0;
    if (receiptIds.length) {
      const deletedReceipts = await client.query(
        `DELETE FROM public.integration_ingress_receipts
         WHERE id = ANY($1::bigint[])
         RETURNING id`,
        [receiptIds],
      );
      deletedReceiptCount = deletedReceipts.rowCount || 0;
      if (deletedReceiptCount !== receiptIds.length) {
        throw new Error("Ingress receipt cleanup verification failed");
      }
    }

    const result = {
      archivedAuditCount: auditIds.length,
      newlyArchivedAuditCount: archivedAuditCount,
      deletedReceiptCount,
      candidateCount: auditIds.length + receiptIds.length,
      candidateBytes: count(preview.candidate_bytes),
    };
    await client.query(
      `UPDATE public.logging_retention_previews
       SET status = 'executed', executed_at = $2::timestamptz,
           result = $3::jsonb
       WHERE id = $1::bigint AND status = 'previewed'`,
      [preview.id, now, JSON.stringify(result)],
    );
    await client.query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata, occurred_at
       ) VALUES (
         $1::bigint, 'browser', 'logging.retention_executed',
         'logging_retention_preview', $2::text, 'succeeded', $3::jsonb,
         $4::timestamptz
       )`,
      [actorId(actor), String(preview.id), JSON.stringify(result), now],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (!error?.committed) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getLoggingIncidentExport(query, incidentId) {
  if (typeof query !== "function") {
    throw new TypeError("Logging incident export requires a query function");
  }
  const id = positiveId(incidentId);
  if (!id) return null;
  const result = await query(
    `SELECT id, name, description, scope_type, request_id, read_id,
            window_start, window_end, protected_until, snapshot_schema_version,
            snapshot, snapshot_sha256, evidence_counts, created_at
     FROM public.logging_incidents
     WHERE id = $1::bigint`,
    [id],
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    incident: incidentFromRow(row),
    schemaVersion: Number(row.snapshot_schema_version),
    snapshot: row.snapshot,
  };
}
