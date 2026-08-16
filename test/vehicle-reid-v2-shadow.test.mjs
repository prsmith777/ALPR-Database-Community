import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  cosineSimilarityFromBytes,
  VehicleReidV2ShadowService,
} from "../lib/vehicle-reid-v2-shadow.mjs";
import {
  VehicleReidV2ShadowRepository,
  vehicleReidV2ShadowRepositoryInternals,
} from "../lib/vehicle-reid-v2-shadow-repository.mjs";

const root = new URL("..", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, root), "utf8");
}

function embedding(values) {
  const bytes = Buffer.alloc(512 * 4);
  for (let index = 0; index < Math.min(values.length, 512); index += 1) {
    bytes.writeFloatLE(values[index], index * 4);
  }
  return bytes;
}

function row(overrides = {}) {
  const derivativeId = Number(overrides.derivative_id || 1);
  return {
    derivative_id: derivativeId,
    asset_id: derivativeId + 100,
    storage_path: `derived/vehicle-crops/${derivativeId}.jpg`,
    content_sha256: String(derivativeId).padStart(64, "0"),
    image_width: 320,
    image_height: 180,
    derivative_created_at: "2026-08-15 12:00:00.123456+00",
    embedding_id: derivativeId + 200,
    embedding: embedding([1, 0]),
    model_name: "vehicle-reid-0001-ir-fp16-v1",
    embedding_algorithm_version: "canonical-overview-crop-embedding-v1",
    read_id: derivativeId + 300,
    plate_number: `PLATE${derivativeId}`,
    observed_plate: `PLATE${derivativeId}`,
    camera_name: "Street LPR 1",
    read_timestamp: "2026-08-15 12:00:00.123456+00",
    overview_context: "street",
    source_kind: "overview_primary",
    plate_numbers: [`PLATE${derivativeId}`],
    camera_names: ["Street LPR 1"],
    cluster_ids: [derivativeId + 400],
    color_status: "ready",
    color_value: "red",
    color_confidence: 0.9,
    body_type_status: "ready",
    body_type_value: "car",
    body_type_confidence: 0.8,
    total_sources: "3",
    ...overrides,
  };
}

test("cosine comparison requires valid finite 512-value embeddings", () => {
  assert.ok(Math.abs(cosineSimilarityFromBytes(embedding([1, 0]), embedding([0.8, 0.6])) - 0.8) < 1e-6);
  assert.equal(cosineSimilarityFromBytes(Buffer.alloc(4), embedding([1, 0])), null);
  assert.equal(cosineSimilarityFromBytes(embedding([]), embedding([1, 0])), null);
  const invalid = embedding([1, 0]);
  invalid.writeFloatLE(Number.NaN, 0);
  assert.equal(cosineSimilarityFromBytes(invalid, embedding([1, 0])), null);
});

test("shadow ranking uses only crop cosine similarity and leaves review evidence separate", async () => {
  const rows = [
    row({ derivative_id: 1, embedding: embedding([1, 0]), plate_numbers: ["SOURCE"], cluster_ids: [700] }),
    row({
      derivative_id: 2,
      embedding: embedding([0.9, Math.sqrt(0.19)]),
      plate_numbers: ["OTHER"],
      cluster_ids: [701],
      color_value: "blue",
      body_type_value: "truck",
    }),
    row({
      derivative_id: 3,
      embedding: embedding([0.8, 0.6]),
      plate_numbers: ["SOURCE"],
      cluster_ids: [700],
      color_value: "red",
      body_type_value: "car",
    }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources() { return rows; },
      async getCurrentSource() { return null; },
    },
  });

  const overview = await service.getOverview({ sourceDerivativeId: 1, resultLimit: 2 });
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [2, 3]);
  assert.equal(overview.matches[0].similarity, 0.9);
  assert.equal(overview.matches[1].similarity, 0.8);
  assert.equal(overview.winnerMargin, 0.1);
  assert.deepEqual(overview.matches[0].reviewEvidence, {
    plateAgreement: false,
    currentProfileAgreement: false,
    colorAgreement: "differs",
    bodyTypeAgreement: "differs",
  });
  assert.deepEqual(overview.matches[1].reviewEvidence, {
    plateAgreement: true,
    currentProfileAgreement: true,
    colorAgreement: "agrees",
    bodyTypeAgreement: "agrees",
  });
});

