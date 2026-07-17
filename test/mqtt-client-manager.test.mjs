import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  MqttClientManager,
  createBrokerIdentity,
  normalizeBrokerConfig,
  redactBrokerConfig,
  validateQos,
} from "../lib/mqtt/client-manager.mjs";

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.ended = false;
    this.published = [];
    this.endCalls = [];
  }

  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    queueMicrotask(() => callback(null));
  }

  end(force, options, callback) {
    this.endCalls.push({ force, options });
    this.connected = false;
    this.ended = true;
    this.emit("end");
    queueMicrotask(() => callback?.());
  }
}

function createHarness({ behavior = "connect" } = {}) {
  const calls = [];
  const clients = [];
  const logs = [];
  const logger = {
    info(message, details) {
      logs.push({ level: "info", message, details });
    },
    warn(message, details) {
      logs.push({ level: "warn", message, details });
    },
    error(message, details) {
      logs.push({ level: "error", message, details });
    },
  };

  const mqttConnect = (url, options) => {
    const client = new FakeMqttClient();
    clients.push(client);
    calls.push({ url, options, client });

    queueMicrotask(() => {
      if (behavior === "connect") {
        client.connected = true;
        client.emit("connect");
      } else if (behavior === "error") {
        client.emit("error", new Error("broker unavailable"));
      }
    });

    return client;
  };

  return { mqttConnect, calls, clients, logs, logger };
}

const baseBroker = {
  id: 7,
  name: "Home MQTT",
  broker: "192.168.0.50",
  port: 1883,
  username: "alpr",
  password: "super-secret",
  use_tls: false,
  client_id: "alpr-dashboard",
  enabled: true,
};

test("broker normalization accepts existing database field names", () => {
  assert.deepEqual(normalizeBrokerConfig(baseBroker), {
    id: 7,
    name: "Home MQTT",
    host: "192.168.0.50",
    port: 1883,
    useTls: false,
    username: "alpr",
    password: "super-secret",
    clientId: "alpr-dashboard",
    enabled: true,
    keepalive: 60,
    rejectUnauthorized: true,
  });
});

test("broker cache identities change for connection-affecting credentials and TLS", () => {
  const original = createBrokerIdentity(baseBroker);

  assert.notEqual(
    original,
    createBrokerIdentity({ ...baseBroker, use_tls: true, port: 8883 })
  );
  assert.notEqual(
    original,
    createBrokerIdentity({ ...baseBroker, username: "different-user" })
  );
  assert.notEqual(
    original,
    createBrokerIdentity({ ...baseBroker, password: "different-password" })
  );
  assert.notEqual(
    original,
    createBrokerIdentity({ ...baseBroker, client_id: "different-client" })
  );
});

test("broker logging redacts passwords while retaining useful connection details", () => {
  const redacted = redactBrokerConfig(baseBroker);

  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.host, "192.168.0.50");
  assert.equal(redacted.username, "alpr");
  assert.equal(JSON.stringify(redacted).includes("super-secret"), false);
});

test("concurrent connection requests share one credential-aware MQTT client", async () => {
  const harness = createHarness();
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
  });

  const [first, second] = await Promise.all([
    manager.getClient(baseBroker),
    manager.getClient(baseBroker),
  ]);

  assert.equal(first, second);
  assert.equal(harness.calls.length, 1);
  assert.equal(manager.connectionCount, 1);
  assert.equal(harness.calls[0].url, "mqtt://192.168.0.50:1883");
  assert.equal(harness.calls[0].options.reconnectPeriod, 5000);
  assert.equal(harness.calls[0].options.username, "alpr");
  assert.equal(harness.calls[0].options.password, "super-secret");

  const serializedLogs = JSON.stringify(harness.logs);
  assert.equal(serializedLogs.includes("super-secret"), false);

  await manager.shutdown();
});

