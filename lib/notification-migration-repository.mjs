import { buildNotificationMigrationPreview } from "./notification-migration-preview.mjs";

const LEGACY_PUSHOVER_QUERY = `
  SELECT id, plate_number, enabled, priority
  FROM public.plate_notifications
  ORDER BY plate_number, id
`;

const LEGACY_MQTT_QUERY = `
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
`;

const MIGRATION_MAPPING_QUERY = `
  SELECT source_type, source_id, target_rule_id, m.created_at,
         (
           r.enabled = FALSE
           AND NOT EXISTS (
             SELECT 1
             FROM public.notification_actions a
             JOIN public.notification_channels ch ON ch.id = a.channel_id
             WHERE a.rule_id = m.target_rule_id
               AND (a.enabled = TRUE OR ch.enabled = TRUE)
           )
         ) AS target_all_disabled,
         EXISTS (
           SELECT 1
           FROM public.notification_condition_groups g
           JOIN public.notification_conditions c ON c.group_id = g.id
           WHERE g.rule_id = m.target_rule_id
             AND c.condition_type = 'known_plate'
             AND c.operator = 'is_true'
         ) AS target_has_known_plate_guard
  FROM public.notification_rule_migrations m
  JOIN public.notification_rules r ON r.id = m.target_rule_id
  ORDER BY source_type, source_id
`;

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationMigrationRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function channelName(ruleName, channelType, position) {
  return `${ruleName} / ${String(channelType || "channel").toUpperCase()} ${position + 1}`.slice(
    0,
    255
  );
}

async function loadMigrationInputs(executor) {
  const [pushoverResult, mqttResult, mappingResult] = await Promise.all([
    executor.query(LEGACY_PUSHOVER_QUERY),
    executor.query(LEGACY_MQTT_QUERY),
    executor.query(MIGRATION_MAPPING_QUERY),
  ]);
  return {
    pushoverRules: pushoverResult.rows,
    mqttRules: mqttResult.rows,
    migrationMappings: mappingResult.rows,
  };
}

async function insertConditionGroup(
  client,
  { ruleId, group, parentGroupId = null, position = 0 }
) {
  const groupResult = await client.query(
    `
      INSERT INTO public.notification_condition_groups
        (rule_id, parent_group_id, combinator, negated, position)
      VALUES ($1::bigint, $2::bigint, $3, $4, $5)
      RETURNING id
    `,
    [
      ruleId,
      parentGroupId,
      group?.combinator || "all",
      Boolean(group?.negated),
      position,
    ]
  );
  const groupId = groupResult.rows[0].id;
  const children = Array.isArray(group?.children) ? group.children : [];
  for (const [childPosition, child] of children.entries()) {
    if (child?.kind === "group") {
      await insertConditionGroup(client, {
        ruleId,
        group: child,
        parentGroupId: groupId,
        position: childPosition,
      });
      continue;
    }
    await client.query(
      `
        INSERT INTO public.notification_conditions
          (group_id, condition_type, operator, operand, position)
        VALUES ($1::bigint, $2, $3, $4::jsonb, $5)
      `,
      [
        groupId,
        child.conditionType,
        child.operator,
        JSON.stringify(child.value ?? {}),
        childPosition,
      ]
    );
  }
  return groupId;
}

async function insertDisabledRule(client, { migrationRule, appliedByUserId }) {
  const { source, proposed } = migrationRule;
  const ruleResult = await client.query(
    `
      INSERT INTO public.notification_rules
        (name, description, enabled, event_type, cooldown_seconds,
         created_by_user_id, updated_by_user_id)
      VALUES ($1, $2, FALSE, $3, $4, $5::bigint, $5::bigint)
      RETURNING id
    `,
    [
      proposed.name,
      `${proposed.description} Migrated from legacy ${source.type} rule #${source.id}; disabled pending review.`,
      proposed.eventType,
      proposed.cooldownSeconds,
      appliedByUserId,
    ]
  );
  const ruleId = ruleResult.rows[0].id;
  await insertConditionGroup(client, {
    ruleId,
    group: proposed.conditionTree,
  });

  for (const [position, action] of proposed.actions.entries()) {
    const channelResult = await client.query(
      `
        INSERT INTO public.notification_channels
          (name, channel_type, enabled, credential_reference, configuration,
           created_by_user_id, updated_by_user_id)
        VALUES ($1, $2, FALSE, $3, $4::jsonb, $5::bigint, $5::bigint)
        RETURNING id
      `,
      [
        channelName(proposed.name, action.channelType, position),
        action.channelType,
        action.credentialReference || null,
        JSON.stringify(action.configuration ?? {}),
        appliedByUserId,
      ]
    );
    await client.query(
      `
        INSERT INTO public.notification_actions
          (rule_id, channel_id, enabled, position, configuration)
        VALUES ($1::bigint, $2::bigint, FALSE, $3, $4::jsonb)
      `,
      [
        ruleId,
        channelResult.rows[0].id,
        position,
        JSON.stringify(action.configuration ?? {}),
      ]
    );
  }

  await client.query(
    `
      INSERT INTO public.notification_rule_migrations
        (source_type, source_id, target_rule_id, applied_by_user_id)
      VALUES ($1, $2::bigint, $3::bigint, $4::bigint)
    `,
    [source.type, source.id, ruleId, appliedByUserId]
  );
  return ruleId;
}

