import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUDIT_PREVIEW_SQL,
  LOGGING_INCIDENT_MAX_SNAPSHOT_BYTES,
  LOGGING_RETENTION_CONFIRMATION,
  LOGGING_RETENTION_OVERVIEW_SQL,
  RECEIPT_PREVIEW_SQL,
  createLoggingIncident,
  createLoggingRetentionPreview,
  executeLoggingRetentionPreview,
  getLoggingRetentionOverview,
  normalizeLoggingIncidentInput,
  normalizeLoggingRetentionPolicy,
  operationalFiltersForIncident,
} from "../lib/logging-retention.mjs";

test("empty retention categories do not report the Unix epoch as their oldest row", async () => {
  const overview = await getLoggingRetentionOverview({
    query: async (text) => {
      if (text === LOGGING_RETENTION_OVERVIEW_SQL) {
        return {
          rows: [{
            receipt_count: 0,
            receipt_oldest: null,
            receipt_newest: null,
            pipeline_count: 0,
            pipeline_oldest: null,
            pipeline_newest: null,
            audit_hot_count: 0,
            audit_hot_oldest: null,
            audit_hot_newest: null,
          }],
        };
      }
      return { rows: [] };
    },
    now: new Date("2026-08-14T12:00:00.000Z"),
  });

  assert.equal(overview.receipts.oldest, null);
  assert.equal(overview.receipts.newest, null);
  assert.equal(overview.pipeline.oldest, null);
  assert.equal(overview.pipeline.newest, null);
  assert.equal(overview.audit.hotOldest, null);
  assert.equal(overview.audit.hotNewest, null);
});

function transactionalExecutor(handler) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return handler(text, values, calls);
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    client,
    executor: { async connect() { return client; } },
    get released() { return released; },
  };
}

test("retention policy is bounded and can never schedule execution", () => {
  assert.deepEqual(normalizeLoggingRetentionPolicy({}), {
    receiptRetentionDays: 14,
    receiptMaximumRows: 25_000,
    auditHotRetentionDays: 90,
    scheduledExecutionEnabled: false,
    batchPerCategory: 500,
  });
  assert.deepEqual(normalizeLoggingRetentionPolicy({
    ALPR_INGRESS_RECEIPT_RETENTION_DAYS: "9999",
    ALPR_INGRESS_RECEIPT_MAX_ROWS: "1",
    ALPR_AUDIT_HOT_RETENTION_DAYS: "1",
    ALPR_LOGGING_RETENTION_SCHEDULED: "true",
  }), {
    receiptRetentionDays: 365,
    receiptMaximumRows: 1_000,
    auditHotRetentionDays: 30,
    scheduledExecutionEnabled: false,
    batchPerCategory: 500,
  });
});

test("incident scopes require one exact bounded selector", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const request = normalizeLoggingIncidentInput({
    name: "Camera outage",
    scopeType: "request",
    requestId: "request-1",
    protectionDays: 7,
  }, now);
  assert.deepEqual(operationalFiltersForIncident(request), { requestId: "request-1" });
  assert.equal(request.protectedUntil, "2026-08-21T12:00:00.000Z");

  const read = normalizeLoggingIncidentInput({
    name: "Read investigation",
    scopeType: "read",
    readId: 40829,
  }, now);
  assert.deepEqual(operationalFiltersForIncident(read), { readId: "40829" });

  assert.throws(() => normalizeLoggingIncidentInput({
    name: "Too broad",
    scopeType: "window",
    windowStart: "2026-08-01T00:00:00Z",
    windowEnd: "2026-08-09T00:00:01Z",
  }, now), /cannot exceed seven days/);
});

