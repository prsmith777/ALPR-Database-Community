import { parseRadarPayload } from "./payload.mjs";

function safeError(error) {
  return String(error?.message || error || "Radar MQTT error").trim().slice(0, 1000);
}

function subscribe(client, topic, qos) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos }, (error, grants) => {
      if (error) reject(error);
      else resolve(grants || []);
    });
  });
}

function endClient(client, force = false) {
  return new Promise((resolve) => {
    if (!client || client.ended) return resolve();
    client.end(force, {}, resolve);
  });
}

export class RadarSubscriber {
  constructor({ repository, mqttConnect, logger = console, correlationIntervalMs = 1_000 } = {}) {
    if (!repository) throw new Error("RadarSubscriber requires a repository");
    if (typeof mqttConnect !== "function") throw new Error("RadarSubscriber requires mqttConnect");
    this.repository = repository;
    this.mqttConnect = mqttConnect;
    this.logger = logger;
    this.correlationIntervalMs = correlationIntervalMs;
    this.client = null;
    this.timer = null;
    this.started = false;
    this.processing = Promise.resolve();
  }

  async start() {
    if (this.started) return { status: "started", reused: true };
    const settings = await this.repository.getSettings();
    if (!settings?.enabled || !settings.broker?.enabled) {
      this.logger?.info?.("radar_mqtt_disabled", {
        reason: !settings ? "settings_missing" : !settings.enabled ? "radar_disabled" : "broker_disabled",
      });
      return { status: "disabled", reused: false };
    }

    const protocol = settings.broker.useTls ? "mqtts" : "mqtt";
    const baseClientId = String(settings.broker.clientId || "alpr-community").trim();
    const options = {
      protocol,
      host: settings.broker.host,
      port: settings.broker.port,
      clean: true,
      keepalive: 60,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
      resubscribe: false,
      clientId: `${baseClientId}-radar-${process.pid}`.slice(0, 128),
    };
    if (settings.broker.username) options.username = settings.broker.username;
    if (settings.broker.password) options.password = settings.broker.password;
    if (settings.broker.useTls) options.rejectUnauthorized = true;

    const client = this.mqttConnect(options);
    this.client = client;
    const onConnected = async () => {
      try {
        await subscribe(client, settings.topicFilter, settings.qos);
        await this.repository.recordConnected();
        this.logger?.info?.("radar_mqtt_subscribed", {
          host: settings.broker.host,
          port: settings.broker.port,
          tls: settings.broker.useTls,
          topic: settings.topicFilter,
        });
      } catch (error) {
        const message = safeError(error);
        await this.repository.recordError(message).catch(() => {});
        this.logger?.error?.("radar_mqtt_subscribe_failed", { error: message });
      }
    };

    client.on("connect", onConnected);
    client.on("message", (topic, payload) => {
      this.processing = this.processing.then(async () => {
        const event = parseRadarPayload({ topic, payload, receivedAt: new Date() });
        if (!event) return;
        const inserted = await this.repository.insertEvent({ ...event, sourceKey: settings.sourceKey });
        if (!inserted) return;
        const matches = await this.repository.correlatePending();
        this.logger?.info?.("radar_event_ingested", {
          eventId: Number(inserted.id),
          direction: inserted.direction,
          speedMph: Number(inserted.speed_mph),
          matched: matches.some((match) => Number(match.id) === Number(inserted.id)),
        });
      }).catch(async (error) => {
        const message = safeError(error);
        await this.repository.recordError(message).catch(() => {});
        this.logger?.error?.("radar_event_ingest_failed", { error: message });
      });
    });
    client.on("error", (error) => {
      const message = safeError(error);
      this.repository.recordError(message).catch(() => {});
      this.logger?.error?.("radar_mqtt_error", { error: message });
    });

    this.timer = setInterval(() => {
      this.processing = this.processing
        .then(() => this.repository.correlatePending())
        .catch((error) => this.logger?.error?.("radar_correlation_failed", { error: safeError(error) }));
    }, this.correlationIntervalMs);
    this.timer.unref?.();
    this.started = true;
    this.logger?.info?.("radar_mqtt_runtime_started", {
      host: settings.broker.host,
      port: settings.broker.port,
      tls: settings.broker.useTls,
      topic: settings.topicFilter,
      sourceKey: settings.sourceKey,
    });
    return { status: "started", reused: false };
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processing.catch(() => {});
    await endClient(this.client, true);
    this.client = null;
    this.started = false;
  }
}

export const radarSubscriberInternals = Object.freeze({ endClient, safeError, subscribe });
