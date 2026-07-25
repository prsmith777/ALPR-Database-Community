import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("MQTT operational tools live under Settings integrations", async () => {
  const [legacyPage, page, admin] = await Promise.all([
    source("app/mqtt/page.jsx"),
    source("app/settings/integrations/mqtt/page.jsx"),
    source("components/mqtt/MqttAdmin.jsx"),
  ]);

  assert.match(legacyPage, /redirect\("\/settings\/integrations\/mqtt"\)/);
  assert.match(page, /<MqttAdmin/);
  assert.match(admin, />\s*Brokers\s*</);
  assert.match(admin, />\s*Cameras & Topics\s*</);
  assert.match(admin, />\s*Test & Activity\s*</);
  assert.doesNotMatch(admin, />\s*Rules\s*</);
});

test("primary navigation names Notification Rules and leaves MQTT in Settings", async () => {
  const sidebar = await source("components/Sidebar.jsx");

  assert.doesNotMatch(sidebar, /label: "MQTT"/);
  assert.match(sidebar, /label: "Notification Rules", href: "\/notifications"/);
  assert.match(sidebar, /navItems\.map/);
});

test("notifications host the unified builder without embedding MQTT broker administration", async () => {
  const notifications = await source("app/notifications/page.jsx");

  assert.equal(notifications.includes("MqttNotificationsTable"), false);
  assert.equal(notifications.includes("getMqttNotificationsAction"), false);
  assert.match(notifications, /NotificationRulesWorkspace/);
  assert.doesNotMatch(notifications, /NotificationLegacyFinalizationPanel/);
  assert.doesNotMatch(notifications, /Legacy exact-plate Pushover rules|NotificationsTable/);
});

test("general Settings no longer embeds the obsolete MQTT broker manager", async () => {
  const settings = await source("app/settings/SettingsForm.jsx");

  assert.equal(settings.includes("MqttBrokerManager"), false);
  assert.equal(settings.includes('id: "mqtt"'), false);
  assert.equal(settings.includes('case "mqtt"'), false);
  assert.equal(settings.includes("renderMqttSection"), false);
});

test("settings navigation exposes dedicated integration pages", async () => {
  const shell = await source("components/settings/SettingsShell.jsx");
  for (const path of ["mqtt", "pushover", "email", "webhook"]) {
    assert.match(shell, new RegExp(`/settings/integrations/${path}`));
  }
});

test("Test & Activity queues through the durable test API and reads outbox history", async () => {
  const activity = await source("components/mqtt/MqttActivity.jsx");
  const testRoute = await source("app/api/mqtt/test/route.js");

  assert.match(activity, /\/api\/mqtt\/test/);
  assert.match(activity, /\/api\/mqtt\/activity/);
  assert.match(testRoute, /startMqttRuntime/);
  assert.match(testRoute, /queueMqttTestPublish/);
  assert.equal(testRoute.includes("clientManager.publish"), false);
});

test("MQTT broker dialog remains reachable on short browser viewports", async () => {
  const brokers = await source("components/mqtt/MqttBrokers.jsx");

  assert.match(
    brokers,
    /max-h-\[calc\(100dvh-2rem\)\] max-w-lg overflow-y-auto/
  );
});