test("incident creation snapshots hot and archived evidence in one immutable digest", async () => {
  let insertedSnapshot;
  const harness = transactionalExecutor(async (text, values) => {
    if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
    if (/FROM public\.integration_ingress_receipts/.test(text)) {
      return { rows: [{ id: 1, request_id: "request-1" }] };
    }
    if (/FROM public\.plate_read_pipeline_events/.test(text)) {
      return { rows: [{ id: 2, request_id: "request-1" }] };
    }
    if (/FROM public\.audit_event_archive/.test(text)) {
      return { rows: [{ source_event_id: 3, request_id: "request-1" }] };
    }
    if (/FROM public\.audit_events/.test(text)) {
      return { rows: [{ id: 4, request_id: "request-1" }] };
    }
    if (/INSERT INTO public\.logging_incidents/.test(text)) {
      insertedSnapshot = JSON.parse(values[8]);
      return { rows: [{ id: 71, created_at: "2026-08-14T12:00:00.000Z" }] };
    }
    if (/INSERT INTO public\.audit_events/.test(text)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });

  const result = await createLoggingIncident({
    executor: harness.executor,
    actor: { id: 9 },
    input: {
      name: "Ingress investigation",
      scopeType: "request",
      requestId: "request-1",
    },
    operationalEntries: [{ id: "log-1", requestId: "request-1" }],
    now: new Date("2026-08-14T12:00:00.000Z"),
  });

  assert.equal(result.id, 71);
  assert.match(result.snapshotSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.evidenceCounts, {
    operationalEntries: 1,
    ingressReceipts: 1,
    pipelineEvents: 1,
    auditEvents: 1,
    archivedAuditEvents: 1,
  });
  assert.equal(insertedSnapshot.archivedAuditEvents[0].source_event_id, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(insertedSnapshot)) < LOGGING_INCIDENT_MAX_SNAPSHOT_BYTES + 4096);
  assert.equal(harness.released, true);
});

