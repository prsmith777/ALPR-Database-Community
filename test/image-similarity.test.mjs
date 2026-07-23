import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import {
  COLOR_SIGNATURE_VERSION,
  calculateVehicleCrop,
  colorSignatureDistance,
  colorSignatureReliability,
  createColorSignature,
  createDHash,
  decodeVisualUploadDataUrl,
  explainSimilarity,
  hammingDistance,
  normalizeBatchSize,
  normalizeCameraCropProfile,
} from "../lib/image-similarity.mjs";
import { resolveStoragePath } from "../lib/storage-path.mjs";
import { CaptureAssetService } from "../lib/capture-asset-service.mjs";
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

test("vehicle crop expands a plate box while remaining inside the source image", () => {
  const crop = calculateVehicleCrop({
    width: 1920,
    height: 1080,
    cropCoordinates: [900, 700, 1020, 760],
  });

  assert.equal(crop.mode, "adaptive_context");
  assert.equal(crop.contextPercent, 90);
  assert.ok(crop.left <= 900);
  assert.ok(crop.top <= 700);
  assert.ok(crop.left + crop.width >= 1020);
  assert.ok(crop.top + crop.height >= 760);
  assert.ok(crop.left >= 0);
  assert.ok(crop.top >= 0);
  assert.ok(crop.left + crop.width <= 1920);
  assert.ok(crop.top + crop.height <= 1080);
});

test("camera profiles support custom context, vertical position, and full-frame fallback", () => {
  const fallback = calculateVehicleCrop({ width: 640, height: 480, cropCoordinates: null });
  assert.equal(fallback.mode, "full_frame_fallback");
  assert.deepEqual([fallback.left, fallback.top, fallback.width, fallback.height], [0, 0, 640, 480]);

  const custom = calculateVehicleCrop({
    width: 1000,
    height: 800,
    cropCoordinates: [450, 500, 550, 550],
    profile: { cropMode: "custom", contextPercent: 60, verticalOffsetPercent: -10, profileVersion: 3 },
  });
  assert.equal(custom.mode, "custom_context");
  assert.equal(custom.width, 600);
  assert.equal(custom.height, 480);
  assert.equal(custom.profileVersion, 3);
  assert.ok(custom.top < 500 - custom.height / 2);

  const full = calculateVehicleCrop({
    width: 1000,
    height: 800,
    cropCoordinates: [450, 500, 550, 550],
    profile: { cropMode: "full_frame" },
  });
  assert.deepEqual([full.left, full.top, full.width, full.height], [0, 0, 1000, 800]);
  assert.equal(full.mode, "full_frame");
});

test("camera profile inputs are clamped to safe setup ranges", () => {
  assert.deepEqual(
    normalizeCameraCropProfile({ cropMode: "custom", contextPercent: 150, verticalOffsetPercent: -90, profileVersion: 4 }),
    { cropMode: "custom", contextPercent: 100, verticalOffsetPercent: -25, profileVersion: 4 }
  );
});

test("uploaded visual queries accept only bounded raster data URLs", async () => {
  const jpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "navy" },
  }).jpeg().toBuffer();
  const decoded = decodeVisualUploadDataUrl(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  assert.deepEqual(decoded.buffer, jpeg);
  assert.equal(decoded.mimeType, "image/jpeg");
  assert.throws(() => decodeVisualUploadDataUrl("data:image/svg+xml;base64,PHN2Zz4="), (error) => error.code === "INVALID_VISUAL_UPLOAD");
  assert.throws(() => decodeVisualUploadDataUrl(`data:image/jpeg;base64,${"A".repeat(9_000_000)}`), (error) => error.code === "UPLOAD_TOO_LARGE");
});

test("dHash is stable and Hamming distance is explainable", () => {
  const descendingRows = Uint8Array.from(
    Array.from({ length: 8 }, () => [9, 8, 7, 6, 5, 4, 3, 2, 1]).flat()
  );
  const hash = createDHash(descendingRows);
  assert.equal(hash, "ffffffffffffffff");
  assert.equal(hammingDistance(hash, hash), 0);
  assert.equal(hammingDistance("0000000000000000", hash), 64);

  const exact = explainSimilarity({ sourceSha256: "same", candidateSha256: "same", distance: 0 });
  assert.equal(exact.exact, true);
  assert.equal(exact.score, 100);
  assert.equal(exact.label, "Exact duplicate");
  assert.equal(exact.signalCount, 1);
  assert.equal(
    explainSimilarity({ sourceSha256: "a", candidateSha256: "b", distance: 6 }).label,
    "Visual candidate"
  );
});