test("publishing serializes flat JSON and honors QoS and retained-message settings", async () => {
  const harness = createHarness();
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
  });

  const result = await manager.publish({
    broker: baseBroker,
    topic: "Blue Iris/ALPR/entry-lpr-1",
    payload: {
      plate_number: "DP0M90",
      matched_plate_number: "DPOM90",
      camera_key: "entry-lpr-1",
    },
    qos: 1,
    retain: false,
  });

  assert.deepEqual(result, {
    topic: "Blue Iris/ALPR/entry-lpr-1",
    qos: 1,
    retain: false,
    bytes: Buffer.byteLength(harness.clients[0].published[0].payload),
  });
  assert.deepEqual(harness.clients[0].published[0].options, {
    qos: 1,
    retain: false,
  });
  assert.deepEqual(JSON.parse(harness.clients[0].published[0].payload), {
    plate_number: "DP0M90",
    matched_plate_number: "DPOM90",
    camera_key: "entry-lpr-1",
  });

  await manager.shutdown();
});

test("invalid publish topics and QoS values fail before opening a broker connection", async () => {
  const harness = createHarness();
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
  });

  await assert.rejects(
    manager.publish({
      broker: baseBroker,
      topic: "Blue Iris/ALPR/#",
      payload: "test",
      qos: 1,
    }),
    /wildcards/
  );

  await assert.rejects(
    manager.publish({
      broker: baseBroker,
      topic: "Blue Iris/ALPR/entry-lpr-1",
      payload: "test",
      qos: 3,
    }),
    /QoS must be 0, 1, or 2/
  );

  assert.throws(() => validateQos("not-a-number"), /QoS/);
  assert.equal(harness.calls.length, 0);
});

test("failed initial connections are removed and closed so a later retry starts cleanly", async () => {
  const harness = createHarness({ behavior: "error" });
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
    connectTimeoutMs: 100,
  });

  await assert.rejects(manager.getClient(baseBroker), /broker unavailable/);

  assert.equal(manager.connectionCount, 0);
  assert.equal(harness.clients[0].ended, true);
  assert.equal(harness.clients[0].endCalls[0].force, true);
});

test("an offline cached client is force-closed before publishing on a replacement", async () => {
  const harness = createHarness();
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
  });

  const staleClient = await manager.getClient(baseBroker);
  staleClient.connected = false;
  staleClient.emit("offline");

  await manager.publish({
    broker: baseBroker,
    topic: "Blue Iris/ALPR/entry-lpr-1",
    payload: { plate_number: "DPOM90" },
  });

  assert.equal(harness.clients.length, 2);
  assert.equal(staleClient.ended, true);
  assert.equal(staleClient.endCalls[0].force, true);
  assert.equal(staleClient.published.length, 0);
  assert.equal(harness.clients[1].published.length, 1);

  await manager.shutdown();
});

test("a publish timeout force-closes and evicts the client before outbox retry", async () => {
  const clients = [];
  const mqttConnect = () => {
    const client = new FakeMqttClient();
    client.publish = (topic, payload, options) => {
      client.published.push({ topic, payload, options });
    };
    clients.push(client);
    queueMicrotask(() => {
      client.connected = true;
      client.emit("connect");
    });
    return client;
  };
  const manager = new MqttClientManager({
    mqttConnect,
    logger: { info() {}, warn() {}, error() {} },
    publishTimeoutMs: 5,
  });

  await assert.rejects(
    manager.publish({
      broker: baseBroker,
      topic: "Blue Iris/ALPR/entry-lpr-1",
      payload: { plate_number: "DPOM90" },
    }),
    /publish timeout/
  );

  assert.equal(clients[0].ended, true);
  assert.equal(clients[0].endCalls[0].force, true);
  assert.equal(manager.connectionCount, 0);
});

test("shutdown closes all cached clients and rejects new connection attempts", async () => {
  const harness = createHarness();
  const manager = new MqttClientManager({
    mqttConnect: harness.mqttConnect,
    logger: harness.logger,
  });

  const secondBroker = {
    ...baseBroker,
    id: 8,
    port: 1884,
    client_id: "alpr-dashboard-secondary",
  };

  await Promise.all([
    manager.getClient(baseBroker),
    manager.getClient(secondBroker),
  ]);
  assert.equal(manager.connectionCount, 2);

  await manager.shutdown();

  assert.equal(manager.connectionCount, 0);
  assert.equal(harness.clients.every((client) => client.ended), true);
  await assert.rejects(manager.getClient(baseBroker), /shutting down/);
});
