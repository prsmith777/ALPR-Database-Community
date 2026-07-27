import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createColorSignature } from "../lib/image-similarity.mjs";
import { CaptureAssetRepository } from "../lib/capture-asset-repository.mjs";
import { inferVehicleColor } from "../lib/vehicle-attributes.mjs";
import { chooseShadowCluster } from "../lib/vehicle-clustering.mjs";
import {
  VEHICLE_DISTINCTIVE_FEATURES,
  normalizeDistinctiveFeatures,
} from "../lib/vehicle-distinctive-features.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

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

test("distinctive vehicle features use a fixed reviewable catalog", () => {
  assert.ok(VEHICLE_DISTINCTIVE_FEATURES.some((feature) => feature.key === "roof_rack"));
  assert.ok(VEHICLE_DISTINCTIVE_FEATURES.some((feature) => feature.key === "rear_bike_rack"));
  assert.ok(VEHICLE_DISTINCTIVE_FEATURES.some((feature) => feature.key === "bumper_sticker"));
  assert.deepEqual(normalizeDistinctiveFeatures(["roof_rack", "roof_rack", "BUMPER_STICKER"]), [
    "roof_rack",
    "bumper_sticker",
  ]);
  assert.throws(() => normalizeDistinctiveFeatures(["invented_feature"]), /supported distinctive/i);
});

test("vehicle intelligence keeps ReID grouping separate from reviewed plate associations", async () => {
  const [migration, component, profileComponent, service, actions] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleClusters.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleProfile.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/capture-asset-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_attribute_observations/i);
  assert.match(migration, /2026072505_vehicle_attribute_observations/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_clusters/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_cluster_assignments/i);
  assert.match(migration, /representative_read_id[\s\S]*?REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /2026072506_vehicle_shadow_clusters/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_plate_associations/i);
  assert.match(migration, /2026072702_vehicle_plate_associations/i);
  assert.match(migration, /WHERE assignments\.assignment_status = 'confirmed'/i);
  assert.match(component, /Confirmed plate associations are reviewed separately/i);
  assert.match(component, /Open vehicle profile/i);
  assert.match(component, /Confirm vehicle/);
  assert.match(component, /Different vehicle/);
  assert.match(profileComponent, /Confirm association/);
  assert.match(profileComponent, /Reject association/);
  assert.match(profileComponent, /Plate text is shown as evidence and was not used/i);
  assert.match(profileComponent, /Review visible features/i);
  assert.match(profileComponent, /Repeated observations from seed or confirmed members strengthen the profile/i);
  assert.match(service, /chooseShadowCluster\(\{ embedding: asset\.vehicle_embedding, candidates \}\)/);
  assert.doesNotMatch(service, /chooseShadowCluster\([\s\S]{0,300}plate_number/);
  assert.match(service, /clusterRecentUnassigned[\s\S]*?analyzeVehicleColorAssets\(assets\)/);
  assert.doesNotMatch(service, /clusterRecentUnassigned[\s\S]{0,1800}?analyzeRecentVehicleColors\(bounded\)/);
  assert.match(actions, /reviewVehicleClusterSuggestion[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /reviewVehiclePlateAssociation[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /reviewVehicleDistinctiveFeatures[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /analyzeRecentVehicleClusters[\s\S]*?requirePermission\("maintenance\.manage"\)/);
});

test("human feature review stores present and absent evidence and appends an audit event", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("SELECT id FROM public.plate_reads")) return { rows: [{ id: 17 }] };
        if (sql.includes("SUBSTRING(attribute_key FROM 9)")) return { rows: [{ feature_key: "roof_rack" }] };
        return { rows: [] };
      },
    },
  });

  const result = await repository.reviewVehicleDistinctiveFeatures({
    readId: 17,
    features: ["rear_bike_rack", "bumper_sticker"],
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });

  assert.deepEqual(result.features, ["rear_bike_rack", "bumper_sticker"]);
  const observation = calls.find((call) => call.sql.includes("INSERT INTO public.vehicle_attribute_observations"));
  assert.ok(observation);
  assert.match(observation.sql, /CASE WHEN feature_key = ANY\(\$2::text\[\]\) THEN 'present' ELSE 'absent'/i);
  assert.equal(observation.values[6].length, VEHICLE_DISTINCTIVE_FEATURES.length);
  const audit = calls.find((call) => call.sql.includes("vehicle.distinctive_features_review"));
  assert.ok(audit);
  assert.equal(audit.values[0], 4);
  assert.deepEqual(JSON.parse(audit.values[2]).features, ["rear_bike_rack", "bumper_sticker"]);
});

test("plate association review is explicit, reversible, and audited", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("FROM public.vehicle_plate_associations") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: 8, cluster_id: 12, plate_number: "ABC123", status: "suggested", evidence_count: 3, confidence: 0.96, revision: 1 }] };
        }
        if (sql.includes("UPDATE public.vehicle_plate_associations SET")) {
          return { rows: [{ id: 8, cluster_id: 12, plate_number: "ABC123", status: "confirmed", evidence_count: 3, confidence: 0.96, revision: 2 }] };
        }
        return { rows: [] };
      },
    },
  });

  const result = await repository.reviewVehiclePlateAssociation({
    clusterId: 12,
    plateNumber: "abc123",
    decision: "confirm",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });

  assert.equal(result.status, "confirmed");
  const update = calls.find((call) => call.sql.includes("UPDATE public.vehicle_plate_associations SET"));
  assert.match(update.sql, /status = \$3::varchar/);
  assert.equal(update.values[1], "ABC123");
  const audit = calls.find((call) => call.sql.includes("vehicle.plate_association_review"));
  assert.ok(audit);
  assert.deepEqual(JSON.parse(audit.values[2]), {
    clusterId: 12,
    plateNumber: "ABC123",
    decision: "confirm",
    previousStatus: "suggested",
    status: "confirmed",
    evidenceCount: 3,
    revision: 2,
  });
});

test("vehicle intelligence settings always navigate to their dedicated route", async () => {
  const [shell, settingsForm] = await Promise.all([
    source("components/settings/SettingsShell.jsx"),
    source("app/settings/SettingsForm.jsx"),
  ]);
  assert.match(shell, /href: "\/settings\/vehicle-intelligence"/);
  assert.match(shell, /<Link key=\{item\.id\} href=\{item\.href\}/);
  assert.doesNotMatch(shell, /isLocalSection|onSelect &&/);
  assert.doesNotMatch(settingsForm, /onSelect=\{setActiveSection\}/);
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
  assert.equal(calls[0].values.length, 4);
  assert.equal(calls[0].values[3], null);
  assert.match(calls[0].text, /JOIN LATERAL[\s\S]*?asset_type = \$2[\s\S]*?algorithm_version = \$3/i);
  assert.doesNotMatch(calls[0].text, /JOIN public\.capture_assets representative ON/i);
  assert.match(calls[0].text, /ORDER BY clusters\.updated_at DESC, clusters\.id DESC/i);
  assert.match(calls[0].text, /filter_observation\.attribute_key = 'feature:' \|\| \$4::varchar/i);
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
