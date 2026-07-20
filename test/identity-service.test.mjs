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
    deleteUser: async (input) => calls.push(["delete", input]),
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


test("administrators cannot use reset to bypass their own current password", async () => {
  const { service } = makeService();
  await assert.rejects(
    service.resetUserPassword({
      actor: { id: 1 },
      userId: 1,
      password: "new password",
      currentPassword: "",
    }),
    { code: "CANNOT_RESET_SELF" }
  );
});

test("administrator password is required to reset another user", async () => {
  const { service, calls } = makeService({
    findUserById: async () => ({
      id: 1,
      password_hash: "hash:administrator password",
    }),
  });

  await assert.rejects(
    service.resetUserPassword({
      actor: { id: 1 },
      userId: 2,
      password: "new password",
      currentPassword: "wrong password",
    }),
    { code: "INVALID_PASSWORD" }
  );

  await service.resetUserPassword({
    actor: { id: 1 },
    userId: 2,
    password: "new password",
    currentPassword: "administrator password",
  });
  assert.deepEqual(calls.at(-1), [
    "password",
    {
      actorUserId: 1,
      targetUserId: 2,
      passwordHash: "hash:new password",
      eventType: "identity.user_password_reset",
      mustChangePassword: true,
    },
  ]);
});

test("account deletion forbids self-delete and requires administrator password", async () => {
  const { service, calls } = makeService({
    findUserById: async () => ({
      id: 1,
      password_hash: "hash:administrator password",
    }),
  });

  await assert.rejects(
    service.deleteUser({
      actor: { id: 1 },
      userId: 1,
      confirmUsername: "admin",
      currentPassword: "administrator password",
    }),
    { code: "CANNOT_DELETE_SELF" }
  );
  await assert.rejects(
    service.deleteUser({
      actor: { id: 1 },
      userId: 2,
      confirmUsername: "operator",
      currentPassword: "wrong",
    }),
    { code: "INVALID_PASSWORD" }
  );

  await service.deleteUser({
    actor: { id: 1 },
    userId: 2,
    confirmUsername: "Operator",
    currentPassword: "administrator password",
  });
  assert.equal(calls.at(-1)[0], "delete");
  assert.equal(calls.at(-1)[1].targetUserId, 2);
  assert.equal(calls.at(-1)[1].confirmUsername, "operator");
  assert.match(calls.at(-1)[1].deletedPasswordHash, /^hash:/);
});


test("new non-administrators must change temporary passwords", async () => {
  const { service } = makeService({ createUser: async (input) => input });
  const viewer = await service.createUser({
    actor: { id: 1 },
    username: "new.viewer",
    displayName: "New Viewer",
    password: "temporary password",
    role: "viewer",
  });
  assert.equal(viewer.mustChangePassword, true);
  const administrator = await service.createUser({
    actor: { id: 1 },
    username: "new.admin",
    displayName: "New Admin",
    password: "temporary password",
    role: "administrator",
  });
  assert.equal(administrator.mustChangePassword, false);
});

test("changing the user's own password clears the reminder", async () => {
  const { service, calls } = makeService({
    findUserById: async () => ({ id: 2, password_hash: "hash:temporary password" }),
  });
  await service.changeOwnPassword({
    actor: { id: 2 },
    currentPassword: "temporary password",
    newPassword: "permanent password",
  });
  assert.deepEqual(calls.at(-1), [
    "password",
    {
      actorUserId: 2,
      targetUserId: 2,
      passwordHash: "hash:permanent password",
      eventType: "identity.password_changed",
      mustChangePassword: false,
    },
  ]);
});
