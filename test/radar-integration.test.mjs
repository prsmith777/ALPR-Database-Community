import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RadarRepository } from "../lib/radar/repository.mjs";
import { RadarSubscriber } from "../lib/radar/subscriber.mjs";

test("radar settings reuse the requested authenticated Mosquitto broker without storing a secret", async () => {
  const [migrations, schema] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../schema.sql", import.meta.url), "utf8"),
  ]);

  assert.match(migrations, /2026082201_ops9243_radar_events/);
  assert.match(migrations, /'A26260220\/#'/);
  assert.match(migrations, /LOWER\(BTRIM\(brokers\.broker\)\) = '192\.168\.0\.250'/);
  assert.match(migrations, /brokers\.port = 1883 AND brokers\.use_tls = FALSE/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.radar_events/);
  assert.match(schema, /matched_read_id INTEGER UNIQUE REFERENCES public\.plate_reads/);
  assert.doesNotMatch(migrations, /radar_password|radar_username/);
});

test("correlation is bounded, directional, and one-to-one", async () => {
  const calls = [];
  const repository = new RadarRepository({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [{ id: 7, matched_read_id: 99, match_delta_ms: -431 }] };
      },
    },
  });

  const matches = await repository.correlatePending({ limit: 10_000 });
  assert.equal(matches[0].matched_read_id, 99);
  assert.deepEqual(calls[0].values, [500]);
  assert.match(calls[0].sql, /correlation_window_ms/);
  assert.match(calls[0].sql, /vehicle_direction_observations/);
  assert.match(calls[0].sql, /bi_trigger_direction_label/);
  assert.match(calls[0].sql, /NOT EXISTS[\s\S]*matched_read_id = plate_reads\.id/);
  assert.match(calls[0].sql, /FOR UPDATE OF events SKIP LOCKED/);
  assert.match(calls[0].sql, /ABS\(EXTRACT\(EPOCH FROM/);
});

test("subscriber reuses broker authentication, subscribes exactly, and ingests serially", async () => {
  const calls = [];
  const client = new EventEmitter();
  client.subscribe = (topic, options, callback) => {
    calls.push(["subscribe", topic, options]);
    callback(null, [{ topic, qos: options.qos }]);
  };
  client.end = (_force, _options, callback) => callback();
  const repository = {
    async getSettings() {
      return {
        enabled: true,
        topicFilter: "A26260220/#",
        sourceKey: "A26260220",
        qos: 1,
        broker: {
          enabled: true,
          host: "192.168.0.250",
          port: 1883,
          username: "radar-reader",
          password: "stored-secret",
          useTls: false,
          clientId: "alpr-community",
        },
      };
    },
    async recordConnected() { calls.push(["connected"]); },
    async recordError(message) { calls.push(["error", message]); },
    async insertEvent(event) {
      calls.push(["insert", event.sourceKey, event.speedMph, event.direction]);
      return { id: 71, speed_mph: event.speedMph, direction: event.direction };
    },
    async correlatePending() {
      calls.push(["correlate"]);
      return [{ id: 71, matched_read_id: 901 }];
    },
  };
  let connectionOptions;
  const subscriber = new RadarSubscriber({
    repository,
    mqttConnect(options) {
      connectionOptions = options;
      return client;
    },
    logger: {},
    correlationIntervalMs: 60_000,
  });

  assert.deepEqual(await subscriber.start(), { status: "started", reused: false });
  assert.equal(connectionOptions.protocol, "mqtt");
  assert.equal(connectionOptions.host, "192.168.0.250");
  assert.equal(connectionOptions.port, 1883);
  assert.equal(connectionOptions.username, "radar-reader");
  assert.equal(connectionOptions.password, "stored-secret");
  client.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("message", "A26260220/json", Buffer.from(JSON.stringify({
    speed: 31,
    direction: "inbound",
    timestamp: "2026-08-22T18:20:31.456Z",
  })));
  await subscriber.processing;

  assert.deepEqual(calls.slice(0, 4), [
    ["subscribe", "A26260220/#", { qos: 1 }],
    ["connected"],
    ["insert", "A26260220", 31, "inbound"],
    ["correlate"],
  ]);
  await subscriber.stop();
});

test("live-feed query and popup expose speed and overview-camera playback provenance", async () => {
  const [database, table] = await Promise.all([
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(database, /radar\.speed_mph/);
  assert.match(database, /LEFT JOIN (?:public\.)?radar_events radar ON radar\.matched_read_id = pr\.id/);
  assert.match(database, /source_camera_short_name/);
  assert.match(table, /label="Speed"/);
  assert.match(table, /minimumSpeed/);
  assert.match(table, /maximumSpeed/);
  assert.match(table, /buildBlueIrisTimelinePath/);
  assert.match(table, /displayedImageView === "vehicle"/);
  assert.match(table, /Count/);
  assert.match(table, /matchMode=off/);
});
