import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "../lib/mqtt/admin-api.mjs";
import {
  MqttAdminRepository,
  mqttAdminRepositoryInternals,
} from "../lib/mqtt/admin-repository.mjs";

function makePool(query) {
  return {
    query,
    async connect() {
      return {
        query,
        release() {},
      };
    },
  };
}

function settingsRow(overrides = {}) {
  return {
    id: 1,
    enabled: false,
    base_topic: "Blue Iris/ALPR",
    camera_topic_template: "{base_topic}/{camera_key}",
    default_qos: 1,
    retain_messages: false,
    payload_profile: "generic_json",
    local_timezone: "America/Denver",
    hour_format: 12,
    created_at: new Date("2026-07-17T00:00:00Z"),
    updated_at: new Date("2026-07-17T00:00:00Z"),
    ...overrides,
  };
}

function brokerRow(overrides = {}) {
  return {
    id: 7,
    name: "Home MQTT",
    broker: "192.168.0.97",
    port: 1883,
    topic: "Plates",
    username: "alpr",
    has_password: true,
    use_tls: false,
    client_id: "alpr-dashboard",
    enabled: true,
    created_at: new Date("2026-07-17T00:00:00Z"),
    updated_at: new Date("2026-07-17T00:00:00Z"),
    ...overrides,
  };
}

test("MQTT admin repository requires a PostgreSQL-compatible pool", () => {
  assert.throws(() => new MqttAdminRepository(), /PostgreSQL-compatible pool/);
  assert.throws(
    () => new MqttAdminRepository({ pool: { query() {} } }),
    /PostgreSQL-compatible pool/
  );
});

test("MQTT settings validation accepts the HomeSeer defaults and America/Denver", () => {
  const normalized = mqttAdminRepositoryInternals.normalizeSettingsInput({
    enabled: true,
    baseTopic: "Blue Iris/ALPR/",
    cameraTopicTemplate: "{base_topic}/{camera_key}",
    defaultQos: 1,
    retainMessages: false,
    payloadProfile: "generic_json",
    localTimezone: "America/Denver",
    hourFormat: 12,
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.baseTopic, "Blue Iris/ALPR");
  assert.equal(normalized.localTimezone, "America/Denver");
  assert.equal(normalized.defaultQos, 1);
  assert.equal(normalized.retainMessages, false);
});

test("MQTT settings reject wildcards, unsupported fields, and invalid timezones", () => {
  const base = {
    enabled: false,
    baseTopic: "Blue Iris/ALPR",
    cameraTopicTemplate: "{base_topic}/{camera_key}",
    defaultQos: 1,
    retainMessages: false,
    payloadProfile: "generic_json",
    localTimezone: "America/Denver",
    hourFormat: 12,
  };

  assert.throws(
    () =>
      mqttAdminRepositoryInternals.normalizeSettingsInput({
        ...base,
        baseTopic: "Blue Iris/#",
      }),
    /wildcards/
  );
  assert.throws(
    () =>
      mqttAdminRepositoryInternals.normalizeSettingsInput({
        ...base,
        cameraTopicTemplate: "{base_topic}/{unknown}",
      }),
    /Unsupported MQTT topic field/
  );
  assert.throws(
    () =>
      mqttAdminRepositoryInternals.normalizeSettingsInput({
        ...base,
        localTimezone: "Not/A-Timezone",
      }),
    /Invalid IANA timezone/
  );

  assert.throws(
    () =>
      mqttAdminRepositoryInternals.normalizeSettingsInput({
        ...base,
        enabled: "definitely",
      }),
    /boolean value must be true or false/
  );
});

test("broker listings expose only password presence and never the credential", async () => {
  const pool = makePool(async () => ({ rows: [brokerRow()] }));
  const repository = new MqttAdminRepository({ pool });
  const [broker] = await repository.listBrokers();

  assert.equal(broker.hasPassword, true);
  assert.equal(Object.hasOwn(broker, "password"), false);
  assert.equal(broker.legacyTopic, "Plates");
});

test("new brokers no longer require or populate a broker-level topic", async () => {
  let captured;
  const pool = makePool(async (sql, values) => {
    captured = { sql, values };
    return { rows: [brokerRow({ topic: null })] };
  });
  const repository = new MqttAdminRepository({ pool });

  const broker = await repository.createBroker({
    name: "Home MQTT",
    broker: "192.168.0.97",
    port: 1883,
    username: "alpr",
    password: "secret",
    useTls: false,
    clientId: "alpr-dashboard",
    enabled: true,
  });

  assert.match(captured.sql, /VALUES \(\$1, \$2, \$3, NULL,/);
  assert.equal(captured.values.includes("Plates"), false);
  assert.equal(Object.hasOwn(broker, "password"), false);
});

test("broker edits preserve credentials unless replacement or clearing is explicit", async () => {
  const calls = [];
  const pool = makePool(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [brokerRow()] };
  });
  const repository = new MqttAdminRepository({ pool });
  const common = {
    name: "Home MQTT",
    broker: "192.168.0.97",
    port: 1883,
    username: "alpr",
    useTls: false,
    clientId: "alpr-dashboard",
    enabled: true,
  };

  await repository.updateBroker(7, common);
  assert.equal(calls[0].values[5], false);
  assert.equal(calls[0].values[6], false);
  assert.equal(calls[0].values[7], null);

  await repository.updateBroker(7, { ...common, password: "replacement" });
  assert.equal(calls[1].values[6], true);
  assert.equal(calls[1].values[7], "replacement");

  await repository.updateBroker(7, { ...common, clearPassword: true });
  assert.equal(calls[2].values[5], true);
});

