import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeTablePageSize,
  readTablePageSizePreference,
  tablePageSizePreferenceKey,
  writeTablePageSizePreference,
} from "../lib/table-page-size-preference.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("table page-size preferences accept only offered row counts", () => {
  for (const size of [10, 25, 50, 100, 250, 500]) {
    assert.equal(normalizeTablePageSize(size), size);
  }
  assert.equal(normalizeTablePageSize("500"), 500);
  assert.equal(normalizeTablePageSize("all"), 25);
  assert.equal(normalizeTablePageSize(10_000), 25);
});

test("Live Feed and Plate Database keep independent preferences", () => {
  const storage = memoryStorage();

  writeTablePageSizePreference("live-feed", 500, storage);
  writeTablePageSizePreference("plate-database", 100, storage);

  assert.equal(readTablePageSizePreference("live-feed", 25, storage), 500);
  assert.equal(readTablePageSizePreference("plate-database", 25, storage), 100);
  assert.notEqual(
    tablePageSizePreferenceKey("live-feed"),
    tablePageSizePreferenceKey("plate-database")
  );
});

test("blocked browser storage safely falls back", () => {
  const blockedStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };

  assert.equal(readTablePageSizePreference("live-feed", 50, blockedStorage), 50);
  assert.equal(writeTablePageSizePreference("live-feed", 250, blockedStorage), 250);
});

test("Live Feed URL values override storage while selections update it", async () => {
  const wrapper = await readFile(
    new URL("../components/PlateTableWrapper.jsx", import.meta.url),
    "utf8"
  );

  assert.match(wrapper, /if \(!params\.get\("pageSize"\)\)/);
  assert.match(wrapper, /updates\.pageSize = String\(preferredPageSize\)/);
  assert.match(wrapper, /writeTablePageSizePreference\("live-feed"/);
});
