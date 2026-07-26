import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createColorSignature } from "../lib/image-similarity.mjs";
import { inferVehicleColor } from "../lib/vehicle-attributes.mjs";
import { chooseShadowCluster } from "../lib/vehicle-clustering.mjs";

function pixels(red, green, blue) {
  const result = Buffer.alloc(16 * 16 * 3);
  for (let offset = 0; offset < result.length; offset += 3) {
    result[offset] = red;
    result[offset + 1] = green;
    result[offset + 2] = blue;
  }
  return result;
}

function vector(x, y) {
  const result = new Float32Array(512);
  result[0] = x;
  result[1] = y;
  return result;
}

test("vehicle color remains per-read evidence with confidence", () => {
  assert.deepEqual(
    { ...inferVehicleColor(createColorSignature(pixels(220, 20, 20))), signature: undefined },
    { status: "ready", value: "red", confidence: 0.99, reliability: 1, signature: undefined }
  );
  assert.equal(inferVehicleColor(createColorSignature(pixels(240, 240, 240))).value, "white");
  assert.equal(inferVehicleColor(createColorSignature(pixels(10, 10, 10))).value, "black");
});

test("shadow clustering uses descriptor similarity and a continuous margin", () => {
  const suggested = chooseShadowCluster({
    embedding: vector(1, 0),
    candidates: [
      { clusterId: 12, embedding: vector(0.99, 0.02) },
      { clusterId: 14, embedding: vector(0.4, 0.9) },
    ],
  });
  assert.equal(suggested.decision, "suggest");
  assert.equal(suggested.clusterId, 12);
  assert.ok(suggested.similarity >= 0.9);
  assert.ok(suggested.margin >= 0.03);

  const ambiguous = chooseShadowCluster({
    embedding: vector(1, 0),
    candidates: [
      { clusterId: 12, embedding: vector(0.99, 0.02) },
      { clusterId: 14, embedding: vector(0.99, -0.02) },
    ],
  });
  assert.equal(ambiguous.decision, "seed");
  assert.equal(ambiguous.clusterId, null);
});

test("vehicle intelligence schema is shadow-only and reviewable", async () => {
  const [migration, component, service, actions] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleClusters.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/capture-asset-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_attribute_observations/i);
  assert.match(migration, /2026072505_vehicle_attribute_observations/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_clusters/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_cluster_assignments/i);
  assert.match(migration, /representative_read_id[\s\S]*?REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /2026072506_vehicle_shadow_clusters/i);
  assert.match(component, /does not create ownership claims or mismatch alerts/i);
  assert.match(component, /Confirm vehicle/);
  assert.match(component, /Different vehicle/);
  assert.match(service, /chooseShadowCluster\(\{ embedding: asset\.vehicle_embedding, candidates \}\)/);
  assert.doesNotMatch(service, /chooseShadowCluster\([\s\S]{0,300}plate_number/);
  assert.match(actions, /reviewVehicleClusterSuggestion[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /analyzeRecentVehicleClusters[\s\S]*?requirePermission\("maintenance\.manage"\)/);
});
