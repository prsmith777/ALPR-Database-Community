import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizePlateExportRow,
  serializePlateExportCsv,
  serializePlateExportJson,
} from "../lib/plate-export.mjs";

const row = {
  plate_number: "ABC123",
  name: "Family, car",
  notes: 'Uses the "west" entrance',
  tags: [{ name: "Known" }, { name: "Visitor" }],
  first_seen_at: "2026-07-01T10:00:00.000Z",
  last_seen_at: "2026-07-19T11:00:00.000Z",
  occurrence_count: "12",
  flagged: true,
};

test("plate exports normalize database rows without leaking tag objects", () => {
  assert.deepEqual(normalizePlateExportRow(row), {
    plate_number: "ABC123",
    known_name: "Family, car",
    notes: 'Uses the "west" entrance',
    tags: "Known; Visitor",
    first_seen_at: "2026-07-01T10:00:00.000Z",
    last_seen_at: "2026-07-19T11:00:00.000Z",
    occurrence_count: 12,
    flagged: true,
  });
});

test("CSV exports quote commas and embedded quotes", () => {
  const csv = serializePlateExportCsv([row]);
  assert.match(csv, /^plate_number,known_name,notes,tags,/);
  assert.match(csv, /"Family, car"/);
  assert.match(csv, /"Uses the ""west"" entrance"/);
  assert.match(csv, /Known; Visitor/);
});

test("CSV exports neutralize spreadsheet formulas in user-controlled fields", () => {
  const csv = serializePlateExportCsv([
    { ...row, plate_number: "=HYPERLINK(\"https://example.invalid\")" },
  ]);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
});

test("JSON exports include bounded export metadata", () => {
  const json = JSON.parse(
    serializePlateExportJson(
      { data: [row], total: 60_000, truncated: true, limit: 50_000 },
      new Date("2026-07-19T00:00:00.000Z")
    )
  );
  assert.equal(json.exported_at, "2026-07-19T00:00:00.000Z");
  assert.equal(json.total_matching, 60_000);
  assert.equal(json.exported_count, 1);
  assert.equal(json.truncated, true);
  assert.equal(json.export_limit, 50_000);
});

test("Downloads page and API expose authenticated filter-respecting exports", async () => {
  const [page, form, route, table, filters] = await Promise.all([
    readFile(new URL("../app/download/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateExportForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/exports/plates/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/plateDbTable.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateDatabaseFilters.jsx", import.meta.url), "utf8"),
  ]);

  assert.equal(page.includes("Coming soon"), false);
  assert.match(page, /PlateExportForm/);
  assert.match(form, /Download CSV/);
  assert.match(form, /Download JSON/);
  assert.match(route, /getPlateDatabaseExport/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /X-Export-Truncated/);
  assert.match(table, /PlateDatabaseFilters/);
  assert.match(filters, /Include close plate matches/);
  assert.match(filters, /Export these results/);
});
