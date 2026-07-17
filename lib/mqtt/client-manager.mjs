import { createHash } from "node:crypto";

import { validatePublishTopic } from "./topic-template.mjs";

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function formatBrokerHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function normalizeBrokerConfig(broker = {}) {
  const host = String(
    firstDefined(broker.host, broker.broker, broker.broker_url, "")
  ).trim();
  const port = normalizeInteger(
    firstDefined(broker.port, broker.broker_port, 1883),
    1883,
    1,
    65535
  );
  const useTls = normalizeBoolean(
    firstDefined(broker.useTls, broker.use_tls, broker.broker_use_tls),
    false
  );
  const username = String(
    firstDefined(broker.username, broker.broker_username, "")
  );
  const password = String(
    firstDefined(broker.password, broker.broker_password, "")
  );
  const clientId = String(
    firstDefined(broker.clientId, broker.client_id, "")
  ).trim();
  const enabled = normalizeBoolean(broker.enabled, true);
  const keepalive = normalizeInteger(broker.keepalive, 60, 5, 65535);
  const rejectUnauthorized = normalizeBoolean(
    firstDefined(broker.rejectUnauthorized, broker.reject_unauthorized),
    true
  );

  if (!host) throw new Error("MQTT broker host cannot be empty");

  return {
    id: firstDefined(broker.id, broker.brokerId, broker.broker_id, null),
    name: String(firstDefined(broker.name, broker.broker_name, host)).trim(),
    host,
    port,
    useTls,
    username,
    password,
    clientId,
    enabled,
    keepalive,
    rejectUnauthorized,
  };
}

