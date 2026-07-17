import {
  normalizeBaseTopic,
  renderCameraTopic,
  validatePublishTopic,
} from "./topic-template.mjs";

const ACTIVITY_STATUSES = new Set([
  "pending",
  "processing",
  "retry",
  "succeeded",
  "dead",
]);
const PAYLOAD_PROFILES = new Set([
  "generic_json",
  "homeseer",
  "home_assistant",
]);

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("MqttAdminRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function requireText(value, name, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function optionalText(value, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (text.length > maximumLength) {
    throw new Error(`Value cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeId(value, name = "MQTT record ID") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeInteger(value, { name, minimum, maximum, fallback }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return Boolean(value);
}

function normalizeTimezone(value) {
  const timezone = requireText(value, "MQTT local timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function normalizeBrokerInput(input = {}, { update = false } = {}) {
  const passwordProvided = Object.prototype.hasOwnProperty.call(input, "password");
  const password = passwordProvided ? String(input.password ?? "") : null;
  const clearPassword = normalizeBoolean(input.clearPassword, false);

  return {
    name: requireText(input.name, "MQTT broker name", 255),
    broker: requireText(input.broker, "MQTT broker host", 255),
    port: normalizeInteger(input.port, {
      name: "MQTT broker port",
      minimum: 1,
      maximum: 65535,
      fallback: 1883,
    }),
    username: optionalText(input.username, 255) || null,
    password: update && !passwordProvided ? null : password || null,
    passwordProvided,
    clearPassword,
    useTls: normalizeBoolean(input.useTls ?? input.use_tls, false),
    clientId: optionalText(input.clientId ?? input.client_id, 255) || null,
    enabled: normalizeBoolean(input.enabled, true),
  };
}

function normalizeSettingsInput(input = {}) {
  const baseTopic = normalizeBaseTopic(input.baseTopic ?? input.base_topic);
  validatePublishTopic(baseTopic);

  const cameraTopicTemplate = requireText(
    input.cameraTopicTemplate ?? input.camera_topic_template,
    "MQTT camera topic template",
    512
  );

  renderCameraTopic({
    baseTopic,
    template: cameraTopicTemplate,
    cameraKey: "sample-camera",
    cameraName: "Sample Camera",
  });

  const payloadProfile = requireText(
    input.payloadProfile ?? input.payload_profile ?? "generic_json",
    "MQTT payload profile",
    50
  );
  if (!PAYLOAD_PROFILES.has(payloadProfile)) {
    throw new Error(`Unsupported MQTT payload profile: ${payloadProfile}`);
  }

  const hourFormat = normalizeInteger(
    input.hourFormat ?? input.hour_format,
    {
      name: "MQTT hour format",
      minimum: 12,
      maximum: 24,
      fallback: 12,
    }
  );
  if (![12, 24].includes(hourFormat)) {
    throw new Error("MQTT hour format must be 12 or 24");
  }

  return {
    enabled: normalizeBoolean(input.enabled, false),
    baseTopic,
    cameraTopicTemplate,
    defaultQos: normalizeInteger(input.defaultQos ?? input.default_qos, {
      name: "MQTT default QoS",
      minimum: 0,
      maximum: 2,
      fallback: 1,
    }),
    retainMessages: normalizeBoolean(
      input.retainMessages ?? input.retain_messages,
      false
    ),
    payloadProfile,
    localTimezone: normalizeTimezone(
      input.localTimezone ?? input.local_timezone ?? "UTC"
    ),
    hourFormat,
  };
}

function mapBroker(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    broker: row.broker,
    port: Number(row.port),
    username: row.username ?? "",
    hasPassword: Boolean(row.has_password),
    useTls: Boolean(row.use_tls),
    clientId: row.client_id ?? "",
    enabled: Boolean(row.enabled),
    legacyTopic: row.topic ?? "",
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapSettings(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    baseTopic: row.base_topic,
    cameraTopicTemplate: row.camera_topic_template,
    defaultQos: Number(row.default_qos),
    retainMessages: Boolean(row.retain_messages),
    payloadProfile: row.payload_profile,
    localTimezone: row.local_timezone,
    hourFormat: Number(row.hour_format),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCamera(row, settings) {
  const topicOverride = row.topic_override ?? "";
  let effectiveTopic = "";
  let topicError = "";

  try {
    effectiveTopic = renderCameraTopic({
      baseTopic: settings.baseTopic,
      template: settings.cameraTopicTemplate,
      cameraKey: row.camera_key,
      cameraName: row.camera_name,
      topicOverride,
    });
  } catch (error) {
    topicError = String(error?.message ?? error);
  }

  return {
    id: Number(row.id),
    cameraName: row.camera_name,
    cameraKey: row.camera_key,
    enabled: Boolean(row.enabled),
    topicOverride,
    effectiveTopic,
    topicError,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row) {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    readId: row.read_id === null ? null : Number(row.read_id),
    cameraKey: row.camera_key,
    cameraName: row.camera_name,
    brokerId: Number(row.broker_id),
    brokerName: row.broker_name,
    topic: row.topic,
    payload: row.payload,
    qos: Number(row.qos),
    retain: Boolean(row.retain),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error ?? "",
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts: Array.isArray(row.attempts) ? row.attempts : [],
  };
}

export class MqttAdminRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async listBrokers() {
    const result = await this.pool.query(`
      SELECT
        id,
        name,
        broker,
        port,
        topic,
        username,
        (password IS NOT NULL AND password <> '') AS has_password,
        use_tls,
        client_id,
        enabled,
        created_at,
        updated_at
      FROM public.mqttbrokers
      ORDER BY name, id
    `);
    return result.rows.map(mapBroker);
  }

  async getBroker(id) {
    const brokerId = normalizeId(id, "MQTT broker ID");
    const result = await this.pool.query(
      `
        SELECT
          id,
          name,
          broker,
          port,
          topic,
          username,
          (password IS NOT NULL AND password <> '') AS has_password,
          use_tls,
          client_id,
          enabled,
          created_at,
          updated_at
        FROM public.mqttbrokers
        WHERE id = $1
      `,
      [brokerId]
    );
    return mapBroker(result.rows[0]);
  }

  async createBroker(input) {
    const broker = normalizeBrokerInput(input);
    const result = await this.pool.query(
      `
        INSERT INTO public.mqttbrokers (
          name,
          broker,
          port,
          topic,
          username,
          password,
          use_tls,
          client_id,
          enabled
        )
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8)
        RETURNING
          id,
          name,
          broker,
          port,
          topic,
          username,
          (password IS NOT NULL AND password <> '') AS has_password,
          use_tls,
          client_id,
          enabled,
          created_at,
          updated_at
      `,
      [
        broker.name,
        broker.broker,
        broker.port,
        broker.username,
        broker.password,
        broker.useTls,
        broker.clientId,
        broker.enabled,
      ]
    );
    return mapBroker(result.rows[0]);
  }

  async updateBroker(id, input) {
    const brokerId = normalizeId(id, "MQTT broker ID");
    const broker = normalizeBrokerInput(input, { update: true });
    const result = await this.pool.query(
      `
        UPDATE public.mqttbrokers
        SET
          name = $2,
          broker = $3,
          port = $4,
          username = $5,
          password = CASE
            WHEN $6::boolean THEN NULL
            WHEN $7::boolean THEN $8
            ELSE password
          END,
          use_tls = $9,
          client_id = $10,
          enabled = $11
        WHERE id = $1
        RETURNING
          id,
          name,
          broker,
          port,
          topic,
          username,
          (password IS NOT NULL AND password <> '') AS has_password,
          use_tls,
          client_id,
          enabled,
          created_at,
          updated_at
      `,
      [
        brokerId,
        broker.name,
        broker.broker,
        broker.port,
        broker.username,
        broker.clearPassword,
        broker.passwordProvided,
        broker.password,
        broker.useTls,
        broker.clientId,
        broker.enabled,
      ]
    );
    return mapBroker(result.rows[0]);
  }

  async deleteBroker(id) {
    const brokerId = normalizeId(id, "MQTT broker ID");
    const result = await this.pool.query(
      `DELETE FROM public.mqttbrokers WHERE id = $1 RETURNING id`,
      [brokerId]
    );
    return result.rows.length > 0;
  }

  async getSettings() {
    const result = await this.pool.query(
      `SELECT * FROM public.mqtt_settings WHERE id = 1`
    );
    if (!result.rows[0]) throw new Error("MQTT settings row is missing");
    return mapSettings(result.rows[0]);
  }

  async updateSettings(input) {
    const settings = normalizeSettingsInput(input);
    const result = await this.pool.query(
      `
        UPDATE public.mqtt_settings
        SET
          enabled = $1,
          base_topic = $2,
          camera_topic_template = $3,
          default_qos = $4,
          retain_messages = $5,
          payload_profile = $6,
          local_timezone = $7,
          hour_format = $8
        WHERE id = 1
        RETURNING *
      `,
      [
        settings.enabled,
        settings.baseTopic,
        settings.cameraTopicTemplate,
        settings.defaultQos,
        settings.retainMessages,
        settings.payloadProfile,
        settings.localTimezone,
        settings.hourFormat,
      ]
    );
    return mapSettings(result.rows[0]);
  }

  async listCameras() {
    const [settings, cameras] = await Promise.all([
      this.getSettings(),
      this.pool.query(`
        SELECT *
        FROM public.mqtt_cameras
        ORDER BY camera_name, id
      `),
    ]);
    return cameras.rows.map((row) => mapCamera(row, settings));
  }

  async updateCamera(id, input = {}) {
    const cameraId = normalizeId(id, "MQTT camera ID");
    const enabled = normalizeBoolean(input.enabled, true);
    const topicOverride = optionalText(
      input.topicOverride ?? input.topic_override,
      65535
    );
    if (topicOverride) validatePublishTopic(topicOverride);

    const result = await this.pool.query(
      `
        UPDATE public.mqtt_cameras
        SET enabled = $2, topic_override = NULLIF($3, '')
        WHERE id = $1
        RETURNING *
      `,
      [cameraId, enabled, topicOverride]
    );
    if (!result.rows[0]) return null;
    const settings = await this.getSettings();
    return mapCamera(result.rows[0], settings);
  }

  async listActivity({ limit = 50, status = null } = {}) {
    const activityLimit = normalizeInteger(limit, {
      name: "MQTT activity limit",
      minimum: 1,
      maximum: 500,
      fallback: 50,
    });
    const normalizedStatus = status ? String(status).trim() : null;
    if (normalizedStatus && !ACTIVITY_STATUSES.has(normalizedStatus)) {
      throw new Error(`Invalid MQTT activity status: ${normalizedStatus}`);
    }

    const result = await this.pool.query(
      `
        SELECT
          d.*,
          b.name AS broker_name,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'attempt_number', a.attempt_number,
                  'outcome', a.outcome,
                  'worker_id', a.worker_id,
                  'error_code', a.error_code,
                  'error_message', a.error_message,
                  'started_at', a.started_at,
                  'completed_at', a.completed_at
                )
                ORDER BY a.attempt_number DESC
              )
              FROM public.mqtt_delivery_attempts a
              WHERE a.delivery_id = d.id
            ),
            '[]'::jsonb
          ) AS attempts
        FROM public.mqtt_deliveries d
        JOIN public.mqttbrokers b ON b.id = d.broker_id
        WHERE ($2::text IS NULL OR d.status = $2)
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $1
      `,
      [activityLimit, normalizedStatus]
    );
    return result.rows.map(mapActivity);
  }
}

export const mqttAdminRepositoryInternals = Object.freeze({
  normalizeId,
  normalizeBrokerInput,
  normalizeSettingsInput,
  mapBroker,
  mapSettings,
  mapCamera,
  mapActivity,
});
