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
    ["app/dashboard/page.jsx", "plate.read"],
    ["app/live_feed/page.jsx", "plate.read"],
    ["app/live_feed/viewer/page.jsx", "plate.read"],
    ["app/database/page.jsx", "plate.read"],
    ["app/known_plates/page.jsx", "plate.read"],
    ["app/flagged/page.jsx", "plate.read"],
    ["app/download/page.jsx", "export.create"],
    ["app/logs/page.jsx", "system.view_audit"],
    ["app/mqtt/page.jsx", "mqtt.manage"],
    ["app/notifications/page.jsx", "notification.manage"],
    ["app/backfill/page.jsx", "maintenance.manage"],
    ["app/jpeg_migration/layout.jsx", "maintenance.manage"],
    ["app/update/layout.jsx", "maintenance.manage"],
    ["app/database/tags/layout.jsx", "tag.manage"],
    ["app/help/page.jsx", "plate.read"],
    ["app/tpms/layout.jsx", "maintenance.manage"],
  ]);
  for (const [path, permission] of expectedGuards) {
    const page = await source(path);
    assert.match(page, new RegExp(`requirePagePermission\\("${permission.replace(".", "\\.")}"\\)`));
  }
});

test("navigation starts denied and exposes only links granted by current access", async () => {
  const [provider, sidebar, titleNav, filters] = await Promise.all([
    source("components/auth/AccessProvider.jsx"),
    source("components/Sidebar.jsx"),
    source("components/layout/TitleNav.jsx"),
    source("components/PlateDatabaseFilters.jsx"),
  ]);
  assert.match(provider, /permissions: \[\]/);
  assert.doesNotMatch(sidebar, /useState\(\["plate\.read"\]\)/);
  assert.match(sidebar, /useAccess\(\)/);
  assert.match(titleNav, /permission: "tag\.manage"/);
  assert.match(titleNav, /permission: "export\.create"/);
  assert.match(filters, /can\("export\.create"\)/);
});

test("plate tables hide mutation and export controls from read-only roles", async () => {
  const [feed, database, knownPlates] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/plateDbTable.jsx"),
    source("components/KnownPlatesTable.jsx"),
  ]);

  for (const component of [feed, database, knownPlates]) {
    assert.match(component, /useAccess\(\)/);
    assert.match(component, /can\("tag\.manage"\)/);
    assert.match(component, /can\("known_plate\.manage"\)/);
  }
  assert.match(feed, /can\("plate\.review"\)/);
  assert.match(feed, /can\("plate\.delete"\)/);
  assert.match(feed, /can\("export\.create"\)/);
  assert.match(database, /can\("plate\.review"\)/);
  assert.match(database, /can\("plate\.delete"\)/);
  assert.match(knownPlates, /can\("plate\.review"\)/);
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
  assert.match(page, /canManageUsers[\s\S]*\? getIdentityAdminState\(\)/);
  assert.match(page, /Promise\.resolve\(personalIdentityState\)/);
  assert.match(
    security,
    /!initialIdentityState\.bootstrapped[\s\S]*initialIdentityState\.canManageUsers/
  );
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

test("permanent account deletion requires username confirmation and administrator reauthentication", async () => {
  const [users, actions, service, repository] = await Promise.all([
    source("app/settings/UserManagement.jsx"),
    source("app/actions.js"),
    source("lib/identity-service.mjs"),
    source("lib/identity-repository.mjs"),
  ]);
  assert.match(users, /deleteNamedUser/);
  assert.match(users, /name="confirmUsername"/);
  assert.match(users, /Delete account/);
  assert.match(actions, /deleteNamedUser[\s\S]*requirePermission\("system\.manage_users"\)/);
  assert.match(service, /CANNOT_DELETE_SELF/);
  assert.match(service, /Incorrect administrator password/);
  assert.match(repository, /identity\.user_deleted/);
  assert.match(repository, /account_deleted/);
  assert.match(repository, /deleted_at = CURRENT_TIMESTAMP/);
});


test("current access carries the persistent temporary-password reminder", async () => {
  const [actions, repository, layout] = await Promise.all([
    source("app/actions.js"),
    source("lib/identity-repository.mjs"),
    source("components/layout/MainLayout.jsx"),
  ]);
  assert.match(actions, /mustChangePassword: Boolean\(principal\.mustChangePassword\)/);
  assert.match(repository, /mustChangePassword: Boolean\(row\.must_change_password\)/);
  assert.match(layout, /<PasswordChangeReminder \/>/);
});

test("Viewer, Operator, and Auditor page loaders stay within non-admin permissions", async () => {
  const sharedPlatePages = [
    "app/dashboard/page.jsx",
    "app/live_feed/page.jsx",
    "app/live_feed/viewer/page.jsx",
    "app/database/page.jsx",
    "app/known_plates/page.jsx",
    "app/flagged/page.jsx",
    "app/help/page.jsx",
  ];
  const auditorPages = ["app/download/page.jsx", "app/logs/page.jsx"];

  for (const path of [...sharedPlatePages, ...auditorPages]) {
    const page = await source(path);
    assert.doesNotMatch(
      page,
      /\b(?:getSettings|getAuthConfig|getIdentityAdminState)\b/,
      `${path} must not load administrator-only state`
    );
  }

  const actions = await source("app/actions.js");
  for (const action of [
    "getDashboardMetrics",
    "getLatestPlateReads",
    "getPlates",
    "getKnownPlatesList",
    "getFlagged",
    "getPlateViewSettings",
  ]) {
    const body = actions.match(
      new RegExp(
        `export async function ${action}\\b[\\s\\S]*?(?=export async function)`
      )
    )?.[0];
    assert.ok(body, `expected ${action} action`);
    assert.match(body, /requirePermission\("plate\.read"\)/);
  }

  const logs = actions.match(
    /export async function getSystemLogs\b[\s\S]*?(?=export async function)/
  )?.[0];
  assert.ok(logs, "expected getSystemLogs action");
  assert.match(logs, /requirePermission\("system\.view_audit"\)/);
});

test("unfinished AI Assistant stays hidden and permission-locked until a real agent exists", async () => {
  const [layout, sidebar, agentChat, chatRoute, route, settings, model] =
    await Promise.all([
      source("app/layout.jsx"),
      source("components/Sidebar.jsx"),
      source("lib/agentchat.ts"),
      source("lib/chat-route.mjs"),
      source("app/api/chat/route.js"),
      source("lib/settings.js"),
      source("lib/identity-model.mjs"),
    ]);

  assert.doesNotMatch(layout, /ChatProvider|ChatInterface/);
  assert.doesNotMatch(sidebar, /ChatButton/);
  assert.doesNotMatch(agentChat, /test-agent|localhost:8000/);
  assert.match(agentChat, /hasPermission\(principal, "assistant\.use"\)/);
  assert.doesNotMatch(agentChat, /sessionId:\s*sessionId/);
  assert.match(route, /hasPermission\(principal, "assistant\.use"\)/);
  assert.doesNotMatch(chatRoute, /getOwnValidSession|getAuthConfig/);
  assert.match(settings, /agents:\s*\[\]/);
  assert.match(model, /"assistant\.use"/);
});
