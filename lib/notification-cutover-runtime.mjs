import { getPool } from "./db.js";
import { getConfig } from "./settings.js";
import { NotificationCutoverRepository } from "./notification-cutover-repository.mjs";

async function runtime() {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  return {
    repository: new NotificationCutoverRepository({ pool }),
    matchingSettings: config.plateMatching || {},
  };
}

export async function getNotificationCutoverPreview() {
  const { repository, matchingSettings } = await runtime();
  return repository.preview({ matchingSettings });
}

export async function cutoverNotificationRule({ ruleId, actor = null } = {}) {
  const { repository, matchingSettings } = await runtime();
  return repository.cutover({ ruleId, actor, matchingSettings });
}

export async function rollbackNotificationRule({ ruleId, actor = null } = {}) {
  const { repository } = await runtime();
  return repository.rollback({ ruleId, actor });
}