async function reconcileDisabledRule(client, { migrationRule, appliedByUserId }) {
  const ruleId = migrationRule.migration.targetRuleId;
  const safety = await client.query(
    `
      SELECT r.enabled,
             EXISTS (
               SELECT 1
               FROM public.notification_actions a
               JOIN public.notification_channels ch ON ch.id = a.channel_id
               WHERE a.rule_id = r.id
                 AND (a.enabled = TRUE OR ch.enabled = TRUE)
             ) AS has_enabled_delivery
      FROM public.notification_rules r
      WHERE r.id = $1::bigint
      FOR UPDATE
    `,
    [ruleId]
  );
  const target = safety.rows[0];
  if (!target || target.enabled || target.has_enabled_delivery) return false;

  await client.query(
    "DELETE FROM public.notification_condition_groups WHERE rule_id = $1::bigint",
    [ruleId]
  );
  await insertConditionGroup(client, {
    ruleId,
    group: migrationRule.proposed.conditionTree,
  });
  await client.query(
    `
      UPDATE public.notification_rules
      SET version = version + 1,
          updated_by_user_id = COALESCE($2::bigint, updated_by_user_id)
      WHERE id = $1::bigint
    `,
    [ruleId, appliedByUserId]
  );
  return true;
}

async function auditMigration(
  client,
  { appliedByUserId, created, reconciled, skipped, blocked }
) {
  await client.query(
    `
      INSERT INTO public.audit_events
        (actor_user_id, source, event_type, resource_type, resource_id,
         outcome, metadata)
      VALUES ($1::bigint, 'browser', 'notification.rules_migrated_disabled',
              'notification_migration', 'legacy-rules', 'succeeded', $2::jsonb)
    `,
    [
      appliedByUserId,
      JSON.stringify({
        createdCount: created.length,
        reconciledCount: reconciled.length,
        skippedCount: skipped.length,
        blockedCount: blocked.length,
        created: created.map(({ sourceType, sourceId, targetRuleId }) => ({
          sourceType,
          sourceId,
          targetRuleId,
        })),
        reconciled: reconciled.map(({ sourceType, sourceId, targetRuleId }) => ({
          sourceType,
          sourceId,
          targetRuleId,
        })),
        allCreatedDisabled: true,
        legacyDeliveryChanged: false,
      }),
    ]
  );
}

export class NotificationMigrationRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async preview({ pushover = {} } = {}) {
    return buildNotificationMigrationPreview({
      ...(await loadMigrationInputs(this.pool)),
      pushover,
    });
  }

  async applyDisabledMigration({ pushover = {}, actor = null } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("Disabled notification migration requires a transactional pool");
    }
    const client = await this.pool.connect();
    const appliedByUserId = actorId(actor);
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_disabled_notification_rule_migration'))"
      );
      const preview = buildNotificationMigrationPreview({
        ...(await loadMigrationInputs(client)),
        pushover,
      });
      const created = [];
      const reconciled = [];
      const skipped = [];
      const blocked = [];

      for (const rule of preview.rules) {
        if (!rule.ready || rule.source.id <= 0) {
          blocked.push({
            sourceType: rule.source.type,
            sourceId: rule.source.id,
            name: rule.source.name,
            blockers:
              rule.source.id > 0
                ? rule.blockers
                : [...rule.blockers, "The source rule has no durable ID."],
          });
          continue;
        }
        if (rule.migration.status === "created_disabled") {
          if (rule.migration.needsReconciliation) {
            if (!rule.migration.reconciliationSafe) {
              blocked.push({
                sourceType: rule.source.type,
                sourceId: rule.source.id,
                targetRuleId: rule.migration.targetRuleId,
                name: rule.proposed.name,
                blockers: [
                  "The existing unified rule, channel, and actions must remain disabled before reconciliation.",
                ],
              });
              continue;
            }
            const updated = await reconcileDisabledRule(client, {
              migrationRule: rule,
              appliedByUserId,
            });
            if (!updated) {
              blocked.push({
                sourceType: rule.source.type,
                sourceId: rule.source.id,
                targetRuleId: rule.migration.targetRuleId,
                name: rule.proposed.name,
                blockers: [
                  "The existing unified rule changed while reconciliation was running; verify it is fully disabled and retry.",
                ],
              });
              continue;
            }
            reconciled.push({
              sourceType: rule.source.type,
              sourceId: rule.source.id,
              targetRuleId: rule.migration.targetRuleId,
              name: rule.proposed.name,
              enabled: false,
            });
            continue;
          }
          skipped.push({
            sourceType: rule.source.type,
            sourceId: rule.source.id,
            targetRuleId: rule.migration.targetRuleId,
            name: rule.proposed.name,
          });
          continue;
        }
        const targetRuleId = await insertDisabledRule(client, {
          migrationRule: rule,
          appliedByUserId,
        });
        created.push({
          sourceType: rule.source.type,
          sourceId: rule.source.id,
          targetRuleId,
          name: rule.proposed.name,
          enabled: false,
        });
      }

      await auditMigration(client, {
        appliedByUserId,
        created,
        reconciled,
        skipped,
        blocked,
      });
      await client.query("COMMIT");
      return {
        mode: "disabled_only",
        createdCount: created.length,
        reconciledCount: reconciled.length,
        skippedCount: skipped.length,
        blockedCount: blocked.length,
        created,
        reconciled,
        skipped,
        blocked,
        allCreatedDisabled: created.every((rule) => rule.enabled === false),
        legacyDeliveryChanged: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const notificationMigrationRepositoryInternals = Object.freeze({
  LEGACY_MQTT_QUERY,
  LEGACY_PUSHOVER_QUERY,
  MIGRATION_MAPPING_QUERY,
  actorId,
  channelName,
  ensurePool,
  insertConditionGroup,
  insertDisabledRule,
  reconcileDisabledRule,
  loadMigrationInputs,
});
