import { createHash } from "node:crypto";

const FINALIZATION_STATE_QUERY = `
  SELECT
    m.id AS migration_id,
    m.source_id,
    m.target_rule_id,
    source.enabled AS source_enabled,
    target.name AS target_name,
    target.enabled AS target_enabled,
    delivery_state.action_count,
    delivery_state.all_delivery_enabled,
    delivery_state.all_mqtt,
    transition.direction AS latest_direction,
    transition.occurred_at AS cutover_at,
    successful_delivery.id AS successful_delivery_id,
    successful_delivery.published_at AS successful_delivery_at,
    jsonb_build_object(
      'schemaVersion', 1,
      'sourceType', 'mqtt',
      'sourceId', source.id,
      'name', source.name,
      'enabled', source.enabled,
      'matchType', source.match_type,
      'matchValue', source.match_value,
      'plateMatchMode', source.plate_match_mode,
      'fuzzyEnabled', source.fuzzy_enabled,
      'fuzzyMaxDistance', source.fuzzy_max_distance,
      'fuzzyMinLength', source.fuzzy_min_length,
      'fuzzyRequireUnique', source.fuzzy_require_unique,
      'fuzzyOcrAware', source.fuzzy_ocr_aware,
      'broker', jsonb_build_object('id', broker.id, 'name', broker.name),
      'destinationMode', source.destination_mode,
      'fixedTopic', source.fixed_topic,
      'message', source.message,
      'cameras', COALESCE(cameras.items, '[]'::jsonb),
      'createdAt', source.created_at,
      'updatedAt', source.updated_at
    ) AS legacy_snapshot
  FROM public.notification_rule_migrations m
  JOIN public.mqtt_rules source ON source.id = m.source_id
  JOIN public.mqttbrokers broker ON broker.id = source.broker_id
  JOIN public.notification_rules target ON target.id = m.target_rule_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(a.id)::integer AS action_count,
      COALESCE(BOOL_AND(a.enabled = TRUE AND ch.enabled = TRUE), FALSE) AS all_delivery_enabled,
      COALESCE(BOOL_AND(ch.channel_type = 'mqtt'), FALSE) AS all_mqtt
    FROM public.notification_actions a
    JOIN public.notification_channels ch ON ch.id = a.channel_id
    WHERE a.rule_id = target.id
  ) delivery_state ON TRUE
  LEFT JOIN LATERAL (
    SELECT e.direction, e.occurred_at
    FROM public.notification_rule_cutover_events e
    WHERE e.migration_id = m.id
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT 1
  ) transition ON TRUE
  LEFT JOIN LATERAL (
    SELECT d.id, d.published_at
    FROM public.mqtt_deliveries d
    WHERE d.status = 'succeeded'
      AND d.published_at IS NOT NULL
      AND d.payload->>'notification_runtime' = 'unified-v1'
      AND target.id::text = ANY(
        string_to_array(COALESCE(d.payload->>'notification_rule_ids', ''), ',')
      )
      AND (transition.occurred_at IS NULL OR d.published_at >= transition.occurred_at)
    ORDER BY d.published_at DESC, d.id DESC
    LIMIT 1
  ) successful_delivery ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', camera.id,
        'cameraName', camera.camera_name,
        'cameraKey', camera.camera_key
      ) ORDER BY camera.id
    ) AS items
    FROM public.mqtt_rule_cameras link
    JOIN public.mqtt_cameras camera ON camera.id = link.camera_id
    WHERE link.rule_id = source.id
  ) cameras ON TRUE
  WHERE m.source_type = 'mqtt'
    AND m.retired_at IS NULL
    AND m.finalized_at IS NULL
  ORDER BY m.source_id
`;

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("MQTT migration finalization requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function blockersFor(row) {
  const blockers = [];
  if (row.source_enabled !== false) blockers.push("The legacy MQTT source must be disabled");
  if (row.target_enabled !== true) blockers.push("The unified replacement must be active");
  if (Number(row.action_count) < 1 || row.all_delivery_enabled !== true || row.all_mqtt !== true) {
    blockers.push("Every unified delivery action and MQTT channel must be active");
  }
  if (row.latest_direction !== "cutover") blockers.push("The latest recorded transition must be a completed cutover");
  if (!row.successful_delivery_id) blockers.push("A successful unified MQTT delivery after cutover is required");
  return blockers;
}

