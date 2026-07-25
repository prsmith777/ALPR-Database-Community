import { getPool } from "./db.js";
import { NotificationLegacyFinalizationRepository } from "./notification-mqtt-finalization-repository.mjs";

async function repository() {
  return new NotificationLegacyFinalizationRepository({ pool: await getPool() });
}

export async function getNotificationLegacyFinalizationPreview() {
  return (await repository()).preview();
}

export async function finalizeNotificationLegacyMigration({ actor = null } = {}) {
  return (await repository()).finalize({ actor });
}
