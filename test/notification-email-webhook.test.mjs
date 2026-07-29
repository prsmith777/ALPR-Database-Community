import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  emailConfigurationState,
  normalizeEmailRecipients,
  sendEmailNotification,
} from "../lib/email-notifications.mjs";
import { NotificationOperationsWorker } from "../lib/notification-operations-worker.mjs";
import { notificationAcceptedReadServiceInternals } from "../lib/notification-accepted-read-service.mjs";
import { normalizeNotificationRuleDraft } from "../lib/notification-rule-builder-shape.mjs";
import { sanitizeSettingsForClient } from "../lib/settings-client.mjs";
import { getInitialEnvConfig } from "../lib/settings.js";
import {
  classifyAddress,
  sendWebhookNotification,
  validateWebhookDestination,
  webhookNotificationInternals,
  webhookConfigurationState,
} from "../lib/webhook-notifications.mjs";

function draft(actions) {
  return {
    name: "Multi-channel arrival",
    timeZone: "America/Denver",
    cooldownSeconds: 0,
    quietHours: { enabled: false },
    conditionTree: {
      kind: "group",
      combinator: "all",
      children: [{ kind: "condition", conditionType: "always", operator: "always", value: {} }],
    },
    actions,
  };
}

test("email and webhook rule actions keep credentials in protected settings references", () => {
  const normalized = normalizeNotificationRuleDraft(draft([
    { channelType: "email", configuration: { recipients: "Owner@Example.com;ops@example.com", subject: "Plate alert", attachImage: true } },
    { channelType: "webhook", configuration: { url: "https://automation.example.com/alpr", message: "Matched" } },
  ]));
  assert.deepEqual(normalized.actions[0].configuration.recipients, ["owner@example.com", "ops@example.com"]);
  assert.equal(normalized.actions[0].credentialReference, "settings:notifications.email");
  assert.equal(normalized.actions[1].credentialReference, "settings:notifications.webhook");
  assert.equal(normalized.actions[1].configuration.url, "https://automation.example.com/alpr");
  assert.equal(JSON.stringify(normalized).includes("signing_secret"), false);
  assert.throws(() => normalizeNotificationRuleDraft(draft([
    { channelType: "webhook", configuration: { url: "https://user:password@example.com/alpr" } },
  ])), /cannot contain credentials/i);
  assert.throws(() => normalizeNotificationRuleDraft(draft([
    { channelType: "email", configuration: { recipients: "not-an-email" } },
  ])), /valid email recipients/i);
});

test("accepted-read email and webhook payloads preserve rule context without credentials", () => {
  const base = {
    decision: { ruleId: 7, ruleName: "Known visitor" },
    event: {
      id: 42,
      type: "plate_read.accepted",
      timestamp: "2026-07-24T20:00:00.000Z",
      plateNumber: "ABC123",
      observedPlate: "ABC12B",
      cameraName: "Driveway",
      confidence: 0.91,
      knownName: "Visitor",
      tags: ["Guest"],
    },
    eventId: "plate-read:42",
    read: { image_path: "/images/read-42.jpg" },
  };
  const email = notificationAcceptedReadServiceInternals.durableActionPayload({
    ...base,
    action: { channelType: "email", configuration: { recipients: ["owner@example.com"], attachImage: true } },
  });
  const webhook = notificationAcceptedReadServiceInternals.durableActionPayload({
    ...base,
    action: { channelType: "webhook", configuration: { url: "https://automation.example.com/alpr" } },
  });
  assert.equal(email.imagePath, "/images/read-42.jpg");
  assert.equal(email.knownName, "Visitor");
  assert.equal(webhook.body.observed_plate, "ABC12B");
  assert.deepEqual(webhook.body.tags, ["Guest"]);
  assert.equal(JSON.stringify({ email, webhook }).includes("signing_secret"), false);
});