test("color signatures distinguish vehicle color distributions with an explainable score", () => {
  const red = solidColorSignature(220, 30, 30);
  const blue = solidColorSignature(30, 50, 220);
  assert.match(red, /^[0-9a-f]{40}$/);
  assert.equal(colorSignatureDistance(red, red), 0);
  assert.ok(colorSignatureDistance(red, blue) >= 0.5);
  const combined = explainSimilarity({
    sourceSha256: "a",
    candidateSha256: "b",
    distance: 8,
    colorDistance: colorSignatureDistance(red, red),
  });
  assert.equal(combined.signalCount, 2);
  assert.equal(combined.rankingVersion, "vehicle-focus-v2");
  assert.equal(combined.colorScore, 100);
  assert.ok(combined.score > combined.structuralScore);
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

test("index batches are deliberately bounded", () => {
  assert.equal(normalizeBatchSize("0"), 1);
  assert.equal(normalizeBatchSize("500"), 50);
  assert.equal(normalizeBatchSize("invalid"), 20);
});

test("derived image paths are allowed without weakening traversal protection", () => {
  const resolved = resolveStoragePath("C:/safe/storage", "derived/2026/07/22/vehicle_v1_read_1.jpg");
  assert.match(resolved.replaceAll("\\", "/"), /\/safe\/storage\/derived\/2026\/07\/22\/vehicle_v1_read_1\.jpg$/);
  assert.throws(
    () => resolveStoragePath("C:/safe/storage", "derived/../images/secret.jpg"),
    /Invalid storage path/
  );
});

test("migration keeps image similarity inert and source images immutable", async () => {
  const migration = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  const section = migration.slice(migration.indexOf("Local-only visual search foundation"));
  assert.match(section, /CREATE TABLE IF NOT EXISTS public\.capture_assets/i);
  assert.match(section, /REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/i);
  assert.match(section, /source_image_path VARCHAR\(255\) NOT NULL/i);
  assert.match(section, /derived_path VARCHAR\(255\)/i);
  assert.match(section, /source_sha256 CHAR\(64\)/i);
  assert.match(section, /perceptual_hash CHAR\(16\)/i);
  assert.match(section, /2026072207_image_similarity_foundation/i);
  assert.match(section, /CREATE TABLE IF NOT EXISTS public\.camera_visual_profiles/i);
  assert.match(section, /crop_profile_version INTEGER NOT NULL DEFAULT 1/i);
  assert.match(section, /2026072208_camera_visual_profiles/i);
  assert.match(section, /color_signature CHAR\(40\)/i);
  assert.match(section, /2026072301_visual_color_signatures/i);
  assert.match(section, /color_signature_version SMALLINT/i);
  assert.match(section, /2026072302_vehicle_focus_ranking/i);
  assert.match(section, /vehicle_embedding BYTEA/i);
  assert.match(section, /octet_length\(vehicle_embedding\) = 2048/i);
  assert.match(section, /2026072303_vehicle_reid_embeddings/i);
  assert.equal(/UPDATE\s+public\.plate_reads/i.test(section), false);
  assert.equal(/INSERT\s+INTO\s+public\.capture_assets[\s\S]*SELECT/i.test(section), false);
});

test("visual-search actions enforce read and maintenance permissions", async () => {
  const actions = await readFile(new URL("../app/actions.js", import.meta.url), "utf8");
  assert.match(actions, /getVisualSearchBootstrap[\s\S]*?requirePermission\("plate\.read"\)/);
  assert.match(actions, /indexCaptureAssetsBatch[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /findSimilarCaptures[\s\S]*?requirePermission\("plate\.read"\)/);
  assert.match(actions, /saveCameraVisualProfile[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /indexCameraCaptureAssetsBatch[\s\S]*?requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /findSimilarUploadedCaptures[\s\S]*?requirePermission\("plate\.read"\)/);
});

test("camera crop setup exposes preview controls and version-aware indexing", async () => {
  const component = await readFile(new URL("../components/VisualSearch.jsx", import.meta.url), "utf8");
  const repository = await readFile(new URL("../lib/capture-asset-repository.mjs", import.meta.url), "utf8");
  assert.match(component, /Camera crop setup/);
  assert.match(component, /Auto \(recommended\)/);
  assert.match(component, /Vehicle context/);
  assert.match(component, /Vertical position/);
  assert.match(component, /Save & reindex next 20/);
  assert.match(repository, /crop_profile_version = COALESCE\(cvp\.profile_version, 1\)/);
  assert.match(repository, /LOWER\(BTRIM\(pr\.camera_name\)\) = LOWER\(BTRIM\(\$\$\{values\.length\}\)\)/);
  assert.match(component, /Drop a vehicle image here, or choose a file/);
  assert.match(component, /processed transiently/);
  assert.match(component, /ranked only by learned Vehicle ReID image embeddings/);
});

test("plate tables render the visual-search link only for an open image", async () => {
  const plateTable = await readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8");
  assert.match(
    plateTable,
    /\{canRead && selectedImage && <Button[\s\S]*?href=\{`\/visual_search\?readId=\$\{selectedImage\.id\}`\}/
  );
});

test("indexing stores a learned embedding without replacing the source", async () => {
  const source = await sharp({
    create: {
      width: 100,
      height: 80,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  }).jpeg().toBuffer();
  const original = Buffer.from(source);
  const derived = new Map();
  const assets = new Map();
  const read = {
    id: 17,
    plate_number: "TEST17",
    observed_plate: "TESTI7",
    camera_name: "Driveway",
    timestamp: "2026-07-22T18:00:00.000Z",
    image_path: "images/2026/07/22/source.jpg",
    crop_coordinates: [40, 50, 60, 60],
  };
  const repository = {
    getAsset: async (readId) => assets.get(Number(readId)) || null,
    getCameraProfile: async () => ({ cropMode: "custom", contextPercent: 90, verticalOffsetPercent: 0, profileVersion: 2 }),
    recordReady: async (asset) => {
      assets.set(asset.read.id, {
        read_id: asset.read.id,
        ...asset,
        source_sha256: asset.sourceSha256,
        perceptual_hash: asset.perceptualHash,
        vehicle_embedding: asset.vehicleEmbedding,
        embedding_model: asset.embeddingModel,
        detector_model: asset.detectorModel,
        detection_confidence: asset.detectionConfidence,
        derived_path: asset.derivedPath,
        plate_number: asset.read.plate_number,
        observed_plate: asset.read.observed_plate,
        camera_name: asset.read.camera_name,
        timestamp: asset.read.timestamp,
      });
    },
    recordFailure: async () => assert.fail("valid source should not fail"),
  };
  const service = new CaptureAssetService({
    repository,
    fileStorage: {
      getImage: async () => source,
      saveDerivedImage: async (relativePath, buffer) => derived.set(relativePath, buffer),
    },
    vehicleMatcher: {
      analyze: async (buffer) => ({
        crop: { left: 0, top: 0, width: 100, height: 80, mode: "vehicle_detector", detectionConfidence: 0.91 },
        cropBuffer: buffer,
        embedding: decodeVehicleEmbedding(embedding([0, 1])),
        embeddingModel: VEHICLE_REID_MODEL,
        detectorModel: "test-detector-v1",
        imageWidth: 100,
        imageHeight: 80,
      }),
    },
    logger: { warn: assert.fail },
  });

  const asset = await service.indexRead(read);
  assert.deepEqual(source, original);
  assert.match(asset.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(asset.perceptual_hash, /^[0-9a-f]{16}$/);
  assert.equal(asset.vehicle_embedding.length, VEHICLE_EMBEDDING_BYTES);
  assert.equal(asset.embedding_model, VEHICLE_REID_MODEL);
  assert.equal(asset.detection_confidence, 0.91);
  assert.match(asset.derived_path, /^derived\/2026\/07\/22\/vehicle_reid_v1_read_17\.jpg$/);
  assert.ok(derived.get(asset.derived_path)?.length > 0);
  const metadata = await sharp(derived.get(asset.derived_path)).metadata();
  assert.ok(metadata.width <= 100);
  assert.ok(metadata.height <= 80);
});

test("search ranks exact and learned embedding matches without using plates", async () => {
  const source = {
    read_id: 1,
    derived_path: "derived/source.jpg",
    source_sha256: "a".repeat(64),
    vehicle_embedding: embedding([0, 1]),
    embedding_model: VEHICLE_REID_MODEL,
    plate_number: "SOURCE",
    camera_name: "Street",
    timestamp: "2026-07-22T18:00:00.000Z",
  };
  const candidate = (overrides) => ({
    read_id: 2,
    derived_path: "derived/candidate.jpg",
    source_sha256: "b".repeat(64),
    vehicle_embedding: embedding([0, 0.95], [1, 0.05]),
    embedding_model: VEHICLE_REID_MODEL,
    plate_number: "CANDIDATE",
    camera_name: "Driveway",
    timestamp: "2026-07-22T18:01:00.000Z",
    ...overrides,
  });
  const candidates = [
    candidate({ read_id: 2, plate_number: "SOURCE", vehicle_embedding: embedding([1, 1]) }),
    candidate({ read_id: 3, plate_number: "OTHER", vehicle_embedding: embedding([0, 0.98], [1, 0.02]) }),
    candidate({ read_id: 4, source_sha256: source.source_sha256, vehicle_embedding: embedding([2, 1]) }),
    candidate({ read_id: 5, embedding_model: "obsolete-model" }),
  ];
  const repository = {
    getAsset: async () => source,
    listSearchCandidates: async () => candidates,
  };
  const service = new CaptureAssetService({
    repository,
    fileStorage: {},
  });

  const result = await service.search({ readId: 1 });
  assert.equal(result.searchedCandidates, 4);
  assert.deepEqual(result.matches.map((match) => match.readId), [4, 3, 2]);
  assert.equal(result.matches[0].label, "Exact duplicate");
  assert.equal(result.matches[1].plateNumber, "OTHER");
  assert.equal(result.matches[2].plateNumber, "SOURCE");
  assert.ok(result.matches[1].score > result.matches[2].score);
  assert.equal(result.matches[1].plateConfirmed, false);
  candidates[1].plate_number = "SOURCE";
  candidates[0].plate_number = "OTHER";
  const platesSwapped = await service.search({ readId: 1 });
  assert.deepEqual(platesSwapped.matches.map((match) => match.readId), [4, 3, 2]);
});

test("an exact upload remains a byte duplicate without inferring plate identity", async () => {
  const upload = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 205, g: 30, b: 35 } },
  }).jpeg().toBuffer();
  const base = {
    derived_path: "derived/candidate.jpg",
    vehicle_embedding: embedding([0, 1]),
    embedding_model: VEHICLE_REID_MODEL,
    observed_plate: "069YQZ",
    camera_name: "Entry LPR 1",
    timestamp: "2026-07-23T03:00:00.000Z",
  };
  const candidates = [
    {
      ...base,
      read_id: 1,
      plate_number: "069YQZ",
      source_sha256: crypto.createHash("sha256").update(upload).digest("hex"),
    },
    {
      ...base,
      read_id: 2,
      plate_number: "069YQZ",
      source_sha256: "b".repeat(64),
      vehicle_embedding: embedding([1, 1]),
    },
    {
      ...base,
      read_id: 3,
      plate_number: "OTHER",
      source_sha256: "c".repeat(64),
      vehicle_embedding: embedding([0, 0.99], [1, 0.01]),
    },
  ];
  const service = new CaptureAssetService({
    repository: { listSearchCandidates: async () => candidates },
    fileStorage: {},
    vehicleMatcher: {
      analyze: async () => ({
        embedding: decodeVehicleEmbedding(embedding([0, 1])),
        embeddingModel: VEHICLE_REID_MODEL,
      }),
    },
  });

  const result = await service.searchUpload({
    dataUrl: `data:image/jpeg;base64,${upload.toString("base64")}`,
    fileName: "truck.jpg",
  });
  assert.deepEqual(result.matches.map((match) => match.readId), [1, 3, 2]);
  assert.equal(result.matches[0].exact, true);
  assert.equal(result.matches[1].plateConfirmed, false);
  assert.equal(result.matches[2].plateConfirmed, false);
});

test("uploaded-image search is transient and uses the existing filtered index", async () => {
  const upload = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  }).jpeg().toBuffer();
  const candidate = {
    read_id: 99,
    derived_path: "derived/match.jpg",
    source_sha256: crypto.createHash("sha256").update(upload).digest("hex"),
    vehicle_embedding: embedding([0, 1]),
    embedding_model: VEHICLE_REID_MODEL,
    plate_number: "MATCH99",
    camera_name: "Street LPR 2",
    timestamp: "2026-07-23T03:00:00.000Z",
  };
  let filters = null;
  const service = new CaptureAssetService({
    repository: {
      listSearchCandidates: async (input) => {
        filters = input;
        return [candidate];
      },
    },
    fileStorage: new Proxy({}, { get: () => assert.fail("uploaded queries must not use file storage") }),
    vehicleMatcher: {
      analyze: async () => ({
        embedding: decodeVehicleEmbedding(embedding([0, 1])),
        embeddingModel: VEHICLE_REID_MODEL,
      }),
    },
  });

  const result = await service.searchUpload({
    dataUrl: `data:image/jpeg;base64,${upload.toString("base64")}`,
    fileName: "driveway.jpg",
    cameraNames: ["Street LPR 2"],
    startDate: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(result.source.uploaded, true);
  assert.equal(result.source.imageUrl, null);
  assert.equal(result.source.plateNumber, "driveway.jpg");
  assert.equal(result.matches[0].readId, 99);
  assert.equal(result.matches[0].exact, true);
  assert.deepEqual(filters.cameraNames, ["Street LPR 2"]);
  assert.equal(filters.readId, null);
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
