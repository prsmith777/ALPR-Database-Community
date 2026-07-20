import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("login supports named users while retaining guarded compatibility access", async () => {
  const page = await fs.readFile("app/login/page.jsx", "utf8");
  const actions = await fs.readFile("app/actions.js", "utf8");
  const route = await fs.readFile("app/api/login-state/route.js", "utf8");
  assert.match(page, /name="username"/);
  assert.match(page, /showCompatibilityHelp/);
  assert.match(page, /\/api\/login-state/);
  assert.match(route, /getBootstrapState/);
  assert.match(route, /bootstrapped: true/);
  assert.doesNotMatch(actions, /getLoginSetupState/);
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
  assert.match(users, /Temporary passwords do not match/);
  assert.match(users, /role="alert"/);
  assert.match(users, /PasswordInput/);
  assert.doesNotMatch(users, /PasswordInputWithToggle/);
  assert.match(actions, /Temporary password and confirmation do not match/);
  assert.match(migration, /must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(repository, /must_change_password = \$3/);
  assert.match(reminder, /Change your temporary password/);
  assert.match(reminder, /Change password now/);
});

test("successful password changes end the invalid session with a login redirect", async () => {
  const actions = await fs.readFile("app/actions.js", "utf8");
  const changePassword = actions.match(
    /export async function updatePassword[\s\S]*?(?=export async function regenerateApiKey)/
  )?.[0];

  assert.ok(changePassword, "expected the complete password-change action");
  assert.match(changePassword, /clearSessionCookie\(cookieStore\)/);
  assert.match(changePassword, /redirect\("\/login"\)/);
  assert.ok(
    changePassword.lastIndexOf('redirect("/login")') >
      changePassword.lastIndexOf("} catch"),
    "redirect must be outside the catch block so Next.js can complete navigation"
  );
});

test("every password field uses the shared accessible visibility control", async () => {
  const passwordEntryFiles = [
    "app/login/page.jsx",
    "app/settings/SecuritySettings.jsx",
    "app/settings/SettingsForm.jsx",
    "app/settings/UserManagement.jsx",
    "components/mqtt/MqttBrokers.jsx",
  ];

  for (const path of passwordEntryFiles) {
    const file = await fs.readFile(path, "utf8");
    assert.match(file, /PasswordInput/, `${path} must use PasswordInput`);
    assert.doesNotMatch(
      file,
      /type="password"/,
      `${path} must not bypass the shared visibility control`
    );
  }

  const shared = await fs.readFile(
    "components/ui/password-input.jsx",
    "utf8"
  );
  assert.match(shared, /type={visible \? "text" : "password"}/);
  assert.match(shared, /aria-label/);
  assert.match(shared, /aria-pressed={visible}/);
  assert.match(shared, /EyeOff/);
  assert.match(shared, /type="button"/);
});