test("SMTP delivery validates configuration and returns only safe delivery metadata", async () => {
  const sent = [];
  let transportOptions;
  const result = await sendEmailNotification({
    config: {
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      verify_tls: true,
      from_address: "alpr@example.com",
      from_name: "ALPR Database",
    },
    payload: {
      eventId: "read-42",
      plateNumber: "ABC123",
      cameraName: "Driveway",
      recipients: ["owner@example.com"],
      subject: "Vehicle detected",
      message: "ABC123 arrived",
    },
    attachment: Buffer.from("jpeg"),
    transportFactory(options) {
      transportOptions = options;
      return {
        async sendMail(message) { sent.push(message); return { messageId: "message-1", accepted: ["owner@example.com"], rejected: [], response: "250 queued" }; },
        close() {},
      };
    },
  });
  assert.equal(emailConfigurationState({ enabled: true, host: "smtp.example.com", port: 587, from_address: "alpr@example.com" }).configured, true);
  assert.deepEqual(normalizeEmailRecipients("OWNER@example.com; owner@example.com"), ["owner@example.com"]);
  assert.equal(transportOptions.tls.rejectUnauthorized, true);
  assert.equal(sent[0].headers["X-ALPR-Event-ID"], "read-42");
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(result.messageId, "message-1");
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("webhooks are signed, idempotent, redirect-free, and classify retryable responses", async () => {
  let request;
  const config = { enabled: true, signing_secret: "top-secret", timeout_seconds: 5 };
  const payload = {
    eventId: "read-42",
    idempotencyKey: "notification-delivery-9",
    url: "https://8.8.8.8/alpr",
    body: { event_id: "read-42", plate_number: "ABC123" },
  };
  const result = await sendWebhookNotification({
    config,
    payload,
    async fetchImpl(url, options) {
      request = { url: String(url), options };
      return new Response(null, { status: 204, headers: { "x-request-id": "receiver-1" } });
    },
  });
  const body = JSON.stringify(payload.body);
  const signature = createHmac("sha256", "top-secret").update(body).digest("hex");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.headers["X-ALPR-Signature"], `sha256=${signature}`);
  assert.equal(request.options.headers["Idempotency-Key"], "notification-delivery-9");
  assert.equal(result.status, 204);
  await assert.rejects(
    sendWebhookNotification({ config, payload, fetchImpl: async () => new Response("", { status: 400 }) }),
    (error) => error.retryable === false && error.code === "WEBHOOK_HTTP_400"
  );
  await assert.rejects(
    sendWebhookNotification({ config, payload, fetchImpl: async () => new Response("", { status: 503 }) }),
    (error) => error.retryable === true && error.code === "WEBHOOK_HTTP_503"
  );
});

test("webhook target policy blocks loopback and private networks unless explicitly allowed", async () => {
  assert.equal(classifyAddress("127.0.0.1"), "forbidden");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "forbidden");
  assert.equal(classifyAddress("198.51.100.5"), "forbidden");
  assert.equal(classifyAddress("192.168.0.20"), "private");
  await assert.rejects(validateWebhookDestination("https://127.0.0.1/hook"), /forbidden/i);
  await assert.rejects(validateWebhookDestination("https://192.168.0.20/hook"), /private-network/i);
  const allowed = await validateWebhookDestination("http://192.168.0.20/hook", {
    allow_http: true,
    allow_private_networks: true,
  });
  assert.equal(allowed.hostname, "192.168.0.20");
  assert.equal(webhookConfigurationState({ enabled: true, signing_secret: "secret" }).configured, true);
});

test("webhook delivery pins the validated DNS answer for the actual connection", async () => {
  const lookups = [];
  let pinnedLookup;
  const result = await sendWebhookNotification({
    config: { enabled: true, signing_secret: "secret" },
    payload: { url: "https://alerts.example.com/hook", body: { ok: true } },
    lookupImpl: async (hostname) => {
      lookups.push(hostname);
      return [{ address: "8.8.8.8", family: 4 }];
    },
    requestImpl(_url, options, onResponse) {
      pinnedLookup = options.lookup;
      const handlers = {};
      return {
        setTimeout() {},
        on(name, handler) { handlers[name] = handler; },
        end() {
          onResponse({
            statusCode: 204,
            headers: {},
            resume() {},
          });
        },
        destroy(error) { handlers.error?.(error); },
      };
    },
  });
  assert.equal(result.status, 204);
  assert.deepEqual(lookups, ["alerts.example.com"]);
  await new Promise((resolve, reject) => {
    pinnedLookup("alerts.example.com", {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
      resolve();
    });
  });
  assert.equal(typeof webhookNotificationInternals.resolveWebhookDestination, "function");
});