test("preview hashes its one-time token and binds exact candidate IDs", async () => {
  let previewInsert;
  const query = async (text, values) => {
    if (text === RECEIPT_PREVIEW_SQL) return { rows: [{ id: 11, row_bytes: "60" }] };
    if (text === AUDIT_PREVIEW_SQL) return { rows: [{ id: 21, row_bytes: "90" }] };
    if (/INSERT INTO public\.logging_retention_previews/.test(text)) {
      previewInsert = values;
      return { rows: [{ id: 51 }] };
    }
    if (/INSERT INTO public\.audit_events/.test(text)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  };

  const preview = await createLoggingRetentionPreview({
    query,
    actor: { id: 9 },
    now: new Date("2026-08-14T12:00:00.000Z"),
  });

  assert.equal(preview.id, 51);
  assert.equal(preview.candidateCount, 2);
  assert.equal(preview.candidateBytes, 150);
  assert.equal(preview.confirmationPhrase, LOGGING_RETENTION_CONFIRMATION);
  assert.deepEqual(preview.receiptIds, [11]);
  assert.deepEqual(preview.auditEventIds, [21]);
  assert.match(preview.previewToken, /^[0-9a-f]{64}$/);
  assert.match(previewInsert[0], /^[0-9a-f]{64}$/);
  assert.notEqual(previewInsert[0], preview.previewToken);
  assert.deepEqual(previewInsert[3], [11]);
  assert.deepEqual(previewInsert[4], [21]);
  assert.equal(JSON.parse(previewInsert[2]).scheduledExecutionEnabled, false);
});

test("execution revalidates, locks, archives, and deletes only the exact preview", async () => {
  const now = new Date("2026-08-14T12:05:00.000Z");
  const previewRow = {
    id: 51,
    status: "previewed",
    expires_at: "2026-08-14T12:15:00.000Z",
    receipt_ids: [11],
    audit_event_ids: [21],
    candidate_bytes: 150,
    policy: {
      receiptCutoff: "2026-07-31T12:00:00.000Z",
      auditCutoff: "2026-05-16T12:00:00.000Z",
      receiptMaximumRows: 25_000,
    },
  };
  const harness = transactionalExecutor(async (text) => {
    if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
    if (/SELECT \* FROM public\.logging_retention_previews/.test(text)) {
      return { rows: [previewRow] };
    }
    if (text === RECEIPT_PREVIEW_SQL) return { rows: [{ id: 11, row_bytes: 60 }] };
    if (text === AUDIT_PREVIEW_SQL) return { rows: [{ id: 21, row_bytes: 90 }] };
    if (/SELECT id FROM public\.audit_events/.test(text)) return { rowCount: 1, rows: [{ id: 21 }] };
    if (/SELECT id FROM public\.integration_ingress_receipts/.test(text)) return { rowCount: 1, rows: [{ id: 11 }] };
    if (/INSERT INTO public\.audit_event_archive/.test(text)) return { rowCount: 1, rows: [{ source_event_id: 21 }] };
    if (/SELECT COUNT\(\*\).*public\.audit_event_archive/s.test(text)) return { rows: [{ count: 1 }] };
    if (/DELETE FROM public\.audit_events/.test(text)) return { rowCount: 1, rows: [{ id: 21 }] };
    if (/DELETE FROM public\.integration_ingress_receipts/.test(text)) return { rowCount: 1, rows: [{ id: 11 }] };
    if (/UPDATE public\.logging_retention_previews/.test(text)) return { rowCount: 1, rows: [] };
    if (/INSERT INTO public\.audit_events/.test(text)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });

  const result = await executeLoggingRetentionPreview({
    executor: harness.executor,
    actor: { id: 9 },
    previewToken: "one-time-token",
    confirmation: LOGGING_RETENTION_CONFIRMATION,
    now,
  });

  assert.deepEqual(result, {
    archivedAuditCount: 1,
    newlyArchivedAuditCount: 1,
    deletedReceiptCount: 1,
    candidateCount: 2,
    candidateBytes: 150,
  });
  const joined = harness.calls.map((call) => call.text).join("\n");
  assert.match(joined, /FOR UPDATE/);
  assert.match(joined, /ON CONFLICT \(source_event_id, occurred_at\) DO NOTHING/);
  assert.ok(harness.calls.findIndex((call) => /INSERT INTO public\.audit_event_archive/.test(call.text))
    < harness.calls.findIndex((call) => /DELETE FROM public\.audit_events/.test(call.text)));
  assert.equal(harness.released, true);
});

test("changed candidates invalidate the preview without deleting evidence", async () => {
  const harness = transactionalExecutor(async (text) => {
    if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
    if (/SELECT \* FROM public\.logging_retention_previews/.test(text)) {
      return { rows: [{
        id: 51,
        status: "previewed",
        expires_at: "2026-08-14T12:15:00.000Z",
        receipt_ids: [11],
        audit_event_ids: [],
        policy: {
          receiptCutoff: "2026-07-31T12:00:00.000Z",
          auditCutoff: "2026-05-16T12:00:00.000Z",
          receiptMaximumRows: 25_000,
        },
      }] };
    }
    if (text === RECEIPT_PREVIEW_SQL) return { rows: [{ id: 12 }] };
    if (text === AUDIT_PREVIEW_SQL) return { rows: [] };
    if (/UPDATE public\.logging_retention_previews/.test(text)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });

  await assert.rejects(executeLoggingRetentionPreview({
    executor: harness.executor,
    actor: { id: 9 },
    previewToken: "one-time-token",
    confirmation: LOGGING_RETENTION_CONFIRMATION,
    now: new Date("2026-08-14T12:05:00.000Z"),
  }), /candidates changed/);
  assert.equal(harness.calls.some((call) => /^\s*DELETE FROM/.test(call.text)), false);
  assert.equal(harness.calls.at(-1).text, "COMMIT");
});

test("schema, UI, and Compose expose one default-off preservation workflow", async () => {
  const [migration, service, actions, page, panel, compose, dbOnly, external, env] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/logging-retention.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../app/logs/retention/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/logs/retention/LoggingRetentionPanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose-dbonly.yml", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.without-database.yml", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.logging_incidents/);
  assert.match(migration, /logging_incidents_append_only/);
  assert.match(migration, /PARTITION BY RANGE \(occurred_at\)/);
  assert.match(migration, /audit_event_archive_append_only/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.logging_retention_previews/);
  assert.match(migration, /2026081401_logging_retention_incidents/);
  assert.match(service, /scheduledExecutionEnabled: false/);
  assert.match(service, /Type \$\{LOGGING_RETENTION_CONFIRMATION\}/);
  assert.match(service, /actor_user_id = \$2::bigint/);
  assert.match(service, /FOR UPDATE/);
  assert.match(actions, /requirePermission\("maintenance\.manage"\)/);
  assert.match(page, /requirePagePermission\("system\.view_audit"\)/);
  assert.match(panel, /Scheduled execution is disabled/);
  assert.match(panel, /aria-label="Incident scope"/);
  assert.match(panel, /aria-label="Read ID"/);
  assert.match(panel, /aria-label="Window start"/);
  assert.match(panel, /aria-label="Window end"/);
  assert.match(panel, /Create retention preview/);
  assert.match(panel, /Show exact candidate IDs/);
  assert.match(panel, /Archive exact preview/);
  for (const source of [compose, dbOnly]) {
    assert.match(source, /ALPR_POSTGRES_LOG_MAX_SIZE/);
    assert.match(source, /ALPR_POSTGRES_LOG_MAX_FILES/);
  }
  for (const source of [compose, external, env]) {
    assert.match(source, /ALPR_AUDIT_HOT_RETENTION_DAYS/);
  }
});
