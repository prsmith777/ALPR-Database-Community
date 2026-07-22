import { buildNotificationMigrationPreview } from "./notification-migration-preview.mjs";

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationMigrationRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

export class NotificationMigrationRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async preview({ pushover = {} } = {}) {
    const [pushoverResult, mqttResult] = await Promise.all([
      this.pool.query(`
        SELECT id, plate_number, enabled, priority
        FROM public.plate_notifications
        ORDER BY plate_number, id
      `),
      this.pool.query(`
        SELECT
          r.id,
          r.name,
          r.enabled,
          r.match_type,
          r.match_value,
          r.plate_match_mode,
          r.broker_id,
          r.destination_mode,
          r.fixed_topic,
          r.message,
          b.name AS broker_name,
          b.enabled AS broker_enabled,
          COALESCE(
            array_agg(c.camera_name ORDER BY c.camera_name)
              FILTER (WHERE c.camera_name IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS camera_names
        FROM public.mqtt_rules r
        JOIN public.mqttbrokers b ON b.id = r.broker_id
        LEFT JOIN public.mqtt_rule_cameras rc ON rc.rule_id = r.id
        LEFT JOIN public.mqtt_cameras c ON c.id = rc.camera_id
        GROUP BY r.id, b.id
        ORDER BY r.name, r.id
      `),
    ]);

    return buildNotificationMigrationPreview({
      pushoverRules: pushoverResult.rows,
      mqttRules: mqttResult.rows,
      pushover,
    });
  }
}

export const notificationMigrationRepositoryInternals = Object.freeze({ ensurePool });