test("the notification worker delivers queued email and webhook jobs through the shared attempt contract", async () => {
  const successes = [];
  const sent = [];
  const repository = {
    async claimDueActivityRuleIds() { return []; },
    async loadEnabledRules() { return []; },
    async releaseExpiredDeliveryLeases() { return []; },
    async claimDueDeliveries() {
      return [
        { id: 71, channelType: "email", payload: { recipients: ["owner@example.com"] } },
        { id: 72, channelType: "webhook", payload: { url: "https://8.8.8.8/hook", body: {} } },
      ];
    },
    async recordDeliverySuccess(value) { successes.push(value); return { status: "succeeded" }; },
    async recordDeliveryFailure() { throw new Error("Unexpected failure"); },
  };
  const worker = new NotificationOperationsWorker({
    repository,
    mqttRepository: {},
    loadConfig: async () => ({ notifications: { email: { enabled: true }, webhook: { enabled: true } } }),
    sendEmail: async (value) => { sent.push(["email", value]); return { messageId: "one" }; },
    sendWebhook: async (value) => { sent.push(["webhook", value]); return { status: 204 }; },
  });
  const result = await worker.runOnce();
  assert.equal(result.succeeded, 2);
  assert.deepEqual(successes.map((entry) => entry.deliveryId), [71, 72]);
  assert.equal(sent[1][1].payload.idempotencyKey, "notification-delivery-72");
});

test("email and webhook secrets never cross the settings boundary", async () => {
  const sanitized = sanitizeSettingsForClient({
    notifications: {
      email: { enabled: true, password: "smtp-secret" },
      webhook: { enabled: true, signing_secret: "webhook-secret" },
    },
  });
  assert.equal(sanitized.notifications.email.passwordConfigured, true);
  assert.equal(sanitized.notifications.webhook.signingSecretConfigured, true);
  assert.equal(JSON.stringify(sanitized).includes("smtp-secret"), false);
  assert.equal(JSON.stringify(sanitized).includes("webhook-secret"), false);
  const [settingsForm, testRoute] = await Promise.all([
    readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/channels/test/route.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(
    settingsForm,
    /initialSettings\.notifications\?\.email\?\.password(?!Configured)/,
  );
  assert.doesNotMatch(
    settingsForm,
    /initialSettings\.notifications\?\.webhook\?\.signing_secret/,
  );
  assert.match(testRoute, /denyUnlessRoutePermission\("notification\.manage"\)/);
});

test("email and webhook environment settings initialize the protected channel configuration", () => {
  const config = getInitialEnvConfig({
    SMTP_ENABLED: "true",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_VERIFY_TLS: "true",
    SMTP_USERNAME: "alpr",
    SMTP_PASSWORD: "smtp-secret",
    SMTP_FROM_ADDRESS: "alpr@example.com",
    WEBHOOK_ENABLED: "true",
    WEBHOOK_SIGNING_SECRET: "webhook-secret",
    WEBHOOK_TIMEOUT_SECONDS: "12",
    WEBHOOK_ALLOW_HTTP: "false",
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: "true",
  });
  assert.equal(config.notifications.email.host, "smtp.example.com");
  assert.equal(config.notifications.email.port, 465);
  assert.equal(config.notifications.email.secure, true);
  assert.equal(config.notifications.email.password, "smtp-secret");
  assert.equal(config.notifications.webhook.timeout_seconds, 12);
  assert.equal(config.notifications.webhook.allow_http, false);
  assert.equal(config.notifications.webhook.allow_private_networks, true);
});
