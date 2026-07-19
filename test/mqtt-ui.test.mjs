import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("MQTT has a dedicated application page with the four agreed sections", async () => {
  const [page, admin] = await Promise.all([
    source("app/mqtt/page.jsx"),
    source("components/mqtt/MqttAdmin.jsx"),
  ]);

  assert.match(page, /title="MQTT"/);
  assert.match(page, /<MqttAdmin/);
  assert.match(admin, />\s*Brokers\s*</);
  assert.match(admin, />\s*Cameras & Topics\s*</);
  assert.match(admin, />\s*Rules\s*</);
  assert.match(admin, />\s*Test & Activity\s*</);
});

test("primary desktop and mobile navigation expose the dedicated MQTT page", async () => {
  const sidebar = await source("components/Sidebar.jsx");

  assert.match(sidebar, /label: "MQTT", href: "\/mqtt"/);
  assert.match(sidebar, /label: "Notifications", href: "\/notifications"/);
  assert.match(sidebar, /navItems\.map/);
});

test("notifications remain Pushover-only and direct users to the MQTT page", async () => {
  const notifications = await source("app/notifications/page.jsx");

  assert.equal(notifications.includes("MqttNotificationsTable"), false);
  assert.equal(notifications.includes("getMqttNotificationsAction"), false);
  assert.match(notifications, /dedicated MQTT page/);
  assert.match(notifications, /Push Notifications/);
});

test("general Settings no longer embeds the obsolete MQTT broker manager", async () => {
  const settings = await source("app/settings/SettingsForm.jsx");

  assert.equal(settings.includes("MqttBrokerManager"), false);
  assert.equal(settings.includes('id: "mqtt"'), false);
  assert.equal(settings.includes('case "mqtt"'), false);
  assert.equal(settings.includes("renderMqttSection"), false);
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
