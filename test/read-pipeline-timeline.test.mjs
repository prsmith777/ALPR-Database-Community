import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  appendReadPipelineEvents,
  buildAcceptedReadPipelineEvents,
  buildLegacyPushoverPipelineEvent,
  queryReadPipelineTimeline,
  readPipelineTimelineInternals,
  sanitizeReadPipelineDetails,
} from "../lib/read-pipeline-timeline.mjs";

test("pipeline details use an explicit allowlist and discard sensitive values", () => {
  const details = sanitizeReadPipelineDetails({
    imageStored: true,
    mqttQueued: "2",
    directionLabel: "Eastbound",
    plateNumber: "PLATE-SENTINEL",
    imagePath: "PATH-SENTINEL",
    requestBody: "BODY-SENTINEL",
    apiKey: "KEY-SENTINEL",
    unknown: "UNKNOWN-SENTINEL",
  });

  assert.deepEqual(details, {
    imageStored: true,
    mqttQueued: 2,
    directionLabel: "Eastbound",
  });
  const serialized = JSON.stringify(details);
  for (const sentinel of [
    "PLATE-SENTINEL",
    "PATH-SENTINEL",
    "BODY-SENTINEL",
    "KEY-SENTINEL",
    "UNKNOWN-SENTINEL",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("accepted reads build an ordered, sanitized four-stage timeline", () => {
  const events = buildAcceptedReadPipelineEvents({
    readId: 40791,
    requestId: "request-40791",
    ingressReceiptId: 73,
    aliasApplied: true,
    imageStored: true,
    thumbnailStored: true,
    alertPointerPresent: true,
    direction: {
      bi_trigger_direction_status: "ready",
      bi_trigger_direction_label: "Eastbound",
      bi_trigger_direction_profile_version: 2,
      bi_trigger_direction_algorithm: "blue-iris-zone-crossing-v2-primary",
      plateNumber: "PLATE-SENTINEL",
    },
    mqttResult: { status: "queued", planned: 1, queued: 1, duplicates: 0 },
    notificationResult: { status: "no-match", planned: 0, queued: 0, duplicates: 0 },
    directionNotificationResult: { status: "queued", planned: 1, queued: 1, duplicates: 0 },
    vehicleOverview: {
      status: "pending",
      queueKind: "overview",
      retryable: true,
      errorCode: "WAITING_FOR_DAYTIME_OVERVIEW",
      imagePath: "PATH-SENTINEL",
    },
  });

  assert.deepEqual(events.map(({ eventType }) => eventType), [
    "read.persisted",
    "direction.resolved",
    "notification.outboxes_prepared",
    "vehicle_view.planned",
  ]);
  assert.deepEqual(events.map(({ status }) => status), [
    "accepted",
    "succeeded",
    "queued",
    "queued",
  ]);
  assert.ok(events.every(({ readId }) => readId === 40791));
  assert.ok(events.every(({ ingressReceiptId }) => ingressReceiptId === 73));
  assert.equal(JSON.stringify(events).includes("PLATE-SENTINEL"), false);
  assert.equal(JSON.stringify(events).includes("PATH-SENTINEL"), false);
});

test("legacy Pushover completion records only bounded outcome evidence", () => {
  const event = buildLegacyPushoverPipelineEvent({
    readId: 40791,
    requestId: "request-40791",
    ingressReceiptId: 73,
    result: {
      plateNumber: "PLATE-SENTINEL",
      pushover: {
        status: "sent",
        matched: true,
        sent: true,
        result: { receipt: "REMOTE-RECEIPT-SENTINEL" },
      },
    },
  });

  assert.equal(event.eventType, "legacy_pushover.completed");
  assert.equal(event.status, "succeeded");
  assert.deepEqual(event.details, {
    legacyPushoverStatus: "sent",
    legacyPushoverMatched: true,
    legacyPushoverSent: true,
  });
  assert.equal(JSON.stringify(event).includes("PLATE-SENTINEL"), false);
  assert.equal(JSON.stringify(event).includes("REMOTE-RECEIPT-SENTINEL"), false);
});

test("expected missing direction and unavailable Vehicle View evidence are skipped, not failures", () => {
  const events = buildAcceptedReadPipelineEvents({
    readId: 40792,
    direction: {
      bi_trigger_direction_status: "unknown",
      bi_trigger_direction_error_code: "TRIGGER_TYPE_UNAVAILABLE",
    },
    vehicleOverview: {
      status: "unavailable",
      retryable: false,
      errorCode: "NIGHTTIME_UNAVAILABLE",
    },
  });

  assert.equal(events.find(({ stage }) => stage === "direction").status, "skipped");
  assert.equal(events.find(({ stage }) => stage === "vehicle-view").status, "skipped");
});

test("timeline appends are batched, parameterized, and preserve event order", async () => {
  const calls = [];
  const events = buildAcceptedReadPipelineEvents({
    readId: 40791,
    requestId: "request-40791",
    ingressReceiptId: 73,
  });
  const count = await appendReadPipelineEvents(async (text, values) => {
    calls.push({ text, values });
    return { rowCount: 4 };
  }, events);

  assert.equal(count, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO public\.plate_read_pipeline_events/);
  assert.match(calls[0].text, /jsonb_array_elements\(\$1::jsonb\) WITH ORDINALITY/);
  assert.match(calls[0].text, /ORDER BY item\.ordinal/);
  const inserted = JSON.parse(calls[0].values[0]);
  assert.deepEqual(inserted.map(({ eventType }) => eventType), events.map(({ eventType }) => eventType));
});

test("timeline queries are bounded and return the newest events chronologically", async () => {
  const calls = [];
  const timeline = await queryReadPipelineTimeline(async (text, values) => {
    calls.push({ text, values });
    if (/SELECT EXISTS/.test(text)) return { rows: [{ read_exists: true }] };
    return {
      rows: [{
        id: "901",
        read_id: 40791,
        request_id: "request-40791",
        ingress_receipt_id: "73",
        stage: "ingress",
        event_type: "read.persisted",
        status: "accepted",
        component: "plate-read-ingress",
        details: { imageStored: true, plateNumber: "PLATE-SENTINEL" },
        occurred_at: "2026-08-13T18:01:02.000Z",
        total_count: 101,
      }],
    };
  }, "40791", { limit: 10_000 });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, [40791]);
  assert.deepEqual(calls[1].values, [40791, 100]);
  assert.match(calls[1].text, /WHERE read_id = \$1::integer/);
  assert.match(calls[1].text, /LIMIT \$2::integer/);
  assert.match(calls[1].text, /ORDER BY occurred_at, id/);
  assert.equal(timeline.readExists, true);
  assert.equal(timeline.total, 101);
  assert.equal(timeline.truncated, true);
  assert.deepEqual(timeline.events[0].details, { imageStored: true });
  assert.equal(JSON.stringify(timeline).includes("PLATE-SENTINEL"), false);

  await assert.rejects(
    () => queryReadPipelineTimeline(async () => ({ rows: [] }), "40791x"),
    /positive read ID/,
  );
  assert.throws(
    () => readPipelineTimelineInternals.normalizedEvent({
      readId: 40791,
      stage: "ingress",
      eventType: "read.persisted",
      component: "plate-read-ingress",
      occurredAt: "not-a-date",
    }),
    /valid occurrence time/,
  );
});

test("pipeline event retention follows the parent plate read cleanup lifecycle", async () => {
  const migration = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.plate_read_pipeline_events/);
  assert.match(migration, /read_id INTEGER NOT NULL REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ingress_receipt_id BIGINT REFERENCES public\.integration_ingress_receipts\(id\)[\s\S]*ON DELETE SET NULL/);
  assert.match(migration, /pg_column_size\(details\) <= 8192/);
  assert.match(migration, /2026081303_read_pipeline_timeline/);
});
