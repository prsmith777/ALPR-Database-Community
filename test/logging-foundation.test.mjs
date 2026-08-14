import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createIntegrationIngressRecorder,
  summarizeIntegrationIngress,
} from "../lib/integration-ingress.mjs";
import {
  appLogger,
  sanitizeLogValue,
} from "../logging/logger.js";

after(() => appLogger.close());

test("ingress summaries retain diagnostics without retaining sensitive values", () => {
  const data = {
    ai_dump: "AI-DUMP-SENTINEL",
    Image: "IMAGE-SENTINEL",
    camera: "Street LPR 1",
    ALERT_PATH: "C:\\BlueIris\\Alerts\\PATH-SENTINEL",
    ALERT_CLIP: "CLIP-SENTINEL",
    timestamp: "2026-08-13T01:02:03-06:00",
    TYPE: "MOTION_A>B",
    plate_number: "PLATE-SENTINEL",
    custom_field: "CUSTOM-SENTINEL",
  };
  const rawText = JSON.stringify(data);
  const summary = summarizeIntegrationIngress({
    rawText,
    data,
    contentType: "application/json",
  });

  assert.equal(summary.bodyBytes, Buffer.byteLength(rawText));
  assert.match(summary.bodySha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.payloadKeys, [
    "ALERT_CLIP",
    "ALERT_PATH",
    "Image",
    "TYPE",
    "ai_dump",
    "camera",
    "plate_number",
    "timestamp",
  ]);
  assert.equal(summary.unknownPayloadKeyCount, 1);
  assert.equal(summary.cameraName, "Street LPR 1");
  assert.equal(summary.triggerField, "TYPE");
  assert.equal(summary.triggerValueState, "recorded");
  assert.equal(summary.triggerType, "MOTION_A>B");
  assert.deepEqual(summary.triggerAliasFields, ["TYPE"]);
  assert.equal(summary.triggerAliasConflict, false);
  assert.equal(summary.triggerAliasDistinctValueCount, 1);
  assert.deepEqual(summary.heavyFields.Image, {
    present: true,
    type: "string",
    bytes: Buffer.byteLength(data.Image),
  });

  const serialized = JSON.stringify(summary);
  for (const sensitive of [
    "AI-DUMP-SENTINEL",
    "IMAGE-SENTINEL",
    "PATH-SENTINEL",
    "CLIP-SENTINEL",
    "PLATE-SENTINEL",
    "CUSTOM-SENTINEL",
  ]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test("ingress summaries flag conflicting trigger aliases without retaining alternate values", () => {
  const conflict = summarizeIntegrationIngress({
    data: {
      trigger_type: "MOTION_A>B",
      triggerType: "motion_a>b",
      TYPE: "MOTION_B>A",
    },
  });

  assert.deepEqual(conflict.triggerAliasFields, ["trigger_type", "triggerType", "TYPE"]);
  assert.equal(conflict.triggerAliasConflict, true);
  assert.equal(conflict.triggerAliasDistinctValueCount, 2);
  assert.equal(conflict.triggerField, "trigger_type");
  assert.equal(conflict.triggerType, "MOTION_A>B");
  assert.equal(JSON.stringify(conflict).includes("MOTION_B>A"), false);

  const consistent = summarizeIntegrationIngress({
    data: { trigger_type: "MOTION_A>B", TYPE: "motion_a>b" },
  });
  assert.equal(consistent.triggerAliasConflict, false);
  assert.equal(consistent.triggerAliasDistinctValueCount, 1);
});

test("ingress summaries distinguish absent, blank, and invalid trigger evidence", () => {
  const absent = summarizeIntegrationIngress({ data: {} });
  assert.equal(absent.triggerPresent, false);
  assert.equal(absent.triggerValueState, "absent");
  assert.equal(absent.triggerType, null);

  const blank = summarizeIntegrationIngress({ data: { trigger_type: "  " } });
  assert.equal(blank.triggerPresent, true);
  assert.equal(blank.triggerValueState, "blank");
  assert.equal(blank.triggerType, null);

  const invalid = summarizeIntegrationIngress({
    data: { triggerType: "MOTION_A>B\nunsafe" },
  });
  assert.equal(invalid.triggerPresent, true);
  assert.equal(invalid.triggerValueState, "invalid");
  assert.equal(invalid.triggerType, null);
});

test("ingress recorder inserts and completes receipt metadata without request-path cleanup", async () => {
  const calls = [];
  const query = async (text, values) => {
    calls.push({ text, values });
    return /INSERT INTO/.test(text) ? { rows: [{ id: 41 }] } : { rows: [] };
  };
  const recorder = createIntegrationIngressRecorder({
    query,
    retentionDays: 7,
    maxRows: 1_000,
    now: () => 8_000_000,
  });
  const rawText = JSON.stringify({
    camera: "Street LPR 1",
    trigger_type: "MOTION_B>A",
    plate_number: "PLATE-SENTINEL",
    Image: "IMAGE-SENTINEL",
  });

  const receipt = await recorder.start({
    requestId: "request-41",
    integration: "blue_iris",
    routeName: "/api/plate-reads",
    method: "POST",
    contentType: "application/json",
    rawText,
    data: JSON.parse(rawText),
  });
  assert.equal(receipt.receiptId, 41);
  assert.deepEqual(receipt.logSummary, {
    contentType: "application/json",
    bodyBytes: Buffer.byteLength(rawText),
    cameraName: "Street LPR 1",
    eventTimestamp: null,
    payloadKeys: ["Image", "camera", "plate_number", "trigger_type"],
    unknownPayloadKeyCount: 0,
    triggerField: "trigger_type",
    triggerPresent: true,
    triggerValueState: "recorded",
    triggerType: "MOTION_B>A",
    receiptSchemaVersion: 2,
    triggerAliasFields: ["trigger_type"],
    triggerAliasConflict: false,
    triggerAliasDistinctValueCount: 1,
    fieldSummaries: {
      aiDumpField: { present: false },
      imageField: {
        present: true,
        type: "string",
        bytes: Buffer.byteLength("IMAGE-SENTINEL"),
      },
      alertPathField: { present: false },
      alertClipField: { present: false },
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO public\.integration_ingress_receipts/);
  assert.equal(JSON.stringify(calls[0].values).includes("PLATE-SENTINEL"), false);
  assert.equal(JSON.stringify(calls[0].values).includes("IMAGE-SENTINEL"), false);

  await recorder.complete({
    receiptId: receipt.receiptId,
    durationMs: 18.9,
    httpStatus: 201,
    outcome: "accepted",
    processedReadIds: [12, "12", 19, -1, "bad"],
    processedCount: 2,
    duplicateCount: 1,
    duplicateTargetReadIds: [81, "81", 82, -1, "bad"],
    ignoredCount: 0,
    overviewWorkQueued: true,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /UPDATE public\.integration_ingress_receipts/);
  assert.deepEqual(calls[1].values, [
    41,
    18,
    201,
    "accepted",
    null,
    [12, 19],
    2,
    1,
    0,
    true,
    [81, 82],
  ]);
});

test("structured logger redacts sensitive fields and bounds unsafe values", () => {
  const circular = { visible: "ok" };
  circular.self = circular;
  const sanitized = sanitizeLogValue({
    requestId: "request-1",
    authorization: "Bearer SECRET-SENTINEL",
    plateNumber: "PLATE-SENTINEL",
    nested: {
      webhookSigningSecret: "WEBHOOK-SENTINEL",
      failure: Object.assign(new Error("RAW-ERROR-SENTINEL"), {
        code: "SAFE_CODE",
      }),
    },
    circular,
    note: "x".repeat(800),
  });

  assert.equal(sanitized.requestId, "request-1");
  assert.equal(sanitized.authorization, "[redacted]");
  assert.equal(sanitized.plateNumber, "[redacted]");
  assert.equal(sanitized.nested.webhookSigningSecret, "[redacted]");
  assert.deepEqual(sanitized.nested.failure, {
    name: "Error",
    code: "SAFE_CODE",
  });
  assert.equal(sanitized.circular.self, "[circular]");
  assert.match(sanitized.note, /\.\.\.\[truncated\]$/);
  assert.equal(JSON.stringify(sanitized).includes("RAW-ERROR-SENTINEL"), false);
});

test("migration and Compose configure bounded logs and receipt candidate policy", async () => {
  const [migration, compose, externalCompose, envExample, security] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.without-database.yml", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docs/security-baseline.md", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.integration_ingress_receipts/);
  assert.match(migration, /trigger_value_state IN \('absent','blank','invalid','recorded'\)/);
  assert.match(migration, /2026081301_integration_ingress_receipts/);
  assert.match(migration, /receipt_schema_version SMALLINT NOT NULL DEFAULT 1/);
  assert.match(migration, /trigger_alias_conflict BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /duplicate_target_read_ids BIGINT\[\] NOT NULL/);
  assert.match(migration, /2026081302_ingress_receipt_diagnostics_v2/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.plate_read_pipeline_events/);
  assert.match(migration, /REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/);
  assert.match(migration, /2026081303_read_pipeline_timeline/);
  for (const source of [compose, externalCompose, envExample]) {
    assert.match(source, /ALPR_OPERATIONAL_LOG_FILE_MAX_BYTES/);
    assert.match(source, /ALPR_INTEGRATION_MAX_BODY_BYTES/);
    assert.match(source, /ALPR_INGRESS_RECEIPT_RETENTION_DAYS/);
    assert.match(source, /ALPR_INGRESS_RECEIPT_MAX_ROWS/);
  }
  assert.match(compose, /app-logs:\/app\/logs/);
  assert.match(externalCompose, /app-logs:\/app\/logs/);
  assert.match(security, /never store raw bodies, plate values, AI dumps, images/);
});
