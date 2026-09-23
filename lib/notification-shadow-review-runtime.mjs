import { getPool } from "./db.js";
import { NotificationShadowReviewRepository } from "./notification-shadow-review-repository.mjs";
import { getConfig } from "./settings.js";

async function runtime() {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  return {
    repository: new NotificationShadowReviewRepository({ pool }),
    matchingSettings: config.plateMatching || {},
  };
}

export async function getNotificationShadowReview() {
  const { repository, matchingSettings } = await runtime();
  return repository.review({ matchingSettings });
}

export async function approveNotificationShadowReview({ ruleId, approvalMode = "parity", actor = null } = {}) {
  const { repository, matchingSettings } = await runtime();
  return repository.approve({ ruleId, approvalMode, actor, matchingSettings });
}
