import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeSystemLogQuery,
  parseSystemLogLine,
  querySystemLogText,
} from "../lib/system-logs.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function entry(index, overrides = {}) {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 13, 16, 0, index)).toISOString(),
    level: "info",
    message: "integration_request_received",
    service: "alpr-community",
    component: "plate-read-ingress",
    requestId: `request-${index}`,
    cameraName: index % 2 ? "Street LPR 1" : "Street LPR 2",
    processedReadIds: [40_000 + index],
    durationMs: index,
    ...overrides,
  });
}

test("structured log parsing preserves correlation fields and redacts credentials", () => {
  const parsed = parseSystemLogLine(JSON.stringify({
    timestamp: "2026-08-13T16:01:02.000Z",
    level: "warn",
    message: "mqtt_connection_test",
    component: "mqtt",
    requestId: "request-1",
    readId: 40645,
    cameraName: "Street LPR 1",
    username: "BROKER-USER-SENTINEL",
    password: "BROKER-PASSWORD-SENTINEL",
    plateNumber: "PLATE-SENTINEL",
  }), 4);

  assert.equal(parsed.level, "WARN");
  assert.equal(parsed.requestId, "request-1");
  assert.equal(parsed.component, "mqtt");
  assert.equal(parsed.cameraName, "Street LPR 1");
  assert.deepEqual(parsed.readIds, ["40645"]);
  assert.equal(parsed.details.username, "[redacted]");
  assert.equal(parsed.details.password, "[redacted]");
  assert.equal(parsed.details.plateNumber, "[redacted]");
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes("BROKER-USER-SENTINEL"), false);
  assert.equal(serialized.includes("BROKER-PASSWORD-SENTINEL"), false);
  assert.equal(serialized.includes("PLATE-SENTINEL"), false);
});

test("legacy log lines remain viewable without breaking structured rows", () => {
  const parsed = parseSystemLogLine(
    "2026-08-13T16:01:02.000Z [warn] Legacy subsystem warning",
    2
  );
  assert.equal(parsed.level, "WARN");
  assert.equal(parsed.message, "Legacy subsystem warning");
  assert.equal(parsed.component, "legacy");
  assert.equal(parsed.format, "legacy");
});

test("log queries filter structured fields and paginate newest-first", () => {
  const content = Array.from({ length: 30 }, (_, index) =>
    entry(index, index === 12 ? { level: "error", outcome: "failed" } : {})
  ).join("\n");

  const firstPage = querySystemLogText(content, { pageSize: 25 }, {
    fileBytes: Buffer.byteLength(content),
    maxFileBytes: 5 * 1024 * 1024,
    maxFiles: 20,
  });
  assert.equal(firstPage.total, 30);
  assert.equal(firstPage.entries.length, 25);
  assert.equal(firstPage.entries[0].requestId, "request-29");
  assert.equal(firstPage.entries.at(-1).requestId, "request-5");
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.metadata.structuredRows, 30);
  assert.deepEqual(firstPage.facets.components, ["plate-read-ingress"]);

  const secondPage = querySystemLogText(content, { page: 2, pageSize: 25 });
  assert.equal(secondPage.entries[0].requestId, "request-4");
  assert.equal(secondPage.entries.at(-1).requestId, "request-0");

  const filtered = querySystemLogText(content, {
    level: "error",
    component: "plate-read-ingress",
    cameraName: "Street LPR 2",
    requestId: "request-12",
    readId: "40012",
    search: "failed",
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].requestId, "request-12");
});

test("log query inputs are bounded to supported levels and page sizes", () => {
  const normalized = normalizeSystemLogQuery({
    page: -2,
    pageSize: 10_000,
    level: "fatal",
    search: "x".repeat(1000),
  });
  assert.equal(normalized.page, 1);
  assert.equal(normalized.pageSize, 50);
  assert.equal(normalized.level, "ALL");
  assert.equal(normalized.search.length, 200);
});

test("System Logs exposes bounded structured diagnostics and operator controls", async () => {
  const [actions, viewer, message, instrumentation, mqtt] = await Promise.all([
    source("app/actions.js"),
    source("app/logs/LogViewer.jsx"),
    source("app/logs/LogMessage.jsx"),
    source("instrumentation.js"),
    source("lib/mqtt/client-manager.mjs"),
  ]);

  assert.match(actions, /querySystemLogText\(content, filters/);
  assert.match(actions, /requirePermission\("system\.view_audit"\)/);
  assert.match(viewer, /Search messages and structured fields/);
  assert.match(viewer, /Request ID/);
  assert.match(viewer, /Read ID/);
  assert.match(viewer, /All components/);
  assert.match(viewer, /All cameras/);
  assert.match(viewer, /Rows per page/);
  assert.match(viewer, /Log level/);
  assert.match(viewer, /Refresh/);
  assert.match(viewer, /const \[filtersExpanded, setFiltersExpanded\] = useState\(false\)/);
  assert.match(viewer, /aria-controls="system-log-filters"/);
  assert.match(viewer, /All levels · all sources/);
  assert.match(viewer, /Unapplied changes/);
  assert.match(message, /Structured fields/);
  assert.match(message, /Copy request ID/);
  assert.match(message, /Trigger \$\{log\.details\.triggerType\}/);
  assert.match(message, /aria-controls=\{detailsId\}/);
  assert.match(message, /hidden min-w-0 flex-1 items-center gap-1 overflow-hidden lg:flex/);
  assert.match(message, /log\.readIds\?\.\[0\]/);
  assert.match(message, /const \[fieldsExpanded, setFieldsExpanded\] = useState\(true\)/);
  assert.match(message, /aria-controls=\{fieldsId\}/);
  assert.match(message, /Show \$\{fieldKey\} in structured fields/);
  assert.match(message, /fieldKey=\{cameraField\}/);
  assert.match(message, /fieldKey=\{triggerField\}/);
  assert.match(message, /fieldKey=\{directionField\}/);
  assert.match(message, /fieldKey=\{readField\}/);
  assert.match(message, /fieldKey=\{componentField\}/);
  assert.match(message, /fieldKey=\{requestField\}/);
  assert.match(message, /fieldKey=\{directionErrorField\}/);
  assert.match(message, /Request \$\{log\.requestId\}/);
  assert.match(message, /additionalReadIds\.map/);
  assert.match(message, /highlightedField === key/);
  assert.match(message, /flex flex-wrap items-center gap-1\.5 font-mono/);
  assert.match(message, /border-b border-border\/40 py-1\.5/);
  assert.match(instrumentation, /createComponentLogger\("background-runtime"\)/);
  assert.match(mqtt, /this\.mqttConnect\(options\)/);
  assert.doesNotMatch(mqtt, /this\.mqttConnect\(url, options\)/);
});
