import assert from "node:assert/strict";
import test from "node:test";

import {
  getDatabaseConfig,
  getInitialEnvConfig,
  parseBooleanEnv,
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

test("new installations keep AI training disabled unless explicitly enabled", () => {
  const config = getInitialEnvConfig({});

  assert.equal(config.training.enabled, false);
  assert.equal(typeof config.training.enabled, "boolean");
});

test("false environment values remain booleans and disable privacy features", () => {
  const config = getInitialEnvConfig({
    AI_TRAINING: "false",
    METRICS: "false",
    PUSHOVER_ENABLED: "false",
    IGNORE_NON_PLATE: "false",
  });

  assert.equal(config.training.enabled, false);
  assert.equal(config.privacy.metrics, false);
  assert.equal(config.notifications.pushover.enabled, false);
  assert.equal(config.general.ignoreNonPlate, false);

  assert.equal(typeof config.training.enabled, "boolean");
  assert.equal(typeof config.privacy.metrics, "boolean");
});

test("explicit true environment values enable configured features", () => {
  const config = getInitialEnvConfig({
    AI_TRAINING: "true",
    METRICS: "true",
    PUSHOVER_ENABLED: "true",
    IGNORE_NON_PLATE: "true",
  });

  assert.equal(config.training.enabled, true);
  assert.equal(config.privacy.metrics, true);
  assert.equal(config.notifications.pushover.enabled, true);
  assert.equal(config.general.ignoreNonPlate, true);
});

test("Blue Iris host initialization uses its own environment setting", () => {
  const config = getInitialEnvConfig({
    BLUEIRIS_HOST: "http://192.168.0.10:81",
    METRICS: "false",
  });

  assert.equal(config.blueiris.host, "http://192.168.0.10:81");
  assert.equal(config.privacy.metrics, false);
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
