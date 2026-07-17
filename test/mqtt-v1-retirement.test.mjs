import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("obsolete MQTT v1 application code is no longer executable", async () => {
  const [actions, notificationsPage, plateRoute] = await Promise.all([
    readSource("app/actions.js"),
    readSource("app/notifications/page.jsx"),
    readSource("app/api/plate-reads/route.js"),
  ]);

  const forbiddenActionTokens = [
    "getMqttBrokersAction",
    "getMqttNotificationsAction",
    "addMqttNotificationAction",
    "editMqttNotificationAction",
    "toggleMqttNotificationAction",
    "deleteMqttNotificationAction",
    "testMqttNotificationAction",
    'formData.get("mqttBroker")',
    'formData.get("mqttTopic")',
    "@/lib/mqtt-client",
  ];

  for (const token of forbiddenActionTokens) {
    assert.equal(
      actions.includes(token),
      false,
      `app/actions.js still contains obsolete MQTT token: ${token}`
    );
  }

  assert.equal(
    notificationsPage.includes("MqttNotificationsTable"),
    false,
    "Notifications still embeds the obsolete MQTT table"
  );

  assert.equal(
    plateRoute.includes("sendMqttNotificationByPlate"),
    false,
    "Plate ingestion still calls the obsolete direct MQTT sender"
  );

  const deletedFiles = [
    "components/MqttBrokerManager.jsx",
    "components/MqttNotificationsTable.jsx",
    "lib/mqtt-client.js",
  ];

  for (const relativePath of deletedFiles) {
    await assert.rejects(
      () => access(new URL(`../${relativePath}`, import.meta.url)),
      (error) => error?.code === "ENOENT",
      `${relativePath} should have been deleted`
    );
  }
});
