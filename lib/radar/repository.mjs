function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("RadarRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function mapSettings(row) {
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    topicFilter: row.topic_filter,
    sourceKey: row.source_key,
    qos: Number(row.qos),
    correlationWindowMs: Number(row.correlation_window_ms),
    inboundAlprDirection: row.inbound_alpr_direction,
    outboundAlprDirection: row.outbound_alpr_direction,
    broker: {
      id: Number(row.broker_id),
      name: row.broker_name,
      host: row.broker_host,
      port: Number(row.broker_port),
      username: row.broker_username || "",
      password: row.broker_password || "",
      useTls: Boolean(row.broker_use_tls),
      clientId: row.broker_client_id || "",
      enabled: Boolean(row.broker_enabled),
    },
  };
}

export class RadarRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async getSettings() {
    const result = await this.pool.query(
      `SELECT settings.*, brokers.name AS broker_name,
              brokers.broker AS broker_host, brokers.port AS broker_port,
              brokers.username AS broker_username,
              brokers.password AS broker_password,
              brokers.use_tls AS broker_use_tls,
              brokers.client_id AS broker_client_id,
              brokers.enabled AS broker_enabled
       FROM public.radar_settings settings
       JOIN public.mqttbrokers brokers ON brokers.id = settings.broker_id
       WHERE settings.id = 1`,
    );
    return mapSettings(result.rows?.[0]);
  }

  async recordConnected() {
    await this.pool.query(
      `UPDATE public.radar_settings
       SET last_connected_at = CURRENT_TIMESTAMP, last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
    );
  }

  async recordError(message) {
    await this.pool.query(
      `UPDATE public.radar_settings
       SET last_error = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [String(message || "Radar MQTT error").slice(0, 1000)],
    );
  }

  async insertEvent(event) {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO public.radar_events (
           source_key, topic, event_timestamp, received_at, speed_mph,
           signed_speed, source_unit, direction, source, label,
           message_hash, raw_payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (message_hash) DO NOTHING
         RETURNING *
       ), touched AS (
         UPDATE public.radar_settings
         SET last_message_at = CURRENT_TIMESTAMP, last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1 AND EXISTS (SELECT 1 FROM inserted)
       )
       SELECT * FROM inserted`,
      [
        event.sourceKey,
        event.topic,
        event.eventTimestamp,
        event.receivedAt,
        event.speedMph,
        event.signedSpeed,
        event.sourceUnit,
        event.direction,
        event.source,
        event.label,
        event.messageHash,
        JSON.stringify(event.payload),
      ],
    );
    return result.rows?.[0] || null;
  }

  async correlatePending({ limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await this.pool.query(
      `WITH settings AS MATERIALIZED (
         SELECT correlation_window_ms,
                LOWER(BTRIM(inbound_alpr_direction)) AS inbound_direction,
                LOWER(BTRIM(outbound_alpr_direction)) AS outbound_direction
         FROM public.radar_settings WHERE id = 1 AND enabled = TRUE
       ), pending AS MATERIALIZED (
         SELECT events.id, events.event_timestamp, events.direction,
                settings.correlation_window_ms,
                settings.inbound_direction, settings.outbound_direction
         FROM public.radar_events events CROSS JOIN settings
         WHERE events.matched_read_id IS NULL
           AND events.event_timestamp >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
         ORDER BY events.event_timestamp, events.id
         LIMIT $1
         FOR UPDATE OF events SKIP LOCKED
       ), candidates AS (
         SELECT pending.id AS event_id, reads.id AS read_id,
                ROUND(EXTRACT(EPOCH FROM (reads."timestamp" - pending.event_timestamp)) * 1000)::integer AS delta_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY reads.id
                  ORDER BY ABS(EXTRACT(EPOCH FROM (reads."timestamp" - pending.event_timestamp))), pending.id
                ) AS read_rank
         FROM pending
         CROSS JOIN LATERAL (
           SELECT plate_reads.id, plate_reads."timestamp"
           FROM public.plate_reads plate_reads
           LEFT JOIN public.vehicle_direction_observations direction
             ON direction.read_id = plate_reads.id
           WHERE NOT EXISTS (
             SELECT 1 FROM public.radar_events matched
             WHERE matched.matched_read_id = plate_reads.id
           )
             AND ABS(EXTRACT(EPOCH FROM (plate_reads."timestamp" - pending.event_timestamp)) * 1000)
                 <= pending.correlation_window_ms
             AND LOWER(BTRIM(COALESCE(direction.direction_label, plate_reads.bi_trigger_direction_label, ''))) =
                 CASE pending.direction
                   WHEN 'inbound' THEN pending.inbound_direction
                   WHEN 'outbound' THEN pending.outbound_direction
                 END
           ORDER BY ABS(EXTRACT(EPOCH FROM (plate_reads."timestamp" - pending.event_timestamp))),
                    plate_reads.id
           LIMIT 1
         ) reads
       ), selected AS (
         SELECT * FROM candidates WHERE read_rank = 1
       )
       UPDATE public.radar_events events
       SET matched_read_id = selected.read_id,
           match_delta_ms = selected.delta_ms,
           matched_at = CURRENT_TIMESTAMP
       FROM selected
       WHERE events.id = selected.event_id AND events.matched_read_id IS NULL
       RETURNING events.id, events.matched_read_id, events.match_delta_ms`,
      [boundedLimit],
    );
    return result.rows || [];
  }
}

export const radarRepositoryInternals = Object.freeze({ mapSettings });
