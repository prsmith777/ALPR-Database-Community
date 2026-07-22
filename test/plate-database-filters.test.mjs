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
  assert.match(result.whereClause, /TRANSLATE/);
  assert.match(result.whereClause, /AND EXISTS \(/);
  assert.match(result.whereClause, /LOWER\(pr_filter\.camera_name\) = ANY\(\$10::text\[\]\)/);
  assert.match(result.whereClause, /timestamp::date >= \$11/);
  assert.match(result.whereClause, /timestamp::date <= \$12/);
  assert.match(result.whereClause, /BETWEEN \$13 AND \$14/);
  assert.equal(result.values[0], "%ABC-123%");
  assert.equal(result.values[1], "ABC123");
  assert.deepEqual(result.values.slice(8), [
    ["Watchlist"],
    ["driveway"],
    "2026-07-01",
    "2026-07-19",
    7,
    19,
  ]);
});

test("multiple tags and cameras use OR within each filter group", () => {
  const result = buildPlateDatabaseFilterClause({
    tags: ["Family", "Delivery"],
    cameraNames: ["Entry LPR 1", "Street LPR 2"],
  });

  assert.match(result.whereClause, /t_filter\.name = ANY\(\$1::text\[\]\)/);
  assert.match(
    result.whereClause,
    /LOWER\(pr_filter\.camera_name\) = ANY\(\$2::text\[\]\)/
  );
  assert.deepEqual(result.values, [
    ["Family", "Delivery"],
    ["entry lpr 1", "street lpr 2"],
  ]);
});

test("untagged remains exclusive when combined with named tags", () => {
  const result = buildPlateDatabaseFilterClause({
    tags: ["untagged", "Family"],
  });

  assert.match(result.whereClause, /NOT EXISTS/);
  assert.match(result.whereClause, / OR EXISTS/);
  assert.deepEqual(result.values, [["Family"]]);
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
    matchMode: "broad",
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
