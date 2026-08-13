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

test("ingress recorder inserts, bounds, and completes receipt metadata", async () => {
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
  assert.equal(calls.length, 3);
  assert.match(calls[0].text, /INSERT INTO public\.integration_ingress_receipts/);
  assert.match(calls[1].text, /received_at < CURRENT_TIMESTAMP/);
  assert.deepEqual(calls[1].values, [7]);
  assert.match(calls[2].text, /OFFSET \$1::integer/);
  assert.deepEqual(calls[2].values, [1_000]);
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
    ignoredCount: 0,
    overviewWorkQueued: true,
  });
  assert.equal(calls.length, 4);
  assert.match(calls[3].text, /UPDATE public\.integration_ingress_receipts/);
  assert.deepEqual(calls[3].values, [
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

test("migration and Compose configuration keep logging and receipts bounded", async () => {
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
