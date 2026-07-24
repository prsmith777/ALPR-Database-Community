import { evaluateNotificationRule } from "./notification-rule-engine.mjs";
import { normalizeEditableTagCameraTree } from "./notification-rule-draft-shape.mjs";

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationRuleDraftRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const parsed = Number(actor?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveId(value, message) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(message);
  return parsed;
}

function stringList(value, { label, maximum = 20 } = {}) {
  const values = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error(`Select at least one ${label}`);
  if (values.length > maximum || values.some((item) => item.length > 100)) {
    throw new Error(`Select valid ${label}`);
  }
  return values;
}

async function loadDraft(client, ruleId, { lock = false } = {}) {
  const ruleLock = lock ? "FOR UPDATE OF r" : "";
  const deliveryLock = lock ? "FOR UPDATE OF a, ch" : "";
  const groupLock = lock ? "FOR UPDATE" : "";
  const conditionLock = lock ? "FOR UPDATE OF c" : "";
  const ruleResult = await client.query(
    `
      SELECT m.source_type, m.source_id, r.id, r.name, r.enabled, r.event_type,
             r.cooldown_seconds, r.version
      FROM public.notification_rule_migrations m
      JOIN public.notification_rules r ON r.id = m.target_rule_id
      WHERE r.id = $1::bigint AND m.retired_at IS NULL
      ${ruleLock}
    `,
    [ruleId]
  );
  const rule = ruleResult.rows[0];
  if (!rule) throw new Error("The migrated unified rule was not found");
  if (rule.source_type !== "mqtt") throw new Error("Only migrated MQTT tag rules can be edited here");
  if (rule.enabled !== false) throw new Error("Disable the unified rule before editing its conditions");

  const deliveryResult = await client.query(
    `
      SELECT a.id, a.enabled AS action_enabled, ch.id AS channel_id,
             ch.enabled AS channel_enabled
      FROM public.notification_actions a
      JOIN public.notification_channels ch ON ch.id = a.channel_id
      WHERE a.rule_id = $1::bigint
      ORDER BY a.position, a.id
      ${deliveryLock}
    `,
    [ruleId]
  );
  const groupResult = await client.query(
    `
      SELECT id, parent_group_id, combinator, negated, position
      FROM public.notification_condition_groups
      WHERE rule_id = $1::bigint
      ORDER BY position, id
      ${groupLock}
    `,
    [ruleId]
  );
  const conditionResult = await client.query(
    `
      SELECT c.id, c.group_id, c.condition_type, c.operator, c.operand, c.position
      FROM public.notification_conditions c
      JOIN public.notification_condition_groups g ON g.id = c.group_id
      WHERE g.rule_id = $1::bigint
      ORDER BY c.position, c.id
      ${conditionLock}
    `,
    [ruleId]
  );

  if (
    deliveryResult.rows.length === 0 ||
    deliveryResult.rows.some((row) => row.action_enabled !== false || row.channel_enabled !== false)
  ) {
    throw new Error("Rule editing requires the rule, channel, and actions to remain disabled");
  }
  const roots = groupResult.rows.filter((group) => group.parent_group_id == null);
  const tree = conditionTree(groupResult.rows, conditionResult.rows);
  const counts = treeCounts(tree);
  if (
    roots.length !== 1 ||
    !tree ||
    counts.groupCount !== groupResult.rows.length ||
    counts.conditionCount !== conditionResult.rows.length
  ) {
    throw new Error("This rule uses a condition structure that is not editable here");
  }
  const shape = normalizeEditableTagCameraTree(tree);
  if (!shape) {
    throw new Error("Only migrated tag-and-camera rules can be edited here");
  }
  return { rule, rootGroup: roots[0], conditionTree: tree, shape };
}

async function insertCondition(client, { groupId, type, operator, operand, position }) {
  await client.query(
    `
      INSERT INTO public.notification_conditions
        (group_id, condition_type, operator, operand, position)
      VALUES ($1::bigint, $2, $3, $4::jsonb, $5)
    `,
    [groupId, type, operator, JSON.stringify(operand), position]
  );
}

function conditionTree(groups, conditions) {
  const trees = new Map(groups.map((group) => [String(group.id), {
    id: group.id,
    kind: "group",
    combinator: group.combinator,
    negated: Boolean(group.negated),
    parentGroupId: group.parent_group_id,
    position: Number(group.position),
    children: [],
  }]));
  for (const condition of conditions) {
    const group = trees.get(String(condition.group_id));
    if (!group) return null;
    group.children.push({
      id: condition.id,
      kind: "condition",
      conditionType: condition.condition_type,
      operator: condition.operator,
      value: condition.operand || {},
      position: Number(condition.position),
    });
  }
  for (const group of trees.values()) {
    if (group.parentGroupId != null) {
      const parent = trees.get(String(group.parentGroupId));
      if (!parent) return null;
      parent.children.push(group);
    }
  }
  for (const group of trees.values()) {
    group.children.sort((left, right) => left.position - right.position || String(left.id).localeCompare(String(right.id)));
  }
  const roots = [...trees.values()].filter((group) => group.parentGroupId == null);
  return roots.length === 1 ? roots[0] : null;
}

