import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCapacityProjections,
  collectStorageHealth,
  STORAGE_HEALTH_METRICS_SQL,
  STORAGE_HEALTH_SAMPLE_SQL,
} from "../lib/storage-health.mjs";

test("capacity projections identify reached, projected, and stable thresholds", () => {
  const projected = buildCapacityProjections({
    totalBytes: 1_000,
    usedBytes: 750,
    estimatedBytesPerDay: 25,
    measuredAt: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.deepEqual(projected[0], {
    percent: 70,
    status: "reached",
    days: 0,
    projectedAt: null,
  });
  assert.deepEqual(projected[1], {
    percent: 80,
    status: "projected",
    days: 2,
    projectedAt: "2026-07-26T12:00:00.000Z",
  });
  assert.equal(projected[2].days, 6);

  const stable = buildCapacityProjections({
    totalBytes: 1_000,
    usedBytes: 500,
    estimatedBytesPerDay: 0,
  });
  assert.equal(stable[0].status, "stable");
});

test("storage health combines exact database and filesystem facts with a bounded sample", async () => {
  const queries = [];
  const metricRow = {
    database_bytes: "5000",
    plate_read_relation_bytes: "2000",
    plate_count: "8",
    read_count: "10",
    image_reference_count: "9",
    records_without_image_path: "1",
    reads_last_24_hours: "12",
    reads_last_7_days: "70",
    ready_count: "7",
    failed_count: "1",
    source_missing_count: "1",
    last_indexed_at: "2026-07-24T11:30:00.000Z",
  };
  const sampleRows = [
    { image_path: "images/a.jpg", thumbnail_path: "thumbnails/a.jpg", derived_path: "derived/a.jpg" },
    { image_path: "images/b.jpg", thumbnail_path: "thumbnails/b.jpg", derived_path: "derived/b.jpg" },
  ];
  const sizes = new Map([
    ["images/a.jpg", 100],
    ["thumbnails/a.jpg", 20],
    ["derived/a.jpg", 30],
    ["images/b.jpg", 200],
    ["thumbnails/b.jpg", 50],
  ]);

  const snapshot = await collectStorageHealth({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return sql === STORAGE_HEALTH_METRICS_SQL
        ? { rows: [metricRow] }
        : { rows: sampleRows };
    },
    storagePath: "/capture-storage",
    statfs: async () => ({ bsize: 100, blocks: 100, bavail: 40 }),
    resolvePath: (relativePath) => relativePath,
    statPath: async (relativePath) => {
      if (!sizes.has(relativePath)) throw new Error("missing");
      return { size: sizes.get(relativePath), isFile: () => true };
    },
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    sampleLimit: 2,
  });

  assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.filesystem, {
    totalBytes: 10_000,
    usedBytes: 6_000,
    availableBytes: 4_000,
    usedPercent: 60,
  });
  assert.equal(snapshot.database.readsPerDay, 10);
  assert.equal(snapshot.database.plateReadBytesPerRead, 200);
  assert.equal(snapshot.assets.readyCount, 7);
  assert.equal(snapshot.assets.pendingCount, 1);
  assert.equal(snapshot.assets.sampledReads, 2);
  assert.equal(snapshot.assets.averageAssetBytesPerRead, 200);
  assert.equal(snapshot.assets.missingReferences, 1);
  assert.equal(snapshot.growth.estimatedBytesPerRead, 400);
  assert.equal(snapshot.growth.estimatedBytesPerDay, 4_000);
  assert.equal(snapshot.growth.projections[0].days, 1);
  assert.equal(queries[1].sql, STORAGE_HEALTH_SAMPLE_SQL);
  assert.deepEqual(queries[1].values, [2]);
});

test("storage health degrades to partial read-only results when database probes fail", async () => {
  const snapshot = await collectStorageHealth({
    query: async () => { throw new Error("offline"); },
    storagePath: "/capture-storage",
    statfs: async () => ({ bsize: 1, blocks: 100, bavail: 25 }),
    resolvePath: (value) => value,
    statPath: async () => ({ size: 0, isFile: () => true }),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(snapshot.filesystem.usedPercent, 75);
  assert.equal(snapshot.database, null);
  assert.equal(snapshot.growth, null);
  assert.match(snapshot.errors[0], /Database and image-asset measurements/);
});

test("the administrator storage view is explicitly read-only and has no cleanup controls", async () => {
  const [page, settings, card] = await Promise.all([
    readFile(new URL("../app/settings/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/StorageHealthCard.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /canManageSettings \? getStorageHealth\(\)/);
  assert.match(settings, /<StorageHealthCard snapshot=\{initialStorageHealth\} \/>/);
  assert.match(card, /Read only/);
  assert.match(card, /cannot delete or modify data/i);
  assert.match(card, /No cleanup is performed from this page/);
  assert.doesNotMatch(card, /onClick=.*(?:delete|prune|vacuum|cleanup)/i);
});