test("camera listings calculate per-camera and override topics", async () => {
  const pool = makePool(async (sql) => {
    if (sql.includes("mqtt_settings")) return { rows: [settingsRow()] };
    if (sql.includes("mqtt_cameras")) {
      return {
        rows: [
          {
            id: 1,
            camera_name: "Entry LPR 1",
            camera_key: "entry-lpr-1",
            enabled: true,
            topic_override: null,
            first_seen_at: null,
            last_seen_at: null,
            created_at: null,
            updated_at: null,
          },
          {
            id: 2,
            camera_name: "Road Entrance LPR",
            camera_key: "road-entrance-lpr",
            enabled: true,
            topic_override: "Estate/Entrance/Plate",
            first_seen_at: null,
            last_seen_at: null,
            created_at: null,
            updated_at: null,
          },
        ],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const repository = new MqttAdminRepository({ pool });
  const cameras = await repository.listCameras();

  assert.equal(cameras[0].effectiveTopic, "Blue Iris/ALPR/entry-lpr-1");
  assert.equal(cameras[1].effectiveTopic, "Estate/Entrance/Plate");
  assert.equal(cameras[0].topicError, "");
});

test("activity filtering validates status and returns attempt history", async () => {
  const pool = makePool(async (_sql, values) => ({
    rows: [
      {
        id: 9,
        event_id: "read-87321",
        read_id: 87321,
        camera_key: "entry-lpr-1",
        camera_name: "Entry LPR 1",
        broker_id: 7,
        broker_name: "Home MQTT",
        topic: "Blue Iris/ALPR/entry-lpr-1",
        payload: { plate_number: "DP0M90" },
        qos: 1,
        retain: false,
        status: values[1],
        attempt_count: 1,
        max_attempts: 5,
        next_attempt_at: null,
        last_error: null,
        published_at: new Date("2026-07-17T03:03:38Z"),
        created_at: new Date("2026-07-17T03:03:37Z"),
        updated_at: new Date("2026-07-17T03:03:38Z"),
        attempts: [{ attempt_number: 1, outcome: "succeeded" }],
      },
    ],
  }));
  const repository = new MqttAdminRepository({ pool });

  await assert.rejects(
    () => repository.listActivity({ status: "unknown" }),
    /Invalid MQTT activity status/
  );

  const [activity] = await repository.listActivity({
    limit: 25,
    status: "succeeded",
  });
  assert.equal(activity.status, "succeeded");
  assert.equal(activity.attempts[0].outcome, "succeeded");
  assert.equal(activity.payload.plate_number, "DP0M90");
});

test("admin API helpers return safe validation and conflict responses", async () => {
  const invalid = new Error("MQTT broker port must be an integer from 1 to 65535");
  assert.equal(mqttAdminErrorStatus(invalid), 400);
  assert.match(mqttAdminErrorMessage(invalid, "fallback"), /broker port/);

  const conflict = new Error("internal PostgreSQL foreign key details");
  conflict.code = "23503";
  assert.equal(mqttAdminErrorStatus(conflict), 409);
  assert.equal(mqttAdminErrorMessage(conflict, "safe conflict"), "safe conflict");

  await assert.rejects(
    () =>
      readJsonObject({
        async json() {
          return ["not", "an", "object"];
        },
      }),
    /JSON object/
  );
});

test("admin routes use the new repository and preserve blank broker passwords", async () => {
  const files = await Promise.all(
    [
      "../app/api/mqtt/brokers/route.js",
      "../app/api/mqtt/brokers/[id]/route.js",
      "../app/api/mqtt/settings/route.js",
      "../app/api/mqtt/cameras/route.js",
      "../app/api/mqtt/cameras/[id]/route.js",
      "../app/api/mqtt/activity/route.js",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8"))
  );
  const combined = files.join("\n");

  assert.equal(combined.includes("getMqttAdminRepository"), true);
  assert.equal(combined.includes("addMqttBroker"), false);
  assert.equal(combined.includes("editMqttBroker"), false);
  assert.equal(combined.includes("Name, broker, and topic are required"), false);
  assert.equal(files[1].includes('if (data.password === "") delete data.password'), true);
  assert.equal(combined.includes("password: broker.password"), false);
});
