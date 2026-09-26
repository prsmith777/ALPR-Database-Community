function configured(value) {
  return String(value ?? "").trim().length > 0;
}

export function environmentManagedSettings(env = {}) {
  return {
    database: {
      host: Boolean(env.DB_HOST),
      name: Boolean(env.DB_NAME),
      user: Boolean(env.DB_USER),
      password: Boolean(env.DB_PASSWORD),
    },
    blueiris: {
      host: Boolean(env.BLUEIRIS_HOST),
      username: Boolean(env.BLUEIRIS_USERNAME),
      password: Boolean(env.BLUEIRIS_PASSWORD),
      timeoutSeconds: Boolean(env.BLUEIRIS_TIMEOUT_SECONDS),
      timelineExportProfile: Boolean(env.BLUEIRIS_TIMELINE_EXPORT_PROFILE),
      timelineExportMinWidth: Boolean(env.BLUEIRIS_TIMELINE_EXPORT_MIN_WIDTH),
      timelineExportMinHeight: Boolean(env.BLUEIRIS_TIMELINE_EXPORT_MIN_HEIGHT),
    },
  };
}

export function sanitizeSettingsForClient(config = {}, env = {}) {
  const pushover = config.notifications?.pushover ?? {};
  const email = config.notifications?.email ?? {};
  const webhook = config.notifications?.webhook ?? {};
  const database = config.database ?? {};
  const blueiris = config.blueiris ?? {};
  const publicPushover = { ...pushover };
  delete publicPushover.app_token;
  delete publicPushover.user_key;
  const publicEmail = { ...email };
  delete publicEmail.password;
  const publicWebhook = { ...webhook };
  delete publicWebhook.signing_secret;
  const publicDatabase = { ...database };
  delete publicDatabase.password;
  const publicBlueIris = { ...blueiris };
  delete publicBlueIris.password;

  return {
    ...config,
    environmentManaged: environmentManagedSettings(env),
    database: {
      ...publicDatabase,
      passwordConfigured: configured(database.password),
    },
    blueiris: {
      ...publicBlueIris,
      passwordConfigured: configured(blueiris.password),
    },
    notifications: {
      ...config.notifications,
      pushover: {
        ...publicPushover,
        appTokenConfigured: configured(pushover.app_token),
        userKeyConfigured: configured(pushover.user_key),
      },
      email: {
        ...publicEmail,
        passwordConfigured: configured(email.password),
      },
      webhook: {
        ...publicWebhook,
        signingSecretConfigured: configured(webhook.signing_secret),
      },
    },
  };
}

export function resolveStoredSecretUpdate({
  currentValue = "",
  replacement = "",
  clear = false,
} = {}) {
  if (clear === true || String(clear).trim().toLowerCase() === "true") return "";
  const replacementValue = String(replacement ?? "");
  return replacementValue.trim() ? replacementValue : String(currentValue ?? "");
}

export const settingsClientInternals = Object.freeze({ configured });