function treeCounts(root) {
  const seenGroups = new Set();
  let conditionCount = 0;
  const visit = (group) => {
    if (!group || seenGroups.has(String(group.id))) return;
    seenGroups.add(String(group.id));
    for (const child of group.children || []) {
      if (child?.kind === "group") visit(child);
      else if (child?.kind === "condition") conditionCount += 1;
    }
  };
  visit(root);
  return { groupCount: seenGroups.size, conditionCount };
}

export class NotificationRuleDraftRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async updateTagCameraRule({ ruleId, requireKnownPlate = false, tags = [], cameras = [], actor = null } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("Notification rule editing requires a transactional pool");
    }
    const parsedRuleId = positiveId(ruleId, "Select a valid unified rule to edit");
    const normalizedTags = stringList(tags, { label: "tag" });
    const normalizedCameras = stringList(cameras, { label: "camera" });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_notification_rule_transition'), $1::integer)",
        [parsedRuleId]
      );
      const locked = await loadDraft(client, parsedRuleId, { lock: true });
      await client.query(
        `
          DELETE FROM public.notification_conditions
          WHERE group_id IN (
            SELECT id FROM public.notification_condition_groups WHERE rule_id = $1::bigint
          )
        `,
        [parsedRuleId]
      );
      await client.query(
        `
          DELETE FROM public.notification_condition_groups
          WHERE rule_id = $1::bigint AND parent_group_id IS NOT NULL
        `,
        [parsedRuleId]
      );
      let position = 0;
      if (requireKnownPlate) {
        await insertCondition(client, {
          groupId: locked.rootGroup.id,
          type: "known_plate",
          operator: "is_true",
          operand: { expected: true },
          position: position++,
        });
      }
      await insertCondition(client, {
        groupId: locked.rootGroup.id,
        type: "tag",
        operator: "any",
        operand: { tags: normalizedTags },
        position: position++,
      });
      await insertCondition(client, {
        groupId: locked.rootGroup.id,
        type: "camera",
        operator: "in",
        operand: { names: normalizedCameras },
        position,
      });
      const updated = await client.query(
        `
          UPDATE public.notification_rules
          SET version = version + 1,
              updated_by_user_id = COALESCE($2::bigint, updated_by_user_id)
          WHERE id = $1::bigint
          RETURNING id, version
        `,
        [parsedRuleId, actorId(actor)]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata)
          VALUES ($1::bigint, 'browser', 'notification.rule_draft_updated',
                  'notification_rule', $2, 'succeeded', $3::jsonb)
        `,
        [
          actorId(actor),
          String(parsedRuleId),
          JSON.stringify({
            version: Number(updated.rows[0].version),
            requireKnownPlate: Boolean(requireKnownPlate),
            tags: normalizedTags,
            cameras: normalizedCameras,
            ruleRemainedDisabled: true,
            deliveryAttempts: 0,
          }),
        ]
      );
      await client.query("COMMIT");
      return {
        ruleId: parsedRuleId,
        version: Number(updated.rows[0].version),
        requireKnownPlate: Boolean(requireKnownPlate),
        tags: normalizedTags,
        cameras: normalizedCameras,
        ruleRemainedDisabled: true,
        deliveryAttempts: 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async simulate({ ruleId, plateNumber, cameraName, tags = [], knownPlate = false, confidence = 100 } = {}) {
    const parsedRuleId = positiveId(ruleId, "Select a valid unified rule to test");
    const plate = String(plateNumber ?? "").trim().toUpperCase();
    const camera = String(cameraName ?? "").trim();
    if (!plate || plate.length > 20) throw new Error("Enter a valid test plate number");
    if (!camera || camera.length > 100) throw new Error("Enter a valid test camera");
    const normalizedTags = [...new Set((Array.isArray(tags) ? tags : []).map((item) => String(item ?? "").trim()).filter(Boolean))];
    if (normalizedTags.length > 20 || normalizedTags.some((item) => item.length > 100)) {
      throw new Error("Enter valid test tags");
    }
    const client = typeof this.pool.connect === "function" ? await this.pool.connect() : this.pool;
    try {
      const locked = await loadDraft(client, parsedRuleId);
      const event = {
        id: `simulation-${parsedRuleId}`,
        type: locked.rule.event_type,
        plateNumber: plate,
        effectivePlate: plate,
        observedPlate: plate,
        cameraName: camera,
        confidence: Number(confidence),
        knownPlate: Boolean(knownPlate),
        knownName: "",
        tags: normalizedTags,
        watchlisted: false,
        timestamp: new Date().toISOString(),
      };
      const decision = evaluateNotificationRule(
        {
          id: locked.rule.id,
          name: locked.rule.name,
          enabled: true,
          eventTypes: [locked.rule.event_type],
          cooldownSeconds: Number(locked.rule.cooldown_seconds),
          version: Number(locked.rule.version),
          conditionTree: locked.conditionTree,
          actions: [],
        },
        { event, now: event.timestamp }
      );
      return {
        ruleId: parsedRuleId,
        version: Number(locked.rule.version),
        matched: Boolean(decision.matched),
        reason: decision.reason,
        trace: decision.trace,
        event,
        ruleRemainedDisabled: true,
        deliveryAttempts: 0,
      };
    } finally {
      if (client !== this.pool && typeof client.release === "function") client.release();
    }
  }
}

export const notificationRuleDraftRepositoryInternals = Object.freeze({
  conditionTree,
  loadDraft,
  positiveId,
  stringList,
  treeCounts,
});
