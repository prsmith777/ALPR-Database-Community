import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeIngressReceiptQuery,
  queryIntegrationIngressReceipts,
} from "../lib/integration-ingress-receipts.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("ingress receipt filters are bounded and normalized", () => {
  const normalized = normalizeIngressReceiptQuery({
    page: -1,
    pageSize: 5000,
    requestId: "r".repeat(500),
    readId: "not-a-read",
    cameraName: "Street LPR 1",
    errorCode: "__any__",
    startAt: "not-a-date",
    endAt: "2026-08-13T17:00:00-06:00",
  });

  assert.equal(normalized.page, 1);
  assert.equal(normalized.pageSize, 50);
  assert.equal(normalized.requestId.length, 128);
  assert.equal(normalized.readId, "");
  assert.equal(normalized.cameraName, "Street LPR 1");
  assert.equal(normalized.errorCode, "__any__");
  assert.equal(normalized.startAt, null);
  assert.equal(normalized.endAt, "2026-08-13T23:00:00.000Z");
});

test("ingress receipt explorer uses parameterized filters and maps safe metadata", async () => {
  const calls = [];
  const query = async (text, values) => {
    calls.push({ text, values });
    if (/COUNT\(\*\)::bigint AS total/.test(text)) {
      return { rows: [{ total: "1" }] };
    }
    if (/available_rows/.test(text)) {
      return {
        rows: [{
          available_rows: "12",
          oldest_received_at: "2026-08-13T20:00:00.000Z",
          newest_received_at: "2026-08-13T21:00:00.000Z",
          cameras: ["Street LPR 1"],
          outcomes: ["accepted"],
          error_codes: ["INVALID_TRIGGER"],
        }],
      };
    }
    return {
      rows: [{
        id: "42",
        request_id: "request-42",
        integration: "blue-iris",
        route_name: "plate-read",
        method: "POST",
        content_type: "text/plain",
        body_bytes: "2048",
        body_sha256: "a".repeat(64),
        payload_keys: ["camera", "Type"],
        unknown_payload_key_count: 1,
        camera_name: "Street LPR 1",
        event_timestamp_text: "2026-08-13T15:00:00-06:00",
        trigger_field: "Type",
        trigger_present: true,
        trigger_value_state: "recorded",
        trigger_type: "MOTION_A>B",
        receipt_schema_version: 2,
        trigger_alias_fields: ["trigger_type", "TYPE"],
        trigger_alias_conflict: true,
        trigger_alias_distinct_value_count: 2,
        heavy_fields: { Image: { present: true, type: "string" } },
        state: "completed",
        received_at: "2026-08-13T21:00:00.000Z",
        completed_at: "2026-08-13T21:00:00.050Z",
        duration_ms: "50",
        http_status: 201,
        outcome: "accepted",
        error_code: null,
        processed_read_ids: ["40683"],
        processed_count: 1,
        duplicate_count: 0,
        duplicate_target_read_ids: ["40682"],
        ignored_count: 0,
        overview_work_queued: true,
        updated_at: "2026-08-13T21:00:00.050Z",
      }],
    };
  };

  const result = await queryIntegrationIngressReceipts(query, {
    requestId: "request-42",
    readId: "40683",
    cameraName: "Street LPR 1",
    outcome: "accepted",
    errorCode: "__any__",
    startAt: "2026-08-13T20:00:00Z",
    pageSize: 25,
  });

  assert.equal(result.total, 1);
  assert.equal(result.metadata.availableRows, 12);
  assert.deepEqual(result.facets.cameras, ["Street LPR 1"]);
  assert.equal(result.receipts[0].requestId, "request-42");
  assert.deepEqual(result.receipts[0].processedReadIds, ["40683"]);
  assert.deepEqual(result.receipts[0].duplicateTargetReadIds, ["40682"]);
  assert.equal(result.receipts[0].receiptSchemaVersion, 2);
  assert.deepEqual(result.receipts[0].triggerAliasFields, ["trigger_type", "TYPE"]);
  assert.equal(result.receipts[0].triggerAliasConflict, true);
  assert.equal(result.receipts[0].triggerAliasDistinctValueCount, 2);
  assert.equal(result.receipts[0].heavyFields.Image.present, true);
  assert.equal(result.receipts[0].bodyBytes, 2048);

  const countCall = calls.find((call) => /AS total/.test(call.text));
  assert.match(countCall.text, /POSITION\(LOWER\(\$1::text\) IN LOWER\(request_id\)\)/);
  assert.match(countCall.text, /\$2::bigint = ANY\(processed_read_ids\)/);
  assert.match(countCall.text, /\$2::bigint = ANY\(duplicate_target_read_ids\)/);
  assert.match(countCall.text, /camera_name = \$3::text/);
  assert.match(countCall.text, /outcome = \$4::text/);
  assert.match(countCall.text, /error_code IS NOT NULL/);
  assert.match(countCall.text, /received_at >= \$5::timestamptz/);
  assert.deepEqual(countCall.values.slice(0, 4), [
    "request-42",
    "40683",
    "Street LPR 1",
    "accepted",
  ]);

  const rowsCall = calls.find((call) => /ORDER BY received_at DESC/.test(call.text));
  assert.match(rowsCall.text, /LIMIT \$6::integer/);
  assert.match(rowsCall.text, /OFFSET \$7::integer/);
  assert.deepEqual(rowsCall.values.slice(-2), [25, 0]);
});

test("receipt explorer is protected and reachable from System Logs", async () => {
  const [actions, page, header, viewer, liveFeed, wrapper, plateTable, database] = await Promise.all([
    source("app/actions.js"),
    source("app/logs/receipts/page.jsx"),
    source("app/logs/AuditHeader.jsx"),
    source("app/logs/receipts/IngressReceiptViewer.jsx"),
    source("app/live_feed/page.jsx"),
    source("components/PlateTableWrapper.jsx"),
    source("components/PlateTable.jsx"),
    source("lib/db.js"),
  ]);

  assert.match(actions, /getIntegrationIngressReceipts/);
  assert.match(actions, /requirePermission\("system\.view_audit"\)/);
  assert.match(page, /requirePagePermission\("system\.view_audit"\)/);
  assert.match(header, /href: "\/logs\/receipts"/);
  assert.match(header, /Ingress receipts/);
  assert.match(viewer, /href=\{`\/logs\?requestId=/);
  assert.match(viewer, /href=\{`\/logs\?readId=/);
  assert.match(viewer, /href=\{`\/live_feed\?readId=/);
  assert.match(viewer, /Receipt schema/);
  assert.match(viewer, /triggerAliasConflict/);
  assert.match(viewer, /Duplicate target \{readId\}/);
  assert.equal(liveFeed.includes("readId: /^\\d+$/.test"), true);
  assert.match(wrapper, /readId: params\.get\("readId"\)/);
  assert.match(plateTable, /Exact read: \{filters\.readId\}/);
  assert.match(plateTable, /\/logs\?readId=\$\{plate\.id\}&expand=first/);
  assert.match(database, /pr\.id = \$\{addValue\(requestedReadId\)\}::bigint/);
});
