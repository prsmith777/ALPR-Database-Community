import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { FileStorage } from "../lib/fileStorage.js";
import { VehicleImageAssetCatalogService } from "../lib/vehicle-image-asset-catalog.mjs";
import {
  canonicalVehicleImageAssetPath,
  isOverviewAssetCandidate,
  OVERVIEW_ASSET_SOURCE_KINDS,
  overviewAssetSourceDetails,
} from "../lib/vehicle-image-asset-model.mjs";
import { VehicleImageAssetRepository } from "../lib/vehicle-image-asset-repository.mjs";
import { validateAndDeleteCleanupCandidate } from "../lib/storage-cleanup.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function readyRead(id, sourceKind, overrides = {}) {
  const isEntry = String(sourceKind || "").startsWith("entry_");
  return {
    id,
    camera_name: isEntry ? "Entry LPR 1" : "Street LPR 1",
    timestamp: "2026-08-14T12:00:00.000Z",
    vehicle_image_status: "ready",
    vehicle_image_path: `derived/overview/${id}.jpg`,
    vehicle_image_timestamp: "2026-08-14T12:00:01.000Z",
    vehicle_image_score: 0.92,
    vehicle_image_detection_confidence: 0.95,
    vehicle_image_detection_box: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 },
    vehicle_image_width: 640,
    vehicle_image_height: 360,
    vehicle_image_sampled_count: 61,
    vehicle_image_selection_metadata: {
      overviewContext: isEntry ? "entry" : "street",
      sourceCameraName: isEntry ? "Entry Overview" : "Street Overview",
    },
    vehicle_image_source_kind: sourceKind,
    vehicle_image_source_read_id: null,
    vehicle_image_updated_at: "2026-08-14T12:00:02.000Z",
    ...overrides,
  };
}

async function jpeg() {
  return sharp({
    create: {
      width: 64,
      height: 36,
      channels: 3,
      background: { r: 30, g: 90, b: 160 },
    },
  }).jpeg({ quality: 91 }).toBuffer();
}

function inMemoryCatalog(reads, sourceBytes) {
  const assets = new Map();
  const links = new Map();
  const canonicalFiles = new Map();
  const registrations = [];
  let writerDepth = 0;
  let nextAssetId = 1;
  const repository = {
    async getRead(readId) {
      return reads.get(Number(readId)) || null;
    },
    async withStorageWriter(operation) {
      writerDepth += 1;
      try {
        return await operation(this);
      } finally {
        writerDepth -= 1;
      }
    },
    async registerAssetForRead({ readSnapshot, asset, link }) {
      assert.equal(writerDepth, 1, "database registration must remain inside the storage writer lock");
      registrations.push({ readSnapshot, asset, link });
      let row = assets.get(asset.contentSha256);
      const assetCreated = !row;
      if (!row) {
        row = {
          id: nextAssetId++,
          content_sha256: asset.contentSha256,
          storage_path: asset.storagePath,
          media_type: asset.mediaType,
          byte_size: asset.byteSize,
          image_width: asset.imageWidth,
          image_height: asset.imageHeight,
        };
        assets.set(asset.contentSha256, row);
      }
      const existing = links.get(readSnapshot.id);
      const linkCreated = !existing;
      const linkUpdated = Boolean(existing) && (
        existing.assetId !== row.id
        || existing.sourcePathSnapshot !== link.sourcePathSnapshot
        || existing.sourceUpdatedAt !== link.sourceUpdatedAt
      );
      links.set(readSnapshot.id, { assetId: row.id, ...link });
      return { asset: row, assetCreated, linkCreated, linkUpdated };
    },
  };
  const fileStorage = {
    reads: 0,
    async getImage(relativePath) {
      this.reads += 1;
      return sourceBytes.get(relativePath) || null;
    },
    async saveDerivedImageIfAbsent(relativePath, bytes) {
      assert.equal(writerDepth, 1, "canonical publication must remain inside the storage writer lock");
      const existing = canonicalFiles.get(relativePath);
      if (existing && !existing.equals(bytes)) throw new Error("canonical mismatch");
      canonicalFiles.set(relativePath, Buffer.from(bytes));
      return { relativePath, created: !existing };
    },
  };
  return {
    service: new VehicleImageAssetCatalogService({ repository, fileStorage }),
    repository,
    fileStorage,
    assets,
    links,
    canonicalFiles,
    registrations,
  };
}

