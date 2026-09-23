import assert from "node:assert/strict";
import test from "node:test";

import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
} from "../lib/mqtt/admin-api.mjs";

test("missing MQTT rule values are returned as safe validation errors", () => {
  const error = new Error("MQTT exact_plate rules require a match value");
  assert.equal(mqttAdminErrorStatus(error), 400);
  assert.equal(mqttAdminErrorMessage(error, "fallback"), error.message);
});

test("database relationship conflicts do not expose PostgreSQL details", () => {
  const error = Object.assign(
    new Error("insert or update violates foreign key constraint mqtt_rules_broker_id_fkey"),
    { code: "23503" }
  );
  assert.equal(mqttAdminErrorStatus(error), 409);
  assert.equal(mqttAdminErrorMessage(error, "Rule references unavailable data"), "Rule references unavailable data");
});
