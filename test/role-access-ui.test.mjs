import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("plate-reading pages use limited view settings instead of administrator settings", async () => {
  for (const path of [
    "app/live_feed/page.jsx",
    "app/live_feed/viewer/page.jsx",
    "app/database/page.jsx",
    "app/download/page.jsx",
  ]) {
    const page = await source(path);
    assert.match(page, /getPlateViewSettings/);
    assert.doesNotMatch(page, /\bgetSettings\b/);
  }
  const actions = await source("app/actions.js");
  assert.match(actions, /getPlateViewSettings[\s\S]*requirePermission\("plate\.read"\)/);
  assert.doesNotMatch(
    actions.match(/getPlateViewSettings[\s\S]*?\n}\n/)[0],
    /database|password|apiKey/i
  );
});

test("navigation and direct management pages enforce role permissions", async () => {
  const sidebar = await source("components/Sidebar.jsx");
  assert.match(sidebar, /permission: "notification\.manage"/);
  assert.match(sidebar, /permission: "mqtt\.manage"/);
  assert.match(sidebar, /canViewAudit/);

  const expectedGuards = new Map([
    ["app/logs/page.jsx", "system.view_audit"],
    ["app/mqtt/page.jsx", "mqtt.manage"],
    ["app/notifications/page.jsx", "notification.manage"],
    ["app/backfill/page.jsx", "maintenance.manage"],
    ["app/jpeg_migration/layout.jsx", "maintenance.manage"],
    ["app/update/layout.jsx", "maintenance.manage"],
    ["app/database/tags/layout.jsx", "tag.manage"],
  ]);
  for (const [path, permission] of expectedGuards) {
    const page = await source(path);
    assert.match(page, new RegExp(`requirePagePermission\\("${permission.replace(".", "\\.")}"\\)`));
  }
});

test("personal settings do not load administrator configuration or user lists", async () => {
  const page = await source("app/settings/page.jsx");
  assert.match(page, /canManageSettings \? getSettings\(\) : Promise\.resolve\(null\)/);
  assert.match(page, /canManageSettings \? getAuthConfig\(\)/);

  const actions = await source("app/actions.js");
  assert.match(actions, /state\.bootstrapped && canManageUsers[\s\S]*listUsers/);

  const form = await source("app/settings/SettingsForm.jsx");
  assert.match(form, /canManageSettings \? "general" : "security"/);

  const security = await source("app/settings/SecuritySettings.jsx");
  assert.match(security, /canManageSettings && \(/);
});

test("password reset UI and server action require administrator reauthentication", async () => {
  const users = await source("app/settings/UserManagement.jsx");
  assert.match(users, /!isCurrent/);
  assert.match(users, /name="currentPassword"/);
  assert.match(users, /name="confirmPassword"/);

  const actions = await source("app/actions.js");
  assert.match(
    actions,
    /resetUserPassword\([\s\S]*currentPassword: formData\.get\("currentPassword"\)/
  );
});
