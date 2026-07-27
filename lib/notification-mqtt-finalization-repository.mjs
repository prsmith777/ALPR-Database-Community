import { createHash } from "node:crypto";

const FINALIZATION_STATE_QUERY = `
  SELECT
    m.id AS migration_id,
    m.source_type,
    m.source_id,
    m.target_rule_id,
    CASE m.source_type
      WHEN 'mqtt' THEN mqtt_source.enabled
      WHEN 'pushover' THEN pushover_source.enabled
      ELSE NULL
    END AS source_enabled,
    target.name AS target_name,
    target.enabled AS target_enabled,
    delivery_state.action_count,
    delivery_state.all_delivery_enabled,
    delivery_state.all_expected_channel,
    transition.direction AS latest_direction,
    transition.occurred_at AS cutover_at,
    successful_delivery.id AS successful_delivery_id,
    successful_delivery.delivered_at AS successful_delivery_at,
    CASE m.source_type
      WHEN 'mqtt' THEN jsonb_build_object(
        'schemaVersion', 1,
        'sourceType', 'mqtt',
        'sourceId', mqtt_source.id,
        'name', mqtt_source.name,
        'enabled', mqtt_source.enabled,
        'matchType', mqtt_source.match_type,
        'matchValue', mqtt_source.match_value,
        'plateMatchMode', mqtt_source.plate_match_mode,
        'fuzzyEnabled', mqtt_source.fuzzy_enabled,
        'fuzzyMaxDistance', mqtt_source.fuzzy_max_distance,
        'fuzzyMinLength', mqtt_source.fuzzy_min_length,
        'fuzzyRequireUnique', mqtt_source.fuzzy_require_unique,
        'fuzzyOcrAware', mqtt_source.fuzzy_ocr_aware,
        'broker', jsonb_build_object('id', broker.id, 'name', broker.name),
        'destinationMode', mqtt_source.destination_mode,
        'fixedTopic', mqtt_source.fixed_topic,
        'message', mqtt_source.message,
        'cameras', COALESCE(cameras.items, '[]'::jsonb),
        'createdAt', mqtt_source.created_at,
        'updatedAt', mqtt_source.updated_at
      )
      WHEN 'pushover' THEN jsonb_build_object(
        'schemaVersion', 1,
        'sourceType', 'pushover',
        'sourceId', pushover_source.id,
        'plateNumber', pushover_source.plate_number,
        'enabled', pushover_source.enabled,
        'priority', pushover_source.priority,
        'createdAt', pushover_source.created_at,
        'updatedAt', pushover_source.updated_at
      )
      ELSE NULL
    END AS legacy_snapshot
  FROM public.notification_rule_migrations m
  LEFT JOIN public.mqtt_rules mqtt_source
    ON m.source_type = 'mqtt' AND mqtt_source.id = m.source_id
  LEFT JOIN public.mqttbrokers broker ON broker.id = mqtt_source.broker_id
  LEFT JOIN public.plate_notifications pushover_source
    ON m.source_type = 'pushover' AND pushover_source.id = m.source_id
  JOIN public.notification_rules target ON target.id = m.target_rule_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(a.id)::integer AS action_count,
      COALESCE(BOOL_AND(a.enabled = TRUE AND ch.enabled = TRUE), FALSE) AS all_delivery_enabled,
      COALESCE(BOOL_AND(ch.channel_type = m.source_type), FALSE) AS all_expected_channel
    FROM public.notification_actions a
    JOIN public.notification_channels ch ON ch.id = a.channel_id
    WHERE a.rule_id = target.id AND a.retired_at IS NULL
  ) delivery_state ON TRUE
  LEFT JOIN LATERAL (
    SELECT e.direction, e.occurred_at
    FROM public.notification_rule_cutover_events e
    WHERE e.migration_id = m.id
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT 1
  ) transition ON TRUE
  LEFT JOIN LATERAL (
    SELECT evidence.id, evidence.delivered_at
    FROM (
      SELECT d.id, d.published_at AS delivered_at
      FROM public.mqtt_deliveries d
      WHERE m.source_type = 'mqtt'
        AND d.status = 'succeeded'
        AND d.published_at IS NOT NULL
        AND d.payload->>'notification_runtime' = 'unified-v1'
        AND target.id::text = ANY(
          string_to_array(COALESCE(d.payload->>'notification_rule_ids', ''), ',')
        )
      UNION ALL
      SELECT d.id, d.delivered_at
      FROM public.notification_deliveries d
      JOIN public.notification_executions e ON e.id = d.execution_id
      JOIN public.notification_channels ch ON ch.id = d.channel_id
      WHERE m.source_type = 'pushover'
        AND d.status = 'succeeded'
        AND d.delivered_at IS NOT NULL
        AND e.rule_id = target.id
        AND ch.channel_type = 'pushover'
    ) evidence
    WHERE transition.occurred_at IS NULL OR evidence.delivered_at >= transition.occurred_at
    ORDER BY evidence.delivered_at DESC, evidence.id DESC
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
    WHERE link.rule_id = mqtt_source.id
  ) cameras ON TRUE
  WHERE m.source_type IN ('mqtt', 'pushover')
    AND m.retired_at IS NULL
    AND m.finalized_at IS NULL
  ORDER BY m.source_type, m.source_id
`;

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("Legacy notification finalization requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sourceLabel(sourceType) {
  return sourceType === "mqtt" ? "MQTT" : sourceType === "pushover" ? "Pushover" : "notification";
}

