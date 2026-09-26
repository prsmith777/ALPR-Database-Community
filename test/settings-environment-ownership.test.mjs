import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  environmentManagedSettings,
  sanitizeSettingsForClient,
} from "../lib/settings-client.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("environment ownership reports only effective nonblank overrides", () => {
  assert.deepEqual(environmentManagedSettings({
    DB_HOST: "runtime-db:5432",
    DB_NAME: "",
    DB_PASSWORD: "private",
    BLUEIRIS_HOST: "",
    BLUEIRIS_TIMEOUT_SECONDS: "10",
    BLUEIRIS_TIMELINE_EXPORT_MIN_WIDTH: "1920",
  }), {
    database: {
      host: true,
      name: false,
      user: false,
      password: true,
    },
    blueiris: {
      host: false,
      username: false,
      password: false,
      timeoutSeconds: true,
      timelineExportProfile: false,
      timelineExportMinWidth: true,
      timelineExportMinHeight: false,
    },
  });
});

test("sanitized settings expose ownership flags without environment values", () => {
  const sanitized = sanitizeSettingsForClient(
    { database: { password: "stored" }, blueiris: { password: "stored-bi" } },
    { DB_PASSWORD: "runtime-secret", BLUEIRIS_PASSWORD: "runtime-bi-secret" },
  );

  assert.equal(sanitized.environmentManaged.database.password, true);
  assert.equal(sanitized.environmentManaged.blueiris.password, true);
  assert.equal(JSON.stringify(sanitized).includes("runtime-secret"), false);
  assert.equal(JSON.stringify(sanitized).includes("runtime-bi-secret"), false);
});

test("Settings locks environment-owned fields and the action rejects forged submissions", async () => {
  const [form, actions] = await Promise.all([
    source("app/settings/SettingsForm.jsx"),
    source("app/actions.js"),
  ]);

  assert.match(form, /Managed in \.env/);
  assert.match(form, /databaseManaged\.password/);
  assert.match(form, /blueIrisManaged\.timelineExportMinWidth/);
  assert.match(form, /appendIfPresent/);
  assert.match(actions, /environmentManagedSettings\(process\.env\)/);
  assert.match(actions, /One or more submitted settings are managed in \.env/);
});
