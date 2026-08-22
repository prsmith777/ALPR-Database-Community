import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeTablePageSize,
  readTablePageSizePreference,
  readTablePageSizeCookiePreference,
  tablePageSizePreferenceCookieName,
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

test("Live Feed preferences use a server-readable cookie without a hydration navigation", async () => {
  const [wrapper, page, table] = await Promise.all([
    readFile(
      new URL("../components/PlateTableWrapper.jsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../app/live_feed/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
  ]);
  const documentRef = { cookie: "" };

  writeTablePageSizePreference("live-feed", 100, memoryStorage(), documentRef);

  assert.match(
    documentRef.cookie,
    new RegExp(`${tablePageSizePreferenceCookieName("live-feed")}=100`)
  );
  assert.equal(
    readTablePageSizeCookiePreference("live-feed", {
      get: () => ({ value: "100" }),
    }),
    100
  );
  assert.match(page, /readTablePageSizeCookiePreference/);
  assert.doesNotMatch(wrapper, /router\.replace\(/);
  assert.match(wrapper, /writeTablePageSizePreference\("live-feed"/);
  assert.equal(
    wrapper.match(
      /parseInt\(\s*params\.get\("pageSize"\) \|\| String\(preferredPageSize\)\s*\)/g
    )?.length,
    2,
    "pagination and page navigation must both fall back to the saved server preference"
  );

  const pageSizeControl = table.indexOf('id="recognition-feed-page-size"');
  const liveUpdatesControl = table.indexOf('id="live-updates"');
  const expandedSearchOptions = table.indexOf(
    'id="recognition-feed-search-options"'
  );
  assert.ok(pageSizeControl > table.indexOf("Search options"));
  assert.ok(pageSizeControl < liveUpdatesControl);
  assert.ok(pageSizeControl < expandedSearchOptions);
  assert.equal(
    table.match(/onValueChange=\{handlePageSizeChange\}/g)?.length,
    1,
    "rows per page must have one dedicated control outside Search options"
  );
});