function mapRow(row) {
  return {
    migrationId: Number(row.migration_id),
    sourceId: Number(row.source_id),
    targetRuleId: Number(row.target_rule_id),
    targetName: row.target_name,
    successfulDeliveryId: row.successful_delivery_id == null ? null : Number(row.successful_delivery_id),
    successfulDeliveryAt: row.successful_delivery_at || null,
    legacySnapshot: row.legacy_snapshot || {},
    blockers: blockersFor(row),
  };
}

async function loadRows(executor) {
  const result = await executor.query(FINALIZATION_STATE_QUERY);
  return result.rows.map(mapRow);
}

function snapshotDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot || {})).digest("hex");
}

export class NotificationMqttFinalizationRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async preview() {
    const [rules, finalized] = await Promise.all([
      loadRows(this.pool),
      this.pool.query(`
        SELECT COUNT(*)::integer AS count
        FROM public.notification_rule_migrations
        WHERE source_type = 'mqtt' AND finalized_at IS NOT NULL
      `),
    ]);
    const blockers = rules.flatMap((rule) => rule.blockers.map((message) => ({ sourceId: rule.sourceId, message })));
    return {
      rules: rules.map(({ legacySnapshot, ...rule }) => rule),
      readyCount: rules.filter((rule) => rule.blockers.length === 0).length,
      blockerCount: blockers.length,
      blockers,
      finalizedCount: Number(finalized.rows[0]?.count || 0),
      canFinalize: rules.length > 0 && blockers.length === 0,
    };
  }

  async finalize({ actor = null } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("MQTT migration finalization requires a transactional pool");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_finalize_legacy_mqtt_rules'))");
      const rules = await loadRows(client);
      if (rules.length === 0) throw new Error("No cutover MQTT rules are available to finalize");
      const blocked = rules.filter((rule) => rule.blockers.length > 0);
      if (blocked.length > 0) {
        throw new Error("Every MQTT replacement must be active with a verified post-cutover delivery before finalization");
      }

      for (const rule of rules) {
        const deleted = await client.query(
          "DELETE FROM public.mqtt_rules WHERE id = $1::integer AND enabled = FALSE RETURNING id",
          [rule.sourceId]
        );
        if (deleted.rows.length !== 1) throw new Error("A legacy MQTT source changed during finalization");
        const digest = snapshotDigest(rule.legacySnapshot);
        await client.query(
          `UPDATE public.notification_rule_migrations
           SET legacy_snapshot = $2::jsonb,
               finalized_at = CURRENT_TIMESTAMP,
               finalized_by_user_id = $3::bigint,
               finalization_reason = 'verified_unified_delivery'
           WHERE id = $1::bigint AND finalized_at IS NULL`,
          [rule.migrationId, JSON.stringify(rule.legacySnapshot), actorId(actor)]
        );
        await client.query(
          `INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata)
           VALUES ($1::bigint, 'browser', 'notification.mqtt_migration_finalized',
                   'notification_rule', $2, 'succeeded', $3::jsonb)`,
          [
            actorId(actor),
            String(rule.targetRuleId),
            JSON.stringify({
              migrationId: rule.migrationId,
              legacySourceId: rule.sourceId,
              targetRuleId: rule.targetRuleId,
              successfulDeliveryId: rule.successfulDeliveryId,
              successfulDeliveryAt: rule.successfulDeliveryAt,
              legacySnapshotSha256: digest,
            }),
          ]
        );
      }
      await client.query("COMMIT");
      return { finalizedCount: rules.length, targetRuleIds: rules.map((rule) => rule.targetRuleId) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const notificationMqttFinalizationInternals = Object.freeze({
  FINALIZATION_STATE_QUERY,
  blockersFor,
  mapRow,
  snapshotDigest,
});
