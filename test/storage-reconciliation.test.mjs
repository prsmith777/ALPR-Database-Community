import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildReconciliationResult,
  inspectDatabaseReferences,
  inspectFilesystemEntries,
  joinStorageRelativePath,
  normalizeStorageRelativePath,
  selectDirectoryEntries,
} from "../lib/storage-reconciliation.mjs";
import { runStorageReconciliationBatch } from "../lib/storage-reconciliation-repository.mjs";

function entry(name, type) {
  return {
    name,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function stats({ size, mtime, symlink = false }) {
  return {
    size,
    mtime: new Date(mtime),
    isFile: () => !symlink,
    isSymbolicLink: () => symlink,
  };
}

test("storage paths and directory batches remain bounded and deterministic", () => {
  assert.equal(normalizeStorageRelativePath("images\\2026\\07"), "images/2026/07");
  assert.equal(joinStorageRelativePath("derived/2026", "asset.jpg"), "derived/2026/asset.jpg");
  assert.throws(() => normalizeStorageRelativePath("../outside"), /Invalid reconciliation/);
  assert.throws(() => joinStorageRelativePath("images", "../escape"), /Invalid reconciliation/);

  const batch = selectDirectoryEntries([
    entry("c.jpg", "file"),
    entry("a.jpg", "file"),
    entry("b.jpg", "file"),
  ], { cursor: "a.jpg", limit: 1 });
  assert.deepEqual(batch.entries.map((item) => item.name), ["b.jpg"]);
  assert.equal(batch.nextCursor, "b.jpg");
  assert.equal(batch.complete, false);
});

test("filesystem inspection defers recent files and identifies only old unreferenced regular files", async () => {
  const fileStats = new Map([
    ["images/old-orphan.jpg", stats({ size: 100, mtime: "2026-07-01T00:00:00.000Z" })],
    ["images/old-linked.jpg", stats({ size: 200, mtime: "2026-07-01T00:00:00.000Z" })],
    ["images/new.jpg", stats({ size: 300, mtime: "2026-07-26T00:00:00.000Z" })],
  ]);
  const result = await inspectFilesystemEntries({
    parent: "images",
    entries: [
      entry("2025", "directory"),
      entry("old-orphan.jpg", "file"),
      entry("old-linked.jpg", "file"),
      entry("new.jpg", "file"),
      entry("external", "symlink"),
    ],
    scanStartedAt: "2026-07-25T00:00:00.000Z",
    referencedPaths: new Set(["images/old-linked.jpg"]),
    statPath: async (relativePath) => fileStats.get(relativePath),
  });

  assert.deepEqual(result.directories, ["images/2025"]);
  assert.deepEqual(result.orphanFiles.map((item) => item.relativePath), ["images/old-orphan.jpg"]);
  assert.equal(result.inspectedFiles.length, 3);
  assert.equal(result.recentFilesSkipped, 1);
  assert.equal(result.skippedEntries, 1);
  assert.equal(result.errorCount, 0);
});

test("database reference inspection separates missing files from access and path errors", async () => {
  const result = await inspectDatabaseReferences({
    references: [
      { relativePath: "images/present.jpg", referenceType: "plate-read-image", ownerId: 1 },
      { relativePath: "images/missing.jpg", referenceType: "plate-read-image", ownerId: 2 },
      { relativePath: "derived/blocked.jpg", referenceType: "capture-derived", ownerId: 3 },
      { relativePath: "../../invalid.jpg", referenceType: "capture-derived", ownerId: 4 },
    ],
    statPath: async (relativePath) => {
      if (relativePath === "images/present.jpg") return stats({ size: 10, mtime: "2026-07-01" });
      const error = new Error("unavailable");
      error.code = relativePath === "images/missing.jpg" ? "ENOENT" : "EACCES";
      throw error;
    },
  });

  assert.equal(result.checked, 3);
  assert.deepEqual(result.missing.map((item) => item.relativePath), ["images/missing.jpg"]);
  assert.equal(result.errorCount, 2);
});

test("a completed reconciliation persists read-only results under an advisory lock", async () => {
  const statements = [];
  let released = false;
  const completedRow = {
    id: "8",
    status: "completed",
    phase: "completed",
    scan_started_at: "2026-07-25T00:00:00.000Z",
    completed_at: "2026-07-25T01:00:00.000Z",
    files_scanned: "100",
    bytes_scanned: "1000",
    references_checked: "80",
    orphan_files: "2",
    orphan_bytes: "20",
    missing_reference_paths: "1",
  };
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
      if (/SELECT \* FROM public\.storage_reconciliation_runs[\s\S]*status = 'running'/.test(sql)) {
        return { rows: [{ ...completedRow, status: "running", phase: "completed" }], rowCount: 1 };
      }
      if (/COUNT\(\*\) FILTER/.test(sql)) {
        return { rows: [{ orphan_files: "2", orphan_bytes: "20", missing_reference_paths: "1" }] };
      }
      if (/UPDATE public\.storage_reconciliation_runs[\s\S]*RETURNING \*/.test(sql)) {
        return { rows: [completedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const result = await runStorageReconciliationBatch({
    pool: { connect: async () => client },
    baseDir: "/storage",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.result.destructive, false);
  assert.equal(result.result.orphanFiles, 2);
  assert.equal(released, true);
  assert.equal(statements.some(({ sql }) => /pg_try_advisory_lock/.test(sql)), true);
  assert.equal(statements.some(({ sql }) => /pg_advisory_unlock/.test(sql)), true);
  assert.equal(statements.some(({ sql }) => /DELETE\s+FROM|TRUNCATE|\bUNLINK\b/i.test(sql)), false);
});

test("reconciliation schema and UI expose inventory without cleanup controls", async () => {
  const [repository, migrations, card] = await Promise.all([
    readFile(new URL("../lib/storage-reconciliation-repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/StorageHealthCard.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS public\.storage_reconciliation_runs/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS public\.storage_reconciliation_items/);
  assert.match(migrations, /WHERE job_name = 'storage-reconciliation'[\s\S]*status = 'failed'/);
  assert.match(repository, /LIMIT 25/);
  assert.match(repository, /\) referenced_paths/);
  assert.doesNotMatch(repository, /\) references\s/);
  assert.match(repository, /next_run_at = CURRENT_TIMESTAMP \+ INTERVAL '1 minute'/);
  assert.doesNotMatch(repository, /rm\(|rmdir\(|unlink\(|DELETE\s+FROM|TRUNCATE/i);
  assert.match(card, /Read-only storage reconciliation/);
  assert.match(card, /Finding sample \(up to 25\)/);
  assert.doesNotMatch(card, /onClick=.*(?:delete|prune|cleanup)/i);
  assert.equal(buildReconciliationResult({ orphan_files: "4" }).orphanFiles, 4);
});
