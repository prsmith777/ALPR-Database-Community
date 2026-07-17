import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MqttRuleAdminRepository,
  mqttRuleAdminInternals,
} from "../lib/mqtt/rule-admin-repository.mjs";

function makeRuleRow(overrides = {}) {
  return {
    id: 7,
    name: "Family Vehicles",
    enabled: true,
    match_type: "tag",
    match_value: "Family",
    fuzzy_enabled: true,
    fuzzy_max_distance: 1,
    fuzzy_min_length: 5,
    fuzzy_require_unique: true,
    fuzzy_ocr_aware: true,
    broker_id: 3,
    broker_name: "Home MQTT",
    broker_enabled: true,
    destination_mode: "per_camera",
    fixed_topic: null,
    message: null,
    camera_ids: [2, 5],
    created_at: new Date("2026-07-17T12:00:00Z"),
    updated_at: new Date("2026-07-17T12:00:00Z"),
    ...overrides,
  };
}

test("MQTT rule repository requires a PostgreSQL-compatible pool", () => {
  assert.throws(
    () => new MqttRuleAdminRepository({ pool: { query() {} } }),
    /PostgreSQL-compatible pool/
  );
});

test("rule validation accepts tag matching, fuzzy defaults, and unique cameras", () => {
  const rule = mqttRuleAdminInternals.normalizeRuleInput({
    name: "Family Vehicles",
    matchType: "tag",
    matchValue: "Family",
    brokerId: 3,
    cameraIds: [5, 2, 5],
    fuzzyEnabled: true,
  });

  assert.equal(rule.matchType, "tag");
  assert.equal(rule.matchValue, "Family");
  assert.equal(rule.fuzzyMaxDistance, 1);
  assert.equal(rule.fuzzyMinLength, 5);
  assert.equal(rule.fuzzyRequireUnique, true);
  assert.equal(rule.fuzzyOcrAware, true);
  assert.deepEqual(rule.cameraIds, [2, 5]);
  assert.equal(rule.destinationMode, "per_camera");
});

test("any-plate rules clear match values and fixed topics are validated", () => {
  const anyPlate = mqttRuleAdminInternals.normalizeRuleInput({
    name: "Every Plate",
    matchType: "any_plate",
    matchValue: "ignored",
    brokerId: 1,
  });
  assert.equal(anyPlate.matchValue, "");

  const fixed = mqttRuleAdminInternals.normalizeRuleInput({
    name: "Security Topic",
    matchType: "exact_plate",
    matchValue: "ABC123",
    brokerId: 1,
    destinationMode: "fixed_topic",
    fixedTopic: "Estate/Security/Plate",
  });
  assert.equal(fixed.fixedTopic, "Estate/Security/Plate");
});

test("invalid rule types, values, fuzzy limits, cameras, and topics are rejected", () => {
  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Bad",
        matchType: "unknown",
        brokerId: 1,
      }),
    /Unsupported MQTT rule match type/
  );

  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Missing",
        matchType: "exact_plate",
        brokerId: 1,
      }),
    /require a match value/
  );

  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Too Fuzzy",
        matchType: "any_plate",
        brokerId: 1,
        fuzzyMaxDistance: 3,
      }),
    /integer from 0 to 2/
  );

  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Bad Cameras",
        matchType: "any_plate",
        brokerId: 1,
        cameraIds: "all",
      }),
    /must be an array/
  );

  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Bad Topic",
        matchType: "any_plate",
        brokerId: 1,
        destinationMode: "fixed_topic",
        fixedTopic: "Estate/#",
      }),
    /wildcards/
  );

  assert.throws(
    () =>
      mqttRuleAdminInternals.normalizeRuleInput({
        name: "Bad Boolean",
        matchType: "any_plate",
        brokerId: 1,
        enabled: "sometimes",
      }),
    /boolean value must be true or false/
  );
});

test("rule mapping returns browser-safe broker and camera fields", () => {
  const rule = mqttRuleAdminInternals.mapRule(makeRuleRow());

  assert.deepEqual(rule.cameraIds, [2, 5]);
  assert.equal(rule.brokerName, "Home MQTT");
  assert.equal(rule.brokerEnabled, true);
  assert.equal(rule.matchType, "tag");
  assert.equal(Object.hasOwn(rule, "password"), false);
});

test("rule option lists contain safe brokers, cameras, known identities, and tags", () => {
  const options = mqttRuleAdminInternals.mapOptions({
    brokers: [{ id: 1, name: "Home MQTT", enabled: true }],
    cameras: [
      {
        id: 2,
        camera_name: "Entry LPR 1",
        camera_key: "entry-lpr-1",
        enabled: true,
      },
    ],
    knownPlates: [
      { plate_number: "DPOM90", name: "Liz's Lexus", tags: ["Family"] },
    ],
    knownNames: [{ name: "Liz's Lexus" }],
    tags: [{ name: "Family" }],
  });

  assert.deepEqual(options.brokers, [
    { id: 1, name: "Home MQTT", enabled: true },
  ]);
  assert.equal(options.cameras[0].cameraKey, "entry-lpr-1");
  assert.equal(options.knownPlates[0].plateNumber, "DPOM90");
  assert.deepEqual(options.knownNames, ["Liz's Lexus"]);
  assert.deepEqual(options.tags, ["Family"]);
  assert.equal(Object.hasOwn(options.brokers[0], "password"), false);
});

test("creating a rule saves selected camera links in one transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("INSERT INTO public.mqtt_rules")) {
        return { rows: [{ id: 7 }] };
      }
      if (sql.includes("DELETE FROM public.mqtt_rule_cameras")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO public.mqtt_rule_cameras")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT") && sql.includes("FROM public.mqtt_rules")) {
        return { rows: [makeRuleRow()] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      calls.push({ sql: "RELEASE", values: [] });
    },
  };
  const pool = {
    async query() {
      throw new Error("Pool query should not be used during create transaction");
    },
    async connect() {
      return client;
    },
  };

  const repository = new MqttRuleAdminRepository({ pool });
  const rule = await repository.createRule({
    name: "Family Vehicles",
    matchType: "tag",
    matchValue: "Family",
    brokerId: 3,
    cameraIds: [5, 2, 5],
    fuzzyEnabled: true,
  });

  assert.equal(rule.id, 7);
  const linkInsert = calls.find((call) =>
    call.sql.includes("INSERT INTO public.mqtt_rule_cameras")
  );
  assert.deepEqual(linkInsert.values, [7, [2, 5]]);
  assert.ok(calls.some((call) => call.sql === "BEGIN"));
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("rule routes expose collection and item CRUD through the rule repository", async () => {
  const collection = await readFile(
    new URL("../app/api/mqtt/rules/route.js", import.meta.url),
    "utf8"
  );
  const item = await readFile(
    new URL("../app/api/mqtt/rules/[id]/route.js", import.meta.url),
    "utf8"
  );
  const runtime = await readFile(
    new URL("../lib/mqtt/admin-runtime.mjs", import.meta.url),
    "utf8"
  );

  assert.match(collection, /repository\.listRules\(\)/);
  assert.match(collection, /repository\.listOptions\(\)/);
  assert.match(collection, /repository\.createRule\(data\)/);
  assert.match(item, /repository\.getRule/);
  assert.match(item, /repository\.updateRule/);
  assert.match(item, /repository\.deleteRule/);
  assert.match(runtime, /getMqttRuleAdminRepository/);
});
