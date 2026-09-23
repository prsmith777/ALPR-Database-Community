import { getPool } from "./db.js";
import { NotificationRuleBuilderRepository } from "./notification-rule-builder-repository.mjs";
import { getConfig } from "./settings.js";
import { emailConfigurationState } from "./email-notifications.mjs";
import { webhookConfigurationState } from "./webhook-notifications.mjs";

function pushoverState(config = {}) {
  const pushover = config.notifications?.pushover ?? {};
  return {
    enabled: Boolean(pushover.enabled),
    configured: Boolean(String(pushover.app_token ?? "").trim() && String(pushover.user_key ?? "").trim()),
    localTimeZone: String(config.mqtt?.local_timezone || config.general?.timezone || "America/Denver"),
  };
}

function notificationChannelState(config = {}) {
  const pushover = pushoverState(config);
  const email = emailConfigurationState(config.notifications?.email ?? {});
  const webhook = webhookConfigurationState(config.notifications?.webhook ?? {});
  return { pushover, email, webhook };
}

async function dependencies() {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  return { repository: new NotificationRuleBuilderRepository({ pool }), config };
}

export async function getNotificationRuleBuilderOverview() {
  const { repository, config } = await dependencies();
  return repository.overview({ channels: notificationChannelState(config) });
}

export async function getNotificationOperationsOverview() {
  const { repository } = await dependencies();
  return { history: await repository.loadOperationsHistory({ limit: 50 }) };
}

export async function createNotificationRuleDraft(input = {}) {
  const { repository } = await dependencies();
  return repository.createDraft(input);
}

export async function updateNotificationRuleBuilderDraft(input = {}) {
  const { repository } = await dependencies();
  return repository.updateDraft(input);
}

export async function setNotificationRuleBuilderEnabled(input = {}) {
  const { repository, config } = await dependencies();
  return repository.setEnabled({ ...input, channelAvailability: notificationChannelState(config) });
}

export async function deleteNotificationRuleBuilderRule(input = {}) {
  const { repository } = await dependencies();
  return repository.deleteRule(input);
}

export async function previewNotificationRuleBuilder(input = {}) {
  const { repository, config } = await dependencies();
  return repository.preview({ ...input, matchingSettings: config.plateMatching ?? {} });
}

export const notificationRuleBuilderRuntimeInternals = Object.freeze({ notificationChannelState, pushoverState });