test("Overview asset eligibility is explicit and excludes plate-camera fallbacks", () => {
  assert.deepEqual(OVERVIEW_ASSET_SOURCE_KINDS, [
    "overview_primary",
    "entry_overview_primary",
    "overview_fallback",
    "overview_pair_share",
    "entry_overview_route_fallback",
    "entry_overview_history",
  ]);
  for (const kind of OVERVIEW_ASSET_SOURCE_KINDS) {
    assert.equal(isOverviewAssetCandidate(readyRead(1, kind)), true, kind);
  }
  for (const kind of ["legacy_plate_camera", "entry_lpr_fallback", null]) {
    assert.equal(isOverviewAssetCandidate(readyRead(1, kind)), false, String(kind));
  }
  assert.equal(isOverviewAssetCandidate(readyRead(1, "overview_primary", {
    vehicle_image_status: "failed",
  })), false);
  assert.equal(isOverviewAssetCandidate(readyRead(1, "overview_primary", {
    vehicle_image_path: " ",
  })), false);
  assert.deepEqual(overviewAssetSourceDetails("entry_overview_route_fallback"), {
    overviewContext: "entry",
    relationship: "display_fallback",
    identityEligible: false,
  });
  assert.deepEqual(overviewAssetSourceDetails("overview_fallback"), {
    overviewContext: "street",
    relationship: "fallback",
    identityEligible: true,
  });
  assert.deepEqual(overviewAssetSourceDetails("overview_pair_share"), {
    overviewContext: "street",
    relationship: "shared",
    identityEligible: true,
  });
  assert.deepEqual(overviewAssetSourceDetails("entry_overview_history"), {
    overviewContext: "entry",
    relationship: "history",
    identityEligible: true,
  });
});

test("canonical asset paths are deterministic and traversal-safe", () => {
  const hash = "ab".padEnd(64, "0");
  assert.equal(
    canonicalVehicleImageAssetPath(hash),
    `derived/vehicle-assets/ab/${hash}.jpg`
  );
  for (const invalid of ["AB".padEnd(64, "0"), "../escape", "a".repeat(63), "g".repeat(64)]) {
    assert.throws(() => canonicalVehicleImageAssetPath(invalid), {
      code: "INVALID_VEHICLE_IMAGE_ASSET_HASH",
    });
  }
});

test("create-if-absent storage never replaces canonical bytes", async (t) => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-vehicle-asset-"));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const storage = new FileStorage({ baseDir });
  await storage.initialize();
  const first = Buffer.from("canonical-overview");
  const hash = crypto.createHash("sha256").update(first).digest("hex");
  const relativePath = canonicalVehicleImageAssetPath(hash);

  assert.deepEqual(await storage.saveDerivedImageIfAbsent(relativePath, first), {
    relativePath,
    created: true,
  });
  assert.deepEqual(await storage.saveDerivedImageIfAbsent(relativePath, Buffer.from(first)), {
    relativePath,
    created: false,
  });
  await assert.rejects(
    () => storage.saveDerivedImageIfAbsent(relativePath, Buffer.from("different")),
    { code: "CANONICAL_DERIVED_IMAGE_MISMATCH" }
  );
  assert.deepEqual(await storage.getImage(relativePath), first);
});