function blockersFor(row) {
  const label = sourceLabel(row.source_type);
  const blockers = [];
  if (row.source_enabled == null) blockers.push(`The legacy ${label} source no longer exists`);
  else if (row.source_enabled !== false) blockers.push(`The legacy ${label} source must be disabled`);
  if (row.target_enabled !== true) blockers.push("The unified replacement must be active");
  if (
    Number(row.action_count) < 1 ||
    row.all_delivery_enabled !== true ||
    row.all_expected_channel !== true
  ) {
    blockers.push(`Every unified delivery action and ${label} channel must be active`);
  }
  if (row.latest_direction !== "cutover") blockers.push("The latest recorded transition must be a completed cutover");
  if (!row.successful_delivery_id) blockers.push(`A successful unified ${label} delivery after cutover is required`);
  return blockers;
}

function mapRow(row) {
  return {
    migrationId: Number(row.migration_id),
    sourceType: row.source_type,
    sourceLabel: sourceLabel(row.source_type),
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

async function deleteLegacySource(client, rule) {
  if (rule.sourceType === "mqtt") {
    return client.query(
      "DELETE FROM public.mqtt_rules WHERE id = $1::integer AND enabled = FALSE RETURNING id",
      [rule.sourceId]
    );
  }
  if (rule.sourceType === "pushover") {
    return client.query(
      "DELETE FROM public.plate_notifications WHERE id = $1::integer AND enabled = FALSE RETURNING id",
      [rule.sourceId]
    );
  }
  throw new Error("Unsupported legacy notification source");
}

export class NotificationLegacyFinalizationRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async preview() {
    const [rules, finalized] = await Promise.all([
      loadRows(this.pool),
      this.pool.query(`
        SELECT source_type, COUNT(*)::integer AS count
        FROM public.notification_rule_migrations
        WHERE source_type IN ('mqtt', 'pushover') AND finalized_at IS NOT NULL
        GROUP BY source_type
      `),
    ]);
    const blockers = rules.flatMap((rule) => rule.blockers.map((message) => ({
      sourceType: rule.sourceType,
      sourceLabel: rule.sourceLabel,
      sourceId: rule.sourceId,
      message,
    })));
    const finalizedCounts = Object.fromEntries(
      finalized.rows.map((row) => [row.source_type, Number(row.count || 0)])
    );
    return {
      rules: rules.map(({ legacySnapshot, ...rule }) => rule),
      readyCount: rules.filter((rule) => rule.blockers.length === 0).length,
      blockerCount: blockers.length,
      blockers,
      finalizedCounts,
      finalizedCount: Object.values(finalizedCounts).reduce((sum, count) => sum + count, 0),
      canFinalize: rules.length > 0 && blockers.length === 0,
    };
  }

  async finalize({ actor = null } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("Legacy notification finalization requires a transactional pool");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_finalize_legacy_notification_rules'))");
      const rules = await loadRows(client);
      if (rules.length === 0) throw new Error("No cutover legacy notification rules are available to finalize");
      const blocked = rules.filter((rule) => rule.blockers.length > 0);
      if (blocked.length > 0) {
        throw new Error("Every legacy replacement must be active with a verified post-cutover delivery before finalization");
      }

      for (const rule of rules) {
        const deleted = await deleteLegacySource(client, rule);
        if (deleted.rows.length !== 1) throw new Error("A legacy notification source changed during finalization");
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
           VALUES ($1::bigint, 'browser', 'notification.legacy_migration_finalized',
                   'notification_rule', $2, 'succeeded', $3::jsonb)`,
          [
            actorId(actor),
            String(rule.targetRuleId),
            JSON.stringify({
              migrationId: rule.migrationId,
              sourceType: rule.sourceType,
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
      return {
        finalizedCount: rules.length,
        sourceTypes: [...new Set(rules.map((rule) => rule.sourceType))],
        targetRuleIds: rules.map((rule) => rule.targetRuleId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const notificationLegacyFinalizationInternals = Object.freeze({
  FINALIZATION_STATE_QUERY,
  blockersFor,
  deleteLegacySource,
  mapRow,
  snapshotDigest,
  sourceLabel,
});
