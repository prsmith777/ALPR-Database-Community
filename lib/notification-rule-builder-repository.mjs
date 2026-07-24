import { evaluateNotificationRule } from "./notification-rule-engine.mjs";
import { normalizeNotificationRuleDraft } from "./notification-rule-builder-shape.mjs";
import { NotificationRuntimeRepository } from "./notification-runtime-repository.mjs";

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationRuleBuilderRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ruleId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Select a valid notification rule");
  return parsed;
}

function buildConditionTrees(groupRows, conditionRows) {
  const groups = new Map(groupRows.map((row) => [String(row.id), {
    id: Number(row.id),
    kind: "group",
    combinator: row.combinator,
    position: Number(row.position),
    ruleId: Number(row.rule_id),
    parentGroupId: row.parent_group_id == null ? null : Number(row.parent_group_id),
    children: [],
  }]));
  for (const row of conditionRows) {
    groups.get(String(row.group_id))?.children.push({
      id: Number(row.id),
      kind: "condition",
      conditionType: row.condition_type,
      operator: row.operator,
      value: row.operand || {},
      position: Number(row.position),
    });
  }
  for (const group of groups.values()) {
    if (group.parentGroupId != null) groups.get(String(group.parentGroupId))?.children.push(group);
  }
  for (const group of groups.values()) {
    group.children.sort((left, right) => left.position - right.position || left.id - right.id);
  }
  return new Map([...groups.values()]
    .filter((group) => group.parentGroupId == null)
    .map((group) => [String(group.ruleId), group]));
}

function mapRules({ rules, groups, conditions, actions }) {
  const trees = buildConditionTrees(groups, conditions);
  const actionsByRule = new Map();
  for (const row of actions) {
    const key = String(row.rule_id);
    const values = actionsByRule.get(key) || [];
    values.push({
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      position: Number(row.position),
      channelId: Number(row.channel_id),
      channelName: row.channel_name,
      channelType: row.channel_type,
      channelEnabled: Boolean(row.channel_enabled),
      credentialReference: row.credential_reference,
      configuration: { ...(row.channel_configuration || {}), ...(row.configuration || {}) },
    });
    actionsByRule.set(key, values);
  }
  return rules.map((row) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description || "",
    enabled: Boolean(row.enabled),
    eventType: row.event_type,
    cooldownSeconds: Number(row.cooldown_seconds),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    managedByMigration: Boolean(row.managed_by_migration),
    conditionTree: trees.get(String(row.id)) || null,
    actions: actionsByRule.get(String(row.id)) || [],
  }));
}

async function loadRules(executor, { onlyRuleId = null, lock = false } = {}) {
  const where = onlyRuleId ? "WHERE r.id = $1::bigint" : "";
  const values = onlyRuleId ? [onlyRuleId] : [];
  const ruleLock = lock ? "FOR UPDATE OF r" : "";
  const [rules, groups, conditions, actions] = await Promise.all([
    executor.query(`
      SELECT r.*,
             EXISTS (SELECT 1 FROM public.notification_rule_migrations m WHERE m.target_rule_id = r.id) AS managed_by_migration
      FROM public.notification_rules r
      ${where}
      ORDER BY r.enabled DESC, r.updated_at DESC, r.id DESC
      ${ruleLock}
    `, values),
    executor.query(`
      SELECT g.* FROM public.notification_condition_groups g
      ${onlyRuleId ? "WHERE g.rule_id = $1::bigint" : ""}
      ORDER BY g.rule_id, g.position, g.id
    `, values),
    executor.query(`
      SELECT c.* FROM public.notification_conditions c
      JOIN public.notification_condition_groups g ON g.id = c.group_id
      ${onlyRuleId ? "WHERE g.rule_id = $1::bigint" : ""}
      ORDER BY g.rule_id, c.group_id, c.position, c.id
    `, values),
    executor.query(`
      SELECT a.*, ch.name AS channel_name, ch.channel_type, ch.enabled AS channel_enabled,
             ch.credential_reference, ch.configuration AS channel_configuration
      FROM public.notification_actions a
      JOIN public.notification_channels ch ON ch.id = a.channel_id
      ${onlyRuleId ? "WHERE a.rule_id = $1::bigint" : ""}
      ORDER BY a.rule_id, a.position, a.id
      ${lock ? "FOR UPDATE OF a, ch" : ""}
    `, values),
  ]);
  return mapRules({ rules: rules.rows, groups: groups.rows, conditions: conditions.rows, actions: actions.rows });
}

