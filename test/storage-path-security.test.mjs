import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isPathInside,
  resolveStoragePath,
  sanitizeStorageComponent,
} from "../lib/storage-path.mjs";

test("plate identifiers are converted to safe filename components", () => {
  assert.equal(sanitizeStorageComponent("ABC-123"), "ABC-123");
  assert.equal(
    sanitizeStorageComponent("../../config/settings.yaml"),
    "config_settings_yaml"
  );
  assert.equal(sanitizeStorageComponent(""), "unknown");
});

test("valid image and thumbnail paths resolve inside storage", () => {
  const baseDir = path.resolve("/tmp/alpr-storage");

  assert.equal(
    resolveStoragePath(baseDir, "images/2026/07/16/ABC123.jpg"),
    path.join(baseDir, "images", "2026", "07", "16", "ABC123.jpg")
  );

  assert.equal(
    resolveStoragePath(baseDir, "thumbnails/2026/07/16/ABC123_thumb.jpg"),
    path.join(
      baseDir,
      "thumbnails",
      "2026",
      "07",
      "16",
      "ABC123_thumb.jpg"
    )
  );
});

test("storage path resolution rejects traversal and unauthorized roots", () => {
  const baseDir = path.resolve("/tmp/alpr-storage");
  const invalidPaths = [
    "../config/settings.yaml",
    "images/../../config/settings.yaml",
    "images\\..\\..\\config\\settings.yaml",
    "/etc/passwd",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "\\\\server\\share\\secret.txt",
    "config/settings.yaml",
    "images/\0secret.jpg",
  ];

  for (const invalidPath of invalidPaths) {
    assert.throws(
      () => resolveStoragePath(baseDir, invalidPath),
      /Invalid storage/
    );
  }
});

test("path containment rejects equal and escaped paths", () => {
  const baseDir = path.resolve("/tmp/alpr-storage/images");

  assert.equal(isPathInside(baseDir, path.join(baseDir, "plate.jpg")), true);
  assert.equal(isPathInside(baseDir, baseDir), false);
  assert.equal(isPathInside(baseDir, path.resolve(baseDir, "../secret")), false);
});