test("shadow overview bounds browsing, searches current evidence, and skips invalid candidates", async () => {
  const rows = [
    row({ derivative_id: 1, camera_names: ["Street LPR 1"], total_sources: "12" }),
    row({ derivative_id: 2, camera_names: ["Entry LPR 2"], embedding: Buffer.alloc(12), total_sources: "12" }),
    row({ derivative_id: 3, camera_names: ["Street LPR 2"], total_sources: "12" }),
  ];
  const service = new VehicleReidV2ShadowService({
    repository: {
      async listCurrentSources(options) {
        assert.deepEqual(options, { limit: 10_000 });
        return rows;
      },
      async getCurrentSource() { return null; },
    },
  });
  const overview = await service.getOverview({
    search: "entry lpr 2",
    page: 100,
    pageSize: 1,
    sourceDerivativeId: 1,
  });
  assert.equal(overview.stats.totalSources, 12);
  assert.equal(overview.stats.scannedSources, 3);
  assert.equal(overview.stats.truncated, true);
  assert.equal(overview.pagination.page, 1);
  assert.deepEqual(overview.sources.map((item) => item.derivativeId), [2]);
  assert.deepEqual(overview.matches.map((item) => item.derivativeId), [3]);
});

test("repository scans only exact current identity links and performs no writes", async () => {
  const calls = [];
  const repository = new VehicleReidV2ShadowRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    },
  });
  await repository.listCurrentSources({ limit: 99_999 });
  await repository.getCurrentSource(44);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values.at(-1), 10_000);
  assert.equal(calls[1].values.at(-1), 44);
  for (const call of calls) {
    assert.match(call.text, /identity_eligible = TRUE/);
    assert.match(call.text, /vehicle_image_status = 'ready'/);
    assert.match(call.text, /vehicle_image_path = links\.source_path_snapshot/);
    assert.match(call.text, /vehicle_image_source_kind = links\.source_kind/);
    assert.match(call.text, /vehicle_image_updated_at IS NOT DISTINCT FROM links\.source_updated_at/);
    assert.match(call.text, /vehicle_asset_embeddings/);
    assert.match(call.text, /vehicle_asset_attribute_observations/);
    assert.match(call.text, /embeddings\.source_sha256 = derivatives\.content_sha256/);
    assert.match(call.text, /color\.source_sha256 = derivatives\.content_sha256/);
    assert.match(call.text, /body\.source_sha256 = derivatives\.content_sha256/);
    assert.doesNotMatch(call.text, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/);
  }
  assert.equal(vehicleReidV2ShadowRepositoryInternals.MAX_SCAN_SOURCES, 10_000);
});

test("shadow review surface is read-only, permission-gated, and provider-neutral", async () => {
  const [actions, page, component, navigation, service, repository] = await Promise.all([
    source("app/actions.js"),
    source("app/visual_search/reid-v2/page.jsx"),
    source("components/VehicleReidV2Shadow.jsx"),
    source("lib/vehicle-intelligence-navigation.mjs"),
    source("lib/vehicle-reid-v2-shadow.mjs"),
    source("lib/vehicle-reid-v2-shadow-repository.mjs"),
  ]);
  assert.match(actions, /export async function getVehicleReidV2Shadow/);
  assert.match(actions, /getVehicleReidV2Shadow[\s\S]*?requirePermission\("plate\.read"\)/);
  assert.match(page, /requirePagePermission\("plate\.read"\)/);
  assert.match(navigation, /ReID v2 Shadow/);
  assert.match(component, /Read-only/);
  assert.match(component, /never alter the score or order/);
  assert.match(component, /does not create or change a vehicle profile, assignment, notification/);
  assert.doesNotMatch(`${service}\n${repository}`, /plate recognizer|plates?recognizer\.com/i);
  assert.doesNotMatch(`${service}\n${repository}`, /openvino-node/);
});