test("concurrent canonical publication creates one file and leaves no temporary files", async (t) => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-vehicle-asset-race-"));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const storage = new FileStorage({ baseDir });
  await storage.initialize();
  const bytes = Buffer.from("one-concurrent-overview");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const relativePath = canonicalVehicleImageAssetPath(hash);

  const results = await Promise.all([
    storage.saveDerivedImageIfAbsent(relativePath, bytes),
    storage.saveDerivedImageIfAbsent(relativePath, Buffer.from(bytes)),
  ]);
  assert.deepEqual(results.map((item) => item.created).sort(), [false, true]);
  assert.deepEqual(await storage.getImage(relativePath), bytes);
  const directory = path.join(baseDir, "derived", "vehicle-assets", hash.slice(0, 2));
  assert.deepEqual((await fs.readdir(directory)).sort(), [`${hash}.jpg`]);
});

test("canonical publication rejects a symbolic-link ancestor", async (t) => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-vehicle-asset-safe-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-vehicle-asset-outside-"));
  t.after(() => Promise.all([
    fs.rm(baseDir, { recursive: true, force: true }),
    fs.rm(outsideDir, { recursive: true, force: true }),
  ]));
  const storage = new FileStorage({ baseDir });
  await storage.initialize();
  await fs.symlink(
    outsideDir,
    path.join(baseDir, "derived", "vehicle-assets"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const bytes = Buffer.from("must-stay-inside-storage");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");

  await assert.rejects(
    () => storage.saveDerivedImageIfAbsent(canonicalVehicleImageAssetPath(hash), bytes),
    /cannot contain symbolic links/
  );
  assert.deepEqual(await fs.readdir(outsideDir), []);
});

test("canonical publication rejects a persistent external hard link", async (t) => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-vehicle-asset-hardlink-"));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const storage = new FileStorage({ baseDir });
  await storage.initialize();
  const bytes = Buffer.from("externally-linked-overview");
  const original = Buffer.from(bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const relativePath = canonicalVehicleImageAssetPath(hash);
  const canonicalPath = path.join(baseDir, ...relativePath.split("/"));
  const siblingPath = path.join(baseDir, "external-owner.jpg");
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fs.writeFile(siblingPath, bytes);
  await fs.link(siblingPath, canonicalPath);

  await assert.rejects(
    () => storage.saveDerivedImageIfAbsent(relativePath, bytes),
    { code: "CANONICAL_DERIVED_IMAGE_UNSAFE" }
  );
  assert.deepEqual(await fs.readFile(siblingPath), original);
  assert.deepEqual(await fs.readFile(canonicalPath), original);
});

test("byte-identical primary and shared Overview reads reuse one canonical asset", async () => {
  const image = await jpeg();
  const reads = new Map([
    [101, readyRead(101, "overview_primary")],
    [102, readyRead(102, "overview_pair_share", {
      vehicle_image_source_read_id: 101,
      vehicle_image_selection_metadata: {
        sourceSelection: { sourceCameraName: "Street Overview" },
      },
    })],
    [103, readyRead(103, "entry_overview_route_fallback", {
      camera_name: "Street LPR 1",
      vehicle_image_source_read_id: 201,
    })],
  ]);
  const original = Buffer.from(image);
  const sourceBytes = new Map([...reads.values()].map((read) => [read.vehicle_image_path, image]));
  const catalog = inMemoryCatalog(reads, sourceBytes);

  const primary = await catalog.service.catalogRead(101);
  const shared = await catalog.service.catalogRead(102);
  const displayFallback = await catalog.service.catalogRead(103);

  assert.equal(primary.status, "cataloged");
  assert.equal(primary.assetCreated, true);
  assert.equal(shared.assetCreated, false);
  assert.equal(displayFallback.assetCreated, false);
  assert.equal(primary.contentSha256, shared.contentSha256);
  assert.equal(shared.contentSha256, displayFallback.contentSha256);
  assert.equal(catalog.assets.size, 1);
  assert.equal(catalog.links.size, 3);
  assert.equal(catalog.canonicalFiles.size, 1);
  assert.equal(catalog.links.get(102).relationship, "shared");
  assert.equal(catalog.links.get(102).sourceCameraName, "Street Overview");
  assert.equal(catalog.links.get(103).relationship, "display_fallback");
  assert.equal(catalog.links.get(103).identityEligible, false);
  assert.equal(catalog.links.get(103).readCameraName, "Street LPR 1");
  assert.equal(catalog.links.get(103).overviewContext, "entry");
  assert.deepEqual(image, original, "cataloging must not re-encode or alter source bytes");

  const repeated = await catalog.service.catalogRead(101);
  assert.equal(repeated.canonicalFileCreated, false);
  assert.equal(repeated.assetCreated, false);
  assert.equal(repeated.linkCreated, false);
  assert.equal(repeated.linkUpdated, false);
});

test("different Overview bytes remain distinct and a replaced read link advances", async () => {
  const firstImage = await jpeg();
  const secondImage = await sharp(firstImage).modulate({ brightness: 1.2 }).jpeg().toBuffer();
  const read = readyRead(501, "overview_primary");
  const reads = new Map([[read.id, read]]);
  const sourceBytes = new Map([[read.vehicle_image_path, firstImage]]);
  const catalog = inMemoryCatalog(reads, sourceBytes);

  const first = await catalog.service.catalogRead(read.id);
  read.vehicle_image_path = "derived/overview/501-replacement.jpg";
  read.vehicle_image_updated_at = "2026-08-14T12:05:00.000Z";
  sourceBytes.set(read.vehicle_image_path, secondImage);
  const replacement = await catalog.service.catalogRead(read.id);

  assert.notEqual(first.contentSha256, replacement.contentSha256);
  assert.notEqual(first.storagePath, replacement.storagePath);
  assert.equal(catalog.assets.size, 2);
  assert.equal(catalog.links.size, 1);
  assert.equal(replacement.linkCreated, false);
  assert.equal(replacement.linkUpdated, true);
  assert.equal(catalog.links.get(read.id).assetId, replacement.asset.id);
});

test("ineligible reads never load or write an image", async () => {
  const reads = new Map([
    [1, readyRead(1, "legacy_plate_camera")],
    [2, readyRead(2, "entry_lpr_fallback")],
    [3, readyRead(3, "overview_primary", { vehicle_image_status: "failed" })],
  ]);
  const catalog = inMemoryCatalog(reads, new Map());
  for (const id of reads.keys()) {
    const result = await catalog.service.catalogRead(id);
    assert.equal(result.status, "ineligible");
  }
  assert.equal(catalog.fileStorage.reads, 0);
  assert.equal(catalog.canonicalFiles.size, 0);
  assert.equal(catalog.assets.size, 0);
});

test("missing, corrupt, and non-JPEG Overview sources fail before publication", async () => {
  const png = await sharp({
    create: {
      width: 20,
      height: 10,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  }).png().toBuffer();
  const reads = new Map([
    [701, readyRead(701, "overview_primary")],
    [702, readyRead(702, "overview_primary")],
    [703, readyRead(703, "overview_primary")],
  ]);
  const sourceBytes = new Map([
    [reads.get(702).vehicle_image_path, Buffer.from("not-an-image")],
    [reads.get(703).vehicle_image_path, png],
  ]);
  const catalog = inMemoryCatalog(reads, sourceBytes);

  await assert.rejects(() => catalog.service.catalogRead(701), {
    code: "VEHICLE_IMAGE_ASSET_SOURCE_MISSING",
  });
  await assert.rejects(() => catalog.service.catalogRead(702), {
    code: "VEHICLE_IMAGE_ASSET_INVALID_IMAGE",
  });
  await assert.rejects(() => catalog.service.catalogRead(703), {
    code: "VEHICLE_IMAGE_ASSET_INVALID_JPEG",
  });
  assert.equal(catalog.canonicalFiles.size, 0);
  assert.equal(catalog.registrations.length, 0);
});

test("repository fails closed when the ready Overview snapshot changes", async () => {
  const calls = [];
  const readSnapshot = readyRead(99, "overview_primary", {
    timestamp: "2026-08-14 12:00:00.123456+00",
    vehicle_image_timestamp: "2026-08-14 12:00:01.234567+00",
    vehicle_image_updated_at: "2026-08-14 12:00:02.345678+00",
  });
  const repository = new VehicleImageAssetRepository({
    storageWriterLockHeld: true,
    executor: {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (/FROM public\.plate_reads reads[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
        assert.fail(`Unexpected query after stale snapshot: ${sql}`);
      },
    },
  });
  await assert.rejects(
    () => repository.registerAssetForRead({
      readSnapshot,
      asset: {
        contentSha256: "a".repeat(64),
        storagePath: canonicalVehicleImageAssetPath("a".repeat(64)),
        mediaType: "image/jpeg",
        byteSize: 100,
        imageWidth: 64,
        imageHeight: 36,
      },
      link: {},
    }),
    { code: "VEHICLE_IMAGE_ASSET_SNAPSHOT_CHANGED" }
  );
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /vehicle_image_path IS NOT DISTINCT FROM \$5/);
  assert.match(calls[1].sql, /vehicle_image_source_kind IS NOT DISTINCT FROM \$14/);
  assert.match(calls[1].sql, /vehicle_image_updated_at IS NOT DISTINCT FROM \$16/);
  assert.match(calls[1].sql, /reads\."timestamp"::text AS "timestamp"/);
  assert.match(calls[1].sql, /vehicle_image_timestamp::text AS vehicle_image_timestamp/);
  assert.match(calls[1].sql, /vehicle_image_updated_at::text AS vehicle_image_updated_at/);
  assert.equal(calls[1].values[2], readSnapshot.timestamp);
  assert.equal(calls[1].values[5], readSnapshot.vehicle_image_timestamp);
  assert.equal(calls[1].values[15], readSnapshot.vehicle_image_updated_at);
  assert.match(calls[1].sql, /FOR UPDATE/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.equal(calls.some(({ sql }) => /INSERT INTO public\.vehicle_image_assets/.test(sql)), false);
});

test("repository creates or reuses an asset and refreshes the current read projection", async () => {
  const read = readyRead(601, "overview_primary");
  const hash = "c".repeat(64);
  const asset = {
    contentSha256: hash,
    storagePath: canonicalVehicleImageAssetPath(hash),
    mediaType: "image/jpeg",
    byteSize: 500,
    imageWidth: 64,
    imageHeight: 36,
  };
  const assetRow = {
    id: "41",
    content_sha256: hash,
    storage_path: asset.storagePath,
    media_type: asset.mediaType,
    byte_size: String(asset.byteSize),
    image_width: asset.imageWidth,
    image_height: asset.imageHeight,
  };
  const link = {
    sourceKind: "overview_primary",
    sourceReadId: null,
    relationship: "primary",
    identityEligible: true,
    overviewContext: "street",
    capturedAt: read.vehicle_image_timestamp,
    readCameraName: read.camera_name,
    sourceCameraName: "Street Overview",
    sourcePathSnapshot: read.vehicle_image_path,
    sourceUpdatedAt: read.vehicle_image_updated_at,
    detectionConfidence: read.vehicle_image_detection_confidence,
    detectionBox: read.vehicle_image_detection_box,
    selectionMetadata: read.vehicle_image_selection_metadata,
  };

  const creationCalls = [];
  const createRepository = new VehicleImageAssetRepository({
    storageWriterLockHeld: true,
    executor: {
      async query(sql, values) {
        creationCalls.push({ sql, values });
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (/FROM public\.plate_reads reads[\s\S]*FOR UPDATE/.test(sql)) return { rows: [read] };
        if (/INSERT INTO public\.vehicle_image_assets/.test(sql)) return { rows: [assetRow] };
        if (/SELECT asset_id, source_kind/.test(sql)) return { rows: [] };
        if (/INSERT INTO public\.vehicle_image_asset_reads/.test(sql)) return { rows: [{ asset_id: 41 }] };
        assert.fail(`Unexpected creation query: ${sql}`);
      },
    },
  });
  const created = await createRepository.registerAssetForRead({ readSnapshot: read, asset, link });
  assert.equal(created.assetCreated, true);
  assert.equal(created.linkCreated, true);
  assert.equal(created.linkUpdated, false);
  const linkInsert = creationCalls.find(({ sql }) => /INSERT INTO public\.vehicle_image_asset_reads/.test(sql));
  assert.equal(linkInsert.values[11], read.vehicle_image_updated_at);
  assert.equal(creationCalls.at(-1).sql, "COMMIT");

  const refreshCalls = [];
  const refreshRepository = new VehicleImageAssetRepository({
    storageWriterLockHeld: true,
    executor: {
      async query(sql, values) {
        refreshCalls.push({ sql, values });
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (/FROM public\.plate_reads reads[\s\S]*FOR UPDATE/.test(sql)) return { rows: [read] };
        if (/INSERT INTO public\.vehicle_image_assets/.test(sql)) return { rows: [] };
        if (/SELECT \* FROM public\.vehicle_image_assets/.test(sql)) return { rows: [assetRow] };
        if (/SELECT asset_id, source_kind/.test(sql)) {
          return { rows: [{
            asset_id: 40,
            source_kind: "overview_primary",
            source_path_snapshot: "derived/overview/old.jpg",
            source_updated_at: "2026-08-14T11:00:00.000Z",
          }] };
        }
        if (/UPDATE public\.vehicle_image_asset_reads/.test(sql)) return { rows: [{ asset_id: 41 }] };
        assert.fail(`Unexpected refresh query: ${sql}`);
      },
    },
  });
  const refreshed = await refreshRepository.registerAssetForRead({ readSnapshot: read, asset, link });
  assert.equal(refreshed.assetCreated, false);
  assert.equal(refreshed.linkCreated, false);
  assert.equal(refreshed.linkUpdated, true);
  assert.match(
    refreshCalls.find(({ sql }) => /UPDATE public\.vehicle_image_asset_reads/.test(sql)).sql,
    /SET asset_id = \$2[\s\S]*source_updated_at = \$12::timestamptz/
  );
  assert.equal(refreshCalls.at(-1).sql, "COMMIT");
});

test("executor-only repositories cannot bypass the storage cleanup writer lock", async () => {
  const repository = new VehicleImageAssetRepository({
    executor: { async query() { return { rows: [] }; } },
  });
  await assert.rejects(
    () => repository.withStorageWriter(async () => assert.fail("operation must not run")),
    /require the shared storage cleanup lock/
  );
  await assert.rejects(
    () => repository.registerAssetForRead({}),
    /requires the shared storage cleanup lock/
  );
});

test("foundation migration is additive, inert, provider-neutral, and storage-safe", async () => {
  const [migration, repositorySource, cleanupSource, reconciliationSource] = await Promise.all([
    fs.readFile(path.join(ROOT, "migrations.sql"), "utf8"),
    fs.readFile(path.join(ROOT, "lib", "vehicle-image-asset-repository.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib", "storage-cleanup.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib", "storage-reconciliation-repository.mjs"), "utf8"),
  ]);
  const marker = "2026081402_vehicle_image_asset_foundation";
  const foundationStart = migration.indexOf("-- Canonical, byte-addressed ownership");
  const foundationEnd = migration.indexOf(marker) + marker.length;
  assert.ok(foundationStart >= 0 && foundationEnd > foundationStart);
  const foundation = migration.slice(foundationStart, foundationEnd);
  const assetTable = foundation.slice(
    foundation.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_image_assets"),
    foundation.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_reads")
  );

  assert.match(assetTable, /content_sha256 CHAR\(64\) NOT NULL UNIQUE/);
  assert.match(assetTable, /derived\/vehicle-assets/);
  assert.doesNotMatch(assetTable, /\bread_id\b|\bsource_read_id\b/);
  assert.match(foundation, /CREATE TRIGGER vehicle_image_assets_immutable[\s\S]*BEFORE UPDATE/);
  assert.match(foundation, /PRIMARY KEY \(asset_id, read_id\)/);
  assert.match(foundation, /UNIQUE \(read_id\)/);
  assert.match(foundation, /entry_overview_route_fallback[\s\S]*identity_eligible = FALSE/);
  assert.match(foundation, /source_kind = 'overview_pair_share'[\s\S]*relationship = 'shared'/);
  assert.match(foundation, /source_kind = 'entry_overview_history'[\s\S]*relationship = 'history'/);
  assert.match(foundation, /source_updated_at TIMESTAMPTZ/);
  assert.match(foundation, /overview_fallback/);
  assert.doesNotMatch(foundation, /legacy_plate_camera|entry_lpr_fallback/);
  assert.doesNotMatch(foundation, /UPDATE public\.plate_reads|INSERT INTO public\.vehicle_image_assets[\s\S]*SELECT/);
  assert.doesNotMatch(foundation.toLowerCase(), /plate recognizer|snapshot sdk|make.?model/);

  assert.doesNotMatch(repositorySource, /reads\.image_path\b/);
  assert.match(repositorySource, /reads\.vehicle_image_path/);
  assert.match(repositorySource, /ON CONFLICT \(content_sha256\) DO NOTHING/);
  assert.match(repositorySource, /FOR UPDATE/);
  assert.match(
    repositorySource,
    /reads\.vehicle_image_updated_at IS NOT DISTINCT FROM links\.source_updated_at/
  );
  assert.match(cleanupSource, /vehicle_image_assets[\s\S]*storage_path/);
  assert.match(cleanupSource, /LOCK TABLE public\.plate_reads, public\.capture_assets, public\.vehicle_image_assets/);
  assert.match(reconciliationSource, /vehicle_image_assets[\s\S]*storage_path/);
  assert.match(reconciliationSource, /vehicle-image-assets/);
});

test("PostgreSQL asset smoke test is explicitly guarded before reading migrations", async () => {
  const smokeSource = await fs.readFile(
    path.join(ROOT, "scripts", "test-vehicle-image-asset-postgres.mjs"),
    "utf8"
  );
  assert.match(
    smokeSource,
    /VEHICLE_IMAGE_ASSET_POSTGRES_TEST_OPT_IN !== "true"/
  );
  assert.match(smokeSource, /VEHICLE_IMAGE_ASSET_POSTGRES_TEST_DATABASE/);
  const databaseGuard = smokeSource.indexOf("SELECT current_database() AS database_name");
  const migrationRead = smokeSource.indexOf("fs.readFile");
  assert.ok(databaseGuard >= 0);
  assert.ok(migrationRead > databaseGuard);
  assert.match(smokeSource, /assert\.deepEqual\(residue\.rows\[0\]/);
  assert.doesNotMatch(smokeSource, /\.catch\(\(\) => \{\}\)/);
});

test("manual cleanup never unlinks a referenced canonical vehicle image", async () => {
  let removeCalled = false;
  const item = {
    relative_path: `derived/vehicle-assets/aa/${"a".repeat(64)}.jpg`,
    observed_size_bytes: 500,
    observed_modified_at: "2026-08-01T12:00:00.000Z",
  };
  const outcome = await validateAndDeleteCleanupCandidate({
    query: async (sql, values) => {
      assert.match(sql, /public\.vehicle_image_assets[\s\S]*storage_path/);
      assert.deepEqual(values, [item.relative_path]);
      return { rows: [{ referenced: true }] };
    },
    storagePath: "/storage",
    item,
    fileLstat: async () => ({
      size: 500,
      mtime: new Date(item.observed_modified_at),
      dev: 1,
      ino: 2,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
    resolveRealPath: async (value) => value,
    removeFile: async () => { removeCalled = true; },
  });
  assert.deepEqual(outcome, { status: "skipped-referenced", reclaimedBytes: 0 });
  assert.equal(removeCalled, false);
});
