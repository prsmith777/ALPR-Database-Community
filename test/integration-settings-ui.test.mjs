import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("notification rules separate rule work from channel configuration", async () => {
  const [page, workspace, builder, operations] = await Promise.all([
    source("app/notifications/page.jsx"),
    source("components/NotificationRulesWorkspace.jsx"),
    source("components/NotificationRuleBuilder.jsx"),
    source("components/NotificationOperationsPanel.jsx"),
  ]);
  assert.match(page, /NotificationRulesWorkspace/);
  assert.match(workspace, />Rules</);
  assert.match(workspace, /Activity & delivery/);
  assert.match(workspace, /settings\/integrations\/pushover/);
  assert.match(builder, /Create rule/);
  assert.match(builder, /Back to rules/);
  assert.doesNotMatch(operations, /PushoverUsageCard/);
});

test("channel integrations have dedicated configuration and test pages", async () => {
  const [component, pushoverPage, emailPage, webhookPage] = await Promise.all([
    source("components/settings/IntegrationChannelSettings.jsx"),
    source("app/settings/integrations/pushover/page.jsx"),
    source("app/settings/integrations/email/page.jsx"),
    source("app/settings/integrations/webhook/page.jsx"),
  ]);
  assert.match(component, /Connection and credentials/);
  assert.match(component, /Delivery defaults/);
  assert.match(component, /Monthly message allowance|PushoverUsageCard/);
  assert.match(component, /Test this integration/);
  assert.match(pushoverPage, /PushoverSettings/);
  assert.match(emailPage, /EmailSettings/);
  assert.match(webhookPage, /WebhookSettings/);
});

test("settings updates revalidate dedicated channel pages", async () => {
  const actions = await source("app/actions.js");
  const updateSettings = actions.match(/export async function updateSettings[\s\S]*?(?=export async function updatePassword)/)?.[0];
  assert.ok(updateSettings);
  for (const path of ["/settings/integrations", "/settings/integrations/pushover", "/settings/integrations/email", "/settings/integrations/webhook"]) {
    assert.match(updateSettings, new RegExp(`revalidatePath\\(\"${path}\"\\)`));
  }
});
