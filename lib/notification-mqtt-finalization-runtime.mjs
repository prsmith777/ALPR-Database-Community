import { getPool } from "./db.js";
import { NotificationMqttFinalizationRepository } from "./notification-mqtt-finalization-repository.mjs";

async function repository() {
  return new NotificationMqttFinalizationRepository({ pool: await getPool() });
}

export async function getNotificationMqttFinalizationPreview() {
  return (await repository()).preview();
}

export async function finalizeNotificationMqttMigration({ actor = null } = {}) {
  return (await repository()).finalize({ actor });
}
