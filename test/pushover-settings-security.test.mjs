import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resolveStoredSecretUpdate,
  sanitizeSettingsForClient,
} from "../lib/settings-client.mjs";

test("saved Pushover credentials are replaced with configured-state flags for the browser", () => {
  const sanitized = sanitizeSettingsForClient({
    general: { timeFormat: 12 },
    database: { host: "db:5432", password: "secret-database-password" },
    notifications: {
      pushover: {
        enabled: true,
        app_token: "secret-app-token",
        user_key: "secret-user-key",
        title: "ALPR Alert",
      },
    },
  });

  assert.equal(sanitized.notifications.pushover.appTokenConfigured, true);
  assert.equal(sanitized.notifications.pushover.userKeyConfigured, true);
  assert.equal(Object.hasOwn(sanitized.notifications.pushover, "app_token"), false);
  assert.equal(Object.hasOwn(sanitized.notifications.pushover, "user_key"), false);
  assert.equal(sanitized.database.passwordConfigured, true);
  assert.equal(Object.hasOwn(sanitized.database, "password"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret-app-token"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret-user-key"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret-database-password"), false);
});

test("blank replacements preserve secrets and clearing requires an explicit control", () => {
  assert.equal(
    resolveStoredSecretUpdate({ currentValue: "existing", replacement: "" }),
    "existing"
  );
  assert.equal(
    resolveStoredSecretUpdate({ currentValue: "existing", replacement: " replacement " }),
    " replacement "
  );
  assert.equal(
    resolveStoredSecretUpdate({ currentValue: "existing", replacement: "replacement", clear: "true" }),
    ""
  );
});

test("Pushover settings render replacement-only password fields and never bind stored secrets", async () => {
  const [form, actions] = await Promise.all([
    readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);

  assert.match(form, /<PasswordInput[\s\S]*name="pushoverAppToken"/);
  assert.match(form, /<PasswordInput[\s\S]*name="pushoverUserKey"/);
  assert.match(form, /Leave blank to keep the configured token/);
  assert.match(form, /clearPushoverAppToken/);
  assert.match(form, /clearPushoverUserKey/);
  assert.equal(form.includes("initialSettings.notifications?.pushover?.app_token"), false);
  assert.equal(form.includes("initialSettings.notifications?.pushover?.user_key"), false);
  assert.doesNotMatch(form, /initialSettings\.database\.password(?!Configured)/);
  assert.match(actions, /return sanitizeSettingsForClient\(config\)/);
  assert.match(actions, /resolveStoredSecretUpdate/);
  assert.doesNotMatch(
    actions,
    /formData\.get\("pushover(?:AppToken|UserKey)"\)\s*===/
  );
  assert.doesNotMatch(
    actions,
    /console\.(?:log|error)\([^)]*(?:app_token|user_key|pushoverAppToken|pushoverUserKey)/s
  );
});
