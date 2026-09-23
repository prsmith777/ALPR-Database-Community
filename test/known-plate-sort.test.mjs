import assert from "node:assert/strict";
import test from "node:test";

import { sortKnownPlates } from "../lib/known-plate-sort.mjs";

const plates = [
  {
    plate_number: "ABC10",
    name: null,
    notes: "Visitor",
    created_at: "2026-01-01T10:00:00.000Z",
    tags: ["Work", "Blue"],
  },
  {
    plate_number: "ABC2",
    name: "Alice",
    notes: null,
    created_at: "2026-03-01T10:00:00.000Z",
    tags: ["Family"],
  },
  {
    plate_number: "XYZ1",
    name: "bob",
    notes: "Delivery",
    created_at: "2026-02-01T10:00:00.000Z",
    tags: [],
  },
];

test("known plates default to newest added first", () => {
  assert.deepEqual(
    sortKnownPlates(plates).map((plate) => plate.plate_number),
    ["ABC2", "XYZ1", "ABC10"]
  );
});

test("known plate text sorting is case-insensitive and numeric-aware", () => {
  assert.deepEqual(
    sortKnownPlates(plates, {
      key: "plate_number",
      direction: "asc",
    }).map((plate) => plate.plate_number),
    ["ABC2", "ABC10", "XYZ1"]
  );

  assert.deepEqual(
    sortKnownPlates(plates, { key: "name", direction: "asc" }).map(
      (plate) => plate.plate_number
    ),
    ["ABC2", "XYZ1", "ABC10"]
  );
});

test("missing optional values remain last in either direction", () => {
  for (const direction of ["asc", "desc"]) {
    const result = sortKnownPlates(plates, { key: "notes", direction });
    assert.equal(result.at(-1).plate_number, "ABC2");
  }
});

test("tag sorting normalizes tag arrays without mutating input", () => {
  const originalTags = [...plates[0].tags];
  const result = sortKnownPlates(plates, { key: "tags", direction: "asc" });

  assert.deepEqual(
    result.map((plate) => plate.plate_number),
    ["ABC10", "ABC2", "XYZ1"]
  );
  assert.deepEqual(plates[0].tags, originalTags);
});

test("equal sort values preserve the existing row order", () => {
  const tiedPlates = [
    { plate_number: "B2", name: "Same" },
    { plate_number: "A1", name: "same" },
  ];

  assert.deepEqual(
    sortKnownPlates(tiedPlates, { key: "name", direction: "asc" }).map(
      (plate) => plate.plate_number
    ),
    ["B2", "A1"]
  );
});
