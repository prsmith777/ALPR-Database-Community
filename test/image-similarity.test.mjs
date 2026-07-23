import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import {
  calculateVehicleCrop,
  createDHash,
  decodeVisualUploadDataUrl,
  explainSimilarity,
  hammingDistance,
  normalizeBatchSize,
  normalizeCameraCropProfile,
} from "../lib/image-similarity.mjs";
import { resolveStoragePath } from "../lib/storage-path.mjs";
import { CaptureAssetService } from "../lib/capture-asset-service.mjs";

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

  assert.deepEqual(
    explainSimilarity({ sourceSha256: "same", candidateSha256: "same", distance: 0 }),
    { exact: true, distance: 0, score: 100, label: "Exact duplicate" }
  );
  assert.equal(
    explainSimilarity({ sourceSha256: "a", candidateSha256: "b", distance: 6 }).label,
    "Near-identical crop"
  );
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
});

test("plate tables render the visual-search link only for an open image", async () => {
  const plateTable = await readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8");
  assert.match(
    plateTable,
    /\{canRead && selectedImage && <Button[\s\S]*?href=\{`\/visual_search\?readId=\$\{selectedImage\.id\}`\}/
  );
});

test("indexing creates a derived crop and hashes without replacing the source", async () => {
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
    logger: { warn: assert.fail },
  });

  const asset = await service.indexRead(read);
  assert.deepEqual(source, original);
  assert.match(asset.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(asset.perceptual_hash, /^[0-9a-f]{16}$/);
  assert.match(asset.derived_path, /^derived\/2026\/07\/22\/vehicle_v2_read_17\.jpg$/);
  assert.ok(derived.get(asset.derived_path)?.length > 0);
  const metadata = await sharp(derived.get(asset.derived_path)).metadata();
  assert.ok(metadata.width <= 100);
  assert.ok(metadata.height <= 80);
});

test("search ranks exact and near matches and excludes distant crops", async () => {
  const source = {
    read_id: 1,
    derived_path: "derived/source.jpg",
    source_sha256: "a".repeat(64),
    perceptual_hash: "0000000000000000",
    plate_number: "SOURCE",
    camera_name: "Street",
    timestamp: "2026-07-22T18:00:00.000Z",
  };
  const candidate = (overrides) => ({
    read_id: 2,
    derived_path: "derived/candidate.jpg",
    source_sha256: "b".repeat(64),
    perceptual_hash: "0000000000000001",
    plate_number: "CANDIDATE",
    camera_name: "Driveway",
    timestamp: "2026-07-22T18:01:00.000Z",
    ...overrides,
  });
  const candidates = [
    candidate({ read_id: 2 }),
    candidate({ read_id: 3, source_sha256: source.source_sha256, perceptual_hash: "ffffffffffffffff" }),
    candidate({ read_id: 4, perceptual_hash: "ffffffffffffffff" }),
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
  assert.equal(result.searchedCandidates, 3);
  assert.deepEqual(result.matches.map((match) => match.readId), [3, 2]);
  assert.equal(result.matches[0].label, "Exact duplicate");
  assert.equal(result.matches[1].distance, 1);
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
  const pixels = await sharp(upload).rotate().resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  const candidate = {
    read_id: 99,
    derived_path: "derived/match.jpg",
    source_sha256: crypto.createHash("sha256").update(upload).digest("hex"),
    perceptual_hash: createDHash(pixels),
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
