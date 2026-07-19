import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("login supports named users while retaining guarded compatibility access", async () => {
  const page = await fs.readFile("app/login/page.jsx", "utf8");
  const actions = await fs.readFile("app/actions.js", "utf8");
  assert.match(page, /name="username"/);
  assert.match(page, /showCompatibilityHelp/);
  assert.match(page, /getLoginSetupState/);
  assert.match(actions, /getLoginSetupState/);
  assert.match(actions, /if \(username\) \{/);
  assert.match(actions, /getIdentityService\(\)\.authenticate/);
});

test("security settings expose guarded bootstrap and user administration", async () => {
  const source = await fs.readFile("app/settings/UserManagement.jsx", "utf8");
  assert.match(source, /Create your named administrator/);
  assert.match(source, /Current administrator password/);
  assert.match(source, /administrator.*operator.*viewer.*auditor/s);
  assert.match(source, /setNamedUserStatus/);
  assert.match(source, /setNamedUserRole/);
  assert.match(source, /resetNamedUserPassword/);
  assert.match(source, /deleteNamedUser/);
});

test("role permissions guard server actions and privileged API routes", async () => {
  const actions = await fs.readFile("app/actions.js", "utf8");
  const mqttRoute = await fs.readFile("app/api/mqtt/brokers/route.js", "utf8");
  const exportRoute = await fs.readFile("app/api/exports/plates/route.js", "utf8");
  assert.match(actions, /requirePermission\("plate\.delete"\)/);
  assert.match(actions, /requirePermission\("system\.manage_users"\)/);
  assert.match(actions, /requirePermission\("maintenance\.manage"\)/);
  assert.match(mqttRoute, /denyUnlessRoutePermission\("mqtt\.manage"\)/);
  assert.match(exportRoute, /denyUnlessRoutePermission\("export\.create"\)/);
});


test("new-user passwords are confirmed and temporary-password reminders persist", async () => {
  const [users, actions, migration, repository, reminder] = await Promise.all([
    fs.readFile("app/settings/UserManagement.jsx", "utf8"),
    fs.readFile("app/actions.js", "utf8"),
    fs.readFile("migrations.sql", "utf8"),
    fs.readFile("lib/identity-repository.mjs", "utf8"),
    fs.readFile("components/auth/PasswordChangeReminder.jsx", "utf8"),
  ]);
  assert.match(users, /name="confirmPassword"/);
  assert.match(users, /Temporary password and confirmation do not match/);
  assert.match(actions, /Temporary password and confirmation do not match/);
  assert.match(migration, /must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(repository, /must_change_password = \$3/);
  assert.match(reminder, /Change your temporary password/);
  assert.match(reminder, /Change password now/);
});
