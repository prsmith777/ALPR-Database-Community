import assert from "node:assert/strict";
import test from "node:test";

import { resolveReadViewerNavigation } from "../lib/read-viewer-navigation.mjs";

function resolve(overrides = {}) {
  return resolveReadViewerNavigation({
    direction: "next",
    selectedIndex: 0,
    itemCount: 25,
    page: 1,
    pageSize: 25,
    total: 60,
    ...overrides,
  });
}

test("next read advances within the current result page", () => {
  assert.deepEqual(resolve({ selectedIndex: 10 }), {
    kind: "item",
    index: 11,
  });
});

test("next read crosses from the final visible read to the next result page", () => {
  assert.deepEqual(resolve({ selectedIndex: 24 }), {
    kind: "page",
    page: 2,
    index: 0,
  });
});

test("next read stops at the final result instead of wrapping to the top", () => {
  assert.deepEqual(
    resolve({ selectedIndex: 9, itemCount: 10, page: 3, total: 60 }),
    { kind: "none" }
  );
});

test("previous read crosses to the final read of the previous result page", () => {
  assert.deepEqual(
    resolve({ direction: "previous", selectedIndex: 0, page: 2 }),
    { kind: "page", page: 1, index: -1 }
  );
});
