import { getPool } from "./db.js";
import { NotificationRuleDraftRepository } from "./notification-rule-draft-repository.mjs";

async function repository() {
  return new NotificationRuleDraftRepository({ pool: await getPool() });
}

export async function updateNotificationRuleDraft(input = {}) {
  return (await repository()).updateTagCameraRule(input);
}

export async function simulateNotificationRuleDraft(input = {}) {
  return (await repository()).simulate(input);
}
