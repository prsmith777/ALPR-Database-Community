import test from "node:test";
import assert from "node:assert/strict";

import {
  IdentityInputError,
  IdentityService,
  hashSessionToken,
  hasPermission,
  legacyAdministratorPrincipal,
} from "../lib/identity-service.mjs";

function makeService(overrides = {}) {
  const calls = [];
  const repository = {
    getBootstrapState: async () => ({ user_count: 0, active_user_count: 0 }),
    bootstrapOwner: async (input) => {
      calls.push(["bootstrapOwner", input]);
      return { id: 1, username: input.username, roles: ["administrator"] };
    },
    findUserByUsername: async () => null,
    recordFailedLogin: async (...args) => calls.push(["failed", ...args]),
    createSession: async (input) => calls.push(["session", input]),
    getSessionPrincipal: async () => null,
    touchSession: async () => {},
    revokeSession: async () => true,
    listUsers: async () => [],
    createUser: async (input) => input,
    setUserStatus: async (input) => calls.push(["status", input]),
    setUserRole: async (input) => calls.push(["role", input]),
    updateUserPassword: async (input) => calls.push(["password", input]),
    findUserById: async () => null,
    ...overrides,
  };
  const service = new IdentityService({
    repository,
    passwordHasher: async (password) => `hash:${password}`,
    passwordVerifier: async (password, hash) => hash === `hash:${password}`,
    randomToken: () => "a".repeat(64),
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  return { service, calls };
}

test("owner bootstrap normalizes identity and stores only a session hash", async () => {
  const { service, calls } = makeService();
  const result = await service.bootstrapOwner({
    username: "  Paul.Admin ",
    displayName: " Paul Smith ",
    password: "correct horse",
    userAgent: "Browser",
  });

  assert.equal(result.sessionToken, "a".repeat(64));
  const input = calls[0][1];
  assert.equal(input.username, "paul.admin");
  assert.equal(input.displayName, "Paul Smith");
  assert.equal(input.passwordHash, "hash:correct horse");
  assert.equal(input.tokenHash, hashSessionToken(result.sessionToken));
  assert.notEqual(input.tokenHash, result.sessionToken);
});

test("named login is generic on failure and records the attempt", async () => {
  const { service, calls } = makeService({
    findUserByUsername: async () => ({
      id: 7,
      status: "active",
      password_hash: "hash:different",
    }),
  });
  assert.equal(
    await service.authenticate({ username: "person", password: "wrong" }),
    null
  );
  assert.deepEqual(calls[0], ["failed", 7, "person"]);
});

test("named login creates a persistent hashed session", async () => {
  const { service, calls } = makeService({
    findUserByUsername: async () => ({
      id: 7,
      status: "active",
      password_hash: "hash:correct horse",
    }),
  });
  const result = await service.authenticate({
    username: "person",
    password: "correct horse",
    userAgent: "Browser",
  });
  assert.equal(result.sessionToken, "a".repeat(64));
  assert.equal(calls[0][0], "session");
  assert.equal(calls[0][1].tokenHash, hashSessionToken(result.sessionToken));
});

test("user inputs and last-administrator repository guards remain errors", async () => {
  const { service } = makeService({
    setUserRole: async () => {
      const error = new Error("Keep one active administrator.");
      error.code = "LAST_ADMINISTRATOR";
      throw error;
    },
  });
  await assert.rejects(
    service.createUser({
      actor: { id: 1 },
      username: "x",
      displayName: "X",
      password: "long enough",
      role: "viewer",
    }),
    IdentityInputError
  );
  await assert.rejects(
    service.setUserRole({ actor: { id: 1 }, userId: 1, role: "viewer" }),
    { code: "LAST_ADMINISTRATOR" }
  );
});

test("legacy administrator retains all permissions during migration", () => {
  const principal = legacyAdministratorPrincipal();
  assert.equal(hasPermission(principal, "system.manage_users"), true);
  assert.equal(hasPermission(principal, "system.manage_settings"), true);
});
