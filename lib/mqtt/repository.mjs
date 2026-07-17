import {
  MQTT_DELIVERY_STATUSES,
  normalizeDeliveryEnvelope,
  planDeliveryFailure,
} from "./delivery-outbox.mjs";
import { normalizeCameraKey } from "./plate-normalize.mjs";

const ACTIVITY_STATUSES = new Set(Object.values(MQTT_DELIVERY_STATUSES));

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function requireText(value, name, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeInteger(
  value,
  { name, minimum, maximum, fallback = undefined, optional = false }
) {
  if ((value === undefined || value === null || value === "") && optional) {
    return null;
  }

  const parsed = Number(firstDefined(value, fallback));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("MqttRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
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

function mapCamera(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    cameraName: row.camera_name,
    cameraKey: row.camera_key,
    enabled: Boolean(row.enabled),
    topicOverride: row.topic_override ?? "",
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBroker(row) {
  if (!row) return null;
  return {
    id: Number(firstDefined(row.broker_id, row.id)),
    name: firstDefined(row.broker_name, row.name, ""),
    broker: firstDefined(row.broker_host, row.broker, ""),
    port: Number(firstDefined(row.broker_port, row.port, 1883)),
    username: firstDefined(row.broker_username, row.username, ""),
    password: firstDefined(row.broker_password, row.password, ""),
    useTls: Boolean(firstDefined(row.broker_use_tls, row.use_tls, false)),
    clientId: firstDefined(row.broker_client_id, row.client_id, ""),
    enabled: Boolean(firstDefined(row.broker_enabled, row.enabled, true)),
  };
}

function mapRule(row) {
  const cameraIds = Array.isArray(row.camera_ids)
    ? row.camera_ids.map(Number).filter(Number.isInteger)
    : [];

  return {
    id: Number(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    matchType: row.match_type,
    matchValue: row.match_value ?? "",
    fuzzyEnabled: Boolean(row.fuzzy_enabled),
    fuzzyMaxDistance: Number(row.fuzzy_max_distance),
    fuzzyMinLength: Number(row.fuzzy_min_length),
    fuzzyRequireUnique: Boolean(row.fuzzy_require_unique),
    fuzzyOcrAware: Boolean(row.fuzzy_ocr_aware),
    brokerId: Number(row.broker_id),
    destinationMode: row.destination_mode,
    fixedTopic: row.fixed_topic ?? "",
    message: row.message ?? "",
    cameraIds,
    broker: mapBroker(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnownPlate(row) {
  return {
    plateNumber: row.plate_number,
    name: row.name ?? "",
    notes: row.notes ?? "",
    ignore: Boolean(row.ignore),
    tags: Array.isArray(row.tags) ? row.tags.filter(Boolean) : [],
    flagged: Boolean(row.flagged),
  };
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupeKey: row.dedupe_key,
    eventId: row.event_id,
    readId:
      row.read_id === null || row.read_id === undefined
        ? null
        : Number(row.read_id),
    cameraId:
      row.camera_id === null || row.camera_id === undefined
        ? null
        : Number(row.camera_id),
    cameraKey: row.camera_key,
    cameraName: row.camera_name,
    brokerId: Number(row.broker_id),
    topic: row.topic,
    payload: row.payload,
    qos: Number(row.qos),
    retain: Boolean(row.retain),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inserted:
      row.inserted === undefined || row.inserted === null
        ? undefined
        : Boolean(row.inserted),
    broker: row.broker_host || row.broker ? mapBroker(row) : null,
    attempts: Array.isArray(row.attempts) ? row.attempts : [],
  };
}

function cameraKeyCandidate(baseKey, sequence) {
  if (sequence === 1) return baseKey.slice(0, 64);
  const suffix = `-${sequence}`;
  return `${baseKey.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

export class MqttRepository {
  constructor({ pool, executor = null, now = () => new Date() } = {}) {
    this.pool = ensurePool(pool);
    this.executor = executor ?? this.pool;
    if (!this.executor || typeof this.executor.query !== "function") {
      throw new Error("MQTT repository executor must provide query()");
    }
    if (typeof now !== "function") throw new Error("MQTT repository clock must be a function");
    this.now = now;
  }

  async getSettings() {
    const result = await this.executor.query(
      `SELECT * FROM public.mqtt_settings WHERE id = 1`
    );
    if (!result.rows[0]) throw new Error("MQTT settings row is missing");
    return mapSettings(result.rows[0]);
  }

  async getKnownPlates() {
    const result = await this.executor.query(`
      SELECT
        kp.plate_number,
        kp.name,
        kp.notes,
        kp.ignore,
        COALESCE(
          array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL),
          ARRAY[]::varchar[]
        ) AS tags,
        COALESCE(p.flagged, FALSE) AS flagged
      FROM public.known_plates kp
      LEFT JOIN public.plate_tags pt ON pt.plate_number = kp.plate_number
      LEFT JOIN public.tags t ON t.id = pt.tag_id
      LEFT JOIN public.plates p ON p.plate_number = kp.plate_number
      GROUP BY kp.plate_number, kp.name, kp.notes, kp.ignore, p.flagged
      ORDER BY kp.plate_number
    `);
    return result.rows.map(mapKnownPlate);
  }

  async getEnabledRules() {
    const result = await this.executor.query(`
      SELECT
        r.*,
        COALESCE(
          array_agg(rc.camera_id ORDER BY rc.camera_id)
            FILTER (WHERE rc.camera_id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS camera_ids,
        b.name AS broker_name,
        b.broker AS broker_host,
        b.port AS broker_port,
        b.username AS broker_username,
        b.password AS broker_password,
        b.use_tls AS broker_use_tls,
        b.client_id AS broker_client_id,
        b.enabled AS broker_enabled
      FROM public.mqtt_rules r
      JOIN public.mqttbrokers b ON b.id = r.broker_id
      LEFT JOIN public.mqtt_rule_cameras rc ON rc.rule_id = r.id
      WHERE r.enabled = TRUE
        AND b.enabled = TRUE
      GROUP BY r.id, b.id
      ORDER BY r.id
    `);
    return result.rows.map(mapRule);
  }

  async loadRuntimeContext() {
    const [settings, knownPlates, rules] = await Promise.all([
      this.getSettings(),
      this.getKnownPlates(),
      this.getEnabledRules(),
    ]);
    return { settings, knownPlates, rules };
  }

  async discoverCamera({ cameraName, seenAt = this.now() } = {}) {
    const name = requireText(cameraName, "MQTT camera name", 255);
    const observedAt = normalizeDate(seenAt, "MQTT camera observation time");
    const baseKey = normalizeCameraKey(name) || "camera";

    const operation = async (client) => {
      const existing = await client.query(
        `SELECT * FROM public.mqtt_cameras WHERE LOWER(camera_name) = LOWER($1) LIMIT 1`,
        [name]
      );

      if (existing.rows[0]) {
        const updated = await client.query(
          `
            UPDATE public.mqtt_cameras
            SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2)
            WHERE id = $1
            RETURNING *
          `,
          [existing.rows[0].id, observedAt]
        );
        return mapCamera(updated.rows[0]);
      }

      for (let sequence = 1; sequence <= 100; sequence += 1) {
        const candidateKey = cameraKeyCandidate(baseKey, sequence);
        const inserted = await client.query(
          `
            INSERT INTO public.mqtt_cameras (
              camera_name,
              camera_key,
              enabled,
              first_seen_at,
              last_seen_at
            )
            VALUES ($1, $2, TRUE, $3, $3)
            ON CONFLICT DO NOTHING
            RETURNING *
          `,
          [name, candidateKey, observedAt]
        );

        if (inserted.rows[0]) return mapCamera(inserted.rows[0]);

        const racedName = await client.query(
          `SELECT * FROM public.mqtt_cameras WHERE LOWER(camera_name) = LOWER($1) LIMIT 1`,
          [name]
        );
        if (racedName.rows[0]) return mapCamera(racedName.rows[0]);
      }

      throw new Error("Unable to allocate a unique MQTT camera key");
    };

    if (this.executor !== this.pool) {
      return operation(this.executor);
    }

    return withTransaction(this.pool, operation);
  }

  async enqueueDelivery(envelope) {
    const delivery = normalizeDeliveryEnvelope(envelope);
    const result = await this.executor.query(
      `
        WITH inserted AS (
          INSERT INTO public.mqtt_deliveries (
            dedupe_key,
            event_id,
            read_id,
            camera_id,
            camera_key,
            camera_name,
            broker_id,
            topic,
            payload,
            qos,
            retain,
            max_attempts
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING *, TRUE AS inserted
        )
        SELECT * FROM inserted
        UNION ALL
        SELECT d.*, FALSE AS inserted
        FROM public.mqtt_deliveries d
        WHERE d.dedupe_key = $1
          AND NOT EXISTS (SELECT 1 FROM inserted)
        LIMIT 1
      `,
      [
        delivery.dedupeKey,
        delivery.eventId,
        delivery.readId,
        delivery.cameraId,
        delivery.cameraKey,
        delivery.cameraName,
        delivery.brokerId,
        delivery.topic,
        JSON.stringify(delivery.payload),
        delivery.qos,
        delivery.retain,
        delivery.maxAttempts,
      ]
    );
    return mapDelivery(result.rows[0]);
  }

  async claimDueDeliveries({ workerId, limit = 10, now = this.now() } = {}) {
    const worker = requireText(workerId, "MQTT worker ID", 255);
    const claimLimit = normalizeInteger(limit, {
      name: "MQTT claim limit",
      minimum: 1,
      maximum: 100,
    });
    const claimedAt = normalizeDate(now, "MQTT claim time");

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `
          WITH due AS (
            SELECT id
            FROM public.mqtt_deliveries
            WHERE status IN ('pending', 'retry')
              AND next_attempt_at <= $2
            ORDER BY next_attempt_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $3
          ),
          claimed AS (
            UPDATE public.mqtt_deliveries d
            SET
              status = 'processing',
              locked_at = $2,
              locked_by = $1
            FROM due
            WHERE d.id = due.id
            RETURNING d.*
          )
          SELECT
            claimed.*,
            b.name AS broker_name,
            b.broker AS broker_host,
            b.port AS broker_port,
            b.username AS broker_username,
            b.password AS broker_password,
            b.use_tls AS broker_use_tls,
            b.client_id AS broker_client_id,
            b.enabled AS broker_enabled
          FROM claimed
          JOIN public.mqttbrokers b ON b.id = claimed.broker_id
          ORDER BY claimed.next_attempt_at, claimed.id
        `,
        [worker, claimedAt, claimLimit]
      );
      return result.rows.map(mapDelivery);
    });
  }

  async releaseExpiredLeases({ leaseMs = 60_000, now = this.now() } = {}) {
    const lease = normalizeInteger(leaseMs, {
      name: "MQTT worker lease",
      minimum: 1,
      maximum: 86_400_000,
    });
    const currentTime = normalizeDate(now, "MQTT lease recovery time");
    const cutoff = new Date(currentTime.getTime() - lease);

    const result = await this.pool.query(
      `
        UPDATE public.mqtt_deliveries
        SET
          status = 'retry',
          next_attempt_at = $1,
          locked_at = NULL,
          locked_by = NULL,
          last_error = COALESCE(last_error, 'MQTT worker lease expired')
        WHERE status = 'processing'
          AND (locked_at IS NULL OR locked_at <= $2)
        RETURNING id
      `,
      [currentTime, cutoff]
    );
    return result.rows.map((row) => Number(row.id));
  }

  async recordDeliverySuccess({ deliveryId, workerId, now = this.now() } = {}) {
    const id = normalizeInteger(deliveryId, {
      name: "MQTT delivery ID",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const worker = requireText(workerId, "MQTT worker ID", 255);
    const completedAt = normalizeDate(now, "MQTT delivery completion time");

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `
          WITH locked AS (
            SELECT *
            FROM public.mqtt_deliveries
            WHERE id = $1
              AND status = 'processing'
              AND locked_by = $2
            FOR UPDATE
          ),
          updated AS (
            UPDATE public.mqtt_deliveries d
            SET
              status = 'succeeded',
              attempt_count = d.attempt_count + 1,
              locked_at = NULL,
              locked_by = NULL,
              last_error = NULL,
              published_at = $3
            FROM locked
            WHERE d.id = locked.id
            RETURNING
              d.*,
              locked.locked_at AS attempt_started_at
          ),
          recorded AS (
            INSERT INTO public.mqtt_delivery_attempts (
              delivery_id,
              attempt_number,
              outcome,
              worker_id,
              started_at,
              completed_at
            )
            SELECT
              id,
              attempt_count,
              'succeeded',
              $2,
              COALESCE(attempt_started_at, $3),
              $3
            FROM updated
            RETURNING delivery_id
          )
          SELECT updated.*
          FROM updated
          JOIN recorded ON recorded.delivery_id = updated.id
        `,
        [id, worker, completedAt]
      );

      if (!result.rows[0]) {
        throw new Error("MQTT delivery success could not be recorded because its worker lease was lost");
      }
      return mapDelivery(result.rows[0]);
    });
  }

  async recordDeliveryFailure({
    deliveryId,
    workerId,
    error,
    now = this.now(),
    baseDelayMs = 1000,
    maximumDelayMs = 300_000,
  } = {}) {
    const id = normalizeInteger(deliveryId, {
      name: "MQTT delivery ID",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const worker = requireText(workerId, "MQTT worker ID", 255);
    const completedAt = normalizeDate(now, "MQTT delivery failure time");

    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `
          SELECT *
          FROM public.mqtt_deliveries
          WHERE id = $1
            AND status = 'processing'
            AND locked_by = $2
          FOR UPDATE
        `,
        [id, worker]
      );
      const delivery = locked.rows[0];
      if (!delivery) {
        throw new Error("MQTT delivery failure could not be recorded because its worker lease was lost");
      }

      const startedAt = delivery.locked_at
        ? normalizeDate(
            delivery.locked_at,
            "MQTT delivery attempt start time"
          )
        : completedAt;

      const plan = planDeliveryFailure({
        attemptCount: Number(delivery.attempt_count),
        maxAttempts: Number(delivery.max_attempts),
        error,
        now: completedAt,
        baseDelayMs,
        maximumDelayMs,
      });

      const updated = await client.query(
        `
          UPDATE public.mqtt_deliveries
          SET
            status = $3,
            attempt_count = $4,
            next_attempt_at = COALESCE($5, next_attempt_at),
            locked_at = NULL,
            locked_by = NULL,
            last_error = $6
          WHERE id = $1
            AND status = 'processing'
            AND locked_by = $2
          RETURNING *
        `,
        [
          id,
          worker,
          plan.status,
          plan.attemptCount,
          plan.nextAttemptAt,
          plan.lastError,
        ]
      );

      await client.query(
        `
          INSERT INTO public.mqtt_delivery_attempts (
            delivery_id,
            attempt_number,
            outcome,
            worker_id,
            error_code,
            error_message,
            started_at,
            completed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          id,
          plan.attemptNumber,
          plan.status,
          worker,
          plan.errorCode || null,
          plan.lastError,
          startedAt,
          completedAt,
        ]
      );

      return mapDelivery(updated.rows[0]);
    });
  }

  async listActivity({ limit = 50, status = null } = {}) {
    const activityLimit = normalizeInteger(limit, {
      name: "MQTT activity limit",
      minimum: 1,
      maximum: 500,
    });
    const normalizedStatus = status === null ? null : String(status).trim();
    if (normalizedStatus !== null && !ACTIVITY_STATUSES.has(normalizedStatus)) {
      throw new Error(`Invalid MQTT activity status: ${normalizedStatus}`);
    }

    const result = await this.pool.query(
      `
        SELECT
          d.*,
          b.name AS broker_name,
          b.broker AS broker_host,
          b.port AS broker_port,
          b.use_tls AS broker_use_tls,
          b.enabled AS broker_enabled,
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
    return result.rows.map(mapDelivery);
  }
}

export const mqttRepositoryInternals = Object.freeze({
  mapSettings,
  mapCamera,
  mapRule,
  mapKnownPlate,
  mapDelivery,
  cameraKeyCandidate,
});
