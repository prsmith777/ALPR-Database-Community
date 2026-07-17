import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  AUTHENTICATION_UNAVAILABLE_MESSAGE,
  createServerActionAuthenticator,
} from "../lib/server-action-auth.mjs";
import { createUpdateActions } from "../lib/update-actions.mjs";

const ACTION_NAMES = [
  "dbBackfill",
  "migrateImageDataToFiles",
  "clearImageData",
  "completeUpdate",
  "skipImageMigration",
];

function makeBlockedHarness(authenticate) {
  const dependencyCalls = [];
  const called = (name, result) => async () => {
    dependencyCalls.push(name);
    return result;
  };

  return {
    dependencyCalls,
    actions: createUpdateActions({
      authenticate,
      backfillOccurrenceCounts: called("backfill", { success: true }),
      getTotalRecordsToMigrate: called("total-records", 0),
      getRecordsToMigrate: called("records", []),
      migrateBase64ToFile: called("filesystem-migration", {}),
      updateImagePathsBatch: called("path-update"),
      clearImageDataBatch: called("clear-images", 0),
      markUpdateComplete: called("mark-complete"),
      verifyImageMigration: called("verify-migration", {
        success: true,
        isComplete: true,
      }),
      logger: { log() {}, warn() {}, error() {} },
    }),
  };
}

async function assertEveryActionRejected(actions, expectedMessage) {
  for (const name of ACTION_NAMES) {
    await assert.rejects(actions[name](), {
      message: expectedMessage,
    });
  }
}

test("every destructive update action rejects missing and invalid sessions before mutation", async () => {
  for (const authenticate of [
    createServerActionAuthenticator({
      readSessionId: async () => null,
      verifySession: async () => true,
      logger: { error() {} },
    }),
    createServerActionAuthenticator({
      readSessionId: async () => "a".repeat(64),
      verifySession: async () => false,
      logger: { error() {} },
    }),
  ]) {
    const { actions, dependencyCalls } = makeBlockedHarness(authenticate);
    await assertEveryActionRejected(actions, AUTHENTICATION_REQUIRED_MESSAGE);
    assert.deepEqual(dependencyCalls, []);
  }
});

test("authentication storage failure causes no mutation or sensitive logging", async () => {
  const secret = "AUTH_STORAGE_EXCEPTION_SECRET_SENTINEL";
  const logs = [];
  const authenticate = createServerActionAuthenticator({
    readSessionId: async () => "b".repeat(64),
    verifySession: async () => {
      throw new Error(secret);
    },
    logger: { error: (...values) => logs.push(values.join(" ")) },
  });
  const { actions, dependencyCalls } = makeBlockedHarness(authenticate);

  await assertEveryActionRejected(
    actions,
    AUTHENTICATION_UNAVAILABLE_MESSAGE
  );

  assert.deepEqual(dependencyCalls, []);
  assert.equal(logs.join(" ").includes(secret), false);
  assert.equal(logs.every((value) => value === "Server action authentication unavailable"), true);
});

test("valid authenticated update actions preserve existing behavior", async () => {
  let authentications = 0;
  let recordReads = 0;
  let clearReads = 0;
  let markCalls = 0;
  const pathUpdates = [];
  const actions = createUpdateActions({
    authenticate: async () => {
      authentications += 1;
    },
    backfillOccurrenceCounts: async () => ({
      success: true,
      updated: 7,
    }),
    getTotalRecordsToMigrate: async () => 1,
    getRecordsToMigrate: async () => {
      recordReads += 1;
      return recordReads === 1
        ? [
            {
              id: 42,
              image_data: "test-image-data",
              plate_number: "TEST123",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ]
        : [];
    },
    migrateBase64ToFile: async () => ({
      imagePath: "safe/image.jpg",
      thumbnailPath: "safe/thumbnail.jpg",
    }),
    updateImagePathsBatch: async (updates) => pathUpdates.push(updates),
    clearImageDataBatch: async () => {
      clearReads += 1;
      return clearReads === 1 ? 3 : 0;
    },
    markUpdateComplete: async () => {
      markCalls += 1;
    },
    verifyImageMigration: async () => ({
      success: true,
      isComplete: true,
      incompleteCount: 0,
    }),
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(await actions.dbBackfill(), {
    success: true,
    updated: 7,
  });
  assert.deepEqual(await actions.migrateImageDataToFiles(), {
    success: true,
    processed: 1,
    errors: 0,
    totalRecords: 1,
  });
  assert.deepEqual(pathUpdates, [
    [
      {
        id: 42,
        imagePath: "safe/image.jpg",
        thumbnailPath: "safe/thumbnail.jpg",
      },
    ],
  ]);
  assert.deepEqual(await actions.clearImageData(), {
    success: true,
    clearedCount: 3,
  });
  assert.deepEqual(await actions.completeUpdate(), { success: true });
  assert.deepEqual(await actions.skipImageMigration(), { success: true });
  assert.equal(authentications, ACTION_NAMES.length);
  assert.equal(markCalls, 2);
});

test("app server actions delegate all five operations to the authenticated action set", async () => {
  const source = await fs.readFile(new URL("../app/actions.js", import.meta.url), "utf8");

  assert.match(source, /authenticate:\s*requireAuthenticatedSession/);
  for (const name of ACTION_NAMES) {
    assert.match(
      source,
      new RegExp(
        `export async function ${name}\\([^)]*\\) \\{\\s*await requireAuthenticatedSession\\(\\);\\s*return await updateActions\\.${name}\\([^)]*\\);\\s*\\}`
      )
    );
  }
});