async function insertConditionGroup(client, { ruleId: id, group, parentGroupId = null, position = 0 }) {
  const inserted = await client.query(`
    INSERT INTO public.notification_condition_groups
      (rule_id, parent_group_id, combinator, negated, position)
    VALUES ($1::bigint, $2::bigint, $3, FALSE, $4)
    RETURNING id
  `, [id, parentGroupId, group.combinator, position]);
  const groupId = inserted.rows[0].id;
  for (const [childPosition, child] of group.children.entries()) {
    if (child.kind === "group") {
      await insertConditionGroup(client, {
        ruleId: id,
        group: child,
        parentGroupId: groupId,
        position: childPosition,
      });
    } else {
      await client.query(`
        INSERT INTO public.notification_conditions
          (group_id, condition_type, operator, operand, position)
        VALUES ($1::bigint, $2, $3, $4::jsonb, $5)
      `, [groupId, child.conditionType, child.operator, JSON.stringify(child.value), childPosition]);
    }
  }
}

async function insertActions(client, { ruleId: id, ruleName, actions, userId }) {
  for (const [position, action] of actions.entries()) {
    const channel = await client.query(`
      INSERT INTO public.notification_channels
        (name, channel_type, enabled, credential_reference, configuration,
         created_by_user_id, updated_by_user_id)
      VALUES ($1, $2, FALSE, $3, $4::jsonb, $5::bigint, $5::bigint)
      RETURNING id
    `, [
      `${ruleName} / ${action.channelType.toUpperCase()} ${position + 1}`.slice(0, 255),
      action.channelType,
      action.credentialReference,
      JSON.stringify(action.configuration),
      userId,
    ]);
    await client.query(`
      INSERT INTO public.notification_actions
        (rule_id, channel_id, enabled, position, configuration)
      VALUES ($1::bigint, $2::bigint, FALSE, $3, $4::jsonb)
    `, [id, channel.rows[0].id, position, JSON.stringify(action.configuration)]);
  }
}

async function audit(client, { actor, eventType, id, metadata }) {
  await client.query(`
    INSERT INTO public.audit_events
      (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata)
    VALUES ($1::bigint, 'browser', $2, 'notification_rule', $3, 'succeeded', $4::jsonb)
  `, [actorId(actor), eventType, String(id), JSON.stringify(metadata)]);
}

function assertEditable(rule) {
  if (!rule) throw new Error("The notification rule was not found");
  if (rule.managedByMigration) throw new Error("Migrated rules must use the guarded migration workflow");
  if (rule.enabled || rule.actions.some((action) => action.enabled || action.channelEnabled)) {
    throw new Error("Disable the rule before editing it");
  }
}

function readEvent(row) {
  return {
    id: Number(row.id),
    type: "plate_read.accepted",
    plateNumber: row.plate_number,
    effectivePlate: row.plate_number,
    observedPlate: row.observed_plate || row.plate_number,
    timestamp: row.timestamp,
    cameraName: row.camera_name,
    confidence: Number(row.confidence),
    knownPlate: Boolean(row.known_plate),
    knownName: row.known_name || "",
    tags: row.tags || [],
    watchlisted: Boolean(row.watchlisted),
  };
}

