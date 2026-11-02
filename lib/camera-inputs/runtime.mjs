import { CameraInputRepository } from "./repository.mjs";
import { AxisEventProcessor } from "./processor.mjs";
import {
  AXIS_MAX_BODY_BYTES,
  InputError,
  topicMatches,
  deviceKey,
} from "./axis.mjs";

export function buildSubscriberOptions(input) {
  return {
    clientId: `alpr-axis-${input.id}`,
    username: input.username || undefined,
    password: input.password || undefined,
    clean: false,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 30,
    rejectUnauthorized: true,
    resubscribe: false,
  };
}
export class CameraInputRuntime {
  constructor({
    pool,
    mqttConnect,
    ingest,
    storage,
    publish,
    notifyDirection,
    logger = console,
    schedule = setTimeout,
    cancel = clearTimeout,
  }) {
    this.pool = pool;
    this.repository = new CameraInputRepository(pool);
    this.processor = new AxisEventProcessor({
      pool,
      ingest,
      storage,
      publish,
      notifyDirection,
      logger,
    });
    this.mqttConnect = mqttConnect;
    this.logger = logger;
    this.schedule = schedule;
    this.cancel = cancel;
    this.started = false;
    this.wakeRequested = false;
    this.clients = new Map();
    this.stopped = false;
    this.running = false;
    this.timer = null;
    this.lastSync = 0;
  }
  async handlePacket(input, packet) {
    if (!topicMatches(input.topic_filter, String(packet.topic))) return;
    const payload = packet.payload;
    if (!payload || payload.byteLength > AXIS_MAX_BODY_BYTES)
      throw new InputError("MQTT event is too large", 413);
    let parsed;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new InputError("Invalid MQTT JSON");
    }
    const current = await this.repository.get(input.id);
    const eventDevice =
      parsed.message?.data?.MACAddress ??
      parsed.camera_info?.SerialNumber ??
      parsed.camera_info?.MACAddress;
    // A wildcard filter may legitimately include other cameras' events.
    if (
      eventDevice &&
      current?.device_id &&
      deviceKey(eventDevice) !== current.device_id
    )
      return;

