import test from "node:test";
import assert from "node:assert/strict";

import { normalizePagination } from "../lib/pagination.mjs";

test("pagination accepts ordinary numeric values", () => {
  assert.deepEqual(normalizePagination(2, 50), { page: 2, pageSize: 50 });
  assert.deepEqual(normalizePagination("3", "10"), {
    page: 3,
    pageSize: 10,
  });
});

test("pagination rejects SQL fragments and invalid numbers", () => {
  for (const value of [
    "1; SELECT pg_sleep(10); --",
    "NaN",
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.deepEqual(normalizePagination(value, value), {
      page: 1,
      pageSize: 25,
    });
  }
});

test("pagination clamps excessive values", () => {
  assert.deepEqual(normalizePagination(2_000_000, 10_000), {
    page: 1_000_000,
    pageSize: 500,
  });
});

test("pagination accepts the large-page option", () => {
  assert.deepEqual(normalizePagination(1, 500), {
    page: 1,
    pageSize: 500,
  });
});
