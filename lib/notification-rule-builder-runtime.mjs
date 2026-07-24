import { getPool } from "./db.js";
import { NotificationRuleBuilderRepository } from "./notification-rule-builder-repository.mjs";
import { getConfig } from "./settings.js";

function pushoverState(config = {}) {
  const pushover = config.notifications?.pushover ?? {};
  return {
    enabled: Boolean(pushover.enabled),
    configured: Boolean(String(pushover.app_token ?? "").trim() && String(pushover.user_key ?? "").trim()),
    localTimeZone: String(config.mqtt?.local_timezone || config.general?.timezone || "America/Denver"),
  };
}

async function dependencies() {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  return { repository: new NotificationRuleBuilderRepository({ pool }), config };
}

export async function getNotificationRuleBuilderOverview() {
  const { repository, config } = await dependencies();
  return repository.overview({ pushover: pushoverState(config) });
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
  const state = pushoverState(config);
  return repository.setEnabled({ ...input, pushoverAvailable: state.enabled && state.configured });
}

export async function previewNotificationRuleBuilder(input = {}) {
  const { repository, config } = await dependencies();
  return repository.preview({ ...input, matchingSettings: config.plateMatching ?? {} });
}

export const notificationRuleBuilderRuntimeInternals = Object.freeze({ pushoverState });