function credentialFingerprint(config) {
  return createHash("sha256")
    .update(`${config.username}\u0000${config.password}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

/**
 * Build a cache identity that changes whenever connection-affecting settings
 * change. The password is represented only by a one-way fingerprint.
 */
export function createBrokerIdentity(broker) {
  const config = normalizeBrokerConfig(broker);
  return JSON.stringify({
    host: config.host.toLowerCase(),
    port: config.port,
    useTls: config.useTls,
    username: config.username,
    credentialFingerprint: credentialFingerprint(config),
    clientId: config.clientId,
    rejectUnauthorized: config.rejectUnauthorized,
  });
}

export function redactBrokerConfig(broker) {
  const config = normalizeBrokerConfig(broker);
  return {
    id: config.id,
    name: config.name,
    host: config.host,
    port: config.port,
    useTls: config.useTls,
    username: config.username,
    password: config.password ? "[REDACTED]" : "",
    clientId: config.clientId,
    enabled: config.enabled,
    keepalive: config.keepalive,
    rejectUnauthorized: config.rejectUnauthorized,
  };
}

export function validateQos(value) {
  const qos = Number(value);
  if (!Number.isInteger(qos) || qos < 0 || qos > 2) {
    throw new Error("MQTT QoS must be 0, 1, or 2");
  }
  return qos;
}

function serializePayload(payload) {
  if (typeof payload === "string" || Buffer.isBuffer(payload)) return payload;

  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new Error(`MQTT payload could not be serialized: ${error.message}`);
  }
}

function safelyLog(logger, level, message, details) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  if (details === undefined) method.call(logger, message);
  else method.call(logger, message, details);
}

export class MqttClientManager {
  constructor({
    mqttConnect,
    logger = console,
    connectTimeoutMs = 10_000,
    publishTimeoutMs = 10_000,
    reconnectPeriodMs = 5_000,
  } = {}) {
    if (typeof mqttConnect !== "function") {
      throw new Error("MqttClientManager requires an mqttConnect function");
    }

    this.mqttConnect = mqttConnect;
    this.logger = logger;
    this.connectTimeoutMs = normalizeInteger(
      connectTimeoutMs,
      10_000,
      1,
      300_000
    );
    this.publishTimeoutMs = normalizeInteger(
      publishTimeoutMs,
      10_000,
      1,
      300_000
    );
    this.reconnectPeriodMs = normalizeInteger(
      reconnectPeriodMs,
      5_000,
      100,
      300_000
    );
    this.entries = new Map();
    this.shuttingDown = false;
  }

  get connectionCount() {
    return this.entries.size;
  }

  buildConnection(config) {
    const protocol = config.useTls ? "mqtts" : "mqtt";
    const url = `${protocol}://${formatBrokerHost(config.host)}:${config.port}`;
    const options = {
      clean: true,
      keepalive: config.keepalive,
      connectTimeout: this.connectTimeoutMs,
      reconnectPeriod: this.reconnectPeriodMs,
      resubscribe: false,
    };

    if (config.clientId) options.clientId = config.clientId;
    if (config.username) options.username = config.username;
    if (config.password) options.password = config.password;
    if (config.useTls) {
      options.rejectUnauthorized = config.rejectUnauthorized;
    }

    return { url, options };
  }

  waitForReady(client, config) {
    if (client.connected) return Promise.resolve(client);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(
            `MQTT connection timeout after ${this.connectTimeoutMs}ms to ${config.host}:${config.port}`
          )
        );
      }, this.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        client.removeListener("connect", onConnect);
        client.removeListener("error", onError);
        client.removeListener("close", onClose);
      };

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };

      const onConnect = () => finish(resolve, client);
      const onError = (error) => {
        finish(
          reject,
          new Error(`MQTT connection failed: ${error?.message ?? "unknown error"}`)
        );
      };
      const onClose = () => {
        finish(reject, new Error("MQTT connection closed before it became ready"));
      };

      client.once("connect", onConnect);
      client.once("error", onError);
      client.once("close", onClose);
    });
  }

  attachLifecycleLogging(client, config, identity) {
    client.on("connect", () => {
      safelyLog(this.logger, "info", "MQTT broker connected", {
        broker: redactBrokerConfig(config),
      });
    });
    client.on("reconnect", () => {
      safelyLog(this.logger, "warn", "MQTT broker reconnecting", {
        broker: redactBrokerConfig(config),
      });
    });
    client.on("offline", () => {
      safelyLog(this.logger, "warn", "MQTT broker offline", {
        broker: redactBrokerConfig(config),
      });
    });
    client.on("error", (error) => {
      safelyLog(this.logger, "error", "MQTT broker error", {
        broker: redactBrokerConfig(config),
        error: error?.message ?? "unknown error",
      });
    });
    client.on("end", () => {
      const current = this.entries.get(identity);
      if (current?.client === client) this.entries.delete(identity);
    });
  }

  async closeClient(client, { force = false } = {}) {
    if (!client || client.ended) return;

    if (typeof client.endAsync === "function") {
      await client.endAsync(force);
      return;
    }

    await new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        resolve();
      };
      const timeout = setTimeout(finish, 5_000);

      try {
        client.end(force, {}, () => {
          clearTimeout(timeout);
          finish();
        });
      } catch {
        clearTimeout(timeout);
        finish();
      }
    });
  }

  async getClient(broker) {
    if (this.shuttingDown) {
      throw new Error("MQTT client manager is shutting down");
    }

    const config = normalizeBrokerConfig(broker);
    if (!config.enabled) throw new Error("MQTT broker is disabled");

    const identity = createBrokerIdentity(config);
    const existing = this.entries.get(identity);
    if (existing) return existing.readyPromise;

    const { url, options } = this.buildConnection(config);
    safelyLog(this.logger, "info", "Opening MQTT broker connection", {
      broker: redactBrokerConfig(config),
    });

    const client = this.mqttConnect(url, options);
    this.attachLifecycleLogging(client, config, identity);

    const readyPromise = this.waitForReady(client, config)
      .then(() => client)
      .catch(async (error) => {
        const current = this.entries.get(identity);
        if (current?.client === client) this.entries.delete(identity);
        await this.closeClient(client, { force: true });
        throw error;
      });

    this.entries.set(identity, { client, config, readyPromise });
    return readyPromise;
  }

  async publish({ broker, topic, payload, qos = 1, retain = false } = {}) {
    const publishTopic = validatePublishTopic(topic);
    const publishQos = validateQos(qos);
    const publishRetain = Boolean(retain);
    const message = serializePayload(payload);
    const client = await this.getClient(broker);

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(`MQTT publish timeout after ${this.publishTimeoutMs}ms`)
        );
      }, this.publishTimeoutMs);

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        handler(value);
      };

      try {
        client.publish(
          publishTopic,
          message,
          { qos: publishQos, retain: publishRetain },
          (error) => {
            if (error) finish(reject, error);
            else finish(resolve);
          }
        );
      } catch (error) {
        finish(reject, error);
      }
    });

    return {
      topic: publishTopic,
      qos: publishQos,
      retain: publishRetain,
      bytes: Buffer.byteLength(message),
    };
  }

  async shutdown({ force = false } = {}) {
    this.shuttingDown = true;
    const entries = [...this.entries.values()];
    this.entries.clear();

    await Promise.allSettled(
      entries.map((entry) => this.closeClient(entry.client, { force }))
    );
  }
}
