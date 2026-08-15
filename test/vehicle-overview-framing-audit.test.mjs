import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VehicleOverviewFramingAuditService } from "../lib/vehicle-overview-framing-audit.mjs";

function read(id, path, overrides = {}) {
  return {
    id,
    plate_number: `TEST${id}`,
    camera_name: "Street LPR 2",
    timestamp: "2026-08-15T17:24:00.000Z",
    vehicle_image_path: path,
    vehicle_image_source_kind: "overview_primary",
    vehicle_image_detection_box: { left: 0.12, top: 0.15, right: 0.78, bottom: 0.72 },
    ...overrides,
  };
}

function imageProcessor() {
  return { async metadata() { return { width: 2688, height: 1520, format: "jpeg" }; } };
}

test("pixel audit catches an edge-clipped saved frame even when stored geometry looks complete", async () => {
  const reads = [
    read(41117, "derived/clipped.jpg"),
    read(41118, "derived/complete.jpg"),
  ];
  const service = new VehicleOverviewFramingAuditService({
    repository: {
      async listOverviewFramingAuditCandidates() {
        return { maxReadId: 41118, total: 2, remaining: 0, reads };
      },
    },
    fileStorage: {},
    imageProcessor,
    loadImage: async (imagePath) => Buffer.from(imagePath),
    detector: {
      async detectAll(buffer) {
        return buffer.toString().includes("clipped")
          ? [{ confidence: 0.96, area: 0.34, left: 0.38, top: 0.15, right: 1, bottom: 0.72 }]
          : [{ confidence: 0.92, area: 0.31, left: 0.1, top: 0.14, right: 0.72, bottom: 0.71 }];
      },
    },
    qualityAnalyzer: async () => ({
      sharpnessScore: 0.8,
      exposureScore: 0.8,
      contrastScore: 0.8,
    }),
  });

  const result = await service.auditBatch({ limit: 10 });

  assert.equal(result.total, 2);
  assert.equal(result.flagged, 1);
  assert.equal(result.unacceptable, 1);
  assert.equal(result.failures, 0);
  assert.equal(result.items[0].classification, "unacceptable");
  assert.equal(result.items[0].edgeContacts, 1);
  assert.ok(result.items[0].reasons.includes("VEHICLE_TOUCHES_IMAGE_EDGE"));
  assert.ok(Number.isFinite(result.items[0].geometryOverlap));
  assert.equal(result.items[1].classification, "acceptable");
  assert.equal(result.items[1].completenessTier, 3);
});

test("one unreadable image is reported without stopping the bounded audit", async () => {
  const service = new VehicleOverviewFramingAuditService({
    repository: {
      async listOverviewFramingAuditCandidates() {
        return {
          maxReadId: 9,
          total: 1,
          remaining: 0,
          reads: [read(9, "derived/missing.jpg")],
        };
      },
    },
    fileStorage: {},
    imageProcessor,
    loadImage: async () => {
      const error = new Error("Source image is missing");
      error.code = "ENOENT";
      throw error;
    },
    detector: { async detectAll() { return []; } },
    qualityAnalyzer: async () => ({}),
  });

  const result = await service.auditBatch();

  assert.equal(result.failures, 1);
  assert.equal(result.items[0].classification, "audit_failed");
  assert.equal(result.items[0].error.code, "ENOENT");
});

test("the Administrator framing audit surface remains read-only and bounded", async () => {
  const [actions, component] = await Promise.all([
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
  ]);
  const start = actions.indexOf("export async function getVehicleOverviewFramingAuditBatch");
  const end = actions.indexOf("\nexport async function ", start + 1);
  const action = actions.slice(start, end);

  assert.ok(start >= 0);
  assert.match(action, /requirePermission\("system\.manage_settings"\)/);
  assert.match(action, /auditBatch\(\{/);
  assert.doesNotMatch(action, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.match(component, /limit: 10/);
  assert.match(component, /Audit all ready Overview images/);
  assert.match(component, /This read-only audit/);
  assert.match(component, /Stop after current batch/);
});
