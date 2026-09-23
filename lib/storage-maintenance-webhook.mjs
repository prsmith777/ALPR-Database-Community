import { normalizeWebhookUrl, sendWebhookNotification } from "./webhook-notifications.mjs";

export async function deliverStorageMaintenanceWebhookTest({
  webhookUrl = "",
  savedWebhookUrl = "",
  applicationConfig = {},
  sendWebhook = sendWebhookNotification,
  now = () => new Date(),
} = {}) {
  const candidate = String(webhookUrl || "").trim();
  const destination = candidate
    ? normalizeWebhookUrl(candidate).toString()
    : String(savedWebhookUrl || "").trim();
  if (!destination) throw new Error("No maintenance webhook destination is configured.");
  const observedAt = now();
  const eventId = `maintenance-webhook-test-${observedAt.getTime()}`;
  const response = await sendWebhook({
    config: applicationConfig.notifications?.webhook || {},
    payload: {
      url: destination,
      eventId,
      idempotencyKey: eventId,
      body: {
        schema_version: 1,
        event_type: "maintenance.webhook_test",
        severity: "ok",
        timestamp: observedAt.toISOString(),
        message: "This is a storage maintenance webhook test from ALPR Database Community.",
      },
    },
  });
  return {
    delivered: true,
    status: Number(response?.status) || null,
    usedSavedDestination: !candidate,
  };
}