export class NotificationRuleBuilderRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async overview({ pushover = {} } = {}) {
    const [rules, tags, cameras, brokers, mqttSettings] = await Promise.all([
      loadRules(this.pool),
      this.pool.query("SELECT id, name, color FROM public.tags ORDER BY LOWER(name), id"),
      this.pool.query(`SELECT DISTINCT camera_name FROM public.plate_reads WHERE NULLIF(BTRIM(camera_name), '') IS NOT NULL ORDER BY camera_name`),
      this.pool.query("SELECT id, name, enabled FROM public.mqttbrokers ORDER BY LOWER(name), id"),
      this.pool.query("SELECT enabled, local_timezone FROM public.mqtt_settings WHERE id = 1"),
    ]);
    return {
      rules,
      options: {
        tags: tags.rows,
        cameras: cameras.rows.map((row) => row.camera_name),
        brokers: brokers.rows.map((row) => ({ id: Number(row.id), name: row.name, enabled: Boolean(row.enabled) })),
        mqttEnabled: Boolean(mqttSettings.rows[0]?.enabled),
        pushoverEnabled: Boolean(pushover.enabled),
        pushoverConfigured: Boolean(pushover.configured),
        localTimeZone: String(mqttSettings.rows[0]?.local_timezone || pushover.localTimeZone || "America/Denver"),
      },
    };
  }

  async createDraft({ draft, actor = null } = {}) {
    const normalized = normalizeNotificationRuleDraft(draft);
    if (typeof this.pool.connect !== "function") throw new Error("Rule creation requires a transactional pool");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const userId = actorId(actor);
      const inserted = await client.query(`
        INSERT INTO public.notification_rules
          (name, description, enabled, event_type, cooldown_seconds, created_by_user_id, updated_by_user_id)
        VALUES ($1, NULLIF($2, ''), FALSE, $3, $4, $5::bigint, $5::bigint)
        RETURNING id, version
      `, [normalized.name, normalized.description, normalized.eventType, normalized.cooldownSeconds, userId]);
      const id = Number(inserted.rows[0].id);
      await insertConditionGroup(client, { ruleId: id, group: normalized.conditionTree });
      await insertActions(client, { ruleId: id, ruleName: normalized.name, actions: normalized.actions, userId });
      await audit(client, {
        actor,
        eventType: "notification.rule_draft_created",
        id,
        metadata: { version: Number(inserted.rows[0].version), ruleRemainedDisabled: true, deliveryAttempts: 0 },
      });
      await client.query("COMMIT");
      return { ruleId: id, version: Number(inserted.rows[0].version), enabled: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDraft({ id, draft, actor = null } = {}) {
    const parsedId = ruleId(id);
    const normalized = normalizeNotificationRuleDraft(draft);
    if (typeof this.pool.connect !== "function") throw new Error("Rule editing requires a transactional pool");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)", [parsedId]);
      const existing = (await loadRules(client, { onlyRuleId: parsedId, lock: true }))[0];
      assertEditable(existing);
      const channelIds = existing.actions.map((action) => action.channelId);
      await client.query("DELETE FROM public.notification_actions WHERE rule_id = $1::bigint", [parsedId]);
      await client.query("DELETE FROM public.notification_condition_groups WHERE rule_id = $1::bigint", [parsedId]);
      if (channelIds.length) {
        await client.query("DELETE FROM public.notification_channels WHERE id = ANY($1::bigint[])", [channelIds]);
      }
      const updated = await client.query(`
        UPDATE public.notification_rules
        SET name = $2, description = NULLIF($3, ''), cooldown_seconds = $4,
            version = version + 1, updated_by_user_id = COALESCE($5::bigint, updated_by_user_id)
        WHERE id = $1::bigint
        RETURNING version
      `, [parsedId, normalized.name, normalized.description, normalized.cooldownSeconds, actorId(actor)]);
      await insertConditionGroup(client, { ruleId: parsedId, group: normalized.conditionTree });
      await insertActions(client, {
        ruleId: parsedId,
        ruleName: normalized.name,
        actions: normalized.actions,
        userId: actorId(actor),
      });
      await audit(client, {
        actor,
        eventType: "notification.rule_draft_updated",
        id: parsedId,
        metadata: { version: Number(updated.rows[0].version), ruleRemainedDisabled: true, deliveryAttempts: 0 },
      });
      await client.query("COMMIT");
      return { ruleId: parsedId, version: Number(updated.rows[0].version), enabled: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setEnabled({ id, enabled, actor = null, pushoverAvailable = false } = {}) {
    const parsedId = ruleId(id);
    if (typeof this.pool.connect !== "function") throw new Error("Rule activation requires a transactional pool");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)", [parsedId]);
      const rule = (await loadRules(client, { onlyRuleId: parsedId, lock: true }))[0];
      if (!rule) throw new Error("The notification rule was not found");
      if (rule.managedByMigration) throw new Error("Migrated rules must use the guarded migration workflow");
      if (!rule.conditionTree || rule.actions.length === 0) throw new Error("The rule needs conditions and an action before activation");

      if (enabled) {
        const pushoverNeeded = rule.actions.some((action) => action.channelType === "pushover");
        if (pushoverNeeded && !pushoverAvailable) throw new Error("Enable and configure Pushover before activating this rule");
        const mqttActions = rule.actions.filter((action) => action.channelType === "mqtt");
        if (mqttActions.length) {
          const brokerIds = mqttActions.map((action) => Number(action.configuration.brokerId));
          const availability = await client.query(`
            SELECT (SELECT enabled FROM public.mqtt_settings WHERE id = 1) AS mqtt_enabled,
                   COUNT(*)::integer AS enabled_brokers
            FROM public.mqttbrokers WHERE id = ANY($1::integer[]) AND enabled = TRUE
          `, [brokerIds]);
          if (!availability.rows[0]?.mqtt_enabled || Number(availability.rows[0]?.enabled_brokers) !== new Set(brokerIds).size) {
            throw new Error("Enable MQTT and every selected broker before activating this rule");
          }
        }
      }

      await client.query("UPDATE public.notification_rules SET enabled = $2, updated_by_user_id = COALESCE($3::bigint, updated_by_user_id) WHERE id = $1::bigint", [parsedId, Boolean(enabled), actorId(actor)]);
      await client.query("UPDATE public.notification_actions SET enabled = $2 WHERE rule_id = $1::bigint", [parsedId, Boolean(enabled)]);
      await client.query(`
        UPDATE public.notification_channels ch SET enabled = $2, updated_by_user_id = COALESCE($3::bigint, updated_by_user_id)
        FROM public.notification_actions a WHERE a.channel_id = ch.id AND a.rule_id = $1::bigint
      `, [parsedId, Boolean(enabled), actorId(actor)]);
      await audit(client, {
        actor,
        eventType: enabled ? "notification.rule_activated" : "notification.rule_deactivated",
        id: parsedId,
        metadata: { version: rule.version, enabled: Boolean(enabled), switchedAtomically: true },
      });
      await client.query("COMMIT");
      return { ruleId: parsedId, enabled: Boolean(enabled), version: rule.version };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async preview({ id, limit = 25, matchingSettings = {} } = {}) {
    const parsedId = ruleId(id);
    const rule = (await loadRules(this.pool, { onlyRuleId: parsedId }))[0];
    if (!rule) throw new Error("The notification rule was not found");
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const reads = await this.pool.query(`
      SELECT pr.id, pr.plate_number, pr.observed_plate, pr.timestamp, pr.camera_name, pr.confidence,
             (kp.plate_number IS NOT NULL) AS known_plate, COALESCE(kp.name, '') AS known_name,
             COALESCE(p.flagged, FALSE) AS watchlisted,
             COALESCE(array_agg(DISTINCT t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), ARRAY[]::varchar[]) AS tags
      FROM public.plate_reads pr
      LEFT JOIN public.plates p ON p.plate_number = pr.plate_number
      LEFT JOIN public.known_plates kp ON kp.plate_number = pr.plate_number
      LEFT JOIN public.plate_tags pt ON pt.plate_number = pr.plate_number
      LEFT JOIN public.tags t ON t.id = pt.tag_id
      GROUP BY pr.id, kp.plate_number, kp.name, p.flagged
      ORDER BY pr.timestamp DESC, pr.id DESC
      LIMIT $1
    `, [safeLimit]);
    const previewRule = {
      ...rule,
      enabled: true,
      eventTypes: [rule.eventType],
      actions: rule.actions.map((action) => ({ ...action, enabled: true })),
    };
    const metricRepository = new NotificationRuntimeRepository({ executor: this.pool });
    const samples = [];
    for (const row of reads.rows) {
      const event = readEvent(row);
      const metrics = await metricRepository.loadReadCountMetrics({ rules: [previewRule], event });
      const decision = evaluateNotificationRule(previewRule, { event, now: event.timestamp, matchingSettings, metrics });
      samples.push({
        readId: event.id,
        plateNumber: event.plateNumber,
        cameraName: event.cameraName,
        timestamp: event.timestamp,
        matched: Boolean(decision.matched),
        reason: decision.reason,
        trace: decision.trace,
      });
    }
    return {
      ruleId: parsedId,
      ruleVersion: rule.version,
      sampleCount: samples.length,
      matchCount: samples.filter((sample) => sample.matched).length,
      samples,
      deliveryAttempts: 0,
    };
  }
}

export const notificationRuleBuilderRepositoryInternals = Object.freeze({
  assertEditable,
  buildConditionTrees,
  loadRules,
  mapRules,
  readEvent,
  ruleId,
});
