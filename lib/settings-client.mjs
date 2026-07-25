function configured(value) {
  return String(value ?? "").trim().length > 0;
}

export function sanitizeSettingsForClient(config = {}) {
  const pushover = config.notifications?.pushover ?? {};
  const email = config.notifications?.email ?? {};
  const webhook = config.notifications?.webhook ?? {};
  const database = config.database ?? {};
  const publicPushover = { ...pushover };
  delete publicPushover.app_token;
  delete publicPushover.user_key;
  const publicEmail = { ...email };
  delete publicEmail.password;
  const publicWebhook = { ...webhook };
  delete publicWebhook.signing_secret;
  const publicDatabase = { ...database };
  delete publicDatabase.password;

  return {
    ...config,
    database: {
      ...publicDatabase,
      passwordConfigured: configured(database.password),
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
