import { getPool } from "./db.js";
import { NotificationMigrationRepository } from "./notification-migration-repository.mjs";
import { getConfig } from "./settings.js";

export async function getNotificationMigrationPreview() {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  const pushover = config.notifications?.pushover ?? {};
  const repository = new NotificationMigrationRepository({ pool });

  return repository.preview({
    pushover: {
      enabled: Boolean(pushover.enabled),
      configured: Boolean(
        String(pushover.app_token ?? "").trim() && String(pushover.user_key ?? "").trim()
      ),
    },
  });
}

export async function applyDisabledNotificationMigration({ actor = null } = {}) {
  const [pool, config] = await Promise.all([getPool(), getConfig()]);
  const pushover = config.notifications?.pushover ?? {};
  const repository = new NotificationMigrationRepository({ pool });

  return repository.applyDisabledMigration({
    actor,
    pushover: {
      enabled: Boolean(pushover.enabled),
      configured: Boolean(
        String(pushover.app_token ?? "").trim() && String(pushover.user_key ?? "").trim()
      ),
    },
  });
}
