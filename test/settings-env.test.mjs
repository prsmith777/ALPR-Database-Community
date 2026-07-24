import assert from "node:assert/strict";
import test from "node:test";

import {
  getDatabaseConfig,
  getInitialEnvConfig,
  parseBooleanEnv,
  removeRuntimeDatabaseSecret,
} from "../lib/settings.js";

test("parseBooleanEnv accepts explicit true values", () => {
  for (const value of ["true", "TRUE", "1", "yes", "on"]) {
    assert.equal(parseBooleanEnv(value, false), true);
  }
});

test("parseBooleanEnv accepts explicit false values", () => {
  for (const value of ["false", "FALSE", "0", "no", "off"]) {
    assert.equal(parseBooleanEnv(value, true), false);
  }
});

test("parseBooleanEnv uses the fallback for missing or invalid values", () => {
  assert.equal(parseBooleanEnv(undefined, false), false);
  assert.equal(parseBooleanEnv(undefined, true), true);
  assert.equal(parseBooleanEnv("unexpected", false), false);
  assert.equal(parseBooleanEnv("unexpected", true), true);
});

test("new installations omit retired upstream sharing settings", () => {
  const config = getInitialEnvConfig({});

  assert.equal(Object.hasOwn(config, "training"), false);
  assert.equal(Object.hasOwn(config, "privacy"), false);
});

test("retired sharing environment values are ignored", () => {
  const config = getInitialEnvConfig({
    AI_TRAINING: "false",
    METRICS: "false",
    PUSHOVER_ENABLED: "false",
    IGNORE_NON_PLATE: "false",
  });

  assert.equal(Object.hasOwn(config, "training"), false);
  assert.equal(Object.hasOwn(config, "privacy"), false);
  assert.equal(config.notifications.pushover.enabled, false);
  assert.equal(config.general.ignoreNonPlate, false);
});

test("explicit true environment values enable configured features", () => {
  const config = getInitialEnvConfig({
    AI_TRAINING: "true",
    METRICS: "true",
    PUSHOVER_ENABLED: "true",
    IGNORE_NON_PLATE: "true",
  });

  assert.equal(Object.hasOwn(config, "training"), false);
  assert.equal(Object.hasOwn(config, "privacy"), false);
  assert.equal(config.notifications.pushover.enabled, true);
  assert.equal(config.general.ignoreNonPlate, true);
});

test("Blue Iris host initialization uses its own environment setting", () => {
  const config = getInitialEnvConfig({
    BLUEIRIS_HOST: "http://192.168.0.10:81",
  });

  assert.equal(config.blueiris.host, "http://192.168.0.10:81");
});

test("visual indexing starts automatically and accepts bounded environment pacing", () => {
  const defaults = getInitialEnvConfig({});
  assert.equal(defaults.visualIndex.enabled, true);
  assert.equal(defaults.visualIndex.paused, false);
  assert.equal(defaults.visualIndex.batchSize, 20);

  const configured = getInitialEnvConfig({
    VISUAL_INDEX_ENABLED: "true",
    VISUAL_INDEX_PAUSED: "true",
    VISUAL_INDEX_BATCH_SIZE: "40",
    VISUAL_INDEX_INTERVAL_SECONDS: "15",
    VISUAL_INDEX_MINIMUM_FREE_DISK_GB: "8",
    VISUAL_INDEX_MAXIMUM_LOAD_PERCENT: "75",
  });
  assert.deepEqual(configured.visualIndex, {
    enabled: true,
    paused: true,
    batchSize: 40,
    intervalSeconds: 15,
    minimumFreeDiskGb: 8,
    maximumLoadPercent: 75,
  });
});

test("runtime database passwords are not copied into persisted settings", () => {
  const config = getInitialEnvConfig({ DB_PASSWORD: "runtime-secret" });
  const persisted = removeRuntimeDatabaseSecret(config, {
    DB_PASSWORD: "runtime-secret",
  });

  assert.equal(config.database.password, "runtime-secret");
  assert.equal(Object.hasOwn(persisted.database, "password"), false);
});

test("stored database passwords remain available without a runtime override", () => {
  const config = { database: { password: "stored-secret" } };
  assert.equal(
    removeRuntimeDatabaseSecret(config, {}).database.password,
    "stored-secret"
  );
});

test("database environment values override persisted credentials", () => {
  const config = getDatabaseConfig(
    {
      host: "stored-db:5432",
      name: "stored-name",
      user: "stored-user",
      password: "stored-password",
    },
    {
      DB_HOST: "runtime-db:5432",
      DB_NAME: "runtime-name",
      DB_USER: "runtime-user",
      DB_PASSWORD: "runtime-password",
    }
  );

  assert.deepEqual(config, {
    host: "runtime-db:5432",
    name: "runtime-name",
    user: "runtime-user",
    password: "runtime-password",
  });
});

test("missing database environment values preserve persisted settings", () => {
  const stored = {
    host: "stored-db:5432",
    name: "stored-name",
    user: "stored-user",
    password: "stored-password",
  };

  assert.deepEqual(getDatabaseConfig(stored, {}), stored);
});
