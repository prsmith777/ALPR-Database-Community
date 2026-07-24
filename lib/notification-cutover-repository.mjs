import { NotificationShadowReviewRepository } from "./notification-shadow-review-repository.mjs";

const CUTOVER_STATE_QUERY = `
  SELECT m.id AS migration_id, m.source_type, m.source_id, m.target_rule_id,
         r.name AS target_name, r.enabled AS target_enabled, r.version AS target_version,
         r.cooldown_seconds AS target_cooldown_seconds,
         CASE m.source_type
           WHEN 'mqtt' THEN (SELECT enabled FROM public.mqtt_rules WHERE id = m.source_id)
           WHEN 'pushover' THEN (SELECT enabled FROM public.plate_notifications WHERE id = m.source_id)
           ELSE NULL
         END AS source_enabled,
         CASE m.source_type
           WHEN 'mqtt' THEN (
             SELECT jsonb_build_object(
               'brokerId', broker_id,
               'destinationMode', destination_mode,
               'fixedTopic', fixed_topic,
               'message', message
             )
             FROM public.mqtt_rules
             WHERE id = m.source_id
           )
           ELSE NULL
         END AS source_configuration,
         COUNT(a.id)::integer AS action_count,
         COALESCE(BOOL_AND(a.enabled = FALSE AND ch.enabled = FALSE), FALSE) AS all_delivery_disabled,
         COALESCE(BOOL_AND(a.enabled = TRUE AND ch.enabled = TRUE), FALSE) AS all_delivery_enabled,
         COALESCE(BOOL_AND(ch.channel_type = 'mqtt'), FALSE) AS runtime_supported,
         COALESCE(
           JSONB_AGG(
             jsonb_build_object(
               'channelType', ch.channel_type,
               'credentialReference', ch.credential_reference,
               'configuration', COALESCE(ch.configuration, '{}'::jsonb) || COALESCE(a.configuration, '{}'::jsonb)
             ) ORDER BY a.position, a.id
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'::jsonb
         ) AS delivery_configurations,
         (SELECT e.direction
          FROM public.notification_rule_cutover_events e
          WHERE e.migration_id = m.id
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1) AS latest_direction
  FROM public.notification_rule_migrations m
  JOIN public.notification_rules r ON r.id = m.target_rule_id
  LEFT JOIN public.notification_actions a ON a.rule_id = r.id
  LEFT JOIN public.notification_channels ch ON ch.id = a.channel_id
  WHERE m.retired_at IS NULL
  GROUP BY m.id, r.id
  ORDER BY m.source_type, m.source_id
`;

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationCutoverRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stateName(row) {
  if (
    row.source_enabled == null &&
    row.target_enabled === false &&
    row.all_delivery_disabled === true &&
    Number(row.action_count) > 0
  ) {
    return "source_removed";
  }
  if (
    row.source_enabled === true &&
    row.target_enabled === false &&
    row.all_delivery_disabled === true &&
    Number(row.action_count) > 0
  ) {
    return "legacy_active";
  }
  if (
    row.source_enabled === false &&
    row.target_enabled === true &&
    row.all_delivery_enabled === true &&
    Number(row.action_count) > 0
  ) {
    return "unified_active";
  }
  return "inconsistent";
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function mqttConfigurationMatches(sourceConfiguration, deliveries) {
  if (!sourceConfiguration || !Array.isArray(deliveries) || deliveries.length !== 1) return false;
  const delivery = deliveries[0] || {};
  const configuration = delivery.configuration || {};
  const sourceBrokerId = Number(sourceConfiguration.brokerId ?? sourceConfiguration.broker_id);
  const deliveryBrokerId = Number(configuration.brokerId ?? configuration.broker_id);
  const sourceDestinationMode = text(
    sourceConfiguration.destinationMode ?? sourceConfiguration.destination_mode
  ) || "per_camera";
  const deliveryDestinationMode = text(
    configuration.destinationMode ?? configuration.destination_mode
  ) || "per_camera";
  return (
    delivery.channelType === "mqtt" &&
    Number.isInteger(sourceBrokerId) &&
    sourceBrokerId === deliveryBrokerId &&
    delivery.credentialReference === `mqtt-broker:${sourceBrokerId}` &&
    sourceDestinationMode === deliveryDestinationMode &&
    text(sourceConfiguration.fixedTopic ?? sourceConfiguration.fixed_topic) ===
      text(configuration.fixedTopic ?? configuration.fixed_topic) &&
    text(sourceConfiguration.message) === text(configuration.message)
  );
}

function mapState(row, shadowRule = null) {
  const state = stateName(row);
  const runtimeSupported =
    Boolean(row.runtime_supported) &&
    row.source_type === "mqtt" &&
    Number(row.target_cooldown_seconds || 0) === 0;
  const configurationMatches =
    row.source_type === "mqtt" &&
    mqttConfigurationMatches(row.source_configuration, row.delivery_configurations);
  const approved =
    ["approved", "approved_intentional"].includes(shadowRule?.status) &&
    shadowRule?.latestReview?.current === true;
  const blockers = [];
  if (!runtimeSupported) blockers.push("A live unified delivery adapter is not available for this channel.");
  if (runtimeSupported && state !== "source_removed" && !configurationMatches) {
    blockers.push("The unified MQTT destination no longer matches the legacy source rule.");
  }
  if (state === "inconsistent") blockers.push("Legacy and unified enabled states are inconsistent; repair them before cutover.");
  if (state === "source_removed") {
    blockers.push(
      row.latest_direction
        ? "The legacy source was removed, but this migration has cutover history and must remain preserved."
        : "The legacy source was removed. This disabled migration copy can be retired without deleting its rule or audit evidence."
    );
  }
  if (state === "legacy_active" && !approved) blockers.push("Current positive shadow evidence requires administrator approval.");
  return {
    migrationId: Number(row.migration_id),
    sourceType: row.source_type,
    sourceId: Number(row.source_id),
    targetRuleId: Number(row.target_rule_id),
    targetName: row.target_name,
    targetVersion: Number(row.target_version),
    state,
    sourceEnabled: Boolean(row.source_enabled),
    targetEnabled: Boolean(row.target_enabled),
    allDeliveryDisabled: Boolean(row.all_delivery_disabled),
    allDeliveryEnabled: Boolean(row.all_delivery_enabled),
    runtimeSupported,
    configurationMatches,
    latestDirection: row.latest_direction || null,
    approved,
    approvalMode: approved ? shadowRule.latestReview.approvalMode || "parity" : null,
    positiveMatchCount: Number(shadowRule?.positiveMatchCount || 0),
    unifiedPositiveMatchCount: Number(shadowRule?.unifiedPositiveMatchCount || 0),
    mismatchCount: Number(shadowRule?.mismatchCount || 0),
    expansionCount: Number(shadowRule?.expansionCount || 0),
    regressionCount: Number(shadowRule?.regressionCount || 0),
    canCutover: state === "legacy_active" && runtimeSupported && configurationMatches && approved,
    canRollback: state === "unified_active" && runtimeSupported,
    canRetire: state === "source_removed" && !row.latest_direction,
    blockers,
  };
}

async function lockOrphanedMigration(client, ruleId) {
  const mappingResult = await client.query(
    `
      SELECT m.id AS migration_id, m.source_type, m.source_id, m.target_rule_id,
             r.name, r.enabled, r.version,
             CASE m.source_type
               WHEN 'mqtt' THEN EXISTS (
                 SELECT 1 FROM public.mqtt_rules WHERE id = m.source_id
               )
               WHEN 'pushover' THEN EXISTS (
                 SELECT 1 FROM public.plate_notifications WHERE id = m.source_id
               )
               ELSE TRUE
             END AS source_exists,
             (SELECT COUNT(*)::integer
              FROM public.notification_rule_cutover_events e
              WHERE e.migration_id = m.id) AS transition_count
      FROM public.notification_rule_migrations m
      JOIN public.notification_rules r ON r.id = m.target_rule_id
      WHERE r.id = $1::bigint AND m.retired_at IS NULL
      FOR UPDATE OF m, r
    `,
    [ruleId]
  );
  const mapping = mappingResult.rows[0];
  if (!mapping) throw new Error("The migrated unified rule was not found");

  const deliveries = await client.query(
    `
      SELECT a.id AS action_id, a.enabled AS action_enabled,
             ch.id AS channel_id, ch.enabled AS channel_enabled
      FROM public.notification_actions a
      JOIN public.notification_channels ch ON ch.id = a.channel_id
      WHERE a.rule_id = $1::bigint
      ORDER BY a.position, a.id
      FOR UPDATE OF a, ch
    `,
    [ruleId]
  );
  return { mapping, deliveries: deliveries.rows };
}

async function lockCutover(client, ruleId) {
  const mappingResult = await client.query(
    `
      SELECT m.id AS migration_id, m.source_type, m.source_id, m.target_rule_id,
             r.name, r.enabled, r.version, r.cooldown_seconds
      FROM public.notification_rule_migrations m
      JOIN public.notification_rules r ON r.id = m.target_rule_id
      WHERE r.id = $1::bigint AND m.retired_at IS NULL
      FOR UPDATE OF r
    `,
    [ruleId]
  );
  const mapping = mappingResult.rows[0];
  if (!mapping) throw new Error("The migrated unified rule was not found");

  const sourceTable = mapping.source_type === "mqtt" ? "mqtt_rules" : "plate_notifications";
  const sourceFields = mapping.source_type === "mqtt"
    ? "id, enabled, broker_id, destination_mode, fixed_topic, message"
    : "id, enabled, priority";
  const sourceResult = await client.query(
    `SELECT ${sourceFields} FROM public.${sourceTable} WHERE id = $1::bigint FOR UPDATE`,
    [mapping.source_id]
  );
  if (!sourceResult.rows[0]) throw new Error("The legacy source rule was not found");

  const deliveries = await client.query(
    `
      SELECT a.id AS action_id, a.enabled AS action_enabled,
             ch.id AS channel_id, ch.enabled AS channel_enabled, ch.channel_type,
             ch.credential_reference,
             COALESCE(ch.configuration, '{}'::jsonb) || COALESCE(a.configuration, '{}'::jsonb) AS configuration
      FROM public.notification_actions a
      JOIN public.notification_channels ch ON ch.id = a.channel_id
      WHERE a.rule_id = $1::bigint
      ORDER BY a.position, a.id
      FOR UPDATE OF a, ch
    `,
    [ruleId]
  );
  if (deliveries.rows.length === 0) throw new Error("The unified rule has no delivery actions");
  return { mapping, source: sourceResult.rows[0], deliveries: deliveries.rows };
}

function allMqtt(deliveries) {
  return deliveries.length > 0 && deliveries.every((row) => row.channel_type === "mqtt");
}

function lockedMqttConfigurationMatches(locked) {
  return mqttConfigurationMatches(
    {
      brokerId: locked.source.broker_id,
      destinationMode: locked.source.destination_mode,
      fixedTopic: locked.source.fixed_topic,
      message: locked.source.message,
    },
    locked.deliveries.map((row) => ({
      channelType: row.channel_type,
      credentialReference: row.credential_reference,
      configuration: row.configuration,
    }))
  );
}

async function recordEvent(client, { locked, direction, actor, metadata }) {
  await client.query(
    `
      INSERT INTO public.notification_rule_cutover_events
        (migration_id, direction, rule_version, actor_user_id, metadata)
      VALUES ($1::bigint, $2, $3, $4::bigint, $5::jsonb)
    `,
    [
      locked.mapping.migration_id,
      direction,
      locked.mapping.version,
      actorId(actor),
      JSON.stringify(metadata),
    ]
  );
  await client.query(
    `
      INSERT INTO public.audit_events
        (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata)
      VALUES ($1::bigint, 'browser', $2, 'notification_rule', $3, 'succeeded', $4::jsonb)
    `,
    [
      actorId(actor),
      direction === "cutover" ? "notification.rule_cutover" : "notification.rule_rollback",
      String(locked.mapping.target_rule_id),
      JSON.stringify(metadata),
    ]
  );
}

export class NotificationCutoverRepository {
  constructor({
    pool,
    sampleLimit = 50,
    shadowRepositoryFactory = (executor) =>
      new NotificationShadowReviewRepository({ pool: executor, sampleLimit }),
  } = {}) {
    this.pool = ensurePool(pool);
    this.sampleLimit = sampleLimit;
    this.shadowRepositoryFactory = shadowRepositoryFactory;
  }

  async preview({ matchingSettings = {} } = {}) {
    const [statesResult, shadow] = await Promise.all([
      this.pool.query(CUTOVER_STATE_QUERY),
      this.shadowRepositoryFactory(this.pool).review({ matchingSettings }),
    ]);
    const shadows = new Map(shadow.rules.map((rule) => [String(rule.targetRule.id), rule]));
    const rules = statesResult.rows.map((row) => mapState(row, shadows.get(String(row.target_rule_id))));
    return {
      mode: "guarded_per_rule",
      rules,
      eligibleCount: rules.filter((rule) => rule.canCutover).length,
      activeCount: rules.filter((rule) => rule.state === "unified_active").length,
      rollbackCount: rules.filter((rule) => rule.canRollback).length,
      orphanedCount: rules.filter((rule) => rule.canRetire).length,
    };
  }

  async retireOrphaned({ ruleId, actor = null } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("Notification migration retirement requires a transactional pool");
    }
    const parsedRuleId = Number(ruleId);
    if (!Number.isInteger(parsedRuleId) || parsedRuleId <= 0) {
      throw new Error("Select a valid orphaned unified rule to retire");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)",
        [parsedRuleId]
      );
      const locked = await lockOrphanedMigration(client, parsedRuleId);
      const safelyDisabled =
        locked.mapping.enabled === false &&
        locked.deliveries.length > 0 &&
        locked.deliveries.every(
          (row) => row.action_enabled === false && row.channel_enabled === false
        );
      if (locked.mapping.source_exists !== false) {
        throw new Error("Retirement requires a removed legacy source rule");
      }
      if (!safelyDisabled) {
        throw new Error("Retirement requires the unified rule, channel, and actions to remain disabled");
      }
      if (Number(locked.mapping.transition_count) > 0) {
        throw new Error("A migration with cutover history cannot be retired");
      }

      await client.query(
        `
          UPDATE public.notification_rule_migrations
          SET retired_at = CURRENT_TIMESTAMP,
              retired_by_user_id = $2::bigint,
              retirement_reason = 'legacy_source_removed'
          WHERE id = $1::bigint
        `,
        [locked.mapping.migration_id, actorId(actor)]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1::bigint, 'browser', 'notification.migration_retired',
                  'notification_rule', $2, 'succeeded', $3::jsonb)
        `,
        [
          actorId(actor),
          String(parsedRuleId),
          JSON.stringify({
            migrationId: Number(locked.mapping.migration_id),
            sourceType: locked.mapping.source_type,
            sourceId: Number(locked.mapping.source_id),
            targetRuleId: parsedRuleId,
            reason: "legacy_source_removed",
            targetRuleDeleted: false,
            evidenceDeleted: false,
            deliveryChanged: false,
          }),
        ]
      );
      await client.query("COMMIT");
      return {
        ruleId: parsedRuleId,
        state: "retired",
        targetRuleDeleted: false,
        evidenceDeleted: false,
        deliveryChanged: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cutover({ ruleId, actor = null, matchingSettings = {} } = {}) {
    if (typeof this.pool.connect !== "function") throw new Error("Notification cutover requires a transactional pool");
    const parsedRuleId = Number(ruleId);
    if (!Number.isInteger(parsedRuleId) || parsedRuleId <= 0) throw new Error("Select a valid unified rule to cut over");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)", [parsedRuleId]);
      const locked = await lockCutover(client, parsedRuleId);
      const targetDisabled = locked.mapping.enabled === false;
      const sourceEnabled = locked.source.enabled === true;
      const deliveryDisabled = locked.deliveries.every(
        (row) => row.action_enabled === false && row.channel_enabled === false
      );
      if (!targetDisabled || !sourceEnabled || !deliveryDisabled) {
        throw new Error("Cutover requires an active legacy rule and a fully disabled unified rule");
      }
      if (locked.mapping.source_type !== "mqtt" || !allMqtt(locked.deliveries)) {
        throw new Error("A live unified delivery adapter is not available for this channel");
      }
      if (Number(locked.mapping.cooldown_seconds || 0) !== 0) {
        throw new Error("A live unified delivery adapter is not available for this channel");
      }
      if (!lockedMqttConfigurationMatches(locked)) {
        throw new Error("Unified MQTT destination no longer matches the legacy source rule");
      }

      const shadow = await this.shadowRepositoryFactory(client).review({ matchingSettings });
      const reviewed = shadow.rules.find((rule) => Number(rule.targetRule.id) === parsedRuleId);
      if (
        !reviewed ||
        !["approved", "approved_intentional"].includes(reviewed.status) ||
        !reviewed.latestReview?.current
      ) {
        throw new Error("Cutover requires current administrator-approved shadow evidence");
      }
      const approvalMode = reviewed.latestReview.approvalMode || "parity";
      if (approvalMode === "parity") {
        if (reviewed.mismatchCount !== 0 || reviewed.positiveMatchCount <= 0) {
          throw new Error("Cutover requires zero mismatches and at least one positive match");
        }
      } else if (
        approvalMode !== "intentional_expansion" ||
        reviewed.regressionCount !== 0 ||
        reviewed.expansionCount <= 0 ||
        reviewed.unifiedPositiveMatchCount <= 0
      ) {
        throw new Error("Cutover requires an approved expansion with no lost legacy matches");
      }

      await client.query("UPDATE public.mqtt_rules SET enabled = FALSE WHERE id = $1::bigint", [locked.mapping.source_id]);
      await client.query(
        `UPDATE public.notification_channels ch SET enabled = TRUE, updated_by_user_id = COALESCE($2::bigint, updated_by_user_id)
         FROM public.notification_actions a WHERE a.channel_id = ch.id AND a.rule_id = $1::bigint`,
        [parsedRuleId, actorId(actor)]
      );
      await client.query("UPDATE public.notification_actions SET enabled = TRUE WHERE rule_id = $1::bigint", [parsedRuleId]);
      await client.query(
        `UPDATE public.notification_rules SET enabled = TRUE, updated_by_user_id = COALESCE($2::bigint, updated_by_user_id)
         WHERE id = $1::bigint`,
        [parsedRuleId, actorId(actor)]
      );
      await recordEvent(client, {
        locked,
        direction: "cutover",
        actor,
        metadata: {
          sourceType: locked.mapping.source_type,
          sourceId: Number(locked.mapping.source_id),
          targetRuleId: parsedRuleId,
          reportFingerprint: reviewed.reportFingerprint,
          approvalMode,
          positiveMatchCount: reviewed.positiveMatchCount,
          unifiedPositiveMatchCount: reviewed.unifiedPositiveMatchCount,
          mismatchCount: reviewed.mismatchCount,
          expansionCount: reviewed.expansionCount,
          regressionCount: reviewed.regressionCount,
          switchedAtomically: true,
        },
      });
      await client.query("COMMIT");
      return { ruleId: parsedRuleId, state: "unified_active", legacyEnabled: false, unifiedEnabled: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback({ ruleId, actor = null } = {}) {
    if (typeof this.pool.connect !== "function") throw new Error("Notification rollback requires a transactional pool");
    const parsedRuleId = Number(ruleId);
    if (!Number.isInteger(parsedRuleId) || parsedRuleId <= 0) throw new Error("Select a valid unified rule to roll back");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)", [parsedRuleId]);
      const locked = await lockCutover(client, parsedRuleId);
      const targetEnabled = locked.mapping.enabled === true;
      const sourceDisabled = locked.source.enabled === false;
      const deliveryEnabled = locked.deliveries.every(
        (row) => row.action_enabled === true && row.channel_enabled === true
      );
      if (!targetEnabled || !sourceDisabled || !deliveryEnabled) {
        throw new Error("Rollback requires an active unified rule and a disabled legacy rule");
      }
      if (locked.mapping.source_type !== "mqtt" || !allMqtt(locked.deliveries)) {
        throw new Error("A live unified delivery adapter is not available for this channel");
      }

      await client.query("UPDATE public.notification_rules SET enabled = FALSE WHERE id = $1::bigint", [parsedRuleId]);
      await client.query("UPDATE public.notification_actions SET enabled = FALSE WHERE rule_id = $1::bigint", [parsedRuleId]);
      await client.query(
        `UPDATE public.notification_channels ch SET enabled = FALSE
         FROM public.notification_actions a WHERE a.channel_id = ch.id AND a.rule_id = $1::bigint`,
        [parsedRuleId]
      );
      await client.query("UPDATE public.mqtt_rules SET enabled = TRUE WHERE id = $1::bigint", [locked.mapping.source_id]);
      await recordEvent(client, {
        locked,
        direction: "rollback",
        actor,
        metadata: {
          sourceType: locked.mapping.source_type,
          sourceId: Number(locked.mapping.source_id),
          targetRuleId: parsedRuleId,
          switchedAtomically: true,
        },
      });
      await client.query("COMMIT");
      return { ruleId: parsedRuleId, state: "legacy_active", legacyEnabled: true, unifiedEnabled: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const notificationCutoverRepositoryInternals = Object.freeze({
  CUTOVER_STATE_QUERY,
  actorId,
  allMqtt,
  lockOrphanedMigration,
  lockCutover,
  lockedMqttConfigurationMatches,
  mapState,
  mqttConfigurationMatches,
  stateName,
});
