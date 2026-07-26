import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createColorSignature } from "../lib/image-similarity.mjs";
import { CaptureAssetRepository } from "../lib/capture-asset-repository.mjs";
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
  assert.match(service, /clusterRecentUnassigned[\s\S]*?analyzeVehicleColorAssets\(assets\)/);
  assert.doesNotMatch(service, /clusterRecentUnassigned[\s\S]{0,1800}?analyzeRecentVehicleColors\(bounded\)/);
  assert.match(actions, /reviewVehicleClusterSuggestion[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /analyzeRecentVehicleClusters[\s\S]*?requirePermission\("maintenance\.manage"\)/);
});

test("vehicle cluster queries use one current vehicle asset per read", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("total_clusters")) {
          return { rows: [{ total_clusters: 0, shadow_clusters: 0, pending_reviews: 0, confirmed_assignments: 0 }] };
        }
        return { rows: [] };
      },
    },
  });

  await repository.listVehicleClusterOverview();

  assert.equal(calls.length, 3);
  assert.equal(calls[0].values.length, 3);
  assert.match(calls[0].text, /JOIN LATERAL[\s\S]*?asset_type = \$2[\s\S]*?algorithm_version = \$3/i);
  assert.doesNotMatch(calls[0].text, /JOIN public\.capture_assets representative ON/i);
  assert.equal(calls[1].values.length, 3);
  assert.match(calls[1].text, /JOIN LATERAL[\s\S]*?candidate[\s\S]*?JOIN LATERAL[\s\S]*?representative/i);
});

test("vehicle cluster review explicitly types the shared status parameter", async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("FOR UPDATE")) {
        return { rows: [{ read_id: 10, cluster_id: 20, assignment_status: "suggested", similarity: 0.97, revision: 1 }] };
      }
      if (text.includes("UPDATE public.vehicle_cluster_assignments")) {
        return { rows: [{ read_id: 10, cluster_id: 20, assignment_status: "confirmed", similarity: 0.97, similarity_margin: 0.08, revision: 2 }] };
      }
      return { rows: [] };
    },
  };
  const repository = new CaptureAssetRepository({ executor: client });

  await repository.reviewVehicleClusterAssignment({
    readId: 10,
    decision: "confirm",
    embeddingModel: "test-model",
    algorithmVersion: "test-cluster",
    actor: { id: 1, username: "tester", displayName: "Tester" },
  });

  const update = calls.find((call) => call.text.includes("UPDATE public.vehicle_cluster_assignments"));
  assert.match(update.text, /assignment_status = \$3::varchar/i);
  assert.match(update.text, /CASE WHEN \$3::varchar = 'seed'/i);
});
