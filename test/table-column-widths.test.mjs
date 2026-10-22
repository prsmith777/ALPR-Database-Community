import assert from "node:assert/strict";
import test from "node:test";
import { tableColumns, clampColumnWidth, columnWidthForKey, normalizeColumnWidths, readColumnWidths, writeColumnWidths } from "../lib/table-column-widths.mjs";

function storageFixture() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("each table can hide State/Country without changing other column identities or persisted widths", () => {
  for (const surface of ["live-feed", "plate-database"]) {
    const all = tableColumns(surface);
    const hidden = tableColumns(surface, false);
    assert.deepEqual(hidden.map((c) => c.id), all.filter((c) => c.id !== "state_country").map((c) => c.id));
    const storage = storageFixture();
    writeColumnWidths(surface, { state_country: 320, actions: 56 }, storage);
    assert.deepEqual(readColumnWidths(surface, storage), { state_country: 320, actions: 56 });
    assert.equal(tableColumns(surface, true).find((c) => c.id === "state_country").width, 176);
  }
});

test("dragging through zero cannot hide controls or create unbounded columns", () => {
  for (const surface of ["live-feed", "plate-database"]) {
    for (const column of tableColumns(surface)) {
      assert.equal(clampColumnWidth(column, -500), column.min);
      assert.equal(clampColumnWidth(column, 50000), 1000);
      assert.equal(clampColumnWidth(column, NaN), column.width);
      assert.ok(column.width >= column.min);
    }
    assert.equal(tableColumns(surface).find((c) => c.id === "actions").min, 56);
  }
});

test("keyboard resizing uses bounded small and large steps and leaves unrelated keys alone", () => {
  const column = tableColumns("live-feed").find((c) => c.id === "state_country");
  assert.equal(columnWidthForKey(column, 176, "ArrowLeft"), 166);
  assert.equal(columnWidthForKey(column, 176, "ArrowRight", true), 226);
  assert.equal(columnWidthForKey(column, 110, "ArrowLeft", true), column.min);
  assert.equal(columnWidthForKey(column, 990, "ArrowRight", true), 1000);
  assert.equal(columnWidthForKey(column, 500, "Home"), column.min);
  assert.equal(columnWidthForKey(column, 500, "End"), 1000);
  assert.equal(columnWidthForKey(column, 176, "Enter"), null);
  assert.equal(columnWidthForKey(column, 176, "Tab"), null);
});

test("saved preferences survive visits, stay separate per table, and reset independently", () => {
  const storage = storageFixture();
  assert.equal(readColumnWidths("live-feed", storage), null);
  writeColumnWidths("live-feed", { plate_number: 220, actions: 56 }, storage);
  writeColumnWidths("plate-database", { plate_number: 310, notes: 400 }, storage);
  assert.deepEqual(readColumnWidths("live-feed", storage), { plate_number: 220, actions: 56 });
  assert.deepEqual(readColumnWidths("plate-database", storage), { plate_number: 310, notes: 400 });
  writeColumnWidths("live-feed", null, storage);
  assert.equal(readColumnWidths("live-feed", storage), null);
  assert.deepEqual(readColumnWidths("plate-database", storage), { plate_number: 310, notes: 400 });
});

test("old or corrupted storage cannot introduce missing, hidden, or excessively wide columns", () => {
  const original = { actions: -5, plate_number: 40000, tags: NaN, state_country: "250", unknown: 200 };
  assert.deepEqual(normalizeColumnWidths("live-feed", original), { plate_number: 1000, actions: 56 });
  assert.equal(original.actions, -5);
  for (const value of [null, [], "{}", {}, { unknown: 200 }]) assert.equal(normalizeColumnWidths("live-feed", value), null);
  assert.equal(readColumnWidths("live-feed", { getItem() { return "{broken"; } }), null);
});

test("browser storage restrictions preserve working in-memory widths", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readColumnWidths("live-feed", blocked), null);
  assert.deepEqual(writeColumnWidths("live-feed", { actions: 60 }, blocked), { actions: 60 });
  assert.equal(writeColumnWidths("live-feed", null, blocked), null);
});
