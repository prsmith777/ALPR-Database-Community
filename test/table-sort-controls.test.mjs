import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Plate Database exposes every supported server-side sort control", async () => {
  const component = await source("components/plateDbTable.jsx");
  const fields = [
    "plate_number",
    "occurrence_count",
    "name",
    "notes",
    "first_seen_at",
    "last_seen_at",
    "tags",
  ];

  for (const field of fields) {
    assert.match(component, new RegExp(`requestSort\\("${field}"\\)`));
    assert.match(component, new RegExp(`getSortIcon\\("${field}"\\)`));
  }
});

test("Recognition Feed exposes every supported server-side sort control", async () => {
  const component = await source("components/PlateTable.jsx");
  const controls = [
    ["Plate Number", "plate_number"],
    ["%", "confidence"],
    ["Occurrences", "occurrence_count"],
    ["Camera", "camera_name"],
    ["Timestamp", "timestamp"],
  ];

  for (const [label, field] of controls) {
    const escapedLabel = label === "%" ? "%" : label;
    assert.match(
      component,
      new RegExp(
        `label="${escapedLabel}"[\\s\\S]{0,120}field="${field}"`
      )
    );
  }
});