    const received = await this.repository.receive(current, parsed, "mqtt", {
      retained: packet.retain === true,
    });
    this.wake();
    return received;
  }
  async sync() {
    const inputs = await this.repository.mqttInputs();
    const wanted = new Set();
    for (const input of inputs) {
      wanted.add(input.id);
      const identity = JSON.stringify([
        input.broker,
        input.port,
        input.username,
        input.password,
        input.use_tls,
        input.broker_enabled,
        input.topic_filter,
        input.qos,
        input.device_id,
      ]);
      let existing = this.clients.get(input.id);
      if (existing && existing.identity !== identity) {
        await new Promise((resolve) => existing.client.end(true, {}, resolve));
        this.clients.delete(input.id);
        existing = null;
      }
      if (!input.broker_enabled) {
        await this.repository.status(
          input.id,
          "disabled",
          "The selected broker is disabled.",
        );
        continue;
      }
      if (existing) continue;
      // The broker host is stored separately from credentials. Do not accept a URL
      // that could override transport security or inject another credential.
      if (/[\s/@?#]/.test(input.broker) || input.broker.includes("://")) {
        await this.repository.status(
          input.id,
          "error",
          "Use a broker hostname or IP without a URL scheme.",
        );
        continue;
      }
      const host = input.broker.includes(":")
        ? `[${input.broker.replace(/^\[|\]$/g, "")}]`
        : input.broker;
      let client;
      try {
        client = this.mqttConnect(
          `${input.use_tls ? "mqtts" : "mqtt"}://${host}:${input.port}`,
          buildSubscriberOptions(input),
        );
      } catch {
        await this.repository.status(
          input.id,
          "error",
          "Unable to create MQTT connection. Check broker settings.",
        );
        continue;
      }
      this.clients.set(input.id, { client, identity });
      // MQTT.js invokes handleMessage before PUBACK for QoS 1. Persist before
      // acknowledging; disconnect on transient failures so the broker can retry.
      client.handleMessage = (packet, callback) => {
        this.handlePacket(input, packet).then(
          () => callback(),
          async (error) => {
            if (error instanceof InputError) {
              await this.repository
                .status(input.id, "receiving", error.message)
                .catch(() => {});
              callback();
              return;
            }
            this.logger.error?.("axis_mqtt_receipt_failed", {
              inputId: input.id,
              code: error?.code || "DATABASE_ERROR",
            });
            client.stream?.destroy();
            callback(error);
          },
        );
      };
      client.on("connect", () => {
        client.subscribe(
          input.topic_filter,
          { qos: input.qos },
          (error, granted) => {
            const refused =
              error || !granted?.length || granted.some((item) => item.qos > 1);
            this.repository
              .status(
                input.id,
                refused ? "error" : "subscribed",
                refused
                  ? "Broker refused the subscription. Check topic permissions."
                  : null,
              )
              .catch(() => {});
          },
        );
      });
      client.on("error", () => {
        this.repository
          .status(
            input.id,
            "error",
            "MQTT connection failed. Check broker, credentials and TLS.",
          )
          .catch(() => {});
      });
      client.on("offline", () => {
        this.repository.status(input.id, "reconnecting", null).catch(() => {});
      });
    }
    for (const [id, entry] of this.clients)
      if (!wanted.has(id)) {
        await new Promise((resolve) => entry.client.end(true, {}, resolve));
        this.clients.delete(id);
      }
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.lastSync > 10000) {
        await this.sync();
        this.lastSync = Date.now();
      }
      for (let count = 0; count < 10; count++) {
        const event = await this.repository.claim();
        if (!event) break;
        try {
          await this.processor.process(event);
        } catch (error) {
          this.logger.error?.("axis_event_processing_failed", {
            eventId: event.id,
            code: error?.code || "PROCESSING_ERROR",
          });
          await this.repository.fail(event);
        }
      }
      const stale = (
        await this.pool
          .query(`SELECT events.* FROM public.camera_input_passages passages
        JOIN public.camera_input_events events ON events.id=passages.last_event_id
        JOIN public.camera_inputs inputs ON inputs.id=passages.input_id
        WHERE passages.read_id IS NULL AND NOT passages.finalized AND inputs.enabled AND inputs.processing_mode='final'
          AND passages.last_seen<CURRENT_TIMESTAMP - INTERVAL '30 seconds' ORDER BY passages.last_seen LIMIT 5`)
      ).rows;
      for (const event of stale)
        await this.processor.process(event, { finalize: true });
      await this.pool
        .query(`DELETE FROM public.camera_input_events WHERE id IN (
        SELECT events.id FROM public.camera_input_events events WHERE events.status<>'pending'
          AND events.processed_at<CURRENT_TIMESTAMP - INTERVAL '7 days'
          AND NOT EXISTS(SELECT 1 FROM public.camera_input_passages passages WHERE passages.last_event_id=events.id AND NOT passages.finalized AND passages.read_id IS NULL)
          ORDER BY events.id LIMIT 100)`);
    } catch (error) {
      this.logger.error?.("camera_input_runtime_retry", {
        code: error?.code || "RUNTIME_ERROR",
      });
    } finally {
      this.running = false;
      if (!this.stopped) {
        this.timer = this.schedule(
          () => {
            void this.tick();
          },
          this.wakeRequested ? 0 : 1000,
        );
        this.wakeRequested = false;
        this.timer?.unref?.();
      }
    }
  }
  wake() {
    if (!this.started || this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      void this.tick();
    }, 0);
    this.timer?.unref?.();
  }
  start() {
    this.started = true;
    void this.tick();
    return this;
  }
  async stop() {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    await Promise.allSettled(
      [...this.clients.values()].map(
        ({ client }) => new Promise((resolve) => client.end(true, {}, resolve)),
      ),
    );
    this.clients.clear();
  }
}

const STATE = Symbol.for("alpr.camera-input-runtime.v1");
export function wakeCameraInputs(stateHost = globalThis) {
  stateHost[STATE]?.then((runtime) => runtime.wake()).catch(() => {});
}
export async function startCameraInputRuntime({
  loadDependencies,
  stateHost = globalThis,
} = {}) {
  if (!stateHost[STATE]) {
    stateHost[STATE] = (async () => {
      const dependencies = loadDependencies
        ? await loadDependencies()
        : await loadDefaultDependencies();
      const runtime = new CameraInputRuntime(dependencies).start();
      return runtime;
    })().catch((error) => {
      delete stateHost[STATE];
      throw error;
    });
  }
  return stateHost[STATE];
}
async function loadDefaultDependencies() {
  const [
    { getPool },
    mqtt,
    { processPlateRead, processCameraDirection },
    { default: storage },
    { publishPlateReadChanges },
  ] = await Promise.all([
    import("../db.js"),
    import("mqtt"),
    import("../plate-read-ingestion.js"),
    import("../fileStorage.js"),
    import("../sse.js"),
  ]);
  return {
    pool: await getPool(),
    mqttConnect: mqtt.connect ?? mqtt.default.connect,
    ingest: processPlateRead,
    storage,
    publish: publishPlateReadChanges,
    notifyDirection: processCameraDirection,
  };
}
