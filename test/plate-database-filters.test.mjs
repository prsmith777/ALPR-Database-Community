import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPlateDatabaseFilterClause } from "../lib/plate-database-filters.mjs";

test("plate database filters are empty by default", () => {
  assert.deepEqual(buildPlateDatabaseFilterClause(), {
    whereClause: "",
    values: [],
  });
});

test("combined plate filters stay grouped and parameterized", () => {
  const result = buildPlateDatabaseFilterClause({
    search: "ABC-123",
    fuzzySearch: true,
    tag: "Watchlist",
    cameraName: "Driveway",
    dateRange: { from: "2026-07-01", to: "2026-07-19" },
    hourRange: { from: 7, to: 19 },
  });

  assert.match(result.whereClause, /^WHERE \(p\.plate_number ILIKE \$1 OR/);
  assert.match(result.whereClause, /LEVENSHTEIN/);
  assert.match(result.whereClause, /AND EXISTS \(/);
  assert.match(result.whereClause, /LOWER\(pr_filter\.camera_name\) = LOWER\(\$4\)/);
  assert.match(result.whereClause, /timestamp::date >= \$5/);
  assert.match(result.whereClause, /timestamp::date <= \$6/);
  assert.match(result.whereClause, /BETWEEN \$7 AND \$8/);
  assert.deepEqual(result.values, [
    "%ABC-123%",
    "ABC123",
    "Watchlist",
    "Driveway",
    "2026-07-01",
    "2026-07-19",
    7,
    19,
  ]);
});

test("overnight hour filters use one read-scoped OR group", () => {
  const result = buildPlateDatabaseFilterClause({
    hourRange: { from: 22, to: 5 },
  });

  assert.match(result.whereClause, /EXTRACT\(HOUR FROM pr_filter\.timestamp\) >= \$1/);
  assert.match(result.whereClause, /OR EXTRACT\(HOUR FROM pr_filter\.timestamp\) <= \$2/);
  assert.deepEqual(result.values, [22, 5]);
});

test("short fuzzy searches remain contains-only", () => {
  const result = buildPlateDatabaseFilterClause({
    search: "A1",
    fuzzySearch: true,
  });

  assert.equal(result.whereClause.includes("LEVENSHTEIN"), false);
  assert.deepEqual(result.values, ["%A1%"]);
});

test("database listing and export share the filter builder", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  assert.match(source, /buildPlateDatabaseFilterClause\(filters\)/);
  assert.match(source, /export async function getPlateDatabaseExport/);
  assert.match(source, /MAX_PLATE_EXPORT_ROWS = 50_000/);
});
