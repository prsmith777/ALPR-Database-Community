import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  isPermissionKey,
  isSystemRole,
  normalizeUsername,
  permissionsForRole,
} from "../lib/identity-model.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("identity roles expose the agreed least-privilege permission matrix", () => {
  assert.deepEqual(SYSTEM_ROLES, [
    "administrator",
    "operator",
    "viewer",
    "auditor",
  ]);
  assert.deepEqual(permissionsForRole("administrator"), PERMISSION_KEYS);
  assert.equal(ROLE_PERMISSIONS.operator.includes("system.manage_users"), false);
  assert.equal(ROLE_PERMISSIONS.viewer.includes("plate.review"), false);
  assert.equal(ROLE_PERMISSIONS.auditor.includes("system.view_audit"), true);
  assert.equal(isSystemRole("Operator"), true);
  assert.equal(isPermissionKey("mqtt.manage"), true);
  assert.equal(isPermissionKey("shell.execute"), false);
});

test("usernames normalize predictably and reject ambiguous values", () => {
  assert.equal(normalizeUsername("  Paul.Smith-7  "), "paul.smith-7");
  assert.throws(() => normalizeUsername("ab"), /3-64 characters/);
  assert.throws(() => normalizeUsername("Paul Smith"), /3-64 characters/);
  assert.throws(() => normalizeUsername("../owner"), /3-64 characters/);
});

test("identity migration creates durable normalized security records", async () => {
  const migration = await source("migrations.sql");

  for (const table of [
    "schema_migrations",
    "users",
    "roles",
    "permissions",
    "role_permissions",
    "user_roles",
    "user_sessions",
    "api_credentials",
    "audit_events",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`)
    );
  }

  assert.match(migration, /users_username_lower_key/);
  assert.match(migration, /user_sessions_token_hash_format/);
  assert.match(migration, /api_credentials_secret_hash_format/);
  assert.match(migration, /audit_events_append_only/);
  assert.match(migration, /prevent_audit_event_mutation/);
  assert.match(migration, /2026071901_identity_audit_foundation/);
});

test("foundation migration preserves the existing login until cutover", async () => {
  const [migration, auth, login] = await Promise.all([
    source("migrations.sql"),
    source("lib/auth.js"),
    source("app/login/page.jsx"),
  ]);

  assert.equal(/INSERT INTO public\.users\s*\(/.test(migration), false);
  assert.match(auth, /path\.join\(process\.cwd\(\), "auth", "auth\.json"\)/);
  assert.match(auth, /export async function verifyPassword/);
  assert.match(login, /name="password"/);
});
