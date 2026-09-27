import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import { COLOR_SIGNATURE_VERSION, colorSignatureDistance, colorSignatureReliability, createColorSignature } from "../lib/vehicle-color-signature.mjs";
import { resolveStoragePath } from "../lib/storage-path.mjs";
import {
  VEHICLE_EMBEDDING_BYTES,
  VEHICLE_REID_MODEL,
  VehicleReidEngine,
  cosineSimilarity,
  decodeVehicleEmbedding,
  encodeVehicleEmbedding,
  selectVehicleDetection,
} from "../lib/vehicle-reid.mjs";

function solidColorSignature(red, green, blue) {
  return createColorSignature(Uint8Array.from(
    Array.from({ length: 16 * 16 }, () => [red, green, blue]).flat()
  ));
}

function embedding(...entries) {
  const values = new Float32Array(512);
  entries.forEach(([index, value]) => { values[index] = value; });
  return encodeVehicleEmbedding(values);
}

test("color signatures distinguish vehicle color distributions with an explainable score", () => {
  const red = solidColorSignature(220, 30, 30);
  const blue = solidColorSignature(30, 50, 220);
  assert.match(red, /^[0-9a-f]{40}$/);
  assert.equal(colorSignatureDistance(red, red), 0);
  assert.ok(colorSignatureDistance(red, blue) >= 0.5);
});

test("vehicle-focused color ignores gray hue and separates body colors from a shared scene", () => {
  const scene = (vehicle, border = [70, 105, 65]) => {
    const pixels = [];
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        pixels.push(...(x >= 3 && x <= 12 && y >= 3 && y <= 11 ? vehicle : border));
      }
    }
    return createColorSignature(Uint8Array.from(pixels));
  };
  const red = scene([210, 28, 35]);
  const redWithDifferentBorder = scene([195, 35, 42], [55, 85, 110]);
  const white = scene([220, 220, 216]);
  const black = scene([28, 30, 32]);

  assert.ok(colorSignatureReliability(red) > colorSignatureReliability(white));
  assert.ok(colorSignatureDistance(red, redWithDifferentBorder) < colorSignatureDistance(red, white));
  assert.ok(colorSignatureDistance(red, redWithDifferentBorder) < colorSignatureDistance(red, black));
});

test("derived image paths are allowed without weakening traversal protection", () => {
  const resolved = resolveStoragePath("C:/safe/storage", "derived/2026/07/22/vehicle_v1_read_1.jpg");
  assert.match(resolved.replaceAll("\\", "/"), /\/safe\/storage\/derived\/2026\/07\/22\/vehicle_v1_read_1\.jpg$/);
  assert.throws(
    () => resolveStoragePath("C:/safe/storage", "derived/../images/secret.jpg"),
    /Invalid storage path/
  );
});

test("vehicle detector selection uses plate geometry only as a crop anchor", () => {
  const selected = selectVehicleDetection([
    { confidence: 0.96, left: 0.05, top: 0.1, right: 0.45, bottom: 0.8 },
    { confidence: 0.82, left: 0.5, top: 0.2, right: 0.95, bottom: 0.9 },
  ], {
    imageWidth: 1000,
    imageHeight: 600,
    plateBox: [700, 360, 780, 410],
  });
  assert.equal(selected.containsPlate, true);
  assert.equal(selected.left, 0.5);
});

test("vehicle embeddings are fixed-size, normalized, and cosine-ranked", () => {
  const left = decodeVehicleEmbedding(embedding([0, 3], [1, 4]));
  const sameDirection = decodeVehicleEmbedding(embedding([0, 6], [1, 8]));
  const orthogonal = decodeVehicleEmbedding(embedding([2, 1]));
  assert.equal(encodeVehicleEmbedding(left).length, VEHICLE_EMBEDDING_BYTES);
  assert.ok(Math.abs(cosineSimilarity(left, sameDirection) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(left, orthogonal)) < 1e-6);
});

test("pinned OpenVINO Vehicle ReID model produces a normalized descriptor", async () => {
  const image = await sharp({
    create: { width: 240, height: 160, channels: 3, background: { r: 180, g: 35, b: 40 } },
  }).jpeg().toBuffer();
  const descriptor = await new VehicleReidEngine().embed(image);
  assert.equal(descriptor.length, 512);
  const magnitude = Math.sqrt(Array.from(descriptor).reduce((sum, value) => sum + value ** 2, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-5);
});
