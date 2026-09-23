import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getAuthConfig,
  getSessionInfo,
  invalidateSession,
  resetAuthStateForTests,
  verifySession,
} from "../lib/auth.js";
import { getOwnValidSession } from "../lib/session-validation.mjs";

let temporaryDirectory;
let temporaryAuth;
let originalEnvironment;

beforeEach(async () => {
  originalEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    ALPR_AUTH_FILE_PATH: process.env.ALPR_AUTH_FILE_PATH,
  };
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "alpr-session-validation-")
  );
  temporaryAuth = path.join(temporaryDirectory, "auth.json");
  process.env.NODE_ENV = "test";
  process.env.ALPR_AUTH_FILE_PATH = temporaryAuth;
  resetAuthStateForTests();
});

afterEach(async () => {
  resetAuthStateForTests();
  if (originalEnvironment.NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalEnvironment.NODE_ENV;
  }
  if (originalEnvironment.ALPR_AUTH_FILE_PATH === undefined) {
    delete process.env.ALPR_AUTH_FILE_PATH;
  } else {
    process.env.ALPR_AUTH_FILE_PATH = originalEnvironment.ALPR_AUTH_FILE_PATH;
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function validRecord(overrides = {}) {
  const now = Date.now();
  return {
    createdAt: now - 1000,
    lastUsed: now - 500,
    expiresAt: now + 60_000,
    userAgent: "Session validation test",
    ...overrides,
  };
}

async function loadSessions(sessions) {
  await fs.writeFile(
    temporaryAuth,
    JSON.stringify({
      password: "unused-test-hash",
      apiKey: "isolated-api-key",
      sessions,
    })
  );
  resetAuthStateForTests();
  return await getAuthConfig();
}

test("rejects prototype names, empty, non-hex, and short session IDs", async () => {
  await loadSessions({});
  for (const sessionId of [
    "__proto__",
    "**proto**",
    "constructor",
    "toString",
    "",
    "z".repeat(64),
    "a".repeat(63),
  ]) {
    assert.equal(await verifySession(sessionId), false, sessionId);
    assert.equal(await getSessionInfo(sessionId), null, sessionId);
    assert.equal(await invalidateSession(sessionId), false, sessionId);
  }
});

test("rejects a valid-format session ID that is not an own property", async () => {
  const sessionId = "1".repeat(64);
  const config = await loadSessions({});
  assert.equal(Object.getPrototypeOf(config.sessions), null);
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("an inherited valid-format session record is rejected", () => {
  const sessionId = "2".repeat(64);
  const inheritedSessions = Object.create({
    [sessionId]: validRecord(),
  });
  assert.equal(getOwnValidSession(inheritedSessions, sessionId), null);
});

test("rejects an own session record with missing expiresAt", async () => {
  const sessionId = "3".repeat(64);
  const record = validRecord();
  delete record.expiresAt;
  await loadSessions({ [sessionId]: record });
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("rejects an own session record with non-numeric expiresAt", async () => {
  const sessionId = "4".repeat(64);
  await loadSessions({
    [sessionId]: validRecord({ expiresAt: "not-a-timestamp" }),
  });
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("rejects an own session record with missing lastUsed", async () => {
  const sessionId = "5".repeat(64);
  const record = validRecord();
  delete record.lastUsed;
  await loadSessions({ [sessionId]: record });
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("rejects an own session record with missing createdAt", async () => {
  const sessionId = "6".repeat(64);
  const record = validRecord();
  delete record.createdAt;
  await loadSessions({ [sessionId]: record });
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("rejects a non-object own session record", async () => {
  const sessionId = "7".repeat(64);
  await loadSessions({ [sessionId]: [] });
  assert.equal(await verifySession(sessionId), false);
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await invalidateSession(sessionId), false);
});

test("rejects and removes an expired valid session", async () => {
  const sessionId = "8".repeat(64);
  const config = await loadSessions({
    [sessionId]: validRecord({ expiresAt: Date.now() - 1 }),
  });
  assert.equal(await getSessionInfo(sessionId), null);
  assert.equal(await verifySession(sessionId), false);
  assert.equal(Object.hasOwn(config.sessions, sessionId), false);
});

test("accepts and can invalidate a well-formed unexpired own session", async () => {
  const sessionId = "9".repeat(64);
  const config = await loadSessions({ [sessionId]: validRecord() });
  assert.equal(Object.getPrototypeOf(config.sessions), null);
  assert.equal(Object.hasOwn(config.sessions, sessionId), true);
  assert.equal(await verifySession(sessionId), true);
  assert.equal((await getSessionInfo(sessionId))?.userAgent, "Session validation test");
  assert.equal(await invalidateSession(sessionId), true);
  assert.equal(await verifySession(sessionId), false);
});
