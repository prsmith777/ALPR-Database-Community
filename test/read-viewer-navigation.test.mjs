import assert from "node:assert/strict";
import test from "node:test";

import {
  findNextUnconfirmedReadIndex,
  isConfirmNextOperationCurrent,
  resolveReadViewerNavigation,
  resolveUnconfirmedPageTransition,
} from "../lib/read-viewer-navigation.mjs";

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

test("previous read moves exactly one item backward within the current page", () => {
  assert.deepEqual(
    resolve({ direction: "previous", selectedIndex: 10 }),
    { kind: "item", index: 9 }
  );
});

test("previous read stops at the first result instead of wrapping", () => {
  assert.deepEqual(
    resolve({ direction: "previous", selectedIndex: 0, page: 1 }),
    { kind: "none" }
  );
});

test("next read does not skip an item after the selected read leaves a filtered page", () => {
  assert.deepEqual(
    resolve({ selectedIndex: 10, itemCount: 24, selectedPresent: false }),
    { kind: "item", index: 10 }
  );
});

test("previous read still selects the prior item after the selected read leaves a filtered page", () => {
  assert.deepEqual(
    resolve({
      direction: "previous",
      selectedIndex: 10,
      itemCount: 24,
      selectedPresent: false,
    }),
    { kind: "item", index: 9 }
  );
});

test("confirm-and-next skips confirmed reads on the current page", () => {
  assert.equal(
    findNextUnconfirmedReadIndex({
      reads: [
        { id: 1, validated: false },
        { id: 2, validated: true },
        { id: 3, validated: true },
        { id: 4, validated: false },
      ],
      selectedIndex: 0,
    }),
    3
  );
});

test("confirm-and-next uses the removed read insertion point after filtering", () => {
  assert.equal(
    findNextUnconfirmedReadIndex({
      reads: [
        { id: 1, validated: true },
        { id: 3, validated: false },
      ],
      selectedIndex: 1,
      selectedPresent: false,
    }),
    1
  );
});

test("confirm-and-next reports no current-page target when all later reads are confirmed", () => {
  assert.equal(
    findNextUnconfirmedReadIndex({
      reads: [
        { id: 1, validated: false },
        { id: 2, validated: true },
        { id: 3, validated: true },
      ],
      selectedIndex: 0,
    }),
    -1
  );
});

test("confirm-and-next treats a missing validation flag as unconfirmed", () => {
  assert.equal(
    findNextUnconfirmedReadIndex({
      reads: [
        { id: 1, validated: false },
        { id: 2 },
      ],
      selectedIndex: 0,
    }),
    1
  );
});

const scanPending = Object.freeze({
  phase: "scan",
  targetPage: 2,
  originPage: 1,
  originReadId: 10,
  originIndex: 24,
  deadlineAt: 1000,
});

test("confirm-and-next scans through a confirmed-only intermediate page", () => {
  assert.deepEqual(
    resolveUnconfirmedPageTransition({
      pending: scanPending,
      reads: [{ validated: true }, { validated: true }],
      page: 2,
      pageSize: 2,
      total: 6,
      now: 500,
      restoreTimeoutMs: 1000,
    }),
    {
      kind: "navigate",
      direction: "next",
      pending: { ...scanPending, targetPage: 3 },
    }
  );
});

test("confirm-and-next resumes at the filtered read insertion index", () => {
  const pending = {
    ...scanPending,
    phase: "await-filtered-removal",
    targetPage: 1,
    originIndex: 1,
  };
  assert.deepEqual(
    resolveUnconfirmedPageTransition({
      pending,
      reads: [{ id: 9, validated: true }, { id: 11, validated: false }],
      page: 1,
      pageSize: 25,
      total: 2,
      now: 500,
      restoreTimeoutMs: 1000,
    }),
    { kind: "open", index: 1 }
  );
});

test("confirm-and-next restores the origin after a no-match page scan", () => {
  const pending = { ...scanPending, targetPage: 3 };
  const result = resolveUnconfirmedPageTransition({
    pending,
    reads: [{ validated: true }],
    page: 3,
    pageSize: 2,
    total: 5,
    now: 500,
    restoreTimeoutMs: 1000,
  });
  assert.equal(result.kind, "navigate");
  assert.equal(result.direction, "previous");
  assert.equal(result.pending.phase, "restore");
  assert.equal(result.pending.targetPage, 2);
  assert.equal(result.pending.deadlineAt, 1500);
  const secondRestoreStep = resolveUnconfirmedPageTransition({
    pending: result.pending,
    reads: [{ validated: true }],
    page: 2,
    pageSize: 2,
    total: 5,
    now: 750,
    restoreTimeoutMs: 1000,
  });
  assert.deepEqual(
    secondRestoreStep,
    {
      kind: "navigate",
      direction: "previous",
      pending: { ...result.pending, targetPage: 1 },
    }
  );
  assert.deepEqual(
    resolveUnconfirmedPageTransition({
      pending: secondRestoreStep.pending,
      reads: [{ validated: false }, { validated: true }],
      page: 1,
      pageSize: 2,
      total: 5,
      now: 800,
      restoreTimeoutMs: 1000,
    }),
    { kind: "complete", reason: "restored" }
  );
});

test("confirm-and-next timeout starts a bounded restore and a stalled restore completes", () => {
  const timedOut = resolveUnconfirmedPageTransition({
    pending: { ...scanPending, targetPage: 3 },
    reads: [],
    page: 3,
    pageSize: 2,
    total: 6,
    now: 1000,
    restoreTimeoutMs: 750,
  });
  assert.equal(timedOut.kind, "navigate");
  assert.equal(timedOut.direction, "previous");
  assert.equal(timedOut.pending.phase, "restore");
  assert.equal(timedOut.pending.deadlineAt, 1750);
  assert.deepEqual(
    resolveUnconfirmedPageTransition({
      pending: timedOut.pending,
      reads: [],
      page: 3,
      pageSize: 2,
      total: 6,
      now: 1750,
      restoreTimeoutMs: 750,
    }),
    { kind: "complete", reason: "timeout" }
  );
});

test("confirm-and-next token is invalidated by close or navigation", () => {
  const operation = {
    activeToken: 7,
    operationToken: 7,
    selectedReadId: 42,
    originReadId: 42,
  };
  assert.equal(isConfirmNextOperationCurrent(operation), true);
  assert.equal(isConfirmNextOperationCurrent({ ...operation, activeToken: null }), false);
  assert.equal(isConfirmNextOperationCurrent({ ...operation, selectedReadId: null }), false);
  assert.equal(isConfirmNextOperationCurrent({ ...operation, selectedReadId: 43 }), false);
});
